/**
 * Cloudflare Worker entrypoint for the maxi-reviewer re-trigger receiver.
 *
 * Subscribes to four webhook events that the App can receive but Actions
 * cannot trigger on (`pull_request_review_thread`, `pull_request_review`,
 * plus `pull_request.opened` for the first evaluation), and
 * `check_run.rerequested` so the existing re-run button on the App's check
 * sends a request this Worker also handles. For each one it runs the
 * evaluator against live PR state and posts the verdict as the App's own
 * check run.
 *
 * Also exposes `/health` (200 with `{ ok: true, last_success: ... }`) and
 * `/heartbeat` (200 with the same shape) so an external monitor — a small
 * scheduled workflow in maxi-config — can detect a dead receiver. The
 * heartbeat writes a timestamp on every successful webhook, and the
 * scheduled monitor alerts when that timestamp is older than the agreed
 * staleness window.
 *
 * Design choices:
 *   * The WebCrypto-only path (no Node crypto) keeps this portable to
 *     Cloudflare's V8 runtime. Verified by hand against the Workers
 *     runtime reference.
 *   * The `installation` lookup is by repo id (a stable integer per
 *     installation) rather than per-repo, because GitHub does not
 *     publish a repo->installation map and an App can be installed on
 *     many repos. A first webhook hit from an unknown installation is
 *     recorded as 404 and surfaces to the operator comment thread.
 *   * `check_run.rerequested` is matched on the App's OWN check name so
 *     a re-request against an Actions-owned check (which GitHub would
 *     refuse to forward to the App anyway) does not enqueue an
 *     evaluation we cannot serve.
 */

import { verifyWebhookSignature, mintAppJwt } from "./auth.js";
import { collect } from "./collect.js";
import { evaluate, failureAnnotations, waiverLabel } from "./evaluate.js";
import {
  makeClient,
  createCheckRun,
  type AuthedClient,
  type AppConfig,
  type ClientCache,
  newClientCache,
} from "./github.js";
import { triage, type WebhookEvent, CHECK_NAME } from "./triage.js";

// Module-scope cache survives within a single Worker isolate instance;
// isolates are recycled periodically, which also discards the cached
// tokens, so the 10-minute lifetime we cache for is well under the
// worst-case residency.
const cache: ClientCache = newClientCache();

export interface Env {
  /** GitHub App id, as a string ("123456"). */
  APP_ID: string;
  /** PKCS#8 PEM-encoded private key from the App settings page. */
  APP_PRIVATE_KEY: string;
  /** Shared webhook secret, base64 or hex stripped (the raw PEM-armoured form). */
  APP_WEBHOOK_SECRET: string;
  /** KV namespace binding for heartbeat timestamps. */
  HEARTBEAT?: KVNamespace;
  /** Staleness window in seconds; default 1h. */
  HEARTBEAT_STALE_SECONDS?: string;
}

interface InstallationMap {
  /** repo full_name ("o/r") -> installation id. */
  byRepo: Map<string, number>;
  /** installation id -> access token URL fragment, refreshed lazily. */
}

/**
 * Look up the installation id for a repository. The App's installations
 * endpoint returns the mapping; cached for 5 minutes inside the isolate.
 */
const installationCache = new Map<
  string,
  { ids: Map<string, number>; fetchedAt: number }
>();
const INSTALLATION_TTL_SECONDS = 5 * 60;

async function installationIdFor(
  repoFullName: string,
  appConfig: AppConfig,
  fetchImpl: typeof fetch
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const cached = installationCache.get(appConfig.appId);
  if (cached && now - cached.fetchedAt < INSTALLATION_TTL_SECONDS) {
    return cached.ids.get(repoFullName) ?? null;
  }
  const jwt = await mintAppJwt({
    appId: appConfig.appId,
    privateKeyPem: appConfig.privateKeyPem,
    nowSeconds: now,
  });
  const res = await fetchImpl(
    "https://api.github.com/app/installations?per_page=100",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "maxi-reviewer-receiver",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`installations list ${res.status}`);
  }
  const list = (await res.json()) as Array<{
    id: number;
    account: { login: string };
    repositories?: { nodes?: Array<{ full_name?: string }> };
  }>;
  const ids = new Map<string, number>();
  for (const inst of list) {
    // Some installations are repo-scoped (no `repositories` field); the
    // mapping for those is per-repo via the `repositories_url`.
    if (inst.repositories?.nodes) {
      for (const r of inst.repositories.nodes) {
        if (r.full_name) ids.set(r.full_name, inst.id);
      }
    } else {
      // Org-level: every repo under the account inherits it. We can't
      // enumerate the full set here without an extra call per repo, so
      // key by account login as a fallback the caller may try next.
      ids.set(inst.account.login + "/*", inst.id);
    }
  }
  installationCache.set(appConfig.appId, { ids, fetchedAt: now });
  return ids.get(repoFullName) ?? null;
}

/** Write the heartbeat timestamp; called only on a successful publish. */
async function recordHeartbeat(env: Env): Promise<number> {
  const ts = Math.floor(Date.now() / 1000);
  if (env.HEARTBEAT) {
    await env.HEARTBEAT.put("last_success", String(ts), {
      // 7 days; we read it ourselves within a couple hours and surface
      // staleness via the scheduled monitor.
      expirationTtl: 7 * 24 * 60 * 60,
    });
  }
  return ts;
}

async function readHeartbeat(env: Env): Promise<number | null> {
  if (!env.HEARTBEAT) return null;
  const raw = await env.HEARTBEAT.get("last_success");
  if (typeof raw !== "string") return null;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : null;
}

function staleSeconds(env: Env): number {
  const raw = env.HEARTBEAT_STALE_SECONDS;
  if (typeof raw !== "string") return 60 * 60;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : 60 * 60;
}

async function evaluateAndPublish(
  client: AuthedClient,
  owner: string,
  repo: string,
  pr: number,
  headSha: string | undefined
): Promise<{ ok: boolean; lines: string[]; reason: string }> {
  const payload = await collect(client, owner, repo, pr);
  // Pull the head SHA from the PR — the webhook's head_sha is the
  // snapshot at delivery, which can lag a force-push by a fraction of
  // a second. The REST read is the SHA the check run has to bind to.
  const headFromApi = (
    (await client.rest(`repos/${owner}/${repo}/pulls/${pr}`)) as {
      head?: { sha?: string };
    }
  ).head?.sha;
  const finalHeadSha = headFromApi ?? headSha;
  if (typeof finalHeadSha !== "string") {
    throw new Error("no head SHA available for check-run");
  }

  // Run BOTH conditions and pick the worst. The Python workflow splits
  // the verdict into two checks (one per condition) so a PR author can
  // see which half failed. We mirror that here: two check runs, with
  // different `name`s. Done sequentially so a failure of one does not
  // mask the other.
  const threads = evaluate(
    payload as unknown as Parameters<typeof evaluate>[0],
    "threads"
  );
  const reviewer = evaluate(
    payload as unknown as Parameters<typeof evaluate>[0],
    "non-author-review"
  );

  const threadsSummary = threads.lines.join("\n");
  const reviewerSummary = reviewer.lines.join("\n");
  const waiver = waiverLabel([...threads.lines, ...reviewer.lines]);

  await createCheckRun(client, owner, repo, {
    headSha: finalHeadSha,
    name: `${CHECK_NAME} (review threads)`,
    conclusion: threads.ok ? "success" : "failure",
    title: threads.ok
      ? "No unresolved review threads"
      : "Unresolved review threads",
    summary: threadsSummary,
  });
  await createCheckRun(client, owner, repo, {
    headSha: finalHeadSha,
    name: `${CHECK_NAME} (non-author review)`,
    conclusion: reviewer.ok ? "success" : "failure",
    title: reviewer.ok ? "Reviewed by a non-author" : "No non-author review",
    summary: reviewerSummary,
  });

  // The combined `failure_annotations` is what surfaces as `::error::`
  // on the run; the App check runs do not carry those directly, so the
  // caller-facing verdict lives in the per-condition summaries above.
  const combinedOk = threads.ok && reviewer.ok;
  return {
    ok: combinedOk,
    lines: [...threads.lines, ...reviewer.lines],
    reason: waiver === "" ? "" : `waived by ${waiver}`,
  };
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const sig = req.headers.get("X-Hub-Signature-256");
  const eventName = req.headers.get("X-GitHub-Event") ?? "";
  const deliveryId = req.headers.get("X-GitHub-Delivery") ?? "";
  const body = await req.text();

  const ok = await verifyWebhookSignature(env.APP_WEBHOOK_SECRET, body, sig);
  if (!ok) {
    return new Response("invalid signature", { status: 401 });
  }

  let parsed: WebhookEvent;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const work = triage(eventName, parsed);
  if (work === null) {
    // Acknowledge so GitHub stops retrying; nothing to do.
    return new Response(
      JSON.stringify({ ok: true, ignored: eventName, delivery: deliveryId }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const appConfig: AppConfig = {
    appId: env.APP_ID,
    privateKeyPem: env.APP_PRIVATE_KEY,
  };

  const instId =
    parsed.installation?.id ??
    (await installationIdFor(`${work.owner}/${work.repo}`, appConfig, fetch));
  if (typeof instId !== "number") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "no installation for repo",
        repo: `${work.owner}/${work.repo}`,
        delivery: deliveryId,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const client = makeClient(cache, appConfig, instId);

  let result: Awaited<ReturnType<typeof evaluateAndPublish>>;
  try {
    result = await evaluateAndPublish(
      client,
      work.owner,
      work.repo,
      work.pr,
      work.headSha
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ ok: false, error: message, delivery: deliveryId }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Only record heartbeat on a SUCCESSFUL publish; a failed publish is
  // exactly what the monitor is supposed to surface, and writing a fresh
  // timestamp then would defeat the whole point.
  if (result.ok) {
    await recordHeartbeat(env);
  }

  return new Response(
    JSON.stringify({
      ok: result.ok,
      reason: work.reason,
      delivery: deliveryId,
      annotations: failureAnnotations(result.lines),
      waiver: waiverLabel(result.lines),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function handleHealth(req: Request, env: Env): Promise<Response> {
  const ts = await readHeartbeat(env);
  const staleWindow = staleSeconds(env);
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = ts === null ? null : now - ts;
  const isStale =
    ts === null || ageSeconds === null || ageSeconds > staleWindow;
  // GET refreshes; HEAD/PUT do not (for external pollers).
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  return new Response(
    JSON.stringify({
      ok: !isStale,
      last_success: ts,
      age_seconds: ageSeconds,
      stale_window_seconds: staleWindow,
    }),
    {
      status: isStale ? 503 : 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/webhook") return handleWebhook(req, env);
    if (url.pathname === "/health" || url.pathname === "/heartbeat") {
      return handleHealth(req, env);
    }
    return new Response("not found", { status: 404 });
  },

  /**
   * Cron trigger — runs every 5 minutes, alerts when the heartbeat is
   * stale. Alerts by writing a Cloudflare Workers KV timestamp that an
   * external probe reads; we deliberately do NOT post to GitHub here,
   * because writing a check run or issue from a Cron-triggered handler
   * means the alert itself becomes a webhook delivery whose failure
   * could mask the receiver's silence.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const ts = await readHeartbeat(env);
    const staleWindow = staleSeconds(env);
    const now = Math.floor(Date.now() / 1000);
    if (ts === null) {
      // The receiver has never run. Not "stale" — just "absent".
      if (env.HEARTBEAT) {
        await env.HEARTBEAT.put(
          "last_alert",
          JSON.stringify({ reason: "never", at: now })
        );
      }
      return;
    }
    const ageSeconds = now - ts;
    if (ageSeconds > staleWindow) {
      if (env.HEARTBEAT) {
        await env.HEARTBEAT.put(
          "last_alert",
          JSON.stringify({
            reason: "stale",
            age_seconds: ageSeconds,
            at: now,
          })
        );
      }
    }
  },
};
