import * as core from "@actions/core";
import { LinkedIssue } from "./types.js";

/** A parsed reference to an issue a PR declares it will close. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * GitHub closing keywords. Matched case-insensitively, optionally followed by a
 * colon, then whitespace, then the issue reference. Mirrors the set GitHub uses
 * to auto-close issues on merge.
 * https://docs.github.com/articles/closing-issues-using-keywords
 */
const CLOSING_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
].join("|");

// keyword <ws> [owner/repo]#123  — owner/repo optional (defaults to current repo)
const SHORTHAND_RE = new RegExp(
  String.raw`\b(?:${CLOSING_KEYWORDS})\b\s*:?\s+(?:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+))?#(\d+)`,
  "gi"
);

// keyword <ws> https://github.com/owner/repo/issues/123
const URL_RE = new RegExp(
  String.raw`\b(?:${CLOSING_KEYWORDS})\b\s*:?\s+https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)`,
  "gi"
);

/**
 * Parse closing-keyword issue references out of a PR body.
 *
 * Cross-repo references are dropped: we only fetch issues from the PR's own
 * repository, both to avoid using the workflow token against unexpected repos
 * and because cross-repo acceptance criteria are rarely the review's intent.
 * The PR body is attacker-controlled, but this function only extracts integer
 * issue numbers — the fetched text is nonce-fenced as UNTRUSTED downstream.
 */
export function parseClosingIssueRefs(
  body: string | null | undefined,
  current: { owner: string; repo: string }
): IssueRef[] {
  if (!body) return [];
  const out: IssueRef[] = [];
  const seen = new Set<number>();
  const push = (owner: string, repo: string, num: number): void => {
    // Same-repo only (case-insensitive owner/repo match).
    if (
      owner.toLowerCase() !== current.owner.toLowerCase() ||
      repo.toLowerCase() !== current.repo.toLowerCase()
    ) {
      return;
    }
    if (num <= 0 || seen.has(num)) return;
    seen.add(num);
    out.push({ owner: current.owner, repo: current.repo, number: num });
  };

  // Collect matches from both forms, then order them by position in the body so
  // the first-seen issue wins when refs exceed the fetch cap, regardless of
  // whether each ref was written as a URL or as #n / owner/repo#n shorthand.
  const matches: {
    index: number;
    owner: string;
    repo: string;
    number: number;
  }[] = [];
  for (const m of body.matchAll(URL_RE)) {
    matches.push({
      index: m.index ?? 0,
      owner: m[1],
      repo: m[2],
      number: Number(m[3]),
    });
  }
  for (const m of body.matchAll(SHORTHAND_RE)) {
    matches.push({
      index: m.index ?? 0,
      owner: m[1] ?? current.owner,
      repo: m[2] ?? current.repo,
      number: Number(m[3]),
    });
  }
  matches.sort((a, b) => a.index - b.index);
  for (const m of matches) push(m.owner, m.repo, m.number);
  return out;
}

export interface FetchLinkedIssuesOptions {
  /** Maximum number of issues to fetch (refs beyond this are ignored). */
  maxIssues?: number;
  /** Per-issue body character cap; longer bodies are truncated and flagged. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_ISSUES = 5;
const DEFAULT_MAX_BODY_CHARS = 8000;

/**
 * Fetch the title/body/state of each referenced issue. Failures (deleted issue,
 * a PR number mistaken for an issue, missing permission) are logged and skipped
 * rather than failing the review. Bodies are capped and truncation is flagged so
 * the downstream prompt can say so.
 */
/**
 * The slice of the Octokit client this module needs: reading a single issue.
 * Narrowing the dependency to this structural type lets tests pass a typed
 * fake without bypassing the type system, while the full client returned by
 * github.getOctokit still satisfies it.
 */
export interface IssueReadClient {
  rest: {
    issues: {
      get: (params: {
        owner: string;
        repo: string;
        issue_number: number;
      }) => Promise<{
        data: {
          title?: string | null;
          body?: string | null;
          state?: string;
          pull_request?: unknown;
        };
      }>;
    };
  };
}

export async function fetchLinkedIssues(
  octokit: IssueReadClient,
  refs: IssueRef[],
  options: FetchLinkedIssuesOptions = {}
): Promise<LinkedIssue[]> {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const selected = refs.slice(0, maxIssues);

  const results = await Promise.all(
    selected.map(async (ref): Promise<LinkedIssue | null> => {
      try {
        const res = await octokit.rest.issues.get({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: ref.number,
        });
        const data = res.data;
        // pulls.get and issues.get share a number space; a closing ref to a PR
        // is not an acceptance-criteria source, so drop it.
        if (data.pull_request) return null;
        const rawBody = data.body ?? "";
        const truncated = rawBody.length > maxBodyChars;
        return {
          number: ref.number,
          title: data.title ?? "",
          body: truncated ? rawBody.slice(0, maxBodyChars) : rawBody,
          state: data.state === "closed" ? "closed" : "open",
          truncated,
        };
      } catch (err) {
        core.warning(
          `Failed to fetch linked issue #${ref.number}: ${String(err)}`
        );
        return null;
      }
    })
  );

  return results.filter((r): r is LinkedIssue => r !== null);
}
