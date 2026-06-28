/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  fetchDiff,
  loadRulesFromBase,
  resolveThreads,
  setStatus,
  submitReview,
  fetchOpenThreads,
  fetchExistingFindings,
  recordReviewArtifactComment,
  listReviewArtifactComments,
} from "../src/github.js";

describe("github.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fetchDiff works with compareCommitsWithBasehead", async () => {
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi
            .fn()
            .mockResolvedValue({ data: "diff content" }),
        },
      },
    } as any;
    const diff = await fetchDiff(
      octokit,
      "owner",
      "repo",
      { number: 1 },
      "baseSHA",
      "headSHA"
    );
    expect(diff).toBe("diff content");
  });

  it("fetchDiff falls back if compareCommitsWithBasehead returns non-string data", async () => {
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi
            .fn()
            .mockResolvedValue({ data: { format: "not a string" } }),
        },
        pulls: {
          get: vi
            .fn()
            .mockResolvedValue({ data: "fallback diff from pulls.get" }),
        },
      },
    } as any;
    const diff = await fetchDiff(
      octokit,
      "owner",
      "repo",
      { number: 1 },
      "baseSHA",
      "headSHA"
    );
    expect(diff).toBe("fallback diff from pulls.get");
  });

  it("fetchDiff falls back to pulls.get when compareCommitsWithBasehead fails", async () => {
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi
            .fn()
            .mockRejectedValue(new Error("fail")),
        },
        pulls: { get: vi.fn().mockResolvedValue({ data: "fallback diff" }) },
      },
    } as any;
    const diff = await fetchDiff(
      octokit,
      "owner",
      "repo",
      { number: 1 },
      "baseSHA",
      "headSHA"
    );
    expect(diff).toBe("fallback diff");
  });

  it("fetchDiff throws if pulls.get fails to return a string diff", async () => {
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi
            .fn()
            .mockRejectedValue(new Error("fail")),
        },
        pulls: { get: vi.fn().mockResolvedValue({ data: {} }) },
      },
    } as any;
    await expect(
      fetchDiff(octokit, "owner", "repo", { number: 1 }, "baseSHA", "headSHA")
    ).rejects.toThrow("GitHub returned no diff text.");
  });

  it("loadRulesFromBase works when file exists", async () => {
    const content = "rule1\nrule2";
    const base64Content = Buffer.from(content).toString("base64");
    const octokit = {
      rest: {
        repos: {
          getContent: vi
            .fn()
            .mockResolvedValue({ data: { content: base64Content } }),
        },
      },
    } as any;
    const rules = await loadRulesFromBase(
      octokit,
      "owner",
      "repo",
      "path",
      "sha"
    );
    expect(rules).toBe(content);
  });

  it("loadRulesFromBase returns undefined on error", async () => {
    const octokit = {
      rest: {
        repos: {
          getContent: vi.fn().mockRejectedValue(new Error("Not found")),
        },
      },
    } as any;
    const rules = await loadRulesFromBase(
      octokit,
      "owner",
      "repo",
      "path",
      "sha"
    );
    expect(rules).toBeUndefined();
  });

  it("loadRulesFromBase returns undefined if content is missing", async () => {
    const octokit = {
      rest: { repos: { getContent: vi.fn().mockResolvedValue({ data: {} }) } },
    } as any;
    const rules = await loadRulesFromBase(
      octokit,
      "owner",
      "repo",
      "path",
      "sha"
    );
    expect(rules).toBeUndefined();
  });

  it("fetchOpenThreads parses graphql response correctly", async () => {
    const octokit = {
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "t1",
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        body: "<!-- maxi-review-inline-comment -->\nMsg",
                        path: "a.ts",
                        line: 10,
                        author: { login: "bot" },
                        viewerDidAuthor: true,
                        createdAt: "2026-06-26T02:43:36Z",
                      },
                      {
                        body: "Human reply on the finding",
                        path: "a.ts",
                        line: null,
                        author: { login: "reviewer" },
                        viewerDidAuthor: false,
                        createdAt: "2026-06-26T02:46:32Z",
                      },
                    ],
                  },
                },
                {
                  id: "t2",
                  isResolved: true,
                  comments: {
                    nodes: [
                      {
                        body: "<!-- jules-inline-comment -->\nMsg",
                        path: "b.ts",
                        line: 20,
                      },
                    ],
                  },
                },
                {
                  id: "t3",
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        body: "Normal user comment",
                        path: "c.ts",
                        line: 30,
                        viewerDidAuthor: false,
                      },
                    ],
                  },
                },
                {
                  id: "t4",
                  isResolved: false,
                  comments: { nodes: [] }, // empty
                },
                {
                  id: "t5",
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        body: "<!-- jules-inline-comment -->\nNo Line",
                        path: "d.ts",
                        line: null,
                        author: { login: "bot" },
                        viewerDidAuthor: true,
                      },
                    ],
                  },
                },
                {
                  id: "t6",
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        body: "<!-- jules-inline-comment -->\nSpoofed Comment",
                        path: "e.ts",
                        line: 40,
                        author: { login: "attacker" },
                        viewerDidAuthor: false,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    } as any;

    const threads = await fetchOpenThreads(octokit, "owner", "repo", 1);
    expect(threads).toEqual([
      {
        index: 1,
        threadId: "t1",
        path: "a.ts",
        line: 10,
        body: "<!-- maxi-review-inline-comment -->\nMsg",
        comments: [
          {
            author: "bot",
            body: "<!-- maxi-review-inline-comment -->\nMsg",
            line: 10,
            viewerDidAuthor: true,
            createdAt: "2026-06-26T02:43:36Z",
          },
          {
            author: "reviewer",
            body: "Human reply on the finding",
            line: 10,
            viewerDidAuthor: false,
            createdAt: "2026-06-26T02:46:32Z",
          },
        ],
      },
      {
        index: 2,
        threadId: "t5",
        path: "d.ts",
        line: 0,
        body: "<!-- jules-inline-comment -->\nNo Line",
        comments: [
          {
            author: "bot",
            body: "<!-- jules-inline-comment -->\nNo Line",
            line: 0,
            viewerDidAuthor: true,
            createdAt: undefined,
          },
        ],
      },
    ]);
    expect(octokit.graphql.mock.calls[0][0]).toContain("comments(first: 20)");
  });

  it("fetchOpenThreads handles empty response", async () => {
    const octokit = { graphql: vi.fn().mockResolvedValue({}) } as any;
    const threads = await fetchOpenThreads(octokit, "owner", "repo", 1);
    expect(threads).toEqual([]);
  });

  it("resolveThreads resolves threads successfully", async () => {
    const octokit = { graphql: vi.fn().mockResolvedValue({}) } as any;
    await resolveThreads(octokit, ["t1", "t2"]);
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });

  it("resolveThreads handles failures gracefully", async () => {
    const octokit = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("fail")),
    } as any;
    await resolveThreads(octokit, ["t1", "t2"]);
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });

  it("submitReview sends proper payload", async () => {
    const octokit = {
      rest: { pulls: { createReview: vi.fn().mockResolvedValue({}) } },
    } as any;
    await submitReview(octokit, "owner", "repo", 1, "headSHA", "Summary text", [
      {
        file: "a.ts",
        line: 10,
        startLine: 10,
        endLine: 12,
        severity: "High",
        confidence: "High",
        message: "Msg",
        promptForAgents: "Fix this issue by doing X",
      },
      {
        file: "b.ts",
        line: 20,
        severity: "Warning",
        confidence: "Medium",
        message: "Msg2",
        promptForAgents: "",
      },
      {
        file: "c.ts",
        line: 30,
        severity: "Info",
        confidence: "Low",
        message: "Msg3",
        promptForAgents: undefined as any,
      },
    ]);

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 1,
      commit_id: "headSHA",
      event: "COMMENT",
      body: "Summary text",
      comments: [
        {
          path: "a.ts",
          start_line: 10,
          start_side: "RIGHT",
          line: 12,
          side: "RIGHT",
          body: "<!-- maxi-review-inline-comment -->\n**Severity:** 🚨 High | **Confidence:** 🟢 High\n\nMsg\n\n<details>\n<summary>🤖 Prompt for Agents</summary>\n\nFix this issue by doing X\n</details>",
        },
        {
          path: "b.ts",
          line: 20,
          side: "RIGHT",
          body: "<!-- maxi-review-inline-comment -->\n**Severity:** ⚠️ Warning | **Confidence:** 🟡 Medium\n\nMsg2",
        },
        {
          path: "c.ts",
          line: 30,
          side: "RIGHT",
          body: "<!-- maxi-review-inline-comment -->\n**Severity:** ℹ️ Info | **Confidence:** 🔴 Low\n\nMsg3",
        },
      ],
    });
  });

  it("submitReview renders structured replacements as GitHub suggestion fences", async () => {
    const octokit = {
      rest: { pulls: { createReview: vi.fn().mockResolvedValue({}) } },
    } as any;

    await submitReview(octokit, "owner", "repo", 1, "headSHA", "Summary text", [
      {
        file: "a.ts",
        line: 10,
        startLine: 10,
        endLine: 10,
        severity: "Warning",
        confidence: "High",
        message: "Use the safer value.",
        promptForAgents: "",
        suggestedReplacement: "const value = safeValue();",
      },
    ]);

    expect(
      octokit.rest.pulls.createReview.mock.calls[0][0].comments[0].body
    ).toContain(
      "Use the safer value.\n\n```suggestion\nconst value = safeValue();\n```"
    );
  });

  it("submitReview records late feedback as an issue comment when review submission is unavailable", async () => {
    const octokit = {
      rest: {
        pulls: {
          createReview: vi
            .fn()
            .mockRejectedValue(new Error("Pull request is closed")),
        },
        issues: { createComment: vi.fn().mockResolvedValue({}) },
      },
    } as any;

    await submitReview(octokit, "owner", "repo", 1, "headSHA", "Summary text", [
      {
        file: "a.ts",
        line: 10,
        startLine: 10,
        endLine: 12,
        severity: "High",
        confidence: "High",
        message: "Msg\n```suggestion\nconst fixed = true;\n```",
        promptForAgents: "",
      },
    ]);

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 1,
      body: expect.stringContaining("Late Maxi review feedback"),
    });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("a.ts:10"),
      })
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("a.ts:10-12"),
      })
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "```suggestion\nconst fixed = true;\n```"
        ),
      })
    );
  });

  it("setStatus sets commit status", async () => {
    const octokit = {
      rest: { repos: { createCommitStatus: vi.fn().mockResolvedValue({}) } },
    } as any;
    await setStatus(
      octokit,
      "owner",
      "repo",
      "sha",
      "context",
      "success",
      "desc"
    );
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      sha: "sha",
      state: "success",
      context: "context",
      description: "desc",
    });
  });

  it("records harvestable review artifact comments without visible wrapper content", async () => {
    const octokit = {
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({}),
        },
      },
    } as any;

    await recordReviewArtifactComment(
      octokit,
      "owner",
      "repo",
      7,
      "maxi-review-7-head.json",
      '{"schema":"maxi.review.v1.review-artifact"}'
    );

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        issue_number: 7,
      })
    );
    const body = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(body).toContain("<!-- maxi-review artifact -->");
    expect(body).toBe(
      `<!-- maxi-review artifact -->
<!-- maxi-review artifact-data
name: maxi-review-7-head.json
encoding: base64
eyJzY2hlbWEiOiJtYXhpLnJldmlldy52MS5yZXZpZXctYXJ0aWZhY3QifQ==
-->`
    );
  });

  it("lists review artifact comments only from trusted automation authors", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [
              {
                body: "<!-- maxi-review artifact -->\nspoofed",
                user: { login: "contributor", type: "User" },
              },
              {
                body: "<!-- maxi-review artifact -->\nwrong bot",
                user: { login: "other-bot[bot]", type: "Bot" },
              },
              {
                body: "<!-- maxi-review artifact -->\ncurrent app",
                user: { login: "maxi-reviewer[bot]", type: "Bot" },
              },
              {
                body: "<!-- maxi-review artifact -->\nlegacy action",
                user: { login: "github-actions[bot]", type: "Bot" },
              },
            ],
          }),
        },
        users: {
          getAuthenticated: vi.fn().mockResolvedValue({
            data: { login: "maxi-reviewer[bot]" },
          }),
        },
      },
    } as any;

    await expect(
      listReviewArtifactComments(octokit, "owner", "repo", 7)
    ).resolves.toEqual([
      "<!-- maxi-review artifact -->\ncurrent app",
      "<!-- maxi-review artifact -->\nlegacy action",
    ]);
  });

  it("trusts the GitHub Actions actor when authenticated user lookup fails", async () => {
    vi.stubEnv("GITHUB_ACTOR", "custom-reviewer[bot]");
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [
              {
                body: "<!-- maxi-review artifact -->\ncurrent actor",
                user: { login: "custom-reviewer[bot]", type: "Bot" },
              },
              {
                body: "<!-- maxi-review artifact -->\nother bot",
                user: { login: "other-bot[bot]", type: "Bot" },
              },
            ],
          }),
        },
        users: {
          getAuthenticated: vi.fn().mockRejectedValue(new Error("api down")),
        },
      },
    } as any;

    await expect(
      listReviewArtifactComments(octokit, "owner", "repo", 7)
    ).resolves.toEqual(["<!-- maxi-review artifact -->\ncurrent actor"]);
  });
});

describe("fetchExistingFindings", () => {
  const makeOctokit = (nodes: unknown[]) => ({
    graphql: vi.fn().mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes } } },
    }),
  });

  it("returns non-self unresolved findings and skips self and resolved", async () => {
    const octokit = makeOctokit([
      {
        isResolved: false,
        comments: {
          nodes: [
            {
              body: "Self comment",
              path: "a.ts",
              line: 3,
              author: { login: "maxi" },
              viewerDidAuthor: true,
            },
          ],
        },
      },
      {
        isResolved: false,
        comments: {
          nodes: [
            {
              body: "CodeRabbit finding here",
              path: "b.ts",
              line: 7,
              author: { login: "coderabbitai" },
              viewerDidAuthor: false,
            },
          ],
        },
      },
      {
        isResolved: true,
        comments: {
          nodes: [
            {
              body: "Resolved other",
              path: "c.ts",
              line: 9,
              author: { login: "cubic" },
              viewerDidAuthor: false,
            },
          ],
        },
      },
    ]);
    const out = await fetchExistingFindings(octokit as any, "o", "r", 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      author: "coderabbitai",
      path: "b.ts",
      line: 7,
    });
    expect(out[0].body).toContain("CodeRabbit finding");
  });

  it("caps the body length", async () => {
    const big = "y".repeat(700);
    const octokit = makeOctokit([
      {
        isResolved: false,
        comments: {
          nodes: [
            {
              body: big,
              path: "a.ts",
              line: 1,
              author: { login: "codex" },
              viewerDidAuthor: false,
            },
          ],
        },
      },
    ]);
    const out = await fetchExistingFindings(octokit as any, "o", "r", 1, {
      maxBodyChars: 100,
    });
    expect(out[0].body.length).toBe(100);
  });

  it("returns an empty list on a graphql error", async () => {
    const octokit = { graphql: vi.fn().mockRejectedValue(new Error("boom")) };
    const out = await fetchExistingFindings(octokit as any, "o", "r", 1);
    expect(out).toEqual([]);
  });
});
