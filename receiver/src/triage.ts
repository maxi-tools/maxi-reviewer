/**
 * Webhook payload shape, plus the pure `triage` function that decides
 * whether a delivery is one we re-evaluate on.
 *
 * Split out of `worker.ts` so the decision table is unit-testable
 * without a Cloudflare runtime. The actual webhook handling
 * (signature verification, fetch, KV writes) stays in worker.ts.
 */

export interface WebhookPullRequest {
  number?: number;
  head?: { sha?: string; repo?: { full_name?: string } };
  base?: { repo?: { full_name?: string } };
}

export interface WebhookEvent {
  action?: string;
  pull_request?: WebhookPullRequest;
  repository?: { full_name?: string };
  installation?: { id?: number };
  check_run?: {
    name?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number; head?: { sha?: string } }>;
  };
  review?: { state?: string };
}

export interface Evaluation {
  owner: string;
  repo: string;
  pr: number;
  /** Optional override; on a `check_run.rerequested` we may already know it. */
  headSha?: string;
  reason:
    | "pull_request_review_thread"
    | "pull_request_review"
    | "pull_request.opened"
    | "check_run.rerequested";
}

export const CHECK_NAME = "maxi-reviewer/review-gate";

export function triage(
  eventName: string,
  body: WebhookEvent
): Evaluation | null {
  const repoFullName =
    body.repository?.full_name ??
    body.pull_request?.base?.repo?.full_name ??
    body.pull_request?.head?.repo?.full_name;
  if (!repoFullName) return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  switch (eventName) {
    case "pull_request_review_thread": {
      const action = body.action;
      if (action !== "resolved" && action !== "unresolved") return null;
      const pr = body.pull_request?.number;
      const headSha = body.pull_request?.head?.sha;
      if (typeof pr !== "number") return null;
      return {
        owner,
        repo,
        pr,
        headSha,
        reason: "pull_request_review_thread",
      };
    }
    case "pull_request_review": {
      const action = body.action;
      if (action !== "submitted" && action !== "dismissed") return null;
      const pr = body.pull_request?.number;
      const headSha = body.pull_request?.head?.sha;
      if (typeof pr !== "number") return null;
      return { owner, repo, pr, headSha, reason: "pull_request_review" };
    }
    case "pull_request": {
      const action = body.action;
      const pr = body.pull_request?.number;
      const headSha = body.pull_request?.head?.sha;
      if (typeof pr !== "number") return null;
      const allowed = ["opened", "reopened", "ready_for_review"];
      if (!allowed.includes(action ?? "")) return null;
      return { owner, repo, pr, headSha, reason: "pull_request.opened" };
    }
    case "check_run": {
      if (body.action !== "rerequested") return null;
      const cr = body.check_run;
      const name = cr?.name;
      // The worker publishes TWO checks per PR, one per condition, so
      // either suffix has to count as "ours" for the re-run button.
      if (
        name !== CHECK_NAME &&
        name !== `${CHECK_NAME} (review threads)` &&
        name !== `${CHECK_NAME} (non-author review)`
      ) {
        return null;
      }
      const prs = cr?.pull_requests ?? [];
      const first = prs[0];
      const pr = first?.number;
      if (typeof pr !== "number") return null;
      return {
        owner,
        repo,
        pr,
        headSha: cr?.head_sha ?? first?.head?.sha,
        reason: "check_run.rerequested",
      };
    }
    default:
      return null;
  }
}
