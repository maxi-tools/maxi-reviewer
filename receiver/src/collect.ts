/**
 * Port of `collect-pr-review-state/action.yml`'s two GraphQL reads.
 *
 * Same queries, same page-cap (100), same `errors` array check, same jq
 * shaping into the payload that `evaluate()` consumes. Only the surface
 * changes: bash+gh+curl+jq -> a TypeScript fetch() and a JSON shape in
 * JavaScript instead of jq's pipeline. Comments lifted from the source of
 * truth and trimmed where the surface moved them out of view.
 */

const REVIEW_THREADS_QUERY = `
  query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        author{login}
        isDraft
        headRefName
        labels(first:100){nodes{name}}
        reviewThreads(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{
            isResolved
            isOutdated
            comments(first:1){nodes{author{login} path url}}
          }
        }
      }
    }
  }`;

const REVIEWS_QUERY = `
  query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviews(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{ author{login} state }
        }
      }
    }
  }`;

const ROSTER_CONTEXT = "review-roster";

export interface CollectionPayload {
  author: string | null;
  isDraft: boolean;
  headRefName: string | null;
  labels: string[];
  threads: Array<{
    isResolved: boolean;
    isOutdated: boolean;
    author: string | null;
    path: string | null;
    url: string | null;
  }>;
  reviews: Array<{
    author: string | null;
    state: string;
  }>;
  roster?: { asked: string[]; skipped: number };
}

export interface GitHubClient {
  /** Post a GraphQL query; throw if any page has .errors or no pullRequest. */
  graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T[]>;
  /** Get a single field by REST path (e.g. `repos/o/r/pulls/1` -> `head.sha`). */
  rest(path: string): Promise<unknown>;
  /** Paginate a REST endpoint that supports Link headers. */
  restPaged(path: string): Promise<unknown[]>;
}

const PAGE_SIZE = 100;

async function fetchAll<T extends object>(
  graphql: (q: string, vars: Record<string, unknown>) => Promise<T[]>,
  query: string,
  baseVars: Record<string, unknown>
): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | null = null;
  // Hard cap: 50 pages * 100 = 5k. A PR with more than 5k review threads
  // is a different shape of problem than this receiver was written for,
  // and unbounded loops in a Cloudflare Worker are a billable-footgun.
  for (let i = 0; i < 50; i++) {
    const vars: Record<string, unknown> = { ...baseVars, endCursor: cursor };
    const data: T[] = await graphql(query, vars);
    if (data.length === 0) break;
    pages.push(...data);
    // `data` here is an array of pages; the last page's
    // `pageInfo.hasNextPage` is what tells us to continue.
    const last = data[data.length - 1] as unknown as Record<string, unknown>;
    const dataField = last?.["data"] as Record<string, unknown> | undefined;
    const pullRequest = dataField?.["repository"] as
      Record<string, unknown> | undefined;
    const prRecord = pullRequest?.["pullRequest"] as
      Record<string, unknown> | undefined;
    const connection = (prRecord?.["reviewThreads"] ??
      prRecord?.["reviews"]) as Record<string, unknown> | undefined;
    const pageInfo = connection?.["pageInfo"] as
      { hasNextPage: boolean; endCursor: string | null } | undefined;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  if (pages.length >= 50) {
    throw new Error(
      `paginated past 50 pages (${pages.length * PAGE_SIZE}+ records) — refusing to judge`
    );
  }
  return pages;
}

export async function collect(
  gh: GitHubClient,
  owner: string,
  repo: string,
  pr: number
): Promise<CollectionPayload> {
  // Both queries paginate. A reviewThreads page caps at 100, and a busy
  // PR exceeds that; judging only the first page would report a clean
  // PR while later pages held unresolved conversations — the exact shape
  // of failure this gate exists to prevent.
  const threadPages = await fetchAll<{
    data?: { repository?: { pullRequest?: Record<string, unknown> } };
    errors?: unknown[];
  }>(gh.graphql, REVIEW_THREADS_QUERY, { owner, repo, pr });

  const reviewPages = await fetchAll<{
    data?: { repository?: { pullRequest?: Record<string, unknown> } };
    errors?: unknown[];
  }>(gh.graphql, REVIEWS_QUERY, { owner, repo, pr });

  // Assert both queries actually returned a pull request. A missing field
  // would otherwise flow onward as an empty list, presenting a PR full of
  // unresolved threads as having none.
  const pairs: Array<[string, unknown[]]> = [
    ["threads", threadPages as unknown[]],
    ["reviews", reviewPages as unknown[]],
  ];
  for (const [name, pages] of pairs) {
    for (const page of pages) {
      const errors = (page as Record<string, unknown>).errors as
        unknown[] | undefined;
      if (errors && errors.length > 0) {
        throw new Error(
          `${name} GraphQL returned errors: ${JSON.stringify(errors)}`
        );
      }
      const pr1 = (page as Record<string, unknown>)?.["data"];
      if (pr1 == null) {
        throw new Error(`${name} GraphQL page has no pullRequest`);
      }
      void pr1;
    }
  }

  // Fetch the PR's HEAD SHA so the roster status can be looked up.
  // `review-roster` is a commit status, not a pull-request property.
  const prRest = (await gh.rest(`repos/${owner}/${repo}/pulls/${pr}`)) as {
    head?: { sha?: string };
  };
  const headSha = prRest.head?.sha;
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error(`could not determine head SHA for PR #${pr}`);
  }

  // Fetch all commit statuses for the head SHA. Newest first; repeated
  // contexts are deduplicated by .context in the selector below.
  //
  // FAILS OPEN on a roster lookup failure: the gate has an explicit
  // `roster=absent` fallback, and an unreadable status endpoint must
  // not strand every gate run on a transient API blip.
  let rosterDescription = "";
  try {
    const statuses = await gh.restPaged(
      `repos/${owner}/${repo}/commits/${headSha}/statuses?per_page=100`
    );
    // Newest first; take the first match on `context`.
    for (const page of statuses) {
      const list = page as Array<{
        context?: string;
        description?: string;
      }>;
      for (const s of list) {
        if (s.context === ROSTER_CONTEXT) {
          rosterDescription = s.description ?? "";
          break;
        }
      }
      if (rosterDescription !== "") break;
    }
  } catch {
    // Fail-open per the comment above.
    rosterDescription = "";
  }

  // Flatten the thread pages, pulling only the fields the gate consumes.
  const flatThreads = threadPages.flatMap((page) => {
    const p = page as unknown as Record<string, unknown>;
    const dataField = p?.["data"] as Record<string, unknown> | undefined;
    const repo = dataField?.["repository"] as
      Record<string, unknown> | undefined;
    const tp = repo?.["pullRequest"] as Record<string, unknown> | undefined;
    const threads = tp?.["reviewThreads"] as { nodes?: unknown[] } | undefined;
    return (threads?.["nodes"] ?? []) as Array<Record<string, unknown>>;
  });
  const threads = flatThreads.map((th) => {
    const comments = th.comments as { nodes?: Array<Record<string, unknown>> };
    const c = comments?.nodes?.[0] ?? {};
    const author = c.author as { login?: string } | undefined;
    return {
      isResolved: th.isResolved === true,
      isOutdated: th.isOutdated === true,
      author: (author?.login ?? null) as string | null,
      path: (c.path ?? null) as string | null,
      url: (c.url ?? null) as string | null,
    };
  });

  // Flatten the review pages.
  const flatReviews = reviewPages.flatMap((page) => {
    const p = page as unknown as Record<string, unknown>;
    const dataField = p?.["data"] as Record<string, unknown> | undefined;
    const repo = dataField?.["repository"] as
      Record<string, unknown> | undefined;
    const tp = repo?.["pullRequest"] as Record<string, unknown> | undefined;
    const reviews = tp?.["reviews"] as { nodes?: unknown[] } | undefined;
    return (reviews?.["nodes"] ?? []) as Array<Record<string, unknown>>;
  });
  const reviews = flatReviews.map((rv) => {
    const author = rv.author as { login?: string } | undefined;
    return {
      author: (author?.login ?? null) as string | null,
      state: (rv.state ?? "") as string,
    };
  });

  const head0 = threadPages[0] as unknown as
    Record<string, unknown> | undefined;
  const headData = head0?.["data"] as Record<string, unknown> | undefined;
  const headRepo = headData?.["repository"] as
    Record<string, unknown> | undefined;
  const headPr = headRepo?.["pullRequest"] as
    Record<string, unknown> | undefined;
  const author = headPr?.["author"] as { login?: string } | undefined;
  const isDraft = headPr?.["isDraft"] === true;
  const headRefName = (headPr?.["headRefName"] ?? null) as string | null;
  const labelsRaw = headPr?.["labels"] as
    { nodes?: Array<{ name?: string }> } | undefined;
  const labels = (labelsRaw?.["nodes"] ?? [])
    .map((n) => n.name)
    .filter((s): s is string => typeof s === "string");

  const payload: CollectionPayload = {
    author: author?.login ?? null,
    isDraft,
    headRefName,
    labels,
    threads,
    reviews,
  };

  // Embed the parsed roster (or its absence) into the payload.
  if (rosterDescription !== "") {
    // Parse inline rather than importing the evaluator's parseRoster —
    // we want this module to be safe to use from contexts that don't
    // need the full evaluator (e.g. a heartbeat probe).
    const roster = parseRosterDescription(rosterDescription);
    if (roster !== null) {
      payload.roster = roster;
    }
  }

  return payload;
}

import { parseRoster as parseRosterDescription } from "./evaluate.js";
