/**
 * Scheduled harvest runner for the per-reviewer calibration profile. The
 * GitHub-side harvesting that `src/calibration.ts`'s docstring defers lives
 * here: walk the org's merged/closed PRs in a window, pull inline review
 * thread states and the commits that landed between each thread's first
 * comment and the PR's merge/close, and feed the observations into the pure
 * classifier in `src/reviewer-profile.ts`.
 *
 * Entry points:
 *   - runScheduledHarvest(): used by .github/workflows/calibration-harvest.yml.
 *   - harvest(...): the harvester itself, exposed for tests.
 *   - listPullsInWindow / listReviewThreads / listChangedPathsAfter: the
 *     three paginated GraphQL walks the harvester composes.
 */

import * as github from "@actions/github";
import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import {
  aggregateReviewerProfiles,
  BotReviewer,
  InlineReviewFinding,
  isBotReviewer,
  pathGroupFor,
  ReviewerProfiles,
} from "./reviewer-profile.js";
import {
  CalibrationInput,
  CalibrationReport,
  ingestCalibration,
} from "./calibration.js";
import { extractReviewArtifact } from "./review-command.js";
import { listReviewArtifactComments } from "./github.js";

interface GraphqlPullsPage {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      number: number;
      title: string;
      url: string;
      mergedAt: string | null;
      closedAt: string | null;
      updatedAt: string;
      repository: { nameWithOwner: string };
    }>;
  };
}

interface GraphqlThreadPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: {
            nodes: Array<{
              author: { login: string } | null;
              createdAt: string;
              databaseId: number;
            }>;
          };
        }>;
      };
    };
  } | null;
}

interface GraphqlCommitPathsPage {
  repository: {
    pullRequest: {
      commits: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          commit: {
            oid: string;
            authoredDate: string;
            committedDate: string;
          };
        }>;
      };
    };
  } | null;
}

const PULLS_QUERY = /* GraphQL */ `
  query HarvestPulls($searchQuery: String!, $first: Int!, $cursor: String) {
    search(query: $searchQuery, type: ISSUE, first: $first, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          number
          title
          url
          mergedAt
          closedAt
          updatedAt
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

const THREADS_QUERY = /* GraphQL */ `
  query HarvestThreads(
    $owner: String!
    $name: String!
    $pr: Int!
    $first: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: $first, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 1) {
              nodes {
                author {
                  login
                }
                createdAt
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

const COMMIT_PATHS_QUERY = /* GraphQL */ `
  query HarvestCommitPaths(
    $owner: String!
    $name: String!
    $pr: Int!
    $first: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        commits(first: $first, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            commit {
              oid
              authoredDate
              committedDate
            }
          }
        }
      }
    }
  }
`;

export interface CollectFindingsOptions {
  /** Maximum PRs to harvest. Defaults to 500. */
  maxPulls?: number;
  /** Maximum review threads per PR to inspect. */
  maxThreadsPerPull?: number;
  /** Maximum commits to walk on a PR's history. */
  maxCommitsPerPull?: number;
  /** Maximum touched paths to keep per PR. */
  maxTouchedPathsPerPull?: number;
}

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
  /** ISO-8601 timestamp of the merge or close event. */
  terminusAt: string;
  updatedAt: string;
}

async function paginate<
  T,
  Page extends { pageInfo: { hasNextPage: boolean; endCursor: string | null } },
>(
  fetcher: (cursor: string | null) => Promise<Page>,
  extractNodes: (page: Page) => T[],
  limit: number
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  while (out.length < limit) {
    const page = await fetcher(cursor);
    out.push(...extractNodes(page));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (cursor === null) break;
  }
  return out.slice(0, limit);
}

/**
 * Walk the org's merged/closed pull requests in the trailing window. The
 * search query narrows on `is:pr` and the merge/close date so we don't
 * enumerate every open PR in the org just to filter server-side.
 *
 * The OR's two sides MUST each be parenthesised individually. The shape
 * `(a OR b)` — even though parens balance — returns zero results, because
 * GitHub search's OR requires the entire OR-branch on each side to be
 * wrapped, not the disjunction as a whole. The working form is
 * `is:pr (merged:>=X) OR (closed:>=X)` — the `is:pr` is hoisted out so
 * it applies to both branches; a disjunction like
 * `(is:pr merged:>=X) OR (is:pr closed:>=X)` returns zero because the
 * left-most qualifier scope differs between branches and the parser
 * rejects it. Verified against `search(type: ISSUE)` directly, not
 * through this client.
 */
export async function listPullsInWindow(
  octokit: ReturnType<typeof github.getOctokit>,
  org: string,
  windowDays: number,
  maxPulls: number
): Promise<PullRef[]> {
  const date = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const searchQuery =
    "org:" +
    org +
    " is:pr is:closed (merged:>=" +
    date +
    ") OR (closed:>=" +
    date +
    ") sort:updated-desc";

  const pulls = await paginate(
    async (cursor) => {
      // `query` is reserved by @octokit/graphql as the document key; pass
      // the GraphQL variable under its declared name (`$searchQuery`) so
      // the library doesn't throw `cannot be used as variable name`.
      const response = (await octokit.graphql(PULLS_QUERY, {
        searchQuery,
        first: 50,
        cursor,
      })) as GraphqlPullsPage;
      return response.search;
    },
    (search) => search.nodes,
    maxPulls
  );

  return pulls.map((p) => {
    const [owner, repo] = p.repository.nameWithOwner.split("/");
    return {
      owner,
      repo,
      number: p.number,
      terminusAt: p.mergedAt ?? p.closedAt ?? p.updatedAt,
      updatedAt: p.updatedAt,
    };
  });
}

export interface ReviewThreadRef {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  firstAuthor: string | null;
  createdAt: string | null;
}

/**
 * Walk the review threads on one PR. The GraphQL pagination caps at 100 per
 * page; most PRs have well under that, but high-traffic repos can blow past.
 */
export async function listReviewThreads(
  octokit: ReturnType<typeof github.getOctokit>,
  pull: PullRef,
  maxThreads: number
): Promise<ReviewThreadRef[]> {
  const threads = await paginate(
    async (cursor) => {
      const response = (await octokit.graphql(THREADS_QUERY, {
        owner: pull.owner,
        name: pull.repo,
        pr: pull.number,
        first: 100,
        cursor,
      })) as GraphqlThreadPage;
      return (
        response.repository?.pullRequest?.reviewThreads ?? {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        }
      );
    },
    (conn) =>
      conn.nodes.map((node) => ({
        id: node.id,
        isResolved: node.isResolved,
        path: node.path,
        line: node.line,
        firstAuthor: node.comments.nodes[0]?.author?.login ?? null,
        createdAt: node.comments.nodes[0]?.createdAt ?? null,
      })),
    maxThreads
  );
  return threads;
}

/**
 * `repos.getCommit` caps a single response at 300 files. 100 per page keeps
 * each response small; 30 pages is 3000 files, far past any real commit, so
 * reaching the limit means something pathological rather than large.
 */
const COMMIT_FILE_PAGE_SIZE = 100;
const COMMIT_FILE_PAGE_LIMIT = 30;

export interface CommitPaths {
  oid: string;
  committedDate: string;
  paths: string[];
  /**
   * Whether `paths` is a real observation for this commit.
   *
   * `false` means the per-commit file list could not be fetched, so an empty
   * `paths` means "we could not look". Callers must not read it as "this
   * commit touched nothing".
   */
  pathsKnown: boolean;
}

export interface CommitWalk {
  /** Reverse-chronological, newest first. */
  commits: CommitPaths[];
  /**
   * `false` when any commit in the window is missing its file list, or the
   * walk stopped early against a cap. A finding derived from an incomplete
   * walk is classified `unknown` rather than `dismissed`.
   */
  complete: boolean;
}

/**
 * Every changed path on one commit, following the REST pagination.
 *
 * `repos.getCommit` returns at most 300 files in a single response and puts
 * the rest behind `Link: rel="next"`. Reading only the first page and then
 * calling the result known records an incomplete page as a complete record:
 * a bot comment on a file that landed on page two classifies as `dismissed`
 * rather than `accepted` — the same "partial result published as data" that
 * #133 is about, one API boundary further down.
 *
 * Returns `known: false` when the page limit is reached on a full page,
 * i.e. more files exist than this is willing to read. Extracted from
 * `listCommitsAfter` so the paging has its own seam: it is the part that
 * carried the bug, so it is the part worth being able to test alone.
 */
export async function listCommitFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  pull: PullRef,
  oid: string
): Promise<{ paths: string[]; known: boolean }> {
  const paths: string[] = [];
  for (let page = 1; page <= COMMIT_FILE_PAGE_LIMIT; page += 1) {
    const { data } = await octokit.rest.repos.getCommit({
      owner: pull.owner,
      repo: pull.repo,
      ref: oid,
      per_page: COMMIT_FILE_PAGE_SIZE,
      page,
    });
    const files = data.files ?? [];
    for (const f of files) paths.push(f.filename);
    if (files.length < COMMIT_FILE_PAGE_SIZE) return { paths, known: true };
  }
  // Fell out of the loop on a full page: more files exist than we read.
  core.warning(
    `harvest: commit ${oid.slice(0, 8)} on ${pull.owner}/${pull.repo}#${pull.number} has more than ` +
      `${COMMIT_FILE_PAGE_LIMIT * COMMIT_FILE_PAGE_SIZE} changed files; its path list is truncated`
  );
  return { paths, known: false };
}

/**
 * Walk the commits on this PR, returning `{oid, committedDate, paths}` in
 * reverse-chronological order.
 *
 * TWO APIs, deliberately. GraphQL supplies the commit list — it paginates
 * cleanly and gives `committedDate`, which is what slices the window. It
 * CANNOT supply the changed paths: `Commit.changedFilesIfAvailable` is an
 * `Int` (a count, null when GitHub cannot compute it), not a connection, and
 * `Commit` exposes no per-commit file list at all. Confirmed by introspecting
 * the live schema: the only file-ish fields are `changedFiles: Int!`,
 * `changedFilesIfAvailable: Int`, `file(path:): TreeEntry` (one path in the
 * tree, not a diff) and `tree`.
 *
 * This code used to select `changedFilesIfAvailable(first: 100) { nodes { path } }`,
 * which the server rejects outright:
 *
 *     Selections can't be made on scalars
 *     (field 'changedFilesIfAvailable' returns Int but has selections ["nodes"])
 *
 * The whole document failed, every commit walk threw, the caller downgraded
 * it to a warning, and `paths` was empty for every finding on every PR — so
 * `accepted` was unreachable and all seven reviewers reported a 0% accept
 * rate over a 270-PR window (#133).
 *
 * So paths come from REST `repos.getCommit`, which returns `files[].filename`.
 * That is one request per commit, so the walk is bounded twice: only commits
 * at or after `since` (the earliest bot thread on the PR — an older commit
 * cannot be "after" any thread and its paths are never consulted) and never
 * more than `maxCommits`.
 */
export async function listCommitsAfter(
  octokit: ReturnType<typeof github.getOctokit>,
  pull: PullRef,
  maxTouchedPaths: number,
  maxCommits: number,
  since: string | null = null
): Promise<CommitWalk> {
  const listed: Array<{ oid: string; committedDate: string }> = [];
  let cursor: string | null = null;
  let complete = true;

  // 1. The commit list, from GraphQL.
  while (listed.length < maxCommits) {
    const response = (await octokit.graphql(COMMIT_PATHS_QUERY, {
      owner: pull.owner,
      name: pull.repo,
      pr: pull.number,
      first: 50,
      cursor,
    })) as GraphqlCommitPathsPage;
    const conn = response.repository?.pullRequest?.commits;
    if (!conn) {
      complete = false;
      break;
    }
    for (const node of conn.nodes) {
      if (listed.length >= maxCommits) {
        // Nodes remain on THIS page that we are not taking. Recorded here,
        // before any break: the previous version only flagged truncation
        // after the `hasNextPage` test, so hitting the cap mid-page on the
        // LAST page dropped commits while still reporting `complete = true`.
        complete = false;
        break;
      }
      listed.push({
        oid: node.commit.oid,
        committedDate: node.commit.committedDate,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (cursor === null) {
      // `hasNextPage` with no cursor: more commits exist and there is no way
      // to reach them. Truncated, not finished.
      complete = false;
      break;
    }
    if (listed.length >= maxCommits) {
      // More commits exist than we are willing to walk. Say so rather than
      // letting a truncated list read as the whole history.
      complete = false;
      break;
    }
  }

  // Newest first, so the per-thread filter can stop at the first commit
  // older than the thread it is accumulating for.
  listed.sort((a, b) => (a.committedDate < b.committedDate ? 1 : -1));

  // 2. The paths, from REST — only for commits that can matter.
  const commits: CommitPaths[] = [];
  let touchedPaths = 0;
  for (const entry of listed) {
    if (since !== null && entry.committedDate < since) {
      // Older than every thread on this PR: its paths are never consulted,
      // so spending a request on it would be waste, not caution.
      commits.push({ ...entry, paths: [], pathsKnown: true });
      continue;
    }
    if (touchedPaths >= maxTouchedPaths) {
      commits.push({ ...entry, paths: [], pathsKnown: false });
      complete = false;
      continue;
    }
    try {
      const { paths, known } = await listCommitFiles(octokit, pull, entry.oid);
      if (!known) complete = false;
      commits.push({ ...entry, paths, pathsKnown: known });
      touchedPaths += paths.length;
    } catch (err) {
      // One unreachable commit must not silently become "touched nothing".
      core.warning(
        `harvest: commit ${entry.oid.slice(0, 8)} on ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
      );
      commits.push({ ...entry, paths: [], pathsKnown: false });
      complete = false;
    }
  }

  return { commits, complete };
}

export interface HarvestResult {
  findings: InlineReviewFinding[];
  /** Per-rule / per-severity / per-path calibration report from `calibration.ts`. */
  calibration: CalibrationReport;
  /** How many maxi-reviewer `maxi.review.v1.review-artifact` payloads we successfully harvested. */
  artifactsObserved: number;
  /** PRs whose commit walk did not complete. Their findings are `unknown`. */
  degradedPulls: number;
  /**
   * PRs read successfully that merged or closed with NO commit after their
   * first bot comment, so no finding on them could be actioned. Their
   * findings are `unknown` too, but for the opposite reason to
   * `degradedPulls`: not a failure to measure, an absence of anything to
   * measure. Reported separately so the fan-out share of the corpus is
   * visible in every run.
   */
  unamendablePulls: number;
  /** PRs that contributed at least one bot finding. */
  observedPulls: number;
}

/**
 * End-to-end harvester: walk the org's PRs, walk their threads, walk the
 * commits that landed between each thread's creation and the PR's merge, and
 * emit observations for the pure classifier. Also harvests
 * `maxi.review.v1.review-artifact` payloads from each PR so the existing
 * `calibration.ts` engine produces a per-rule / per-severity / per-path report
 * for maxi-reviewer.
 *
 * The touched-paths set for each finding is filtered by that thread's own
 * `createdAt`. Using a single PR-wide earliest date (as the original draft
 * did) risked marking threads accepted by commits that landed before the
 * thread was opened.
 */
export async function harvest(
  octokit: ReturnType<typeof github.getOctokit>,
  org: string,
  windowDays: number,
  options: CollectFindingsOptions = {}
): Promise<HarvestResult> {
  const maxPulls = options.maxPulls ?? 500;
  const maxThreadsPerPull = options.maxThreadsPerPull ?? 200;
  const maxCommitsPerPull = options.maxCommitsPerPull ?? 200;
  const maxTouchedPathsPerPull = options.maxTouchedPathsPerPull ?? 2000;

  const pulls = await listPullsInWindow(octokit, org, windowDays, maxPulls);
  core.info(`harvest: scanning ${pulls.length} merged/closed PRs in ${org}`);

  const findings: InlineReviewFinding[] = [];
  const calibrationInputs: CalibrationInput[] = [];
  let artifactsObserved = 0;
  let degradedPulls = 0;
  let unamendablePulls = 0;
  let observedPulls = 0;
  let pullIndex = 0;
  for (const pull of pulls) {
    pullIndex += 1;
    let threads: ReviewThreadRef[];
    try {
      threads = await listReviewThreads(octokit, pull, maxThreadsPerPull);
    } catch (err) {
      core.warning(
        `harvest: threads fetch failed for ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
      );
      // Counted as observed AND degraded. A `continue` alone incremented
      // nothing, so a threads leg that failed on every PR -- an expired App
      // token, a revoked `pull_requests: read` -- produced zero findings,
      // zero unknowns, and an all-zero profile that the all-degraded guard
      // below never saw. The commits leg had this covered; this one did not.
      observedPulls += 1;
      degradedPulls += 1;
      continue;
    }

    const botThreads = threads.filter(
      (t) => t.firstAuthor && isBotReviewer(t.firstAuthor)
    );
    if (botThreads.length === 0) continue;
    observedPulls += 1;
    core.info(
      `harvest: PR ${pullIndex}/${pulls.length} ${pull.owner}/${pull.repo}#${pull.number}: ${botThreads.length} bot threads`
    );

    // Walk the PR's commits once, then slice per thread. The list is
    // reverse-chronological, so the per-thread filter stops at the first
    // commit older than the thread it is accumulating for.
    //
    // Walk for EVERY PR that has bot threads, not just those with an
    // unresolved one. A resolved thread still needs the commit list to tell
    // `accepted` (the author pushed a fix, then closed the thread) from
    // `dismissed` (closed with no commit touching the file) — and since the
    // merge rules require threads to be resolved before merging, gating the
    // walk on an unresolved thread made `accepted` unreachable for nearly
    // every merged PR.
    //
    // `since` is the earliest bot thread on this PR: no commit older than
    // that can be "after" any thread here, so its paths are never consulted
    // and fetching them would be waste. This is what keeps the REST leg
    // bounded.
    const threadDates = botThreads
      .map((t) => t.createdAt)
      .filter((d): d is string => Boolean(d));
    const since =
      threadDates.length > 0
        ? threadDates.reduce((a, b) => (a < b ? a : b))
        : null;

    let walk: CommitWalk = { commits: [], complete: false };
    try {
      walk = await listCommitsAfter(
        octokit,
        pull,
        maxTouchedPathsPerPull,
        maxCommitsPerPull,
        since
      );
    } catch (err) {
      // The findings from this PR are still recorded, but as `unknown`:
      // a failed walk must not be published as "nothing was touched".
      core.warning(
        `harvest: commits fetch failed for ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
      );
      walk = { commits: [], complete: false };
    }
    // `degraded` is decided AFTER the findings, on whether this PR yielded
    // any known outcome -- not on `walk.complete`. A truncated walk that
    // still closed every thread's slice taught us everything we needed, and
    // counting it as degraded made a single-PR harvest of exactly that shape
    // trip the all-degraded guard and throw.

    function touchedPathsAfterThread(thread: ReviewThreadRef): {
      paths: string[];
      known: boolean;
      /**
       * Commits dated after the thread. Counted rather than inferred from
       * `paths` being empty: a commit whose file list is empty would leave
       * `paths` empty while a commit really did land, and the difference
       * decides whether a finding is measurable at all.
       */
      commitCount: number;
    } {
      if (!thread.createdAt) return { paths: [], known: false, commitCount: 0 };
      const out: string[] = [];
      let commitCount = 0;
      // commits is reverse-chronological; once we see a commit dated
      // before the thread, no later commit is older, so we stop walking.
      for (const c of walk.commits) {
        if (c.committedDate < thread.createdAt) {
          // The slice is CLOSED: we found a commit older than the thread, so
          // everything after it is already in `out`. That is a complete
          // answer for THIS thread even if the walk was truncated further
          // back in history -- truncation drops the oldest commits, which by
          // definition cannot be after a thread we have already passed.
          //
          // Bailing on `!walk.complete` up front (as this did) threw away
          // every thread on a large PR, including recent ones whose commits
          // were all present.
          return { paths: out, known: true, commitCount };
        }
        if (!c.pathsKnown) return { paths: [], known: false, commitCount: 0 };
        commitCount += 1;
        for (const p of c.paths) {
          out.push(p);
        }
      }
      // Ran off the end without closing the slice. If the walk was truncated,
      // a commit after this thread may be among the ones we never fetched.
      return walk.complete
        ? { paths: out, known: true, commitCount }
        : { paths: [], known: false, commitCount: 0 };
    }

    let knownHere = 0;
    let addedHere = 0;
    let amendableHere = 0;
    for (const thread of botThreads) {
      const reviewer = thread.firstAuthor;
      if (!reviewer || !isBotReviewer(reviewer)) continue;
      const path = thread.path ?? "";
      const touched = touchedPathsAfterThread(thread);
      addedHere += 1;
      if (touched.known) knownHere += 1;
      if (touched.known && touched.commitCount > 0) amendableHere += 1;
      findings.push({
        reviewer: reviewer as BotReviewer,
        repo: `${pull.owner}/${pull.repo}`,
        prNumber: pull.number,
        path,
        line: thread.line ?? 0,
        threadResolved: thread.isResolved,
        subsequentTouchedPaths: touched.paths,
        touchedPathsKnown: touched.known,
        subsequentCommitCount: touched.commitCount,
      });
    }
    // Degraded means this PR taught us NOTHING -- every finding unknown --
    // which is the state the all-degraded guard exists to catch. A PR that
    // answered some threads and not others is partial, not blind.
    if (addedHere > 0 && knownHere === 0) degradedPulls += 1;
    // Counted SEPARATELY from degraded, because they are different facts and
    // the difference is the whole point. A degraded PR is one we failed to
    // read. An un-amendable one we read perfectly: it merged with no commit
    // after its first bot comment, so there was never an opportunity for a
    // finding to be actioned. Both yield outcome=unknown; only one is a
    // defect. Reporting them in a single number would make a healthy harvest
    // of fan-out traffic look like a broken one -- and, worse, would make the
    // fan-out share invisible, which is how it went unnoticed until the rates
    // had already decayed.
    //
    // `knownHere === addedHere`, not `knownHere > 0`: EVERY finding on the
    // PR has to be a real observation before the PR as a whole can be called
    // un-amendable. A PR with one known zero-commit finding and one finding
    // whose commit walk failed satisfies `knownHere > 0`, but the failed one
    // may well have had later commits we never saw -- so calling the PR
    // un-amendable would be a whole-PR verdict drawn from a partial read.
    // That is the defect this PR exists to fix, one level up, in the counter
    // added to measure it. Found in review by coderabbitai.
    if (addedHere > 0 && knownHere === addedHere && amendableHere === 0) {
      unamendablePulls += 1;
    }

    // Calibration harvest: pull maxi-reviewer's `review-artifact` comments off
    // this PR, decode them, and feed each into `calibration.ts`. The thread
    // states we already walked above feed the same engine.
    try {
      const artifactBodies = await listReviewArtifactComments(
        octokit,
        pull.owner,
        pull.repo,
        pull.number
      );
      for (const body of artifactBodies) {
        const artifact = extractReviewArtifact(body);
        if (
          !artifact ||
          typeof (artifact as { repoFullName?: unknown }).repoFullName !==
            "string"
        ) {
          continue;
        }
        const threadStates = threads.map((t) => ({
          path: t.path ?? "",
          line: t.line ?? 0,
          resolved: t.isResolved,
        }));
        calibrationInputs.push({
          artifact: artifact as CalibrationInput["artifact"],
          threads: threadStates,
        });
        artifactsObserved += 1;
      }
    } catch (err) {
      core.warning(
        `harvest: artifact fetch failed for ${pull.owner}/${pull.repo}#${pull.number}: ${String(err)}`
      );
    }
  }

  const { report: calibration, excluded } =
    ingestCalibration(calibrationInputs);
  core.info(
    `harvest: calibration report produced ${calibration.byRule.length} rule groups, ${calibration.bySeverity.length} severity groups, ${calibration.byPath.length} path groups from ${artifactsObserved} artifacts (${excluded.length} excluded)`
  );

  // A harvest that could not measure anything must not look like a harvest
  // that measured zero. #133 published a profile asset reading 0% for all
  // seven reviewers while every commit fetch was failing, and the job was
  // green throughout — the failures were warnings and the empty result was
  // indistinguishable from real data.
  if (degradedPulls > 0) {
    core.warning(
      `harvest: ${degradedPulls}/${observedPulls} PRs had an incomplete commit walk; ` +
        "their findings are recorded as outcome=unknown and excluded from every accept rate"
    );
  }
  if (observedPulls > 0 && degradedPulls === observedPulls) {
    // Not a warning. Every single PR failed, so the accept rates are
    // vacuous and publishing them would put a table of zeroes in front of
    // the router as though it were evidence.
    throw new Error(
      `harvest: the commit walk failed on all ${observedPulls} PRs with bot threads. ` +
        "Every accept rate would be computed from zero observations, so this is a " +
        "failed harvest, not an empty one. See the warnings above for the cause."
    );
  }
  // Info, not a warning: this is the corpus being what it is, not anything
  // going wrong. It is printed on EVERY run, including at zero, because the
  // number is only useful as a trend -- a reader comparing two harvests needs
  // to know how much of each window was measurable before comparing the
  // rates. 41% of the merged corpus was un-amendable fan-out traffic when
  // this was written, and nothing said so.
  core.info(
    `harvest: ${unamendablePulls}/${observedPulls} PRs merged or closed with no commit after their ` +
      "first bot comment; their findings are outcome=unknown because no finding on them " +
      "could have been actioned (fan-out PRs are un-amendable by construction)"
  );

  return {
    findings,
    calibration,
    artifactsObserved,
    degradedPulls,
    unamendablePulls,
    observedPulls,
  };
}

export interface RunHarvestOptions {
  outPath: string;
  /** Optional second output path for the calibration.ts report (maxi-reviewer own-artifacts). */
  calibrationOutPath?: string;
  org: string;
  windowDays: number;
  maxPulls?: number;
  token: string;
}

export interface RunHarvestResult {
  profiles: ReviewerProfiles;
  calibration: CalibrationReport;
  artifactsObserved: number;
  /** PRs whose commit walk did not complete. See HarvestResult. */
  degradedPulls: number;
  /** PRs with no commit after the first bot comment. See HarvestResult. */
  unamendablePulls: number;
  observedPulls: number;
}

export async function runScheduledHarvest(
  options: RunHarvestOptions
): Promise<RunHarvestResult> {
  const octokit = github.getOctokit(options.token, {
    throttle: {
      retries: 3,
      onRateLimit: () => true,
      onSecondaryRateLimit: () => true,
    },
  });
  const result = await harvest(octokit, options.org, options.windowDays, {
    maxPulls: options.maxPulls,
  });
  const profiles = aggregateReviewerProfiles(
    result.findings,
    new Date().toISOString(),
    options.windowDays
  );

  const totalSamples = Object.values(profiles.reviewers).reduce(
    (sum, stats) => sum + stats.overall.n,
    0
  );
  const reviewersWithSamples = Object.values(profiles.reviewers).filter(
    (stats) => stats.overall.n > 0
  ).length;
  const totalUnknown = Object.values(profiles.reviewers).reduce(
    (sum, stats) => sum + stats.overall.unknownN,
    0
  );
  core.info(
    `harvest: wrote ${totalSamples} samples across ${reviewersWithSamples} bot reviewers (window=${options.windowDays}d)`
  );
  // Report the unmeasured count next to the measured one. A reader who sees
  // only "6358 samples" cannot tell that every one of them was unusable,
  // which is exactly the state #133 shipped in.
  core.info(
    `harvest: ${totalUnknown} finding(s) had an unknown outcome and are excluded from every accept rate ` +
      `(${result.degradedPulls}/${result.observedPulls} PRs had an incomplete commit walk, ` +
      `${result.unamendablePulls}/${result.observedPulls} had no commit after the first bot comment)`
  );
  if (totalSamples === 0 && totalUnknown > 0) {
    throw new Error(
      `harvest: all ${totalUnknown} findings are outcome=unknown, so every accept rate ` +
        "would be 0% over an empty denominator. Refusing to publish a profile that " +
        "cannot be distinguished from a real measurement."
    );
  }
  for (const [reviewer, stats] of Object.entries(profiles.reviewers)) {
    const groups = Object.entries(stats.byPathGroup)
      // `s.n > 0` alone would hide a group whose findings were ALL
      // unknown, which is the state worth seeing most.
      .filter(([, s]) => s.n > 0 || s.unknownN > 0)
      .sort((a, b) => b[1].n + b[1].unknownN - (a[1].n + a[1].unknownN))
      .slice(0, 3);
    if (groups.length > 0) {
      const summary = groups
        .map(
          ([g, s]) =>
            `${g}=${s.n}@${(s.acceptRate * 100).toFixed(0)}%` +
            (s.unknownN > 0 ? `+${s.unknownN}?` : "")
        )
        .join(", ");
      core.info(`harvest: ${reviewer}: ${summary}`);
    }
  }
  core.info(
    `harvest: bucketer smoke-check: Cargo.lock=${pathGroupFor("Cargo.lock")} workflows/ci.yml=${pathGroupFor(".github/workflows/ci.yml")}`
  );

  await fs.writeFile(options.outPath, JSON.stringify(profiles, null, 2));
  if (options.calibrationOutPath) {
    await fs.writeFile(
      options.calibrationOutPath,
      JSON.stringify(
        {
          schema: "maxi.review.v1.calibration-report",
          generatedAt: profiles.generatedAt,
          windowDays: options.windowDays,
          artifactsObserved: result.artifactsObserved,
          byRule: result.calibration.byRule,
          bySeverity: result.calibration.bySeverity,
          byPath: result.calibration.byPath,
        },
        null,
        2
      )
    );
  }
  return {
    profiles,
    calibration: result.calibration,
    artifactsObserved: result.artifactsObserved,
    degradedPulls: result.degradedPulls,
    unamendablePulls: result.unamendablePulls,
    observedPulls: result.observedPulls,
  };
}
