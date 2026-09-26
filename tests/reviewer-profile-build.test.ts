import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphqlPullsPage } from "../src/reviewer-profile-build.js";

vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(),
  context: {
    eventName: "workflow_dispatch",
    repo: { owner: "maxi-tools", repo: "maxi-reviewer" },
  },
}));

import { readFileSync } from "node:fs";
import * as github from "@actions/github";
import {
  harvest,
  listPullsInWindow,
  listReviewThreads,
  listCommitsAfter,
  runScheduledHarvest,
} from "../src/reviewer-profile-build.js";
import {
  classifyOutcome,
  aggregateReviewerProfiles,
} from "../src/reviewer-profile.js";
import { buildCalibrationReport } from "../src/calibration.js";
import { extractReviewArtifact } from "../src/review-command.js";

// The mock below is the test fixture — referencing `github` here so the
// import survives the linter's `no-unused-vars` check.
void github;

interface FakeOctokit {
  graphql: ReturnType<typeof vi.fn>;
  rest: {
    users: {
      getAuthenticated: ReturnType<typeof vi.fn>;
    };
    repos: {
      getCommit: ReturnType<typeof vi.fn>;
    };
  };
}

/**
 * `commitFiles` maps a commit oid to the filenames REST reports for it.
 *
 * The shape below is the REAL `GET /repos/{owner}/{repo}/commits/{ref}`
 * response shape — `{ data: { files: [{ filename }] } }`. The previous
 * fixture invented `changedFilesIfAvailable: { nodes: [{ path }] }` to match
 * what the code expected, and GitHub's schema has no such field: it is an
 * `Int`. Because the fixture agreed with the code rather than with the
 * server, the suite stayed green through a query the API rejects outright,
 * and a 270-PR harvest reported 0% for every reviewer (#133).
 *
 * An oid with no entry throws, the way a fetch for an unreachable commit
 * would, so a test must state which commits it expects to be read.
 */
function makeOctokit(
  handlers: Record<string, (vars: Record<string, unknown>) => unknown>,
  commitFiles: Record<string, string[]> = {}
): FakeOctokit {
  return {
    graphql: vi.fn(async (query: string, vars: Record<string, unknown>) => {
      // Dispatch on the OPERATION NAME first. Keying only on the sorted
      // variable names collides: HarvestThreads and HarvestCommitPaths take
      // the same five variables, so a fixture that declared threads would
      // silently answer the commit walk with a threads payload, the walk
      // would find no `commits` connection, and the test would exercise a
      // degraded path while appearing to cover the healthy one.
      const op = /query\s+(\w+)/.exec(query)?.[1];
      const byKey = JSON.stringify(Object.keys(vars).sort());
      const handler =
        (op !== undefined ? handlers[op] : undefined) ?? handlers[byKey];
      if (!handler) {
        throw new Error(
          `Unexpected graphql call: operation=${op ?? "?"} vars=${byKey}`
        );
      }
      return handler(vars);
    }),
    rest: {
      users: {
        // tests that exercise the artifact path need to seed the
        // authenticated user the github.ts helper uses to filter
        // trustedAuthors; default to a known bot so the filter is
        // permissive without making the test reach the network.
        getAuthenticated: vi.fn(async () => ({
          data: { login: "maxi-tools-auth[bot]" },
        })),
      },
      repos: {
        // Paged, like the real endpoint: `repos.getCommit` caps a response
        // at 300 files and puts the rest behind `Link: rel="next"`, so a
        // fixture that always returns everything in one page cannot catch a
        // caller that reads only the first.
        getCommit: vi.fn(
          async ({
            ref,
            per_page: perPage,
            page,
          }: {
            ref: string;
            per_page?: number;
            page?: number;
          }) => {
            if (!(ref in commitFiles)) {
              throw new Error(`Unexpected getCommit for ref: ${ref}`);
            }
            const all = commitFiles[ref];
            const size = perPage ?? all.length;
            const start = ((page ?? 1) - 1) * size;
            return {
              data: {
                files: all
                  .slice(start, start + size)
                  .map((filename) => ({ filename })),
              },
            };
          }
        ),
      },
    },
  };
}

describe("listPullsInWindow", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("walks the org search API and maps mergedAt / closedAt to terminusAt", async () => {
    let capturedQuery = "";
    const octokit = makeOctokit({
      HarvestPulls: (vars) => {
        capturedQuery = String(vars.searchQuery);
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "merged",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
              {
                number: 8,
                title: "closed-not-merged",
                url: "u",
                mergedAt: null,
                closedAt: "2026-09-09T12:00:00Z",
                updatedAt: "2026-09-09T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        } satisfies GraphqlPullsPage;
      },
    });
    const pulls = await listPullsInWindow(
      octokit as never,
      "maxi-tools",
      30,
      10
    );
    expect(pulls).toHaveLength(2);
    expect(pulls[0].terminusAt).toBe("2026-09-10T12:00:00Z");
    expect(pulls[1].terminusAt).toBe("2026-09-09T12:00:00Z");
    expect(capturedQuery).toContain("org:maxi-tools");
    expect(capturedQuery).toContain("is:pr");
    expect(capturedQuery).toContain("is:closed");
  });

  it("passes its variables object without a reserved `query` key", async () => {
    // Regression for the @octokit/graphql reserved-key guard: passing
    // `{ query: ... }` causes `octokit.graphql` to throw
    // `"query" cannot be used as variable name`. Inspect the variables
    // object handed to `graphql` directly so we catch a future regression
    // even if the handler-key dispatch above were loosened.
    const graphqlSpy = vi.fn(async () => ({
      search: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    }));
    // The inline mock implements only the subset of `Octokit` that
    // `listPullsInWindow` exercises (the `graphql` call); `as never` on
    // the call site matches the established test idiom in this file
    // for partial Octokit fixtures (see other `listPullsInWindow`
    // blocks above).
    const octokit = { graphql: graphqlSpy };
    await listPullsInWindow(octokit as never, "maxi-tools", 30, 5);
    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    const vars = graphqlSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(vars).toBeDefined();
    expect(Object.keys(vars)).not.toContain("query");
    expect(Object.keys(vars)).toContain("searchQuery");
  });

  it("builds the searchQuery so GitHub's OR returns both merged and closed-not-merged PRs in window", async () => {
    // Regression for the broken search-query shape that returned 0 PRs
    // for the entire `maxi-tools` org. GitHub's `search(type: ISSUE)`
    // requires the OR's two sides to each be parenthesised individually:
    // `is:pr (merged:>=D) OR (closed:>=D)`. A single outer paren around
    // the disjunction — `(merged:>=D OR closed:>=D)` — also returns 0,
    // even though the parens balance. Assert the live shape so the next
    // refactor that re-collapses the parens fails before it ships.
    //
    // `octokit.graphql` takes the document as arg[0] and the variables
    // object as arg[1]; the rendered search string lives under
    // `args[1].searchQuery`.
    //
    // The window start is derived from the wall clock (now - windowDays), so
    // the clock is pinned here: under the real timers this describe block
    // installs, the literal dates below are correct only on the day the test
    // was written, and the suite would start failing the next day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
    const graphqlSpy = vi.fn(async () => ({
      search: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    }));
    const octokit = { graphql: graphqlSpy };
    try {
      await listPullsInWindow(octokit as never, "maxi-tools", 30, 5);
    } finally {
      // Never leave the fake clock installed for whatever runs next.
      vi.useRealTimers();
    }
    const vars = graphqlSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    const query = vars?.["searchQuery"];
    expect(typeof query).toBe("string");
    const rendered = query as string;
    // The whole-org form, with the hoisted `is:pr is:closed` shared scope.
    expect(rendered).toMatch(/org:maxi-tools/);
    expect(rendered).toMatch(/is:pr/);
    expect(rendered).toMatch(/is:closed/);
    // Each OR branch MUST be wrapped in its own parens.
    expect(rendered).toMatch(/\(merged:>=2026-08-20\)/);
    expect(rendered).toMatch(/\(closed:>=2026-08-20\)/);
    // ...and the two branches MUST be joined by OR. Asserting the branches
    // separately is not enough: `(merged:>=D) (closed:>=D)` satisfies both
    // of the assertions above, but GitHub reads juxtaposition as AND, which
    // matches only PRs that are both merged and closed-not-merged — i.e.
    // nothing. Pin the whole shape, operator included.
    expect(rendered).toMatch(
      /\(merged:>=2026-08-20\)\s+OR\s+\(closed:>=2026-08-20\)/
    );
    // The single-outer-paren shape that returns 0 must not reappear.
    // The bad shape: `(merged:>=D OR closed:>=D)` — one open paren,
    // no close paren before the OR.
    expect(rendered).not.toMatch(/\(merged:>=[^)]*OR[^)]*closed:>=/);
  });
});

describe("listReviewThreads", () => {
  it("returns the first-comment author and createdAt per thread", async () => {
    const octokit = makeOctokit({
      HarvestThreads: () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  path: "src/a.ts",
                  line: 4,
                  comments: {
                    nodes: [
                      {
                        author: { login: "coderabbitai" },
                        createdAt: "2026-09-10T00:00:00Z",
                        databaseId: 1,
                      },
                    ],
                  },
                },
                {
                  id: "T2",
                  isResolved: true,
                  path: "src/b.ts",
                  line: 9,
                  comments: {
                    nodes: [
                      {
                        author: { login: "maxiboch" },
                        createdAt: "2026-09-10T00:01:00Z",
                        databaseId: 2,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    });
    const threads = await listReviewThreads(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      10
    );
    expect(threads).toHaveLength(2);
    expect(threads[0].firstAuthor).toBe("coderabbitai");
    expect(threads[1].firstAuthor).toBe("maxiboch");
    expect(threads[1].isResolved).toBe(true);
  });
});

describe("listCommitsAfter", () => {
  it("returns the commit list with paths in reverse-chronological order", async () => {
    const octokit = makeOctokit(
      {
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: "a",
                      authoredDate: "2026-09-10T00:00:00Z",
                      committedDate: "2026-09-10T00:00:00Z",
                    },
                  },
                  {
                    commit: {
                      oid: "b",
                      authoredDate: "2026-09-09T23:59:00Z",
                      committedDate: "2026-09-09T23:59:00Z",
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      { a: ["src/a.ts", "src/b.ts"], b: ["src/early.ts"] }
    );
    const walk = await listCommitsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      2000,
      200
    );
    // The list is reverse-chronological by GitHub's contract; commit "a"
    // (newer) appears before "b" (older).
    expect(walk.commits.map((c) => c.oid)).toEqual(["a", "b"]);
    // A complete walk is part of the contract: an incomplete one would
    // classify every finding on this PR as unknown.
    expect(walk.complete).toBe(true);
    expect(walk.commits[0].paths).toContain("src/a.ts");
  });
});

describe("harvest", () => {
  it("emits findings for every bot thread and a calibration report for maxi-reviewer artifacts", async () => {
    const octokit = makeOctokit(
      {
        HarvestPulls: () => ({
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "t",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        }),
        HarvestThreads: () => ({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: false,
                    path: "crates/x/src/lib.rs",
                    line: 4,
                    comments: {
                      nodes: [
                        {
                          author: { login: "coderabbitai" },
                          createdAt: "2026-09-10T00:00:00Z",
                          databaseId: 1,
                        },
                      ],
                    },
                  },
                  {
                    id: "T2",
                    isResolved: true,
                    path: "scripts/run.sh",
                    line: 9,
                    comments: {
                      nodes: [
                        {
                          author: { login: "maxi-reviewer" },
                          createdAt: "2026-09-10T00:01:00Z",
                          databaseId: 2,
                        },
                      ],
                    },
                  },
                  {
                    id: "T3",
                    isResolved: false,
                    path: "crates/x/src/lib.rs",
                    line: 7,
                    comments: {
                      nodes: [
                        {
                          author: { login: "codacy-production" },
                          createdAt: "2026-09-10T00:02:00Z",
                          databaseId: 3,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
        // Keyed by operation: HarvestThreads and HarvestCommitPaths take the
        // same variables, so a variable-name key cannot tell them apart.
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: "a",
                      authoredDate: "2026-09-10T00:30:00Z",
                      committedDate: "2026-09-10T00:30:00Z",
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      { a: ["crates/x/src/lib.rs"] }
    );

    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
      maxThreadsPerPull: 10,
      maxCommitsPerPull: 50,
    });

    // Three threads -> three observations, classified:
    //   - coderabbitai on rust-src: open, file touched -> accepted
    //   - maxi-reviewer on shell: resolved, untouched -> dismissed
    //   - codacy-production on rust-src: open, file touched -> accepted
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].reviewer).toBe("coderabbitai");
    expect(result.findings[1].reviewer).toBe("maxi-reviewer");
    expect(result.findings[2].reviewer).toBe("codacy-production");
    // Calibration report: no artifacts returned -> empty report.
    expect(result.calibration.byRule).toEqual([]);
    expect(result.calibration.bySeverity).toEqual([]);
    expect(result.calibration.byPath).toEqual([]);
    expect(result.artifactsObserved).toBe(0);
  });

  it("counts a resolved thread with a later commit as accepted", async () => {
    // Regression: `accepted` was structurally unreachable on any PR whose bot
    // threads were ALL resolved. The commit walk was gated on
    // `botThreads.some((t) => !t.isResolved)`, so a fully-resolved PR never
    // fetched commits, `subsequentTouchedPaths` was always empty, and every
    // finding fell through to `dismissed`. Because the merge rules require
    // threads to be resolved before merging, that is the shape of nearly
    // every merged PR — which is why a 270-PR harvest over the whole org
    // reported a 0% accept rate for all seven bot reviewers at once.
    //
    // This fixture is the canonical accepted case: the bot commented, the
    // author pushed a commit touching that file, and then the thread was
    // resolved. It must read as `accepted`, not `dismissed`.
    const octokit = makeOctokit(
      {
        HarvestPulls: () => ({
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "t",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        }),
        HarvestThreads: () => ({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    // Resolved: the author fixed it and closed the thread.
                    isResolved: true,
                    path: "crates/x/src/lib.rs",
                    line: 4,
                    comments: {
                      nodes: [
                        {
                          author: { login: "coderabbitai" },
                          createdAt: "2026-09-10T00:00:00Z",
                          databaseId: 1,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: "fix",
                      authoredDate: "2026-09-10T02:00:00Z",
                      committedDate: "2026-09-10T02:00:00Z",
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      // The commit's changed files, in the shape REST actually returns.
      { fix: ["crates/x/src/lib.rs"] }
    );

    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
      maxThreadsPerPull: 10,
      maxCommitsPerPull: 50,
    });

    expect(result.findings).toHaveLength(1);
    // The commit landed after the comment and touched the commented file, so
    // its path must reach the classifier.
    expect(result.findings[0].subsequentTouchedPaths).toContain(
      "crates/x/src/lib.rs"
    );
    expect(classifyOutcome(result.findings[0])).toBe("accepted");
  });

  it("returns zero findings when no PRs match", async () => {
    const octokit = makeOctokit({
      HarvestPulls: () => ({
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      }),
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(result.findings).toEqual([]);
    expect(result.calibration.byRule).toEqual([]);
  });

  it("decodes a maxi-reviewer artifact comment and feeds it to calibration.ts", async () => {
    // The full GraphQL + REST round-tripping (artifact comment fetch, the
    // trustedAuthors helper, paginate) is exercised in the
    // `runScheduledHarvest` test below. Here we test the pure composition:
    // once `extractReviewArtifact` has decoded a body and `harvest` has
    // produced the (artifact, threads) pair, `buildCalibrationReport`
    // produces a non-empty report.
    const artifact = {
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-09-10T00:00:00.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi-tools/maxi-reviewer",
      prNumber: 7,
      headSha: "h",
      baseSha: "b",
      outcome: "REVIEWED_WITH_FINDINGS",
      outcomeSchema: "maxi.review.v1.review-outcome",
      reviewOutputChars: 1,
      runIdentity: { workflowRunId: 1, workflowRunAttempt: 1, job: "review" },
      analyzerFindings: [],
      rawJulesResponses: [],
      validatedReview: {
        schema: "maxi.review.v1.jules-review",
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        comments: [
          {
            id: "c1",
            path: "crates/x/src/lib.rs",
            line: 4,
            severity: "Warning",
            confidence: "High",
            message: "m",
          },
        ],
      },
      validationErrors: [],
    };
    const body = `<!-- maxi-review artifact -->\n<!-- maxi-review artifact-data\nname: review.json\nencoding: base64\n${Buffer.from(JSON.stringify(artifact), "utf8").toString("base64")}\n-->`;

    const decoded = extractReviewArtifact(body);
    expect(decoded).not.toBeNull();

    // Drive the calibration engine directly to confirm the artifact decoded
    // into the shape the engine consumes.
    const built = buildCalibrationReport([
      {
        artifact: decoded as never,
        threads: [{ path: "crates/x/src/lib.rs", line: 4, resolved: true }],
      },
    ]);

    expect(built.byRule.length).toBeGreaterThan(0);
    expect(built.bySeverity.length).toBeGreaterThan(0);
    expect(built.byPath.length).toBeGreaterThan(0);
  });
});

describe("listCommitsAfter pagination", () => {
  it("walks multiple history pages and stops when the path set is full", async () => {
    let pages = 0;
    const octokit = makeOctokit(
      {
        HarvestCommitPaths: () => {
          pages += 1;
          if (pages === 1) {
            return {
              repository: {
                pullRequest: {
                  commits: {
                    pageInfo: { hasNextPage: true, endCursor: "c2" },
                    nodes: [
                      {
                        commit: {
                          oid: "a",
                          authoredDate: "2026-09-10T00:30:00Z",
                          committedDate: "2026-09-10T00:30:00Z",
                        },
                      },
                    ],
                  },
                },
              },
            };
          }
          return {
            repository: {
              pullRequest: {
                commits: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      commit: {
                        oid: "b",
                        authoredDate: "2026-09-10T00:31:00Z",
                        committedDate: "2026-09-10T00:31:00Z",
                      },
                    },
                  ],
                },
              },
            },
          };
        },
      },
      { a: ["src/a.ts", "src/b.ts"], b: ["src/c.ts"] }
    );
    const walk = await listCommitsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      2000,
      200
    );
    expect(walk.commits.map((c) => c.paths).flat()).toEqual(
      expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts"])
    );
    expect(pages).toBe(2);
  });

  it("caps at the commit ceiling when a branch has unbounded history", async () => {
    const octokit = makeOctokit(
      {
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: true, endCursor: "c2" },
                nodes: [
                  {
                    commit: {
                      oid: "a",
                      authoredDate: "2026-09-10T00:30:00Z",
                      committedDate: "2026-09-10T00:30:00Z",
                    },
                  },
                ],
              },
            },
          },
        }),
      },
      { a: ["src/a.ts", "src/b.ts"] }
    );
    const walk = await listCommitsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      2000,
      1
    );
    expect(walk.commits[0]?.paths).toContain("src/a.ts");
  });
});

describe("runScheduledHarvest", () => {
  it("writes reviewer-profiles.json and calibration.json when given a token", async () => {
    const fakeGetOctokit = github.getOctokit as unknown as ReturnType<
      typeof vi.fn
    >;
    fakeGetOctokit.mockImplementation(() => {
      const handlers: Record<
        string,
        (vars: Record<string, unknown>) => unknown
      > = {
        HarvestPulls: () => ({
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "t",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        }),
        HarvestThreads: () => ({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: true,
                    path: "crates/x/src/lib.rs",
                    line: 4,
                    comments: {
                      nodes: [
                        {
                          author: { login: "coderabbitai" },
                          createdAt: "2026-09-10T00:00:00Z",
                          databaseId: 1,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: "c1",
                      authoredDate: "2026-09-10T06:00:00Z",
                      committedDate: "2026-09-10T06:00:00Z",
                    },
                  },
                ],
              },
            },
          },
        }),
        '["issue_number","owner","per_page","repo"]': () => ({ data: [] }),
      };
      return {
        graphql: vi.fn(async (q: string, vars: Record<string, unknown>) => {
          // Operation-keyed, same as makeOctokit: HarvestThreads and
          // HarvestCommitPaths are indistinguishable by variable name.
          const op = /query\s+(\w+)/.exec(q)?.[1];
          const key = JSON.stringify(Object.keys(vars).sort());
          const handler =
            (op !== undefined ? handlers[op] : undefined) ?? handlers[key];
          if (!handler) {
            throw new Error(
              `Unexpected graphql call: operation=${op ?? "?"} vars=${key}`
            );
          }
          return handler(vars);
        }),
        rest: {
          // Paths come from REST now; without this the commit walk is
          // incomplete and every finding is classified `unknown`.
          repos: {
            getCommit: vi.fn(async () => ({
              data: { files: [{ filename: "crates/x/src/lib.rs" }] },
            })),
          },
        },
      };
    });

    const tmpDir = await import("node:fs/promises").then((m) =>
      m.mkdtemp("/tmp/calibration-")
    );
    const profilesPath = `${tmpDir}/reviewer-profiles.json`;
    const calibrationPath = `${tmpDir}/calibration.json`;
    try {
      const result = await runScheduledHarvest({
        outPath: profilesPath,
        calibrationOutPath: calibrationPath,
        org: "maxi-tools",
        windowDays: 30,
        token: "fake-token",
      });
      expect(result.profiles.windowDays).toBe(30);
      expect(result.profiles.reviewers["coderabbitai"].overall.n).toBe(1);
      // The fixture's commit touches the commented file after the comment,
      // so the finding is `accepted`. This asserted 0 before, which passed
      // only because the commit walk was failing and every finding fell
      // through to `dismissed` — the test agreed with the bug.
      expect(result.profiles.reviewers["coderabbitai"].overall.acceptRate).toBe(
        1
      );
      // And nothing was silently unmeasurable.
      expect(result.profiles.reviewers["coderabbitai"].overall.unknownN).toBe(
        0
      );
      expect(result.degradedPulls).toBe(0);

      const written = JSON.parse(
        await import("node:fs/promises").then((m) =>
          m.readFile(profilesPath, "utf8")
        )
      );
      expect(written.schema).toBe("maxi.review.v1.reviewer-profiles");
      expect(written.reviewers["coderabbitai"].overall.n).toBe(1);

      const calibrationWritten = JSON.parse(
        await import("node:fs/promises").then((m) =>
          m.readFile(calibrationPath, "utf8")
        )
      );
      expect(calibrationWritten.schema).toBe(
        "maxi.review.v1.calibration-report"
      );
      expect(calibrationWritten.windowDays).toBe(30);
      expect(calibrationWritten.artifactsObserved).toBe(0);
    } finally {
      await import("node:fs/promises").then((m) =>
        m.rm(tmpDir, { recursive: true })
      );
    }
  });
});

describe("a failed measurement is never published as data", () => {
  // The three properties that, together, make the #133 failure mode
  // impossible to ship again. Each one alone was insufficient: the query bug
  // was real, but what let it reach production for weeks was that a failed
  // fetch was indistinguishable from a measurement of zero.

  function pullsOnly() {
    return {
      HarvestPulls: () => ({
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 7,
              title: "t",
              url: "u",
              mergedAt: "2026-09-10T12:00:00Z",
              closedAt: null,
              updatedAt: "2026-09-10T12:00:00Z",
              repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
            },
          ],
        },
      }),
      HarvestThreads: () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: true,
                  path: "crates/x/src/lib.rs",
                  line: 4,
                  comments: {
                    nodes: [
                      {
                        author: { login: "coderabbitai" },
                        createdAt: "2026-09-10T00:00:00Z",
                        databaseId: 1,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    };
  }

  it("does not select subfields on changedFilesIfAvailable", () => {
    // The exact regression. `Commit.changedFilesIfAvailable` is an Int in
    // GitHub's schema — a count, null when GitHub cannot compute it — so
    // selecting `{ nodes { path } }` on it makes the server reject the whole
    // document:
    //
    //   Selections can't be made on scalars (field
    //   'changedFilesIfAvailable' returns Int but has selections ["nodes"])
    //
    // Asserted against the query TEXT because no unit test can reach the
    // real schema, and the fixtures cannot catch it: a fixture is written to
    // match the code, so it agreed with the bug.
    const source = readFileSync(
      new URL("../src/reviewer-profile-build.ts", import.meta.url),
      "utf8"
    );
    // Comments stripped first: the doc comment on `listCommitsAfter` quotes
    // the broken selection deliberately, to explain it. Asserting over the
    // raw file would make this test fail on its own documentation and teach
    // the next reader to delete the explanation.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/changedFilesIfAvailable\s*[({]/);
    expect(code).not.toMatch(/changedFiles\s*\{/);
    // And the explanation is still there, so this test's reason survives.
    expect(source).toMatch(/Selections can't be made on scalars/);
  });

  it("classifies a finding as unknown when the commit walk fails", async () => {
    // Not `dismissed`. An empty touched-paths list from a FAILED fetch means
    // "we could not look", and reading it as "nothing was touched" invents a
    // verdict against the reviewer out of a network error.
    const octokit = makeOctokit(pullsOnly());
    // No HarvestCommitPaths handler and no commitFiles: the walk throws.
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
      maxThreadsPerPull: 10,
      maxCommitsPerPull: 50,
    }).catch((err: unknown) => err);

    // A single PR that wholly failed is a wholly failed harvest, which must
    // throw rather than publish.
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toMatch(/failed harvest, not an empty one/);
  });

  it("keeps unknown findings out of the accept rate entirely", () => {
    const base = {
      reviewer: "coderabbitai" as const,
      repo: "maxi-tools/maxi-reviewer",
      prNumber: 1,
      path: "crates/x/src/lib.rs",
      line: 4,
    };
    const profiles = aggregateReviewerProfiles(
      [
        // One genuinely accepted.
        {
          ...base,
          threadResolved: true,
          subsequentTouchedPaths: ["crates/x/src/lib.rs"],
          touchedPathsKnown: true,
        },
        // One unmeasurable. It must not drag the rate toward zero.
        {
          ...base,
          threadResolved: true,
          subsequentTouchedPaths: [],
          touchedPathsKnown: false,
        },
      ],
      "2026-09-19T00:00:00.000Z",
      30
    );
    const overall = profiles.reviewers["coderabbitai"].overall;
    expect(overall.n).toBe(1);
    expect(overall.acceptRate).toBe(1);
    expect(overall.unknownN).toBe(1);
  });

  it("reports unknown outcomes rather than silently dropping them", () => {
    expect(
      classifyOutcome({
        reviewer: "coderabbitai",
        repo: "maxi-tools/maxi-reviewer",
        prNumber: 1,
        path: "a.ts",
        line: 1,
        threadResolved: true,
        subsequentTouchedPaths: [],
        touchedPathsKnown: false,
      })
    ).toBe("unknown");
    // The same finding with a KNOWN empty walk is a real `dismissed`.
    expect(
      classifyOutcome({
        reviewer: "coderabbitai",
        repo: "maxi-tools/maxi-reviewer",
        prNumber: 1,
        path: "a.ts",
        line: 1,
        threadResolved: true,
        subsequentTouchedPaths: [],
        touchedPathsKnown: true,
      })
    ).toBe("dismissed");
  });
});

describe("truncation and partial failure are reported, not hidden", () => {
  // Review on #134 found three holes in the #133 fix itself -- each one the
  // same shape it was written to close: an incomplete result presented as a
  // complete one.

  const PULL = {
    owner: "maxi-tools",
    repo: "maxi-reviewer",
    number: 1,
    terminusAt: "2026-09-10T01:00:00Z",
    updatedAt: "2026-09-10T01:00:00Z",
  };

  function commitNode(oid: string, date: string) {
    return {
      commit: { oid, authoredDate: date, committedDate: date },
    };
  }

  it("flags truncation when the cap is hit mid-page on the LAST page", async () => {
    // hasNextPage is FALSE, so the old code broke out before its truncation
    // check and reported complete=true -- while silently dropping the third
    // commit on this page.
    const octokit = makeOctokit(
      {
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  commitNode("c3", "2026-09-10T03:00:00Z"),
                  commitNode("c2", "2026-09-10T02:00:00Z"),
                  commitNode("c1", "2026-09-10T01:00:00Z"),
                ],
              },
            },
          },
        }),
      },
      { c3: ["a.ts"], c2: ["b.ts"] }
    );
    const walk = await listCommitsAfter(octokit as never, PULL, 2000, 2);
    expect(walk.commits).toHaveLength(2);
    expect(walk.complete).toBe(false);
  });

  it("flags truncation when hasNextPage is true but the cursor is null", async () => {
    // More commits exist and there is no way to reach them. Reported as
    // finished before.
    const octokit = makeOctokit(
      {
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: true, endCursor: null },
                nodes: [commitNode("c1", "2026-09-10T01:00:00Z")],
              },
            },
          },
        }),
      },
      { c1: ["a.ts"] }
    );
    const walk = await listCommitsAfter(octokit as never, PULL, 2000, 50);
    expect(walk.complete).toBe(false);
  });

  it("still answers a thread whose commits were all walked, on a truncated walk", async () => {
    // Truncation drops the OLDEST commits. A thread whose slice closes --
    // i.e. we saw a commit older than it -- has a complete answer regardless.
    // Bailing on `!walk.complete` threw away every thread on a large PR,
    // including recent ones whose commits were all present.
    //
    // Driven through `harvest`, deliberately. An earlier version of this
    // test handed `subsequentTouchedPaths` and `touchedPathsKnown` straight
    // to `classifyOutcome`, which never touches `listCommitsAfter` or
    // `touchedPathsAfterThread` -- so restoring the bailout would not have
    // failed it. A test that cannot fail for the behaviour it names is the
    // defect this PR is about, one level up.
    //
    // maxCommitsPerPull = 3 against a page of three commits with
    // hasNextPage true: every listed commit is kept, but MORE pages exist
    // and are not read, so `walk.complete` is false. The thread is dated
    // between c2 and c1, so its slice closes on c1 -- the omitted older
    // commits cannot be after it, and the answer is complete anyway.
    const octokit = makeOctokit(
      {
        HarvestPulls: () => ({
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 7,
                title: "t",
                url: "u",
                mergedAt: "2026-09-10T12:00:00Z",
                closedAt: null,
                updatedAt: "2026-09-10T12:00:00Z",
                repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
              },
            ],
          },
        }),
        HarvestThreads: () => ({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "T1",
                    isResolved: true,
                    path: "a.ts",
                    line: 4,
                    comments: {
                      nodes: [
                        {
                          author: { login: "coderabbitai" },
                          // Between c2 and c1: the slice closes on c1.
                          createdAt: "2026-09-10T01:30:00Z",
                          databaseId: 1,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: true, endCursor: "C2" },
                nodes: [
                  commitNode("c3", "2026-09-10T03:00:00Z"),
                  commitNode("c2", "2026-09-10T02:00:00Z"),
                  commitNode("c1", "2026-09-10T01:00:00Z"),
                ],
              },
            },
          },
        }),
      },
      { c3: ["a.ts"], c2: ["b.ts"] }
    );

    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
      maxThreadsPerPull: 10,
      maxCommitsPerPull: 3,
    });

    expect(result.findings).toHaveLength(1);
    // The walk was truncated, but THIS thread's answer is complete.
    expect(result.findings[0].touchedPathsKnown).toBe(true);
    expect(classifyOutcome(result.findings[0])).toBe("accepted");
  });

  it("follows every page of a commit's changed files", async () => {
    // `repos.getCommit` caps a response at 300 files. Reading only the first
    // page and marking the paths known classifies a finding on a later page
    // as `dismissed` rather than `accepted`.
    const many = Array.from({ length: 150 }, (_, i) => `f${i}.ts`);
    const octokit = makeOctokit(
      {
        HarvestCommitPaths: () => ({
          repository: {
            pullRequest: {
              commits: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [commitNode("big", "2026-09-10T02:00:00Z")],
              },
            },
          },
        }),
      },
      { big: many }
    );
    const walk = await listCommitsAfter(
      octokit as never,
      {
        owner: "maxi-tools",
        repo: "maxi-reviewer",
        number: 1,
        terminusAt: "2026-09-10T01:00:00Z",
        updatedAt: "2026-09-10T01:00:00Z",
      },
      5000,
      50
    );
    // 150 files over a 100-per-page fixture: the second page must be read.
    expect(walk.commits[0].paths).toHaveLength(150);
    expect(walk.commits[0].paths).toContain("f149.ts");
    expect(walk.commits[0].pathsKnown).toBe(true);
    expect(walk.complete).toBe(true);
  });

  it("counts a threads-leg failure as an observed, degraded PR", async () => {
    // The commits leg was covered; this one was not. A `continue` before
    // `observedPulls += 1` meant a threads query failing on EVERY PR yielded
    // zero findings, zero unknowns, and an all-zero profile that the
    // all-degraded guard never saw.
    const octokit = makeOctokit({
      HarvestPulls: () => ({
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 7,
              title: "t",
              url: "u",
              mergedAt: "2026-09-10T12:00:00Z",
              closedAt: null,
              updatedAt: "2026-09-10T12:00:00Z",
              repository: { nameWithOwner: "maxi-tools/maxi-reviewer" },
            },
          ],
        },
      }),
      HarvestThreads: () => {
        throw new Error("pull_requests: read revoked");
      },
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    }).catch((err: unknown) => err);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toMatch(/failed harvest, not an empty one/);
  });
});

describe("a PR nobody could amend is not evidence about a reviewer", () => {
  // 41% of the merged corpus is `maxi-config-sync/*` fan-out, and a consumer
  // cannot edit one: every file carries `# maxi-config-owned ` and
  // check-owned-files.py fails lint-gate on any change to it. The PR merges
  // exactly as generated or not at all, so no commit ever lands after a bot
  // comment and no finding there can be actioned.
  //
  // The fixture below is that shape: a thread created AFTER the only commit
  // on the PR. The walk succeeds -- this is not a degraded read -- and finds
  // nothing later, which is a fact rather than a failure.

  function unamendablePull(threadResolved: boolean) {
    return {
      HarvestPulls: () => ({
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 88,
              title: "ci: sync coverage from maxi-config",
              url: "u",
              mergedAt: "2026-09-21T02:00:00Z",
              closedAt: null,
              updatedAt: "2026-09-21T02:00:00Z",
              repository: { nameWithOwner: "maxi-tools/maxi-lint" },
            },
          ],
        },
      }),
      HarvestThreads: () => ({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: threadResolved,
                  path: ".github/workflows/ci.yml",
                  line: 12,
                  comments: {
                    nodes: [
                      {
                        author: { login: "coderabbitai" },
                        // AFTER the commit below: nothing can follow it.
                        createdAt: "2026-09-21T01:00:00Z",
                        databaseId: 1,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
      HarvestCommitPaths: () => ({
        repository: {
          pullRequest: {
            commits: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  commit: {
                    oid: "a",
                    authoredDate: "2026-09-21T00:00:00Z",
                    committedDate: "2026-09-21T00:00:00Z",
                  },
                },
              ],
            },
          },
        },
      }),
    };
  }

  it("records the commit count so an un-amendable PR is measurable", async () => {
    // The guard that keeps the classifier's new clause reachable. If the
    // harvester ever stops setting `subsequentCommitCount`, it reads as
    // `undefined` -- "not recorded" -- and every finding silently reverts to
    // being scored against the reviewer. This test is the only thing that
    // would say so.
    const octokit = makeOctokit(unamendablePull(false), {
      a: [".github/workflows/ci.yml"],
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].subsequentCommitCount).toBe(0);
    // Read successfully: this is NOT a degraded walk.
    expect(result.findings[0].touchedPathsKnown).toBe(true);
    expect(classifyOutcome(result.findings[0])).toBe("unknown");
  });

  it("scores a resolved thread on such a PR as unknown, not dismissed", async () => {
    // On a fan-out PR the right response to a finding is to fix it at the
    // source in maxi-config and re-fan, then resolve here with no commit.
    // That used to be recorded as the reviewer being wrong.
    const octokit = makeOctokit(unamendablePull(true), {
      a: [".github/workflows/ci.yml"],
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(classifyOutcome(result.findings[0])).toBe("unknown");
  });

  it("counts it as un-amendable and NOT as degraded", async () => {
    // The two are different facts and the report keeps them apart: a
    // degraded PR is one we failed to read, an un-amendable one we read
    // perfectly. Folding them together would make a healthy harvest of
    // fan-out traffic look like a broken one, and would hide the share of
    // the corpus that is unmeasurable -- which is how this went unnoticed
    // until the rates had already decayed.
    const octokit = makeOctokit(unamendablePull(false), {
      a: [".github/workflows/ci.yml"],
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(result.observedPulls).toBe(1);
    expect(result.unamendablePulls).toBe(1);
    expect(result.degradedPulls).toBe(0);
  });

  it("does not call a PR un-amendable when any finding could not be read", async () => {
    // Found in review. `knownHere > 0` was enough, so a PR with one readable
    // zero-commit finding and one failed commit walk was labelled
    // un-amendable on the strength of the half we could see -- a whole-PR
    // verdict from a partial read, which is this PR's own subject one level
    // up. Two threads here; the second has no createdAt, so its walk yields
    // known=false.
    const handlers = unamendablePull(false);
    handlers.HarvestThreads = () => ({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "T1",
                isResolved: false,
                path: "a.yml",
                line: 12,
                comments: {
                  nodes: [
                    {
                      author: { login: "coderabbitai" },
                      createdAt: "2026-09-21T01:00:00Z",
                      databaseId: 1,
                    },
                  ],
                },
              },
              {
                id: "T2",
                isResolved: false,
                path: "scripts/thing.sh",
                line: 3,
                comments: {
                  nodes: [
                    {
                      author: { login: "qltysh" },
                      // No createdAt: the walk cannot place this thread in
                      // time, so its outcome is unknown.
                      createdAt: "",
                      databaseId: 2,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const octokit = makeOctokit(handlers, { a: ["a.yml"] });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(result.findings).toHaveLength(2);
    const known = result.findings.filter((f) => f.touchedPathsKnown);
    expect(known).toHaveLength(1);
    // The readable finding is still scored correctly on its own terms...
    expect(classifyOutcome(known[0])).toBe("unknown");
    // ...but the PR is NOT counted, because we did not read all of it.
    expect(result.unamendablePulls).toBe(0);
  });

  it("keeps counting a PR that did get a later commit as amendable", async () => {
    // The guard against over-correcting: one commit after the comment is
    // opportunity enough, and the PR must not be counted un-amendable.
    const handlers = unamendablePull(false);
    handlers.HarvestCommitPaths = () => ({
      repository: {
        pullRequest: {
          commits: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                commit: {
                  oid: "b",
                  authoredDate: "2026-09-21T01:30:00Z",
                  committedDate: "2026-09-21T01:30:00Z",
                },
              },
            ],
          },
        },
      },
    });
    const octokit = makeOctokit(handlers, {
      b: [".github/workflows/ci.yml"],
    });
    const result = await harvest(octokit as never, "maxi-tools", 30, {
      maxPulls: 5,
    });
    expect(result.unamendablePulls).toBe(0);
    expect(result.findings[0].subsequentCommitCount).toBe(1);
    expect(classifyOutcome(result.findings[0])).toBe("accepted");
  });
});
