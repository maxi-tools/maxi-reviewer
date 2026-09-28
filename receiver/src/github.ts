/**
 * GitHub client used by the Worker. Backs the `GitHubClient` interface in
 * `collect.ts` and the check-run helper used by `worker.ts`.
 *
 * The token used is an installation token minted from the App's own JWT.
 * On a per-installation cache: one token per installation is held for ~10
 * minutes (well under GitHub's ~1-hour TTL), keyed by installation id.
 */

import type { GitHubClient } from "./collect.js";
import { mintAppJwt, installationToken } from "./auth.js";

export interface AppConfig {
  appId: string;
  privateKeyPem: string;
}

export interface ClientCache {
  /** installation id -> { token, expiresAt } */
  tokens: Map<number, { token: string; expiresAt: number }>;
  /** app id -> minted app jwt, expires 9 min from issue */
  appJwts: Map<string, { jwt: string; expiresAt: number }>;
}

export function newClientCache(): ClientCache {
  return { tokens: new Map(), appJwts: new Map() };
}

const INSTALLATION_TTL_BUFFER_SECONDS = 60;

async function getInstallationToken(
  cache: ClientCache,
  config: AppConfig,
  installationId: number,
  fetchImpl: typeof fetch
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.tokens.get(installationId);
  if (cached && cached.expiresAt > now + INSTALLATION_TTL_BUFFER_SECONDS) {
    return cached.token;
  }
  const jwt = await getAppJwt(cache, config);
  const tok = await installationToken({
    appJwt: jwt,
    installationId,
    fetchImpl,
  });
  const expiresAt = tok.expiresAt ?? now + 50 * 60; // 50 min default; GitHub's actual TTL is ~1h
  cache.tokens.set(installationId, { token: tok.token, expiresAt });
  return tok.token;
}

const APP_JWT_BUFFER_SECONDS = 60;
async function getAppJwt(cache: ClientCache, config: AppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.appJwts.get(config.appId);
  if (cached && cached.expiresAt > now + APP_JWT_BUFFER_SECONDS) {
    return cached.jwt;
  }
  const jwt = await mintAppJwt({
    appId: config.appId,
    privateKeyPem: config.privateKeyPem,
    nowSeconds: now,
  });
  cache.appJwts.set(config.appId, { jwt, expiresAt: now + 9 * 60 });
  return jwt;
}

export interface AuthedClient extends GitHubClient {
  /** Bearer header for REST/GraphQL calls — used by createCheckRun below. */
  authHeaders(): Promise<Record<string, string>>;
  /** Owns the cached installation token this client is bound to. */
  installationId(): number;
}

/**
 * Build an authenticated GitHub client bound to one installation.
 */
export function makeClient(
  cache: ClientCache,
  config: AppConfig,
  installationId: number,
  fetchImpl: typeof fetch = fetch
): AuthedClient {
  const authHeaders = async (): Promise<Record<string, string>> => {
    const token = await getInstallationToken(
      cache,
      config,
      installationId,
      fetchImpl
    );
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "maxi-reviewer-receiver",
    };
  };

  const graphql = async <T = unknown>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T[]> => {
    const headers = await authHeaders();
    const res = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GraphQL ${res.status}: ${body.slice(0, 200)}`);
    }
    return [await res.json()] as T[];
  };

  const rest = async (path: string): Promise<unknown> => {
    const headers = await authHeaders();
    const res = await fetchImpl(`https://api.github.com/${path}`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      throw new Error(`REST ${res.status} ${res.statusText} on ${path}`);
    }
    return res.json();
  };

  const restPaged = async (path: string): Promise<unknown[]> => {
    const headers = await authHeaders();
    const pages: unknown[] = [];
    let url: string | null = `https://api.github.com/${path}`;
    let guard = 0;
    while (url !== null && guard < 50) {
      const res: Response = await fetchImpl(url, {
        method: "GET",
        headers,
      });
      if (!res.ok) {
        throw new Error(
          `REST paged ${res.status} ${res.statusText} on ${path}`
        );
      }
      const data = (await res.json()) as unknown[];
      pages.push(data);
      const link: string | null = res.headers.get("Link");
      const next: string | undefined = link
        ?.split(",")
        .map((s: string) => s.trim())
        .find((s: string) => s.endsWith('rel="next"'));
      const m = next ? /<([^>]+)>/.exec(next) : null;
      url = m ? (m[1] ?? null) : null;
      guard++;
    }
    return pages;
  };

  return {
    graphql,
    rest,
    restPaged,
    authHeaders,
    installationId: () => installationId,
  };
}

/**
 * Publish a check run for the gate. `conclusion` is `success` / `failure`
 * / `neutral`; `text` is the multi-line gate output joined with newlines.
 *
 * Returns the new check run id.
 */
export async function createCheckRun(
  client: AuthedClient,
  owner: string,
  repo: string,
  args: {
    headSha: string;
    name: string;
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
    detailsUrl?: string;
  }
): Promise<number> {
  const body = {
    owner,
    repo,
    name: args.name,
    head_sha: args.headSha,
    status: "completed",
    conclusion: args.conclusion,
    output: {
      title: args.title,
      summary: args.summary.slice(0, 65000),
    },
    ...(args.detailsUrl ? { details_url: args.detailsUrl } : {}),
  };
  const headers = await client.authHeaders();
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `check-run create failed ${res.status}: ${txt.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as { id?: number };
  if (typeof data.id !== "number") {
    throw new Error("check-run create returned no id");
  }
  return data.id;
}
