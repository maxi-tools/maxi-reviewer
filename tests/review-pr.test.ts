/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildArtifactCommentContent,
  fetchPullRequestContext,
  runAnalyzers,
  runReviewPr,
  uploadReviewArtifact,
} from "../src/review-pr.js";

vi.mock("@actions/core");
vi.mock("@actions/github");

function artifactComment(input: {
  headSha: string;
  sessionId?: string;
}): string {
  const encoded = Buffer.from(
    JSON.stringify({
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-06-26T04:07:21.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: input.headSha,
      baseSha: "base-sha",
      analyzerFindings: [],
      rawJulesResponses: [],
      validatedReview: {
        schema: "maxi.review.v1.jules-review",
        summary: "Review summary.",
        verdict: "approve",
        resolvedCommentIds: [],
        comments: [],
      },
      validationErrors: [],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
    "utf8"
  ).toString("base64");
  return `<!-- maxi-review artifact -->
<!-- maxi-review artifact-data
name: maxi-review-7-${input.headSha}.json
encoding: base64
${encoded}
-->`;
}

// A run in which Jules returned a clean, valid review. Only the artifact
// transport varies in the tests that use this.
function completedReviewDeps() {
  return {
    fetchPullRequestContext: vi.fn().mockResolvedValue({
      diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      changedFiles: ["src/a.ts"],
      files: new Map([["src/a.ts", "new\n"]]),
      changedLines: new Map([["src/a.ts", new Set([1])]]),
      rulesFromFile: undefined,
      openThreads: [],
      linkedIssues: [],
    }),
    selectRuleFiles: vi.fn().mockReturnValue(["rules/typescript.md"]),
    loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
    runAnalyzers: vi.fn().mockResolvedValue([]),
    buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
    runJulesReview: vi.fn().mockResolvedValue({
      reviewResult: {
        verdict: "approve",
        summary: "Looks okay.",
        resolvedCommentIds: [],
        newComments: [],
      },
      sessionId: "session-1",
    }),
    submitReview: vi.fn().mockResolvedValue(undefined),
    resolveThreads: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    uploadArtifact: vi.fn().mockResolvedValue(undefined),
    recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
    wrapPermissionError: vi.fn((err: unknown) => err),
  };
}

describe("runReviewPr orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "30";
      return "";
    });
    vi.spyOn(core, "getBooleanInput").mockReturnValue(false);
    vi.spyOn(core, "setSecret").mockImplementation(() => undefined);
    vi.spyOn(core, "info").mockImplementation(() => undefined);
    vi.spyOn(core, "warning").mockImplementation(() => undefined);
    vi.spyOn(core, "error").mockImplementation(() => undefined);
    vi.spyOn(core, "setFailed").mockImplementation(() => undefined);

    (github as any).getOctokit = vi.fn().mockReturnValue({ rest: {} });
    (github as any).context = {
      runId: 101,
      runAttempt: 1,
      job: "review",
      eventName: "pull_request",
      repo: { owner: "maxi", repo: "example" },
      payload: {
        action: "opened",
        pull_request: {
          number: 7,
          head: { sha: "head-sha", repo: { full_name: "maxi/example" } },
          base: { sha: "base-sha", ref: "main" },
          title: "PR title",
          body: "PR body",
          labels: [],
          draft: false,
        },
      },
    };
  });

  it("passes changed files to rules, analyzer findings to prompt, and uploads an artifact", async () => {
    const analyzerFindings = [
      {
        schema: "maxi.review.v1.analyzer-finding" as const,
        id: "f1",
        tool: "opengrep",
        ruleId: "typescript.no-floating-promises",
        severity: "warning" as const,
        confidence: "high" as const,
        message: "Promise is not awaited.",
        path: "src/a.ts",
        startLine: 4,
        endLine: 4,
      },
    ];
    const deps = {
      fetchPullRequestContext: vi.fn().mockResolvedValue({
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        changedFiles: ["src/a.ts", "README.md"],
        files: new Map([["src/a.ts", "new\n"]]),
        changedLines: new Map([["src/a.ts", new Set([1])]]),
        rulesFromFile: undefined,
        openThreads: [],
        linkedIssues: [],
      }),
      selectRuleFiles: vi
        .fn()
        .mockReturnValue(["rules/typescript.md", "rules/markdown.md"]),
      loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
      runAnalyzers: vi.fn().mockResolvedValue(analyzerFindings),
      fetchCiSignal: vi.fn().mockResolvedValue({
        schema: "maxi.review.v1.ci-signal",
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
        ],
        truncated: false,
      }),
      buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "comment",
          summary: "Looks okay.",
          resolvedCommentIds: [],
          newComments: [
            {
              file: "src/a.ts",
              line: 1,
              severity: "Warning",
              confidence: "High",
              message: "Finding.",
              promptForAgents: "Fix the finding.",
            },
          ],
        },
        sessionId: "session-1",
        rawResponses: ["raw response"],
        validationErrors: ["non-applying suggestion"],
      }),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);

    expect(deps.selectRuleFiles).toHaveBeenCalledWith([
      "src/a.ts",
      "README.md",
    ]);
    expect(deps.runAnalyzers).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: ["src/a.ts", "README.md"],
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      })
    );
    expect(deps.buildReviewPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        analyzerFindings,
        rules: "# TypeScript",
      })
    );
    expect(deps.fetchCiSignal).toHaveBeenCalled();
    expect(deps.buildReviewPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        ciSignal: expect.objectContaining({
          schema: "maxi.review.v1.ci-signal",
        }),
      })
    );
    expect(deps.runJulesReview).toHaveBeenCalledWith(
      "jules-key",
      "prompt",
      { github: "maxi/example", baseBranch: "main" },
      30,
      {
        verificationContext: {
          files: new Map([["src/a.ts", "new\n"]]),
          changedLines: new Map([["src/a.ts", new Set([1])]]),
        },
        // Heartbeat that keeps the pending status current while Jules works.
        onProgress: expect.any(Function),
      }
    );
    expect(deps.submitReview).toHaveBeenCalled();
    expect(deps.uploadArtifact).toHaveBeenCalledWith(
      "maxi-review-7-head-sha.json",
      expect.stringContaining('"analyzerFindings"')
    );
    expect(deps.recordReviewArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      7,
      "maxi-review-7-head-sha.json",
      expect.stringContaining('"validationErrors"')
    );
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    const commentArtifact = JSON.parse(
      deps.recordReviewArtifact.mock.calls[0][5]
    );
    expect(artifact).toMatchObject({
      schema: "maxi.review.v1.review-artifact",
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      analyzerFindings,
      rawJulesResponses: ["raw response"],
      validationErrors: ["non-applying suggestion"],
      sessionId: "session-1",
      outcomeSchema: "maxi.review.v1.review-outcome",
      outcome: "REVIEWED_WITH_FINDINGS",
      reviewOutputChars: 12,
      runIdentity: {
        workflowRunId: 101,
        workflowRunAttempt: 1,
        job: "review",
      },
    });
    expect(commentArtifact.rawJulesResponses).toEqual([]);
  });

  it("distinguishes reused sessions by immutable run identity", async () => {
    const deps = {
      fetchPullRequestContext: vi.fn().mockResolvedValue({
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        changedFiles: ["src/a.ts"],
        files: new Map([["src/a.ts", "new\n"]]),
        changedLines: new Map([["src/a.ts", new Set([1])]]),
        rulesFromFile: undefined,
        openThreads: [],
        linkedIssues: [],
      }),
      selectRuleFiles: vi.fn().mockReturnValue(["rules/typescript.md"]),
      loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
      runAnalyzers: vi.fn().mockResolvedValue([]),
      fetchCiSignal: vi.fn().mockResolvedValue(undefined),
      buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "approve",
          summary: "Looks okay.",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "reused-session",
      }),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);
    const firstArtifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);

    (github as any).context.runId = 102;
    (github as any).context.runAttempt = 2;
    (github as any).context.payload.pull_request.number = 8;
    (github as any).context.payload.pull_request.head.sha = "retry-head-sha";

    await runReviewPr(deps);
    const retryArtifact = JSON.parse(deps.uploadArtifact.mock.calls[1][1]);

    expect(firstArtifact).toMatchObject({
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
      sessionId: "reused-session",
      runIdentity: {
        workflowRunId: 101,
        workflowRunAttempt: 1,
        job: "review",
      },
    });
    expect(retryArtifact).toMatchObject({
      repoFullName: "maxi/example",
      prNumber: 8,
      headSha: "retry-head-sha",
      sessionId: "reused-session",
      runIdentity: {
        workflowRunId: 102,
        workflowRunAttempt: 2,
        job: "review",
      },
    });
    expect(retryArtifact.runIdentity).not.toEqual(firstArtifact.runIdentity);
  });

  it("continues when recording the artifact comment fails", async () => {
    const deps = {
      fetchPullRequestContext: vi.fn().mockResolvedValue({
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        changedFiles: ["src/a.ts"],
        files: new Map([["src/a.ts", "new\n"]]),
        changedLines: new Map([["src/a.ts", new Set([1])]]),
        rulesFromFile: undefined,
        openThreads: [],
        linkedIssues: [],
      }),
      selectRuleFiles: vi.fn().mockReturnValue(["rules/typescript.md"]),
      loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
      runAnalyzers: vi.fn().mockResolvedValue([]),
      buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "approve",
          summary: "Looks okay.",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "session-1",
      }),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      recordReviewArtifact: vi.fn().mockRejectedValue(new Error("too large")),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);

    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact).toMatchObject({
      outcomeSchema: "maxi.review.v1.review-outcome",
      outcome: "REVIEWED_NO_FINDINGS",
      reviewOutputChars: 0,
    });
    expect(deps.submitReview).toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "success",
      "Review complete (verdict: approve)"
    );
    expect(core.warning).toHaveBeenCalledWith(
      "Failed to record review artifact comment: Error: too large"
    );
  });

  it("continues when artifact storage is unavailable", async () => {
    const deps = {
      ...completedReviewDeps(),
      uploadArtifact: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to CreateArtifact: Artifact storage quota has been hit."
          )
        ),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
    };

    await runReviewPr(deps);

    // The verdict still reaches the PR: storage capacity is not a property of
    // the code under review.
    expect(deps.submitReview).toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "success",
      "Review complete (verdict: approve)"
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to upload review artifact")
    );
  });

  it("fails when neither artifact channel records the review", async () => {
    const deps = {
      ...completedReviewDeps(),
      uploadArtifact: vi
        .fn()
        .mockRejectedValue(new Error("Artifact storage quota has been hit.")),
      recordReviewArtifact: vi.fn().mockRejectedValue(new Error("too large")),
    };

    await runReviewPr(deps);

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("could not be recorded")
    );
    expect(deps.submitReview).not.toHaveBeenCalled();
  });

  it("still fails a review that could not be produced, artifacts aside", async () => {
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: undefined,
        sessionId: "session-1",
      }),
      uploadArtifact: vi
        .fn()
        .mockRejectedValue(new Error("Artifact storage quota has been hit.")),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
    };

    await runReviewPr(deps);

    // Tolerating the transport must never tolerate a missing review: the
    // no-review verdict still reaches the commit status unchanged, and no
    // review is submitted as if one had been produced.
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "failure",
      "Review timed out; see harvested artifact"
    );
    expect(deps.submitReview).not.toHaveBeenCalled();
  });

  it("passes the latest recorded Jules session id into the review request", async () => {
    const deps = {
      fetchPullRequestContext: vi.fn().mockResolvedValue({
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        changedFiles: ["src/a.ts"],
        files: new Map([["src/a.ts", "new\n"]]),
        changedLines: new Map([["src/a.ts", new Set([1])]]),
        rulesFromFile: undefined,
        openThreads: [],
        linkedIssues: [],
      }),
      selectRuleFiles: vi.fn().mockReturnValue(["rules/typescript.md"]),
      loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
      runAnalyzers: vi.fn().mockResolvedValue([]),
      buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "approve",
          summary: "Looks okay.",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "continued-session",
      }),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
      listReviewArtifactComments: vi.fn().mockResolvedValue([
        artifactComment({ headSha: "older-head", sessionId: "old-session" }),
        artifactComment({
          headSha: "previous-head",
          sessionId: "prev-session",
        }),
      ]),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);

    expect(deps.listReviewArtifactComments).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      7
    );
    expect(deps.runJulesReview).toHaveBeenCalledWith(
      "jules-key",
      "prompt",
      { github: "maxi/example", baseBranch: "main" },
      30,
      {
        verificationContext: {
          files: new Map([["src/a.ts", "new\n"]]),
          changedLines: new Map([["src/a.ts", new Set([1])]]),
        },
        previousSessionId: "prev-session",
        onProgress: expect.any(Function),
      }
    );
  });

  it("records a harvestable artifact without failing when Jules times out", async () => {
    const deps = {
      fetchPullRequestContext: vi.fn().mockResolvedValue({
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        changedFiles: ["src/a.ts"],
        files: new Map([["src/a.ts", "new\n"]]),
        changedLines: new Map([["src/a.ts", new Set([1])]]),
        rulesFromFile: undefined,
        openThreads: [],
        linkedIssues: [],
      }),
      selectRuleFiles: vi.fn().mockReturnValue(["rules/typescript.md"]),
      loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
      runAnalyzers: vi.fn().mockResolvedValue([]),
      buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "session-1",
        rawResponses: [],
        validationErrors: [],
      }),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);

    expect(deps.uploadArtifact).toHaveBeenCalledWith(
      "maxi-review-7-head-sha.json",
      expect.any(String)
    );
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact).toMatchObject({
      validatedReview: null,
      outcomeSchema: "maxi.review.v1.review-outcome",
      outcome: "TIMED_OUT_NO_CONTENT",
      reviewOutputChars: 0,
      runIdentity: {
        workflowRunId: 101,
        workflowRunAttempt: 1,
        job: "review",
      },
      retention: {
        harvestableAfterMerge: true,
      },
    });
    expect(deps.recordReviewArtifact).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      7,
      "maxi-review-7-head-sha.json",
      expect.any(String)
    );
    const commentArtifact = JSON.parse(
      deps.recordReviewArtifact.mock.calls[0][5]
    );
    expect(commentArtifact.retention.harvestableAfterMerge).toBe(true);
    expect(deps.submitReview).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "failure",
      "Review timed out; see harvested artifact"
    );
    expect(core.warning).toHaveBeenCalledWith(
      "Jules returned no review message within 30 minutes; recorded a harvestable review artifact."
    );
    expect(core.setFailed).toHaveBeenCalledWith(
      "Jules returned no review message within 30 minutes."
    );
  });
});

describe("uploadReviewArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes artifact content to a temporary file and uploads it", async () => {
    const uploadedFiles: string[] = [];
    const uploader = {
      uploadArtifact: vi.fn(async (_name: string, files: string[]) => {
        uploadedFiles.push(...files);
        expect(readFileSync(files[0], "utf8")).toBe('{"ok":true}');
        return { id: 42, size: 11 };
      }),
    };

    await uploadReviewArtifact(
      "maxi-review-7-head.json",
      '{"ok":true}',
      uploader
    );

    expect(uploader.uploadArtifact).toHaveBeenCalledWith(
      "maxi-review-7-head.json",
      [expect.stringContaining("maxi-review-7-head.json")],
      expect.stringContaining("maxi-review-"),
      { retentionDays: 90 }
    );
    expect(() => readFileSync(uploadedFiles[0], "utf8")).toThrow();
    expect(core.info).toHaveBeenCalledWith(
      "Uploaded review artifact maxi-review-7-head.json (11 bytes, id 42)."
    );
  });
});

describe("buildArtifactCommentContent", () => {
  it("returns non-object JSON content unchanged", () => {
    expect(buildArtifactCommentContent("null")).toBe("null");
    expect(buildArtifactCommentContent('"text"')).toBe('"text"');
  });

  it("removes bulky raw Jules responses from object artifacts", () => {
    const content = JSON.stringify({
      schema: "maxi.review.v1.review-artifact",
      rawJulesResponses: ["large"],
      validatedReview: { comments: [] },
    });

    expect(JSON.parse(buildArtifactCommentContent(content))).toMatchObject({
      schema: "maxi.review.v1.review-artifact",
      rawJulesResponses: [],
      validatedReview: { comments: [] },
    });
  });
});

describe("fetchPullRequestContext", () => {
  it("loads changed file contents and changed new-side lines for verification", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -10 +10 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const octokit = {
      rest: {
        repos: {
          compareCommitsWithBasehead: vi.fn().mockResolvedValue({ data: diff }),
          getContent: vi.fn(async ({ path }: { path: string }) => ({
            data: {
              content: Buffer.from(
                path === "src/a.ts" ? "const a = 1;\nconst b = 3;\n" : "new\n"
              ).toString("base64"),
            },
          })),
        },
      },
      graphql: vi.fn().mockResolvedValue({
        repository: { pullRequest: { reviewThreads: { nodes: [] } } },
      }),
    } as any;

    const context = await fetchPullRequestContext({
      octokit,
      owner: "maxi",
      repo: "example",
      pr: { number: 7 },
      baseSha: "base",
      baseShaForDiff: "base",
      headSha: "head",
      rulesFilePath: "",
    });

    expect(context.changedFiles).toEqual(["src/a.ts", "README.md"]);
    expect(context.files).toEqual(
      new Map([
        ["src/a.ts", "const a = 1;\nconst b = 3;\n"],
        ["README.md", "new\n"],
      ])
    );
    expect(context.changedLines).toEqual(
      new Map([
        ["src/a.ts", new Set([2])],
        ["README.md", new Set([10])],
      ])
    );
  });
});

describe("runAnalyzers", () => {
  it("normalizes configured analyzer output files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maxi-review-analyzers-"));
    const semgrepJson = join(dir, "semgrep.json");
    const pmdXml = join(dir, "pmd.xml");
    writeFileSync(
      semgrepJson,
      readFileSync(new URL("fixtures/semgrep.json", import.meta.url), "utf8")
    );
    writeFileSync(
      pmdXml,
      readFileSync(new URL("fixtures/pmd.xml", import.meta.url), "utf8")
    );

    const findings = await runAnalyzers({
      changedFiles: ["src/a.ts", "src/Main.java"],
      diff: "",
      analyzerOutputPaths: { opengrepJson: semgrepJson, pmdXml },
    });

    expect(findings.map((finding) => finding.tool)).toEqual([
      "opengrep",
      "pmd",
    ]);
  });

  it("runs external analyzers in auto mode when output files are not configured", async () => {
    const semgrepFixture = readFileSync(
      new URL("fixtures/semgrep.json", import.meta.url),
      "utf8"
    );
    const pmdFixture = readFileSync(
      new URL("fixtures/pmd.xml", import.meta.url),
      "utf8"
    );
    const cpdFixture = readFileSync(
      new URL("fixtures/cpd.xml", import.meta.url),
      "utf8"
    );
    const commands: string[][] = [];

    const findings = await runAnalyzers({
      changedFiles: ["src/a.ts", "src/Main.java"],
      diff: "",
      executeAnalyzer: async (command, args) => {
        commands.push([command, ...args]);
        if (command === "opengrep") return semgrepFixture;
        if (command === "pmd" && args[0] === "check") return pmdFixture;
        if (command === "pmd" && args[0] === "cpd") return cpdFixture;
        return "";
      },
    });

    expect(commands).toEqual([
      [
        "opengrep",
        "scan",
        "--json",
        "--metrics",
        "off",
        "--disable-version-check",
        ".",
      ],
      [
        "pmd",
        "check",
        "--format",
        "xml",
        "--dir",
        ".",
        "--rulesets",
        "category/java/bestpractices.xml",
      ],
      [
        "pmd",
        "cpd",
        "--format",
        "xml",
        "--dir",
        ".",
        "--minimum-tokens",
        "100",
      ],
    ]);
    expect(findings.map((finding) => finding.tool)).toEqual([
      "opengrep",
      "pmd",
      "cpd",
      "cpd",
    ]);
  });

  it("skips optional auto analyzers that are not installed", async () => {
    const warning = vi.spyOn(core, "warning");
    const findings = await runAnalyzers({
      changedFiles: ["src/a.ts", "src/Main.java"],
      diff: "",
      executeAnalyzer: async () => {
        const err = new Error("spawn opengrep ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });

    expect(findings).toEqual([]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Optional analyzer command not found")
    );
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining("Analyzer command failed")
    );
  });
});
