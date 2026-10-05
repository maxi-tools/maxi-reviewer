/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildArtifactCommentContent,
  emptyReviewExplanation,
  emptyReviewStatus,
  extractChangedFiles,
  extractChangedLines,
  fetchPullRequestContext,
  isBlankReviewBody,
  latestReviewArtifactSessionId,
  reviewTimeoutExplanation,
  reviewTimeoutStatus,
  reviewerUnavailableError,
  reviewerUnavailableExplanation,
  reviewerUnavailableStatus,
  runAnalyzers,
  runReviewPr,
  uploadReviewArtifact,
} from "../src/review-pr.js";
import { SessionStuckInSetupError } from "../src/jules.js";

vi.mock("@actions/core");
vi.mock("@actions/github");

function artifactComment(input: {
  headSha: string;
  sessionId?: string;
  outcome?: "EMPTY_REVIEW_BODY";
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
      rawJulesResponses: input.outcome ? ["partial response"] : [],
      validatedReview: input.outcome
        ? null
        : {
            schema: "maxi.review.v1.jules-review",
            summary: "Review summary.",
            verdict: "approve",
            resolvedCommentIds: [],
            comments: [],
          },
      validationErrors: [],
      ...(input.outcome
        ? {
            outcomeSchema: "maxi.review.v1.review-outcome",
            outcome: input.outcome,
            outcomeReason: "No review body was produced",
            reviewOutputChars: 16,
            runIdentity: {
              workflowRunId: 101,
              workflowRunAttempt: 1,
              job: "review",
            },
          }
        : {}),
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

    vi.mocked(github.getOctokit).mockReturnValue({ rest: {} } as ReturnType<
      typeof github.getOctokit
    >);
    (github as typeof github & { context: typeof github.context }).context = {
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
      "No review after 30 min: Jules never replied. Reviewer timeout, not a code finding — re-runs often pass."
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

  it("reports a stuck session as its own failure, not as a timeout", async () => {
    // The two look identical from the PR page today -- both end as "no review"
    // -- and they call for opposite responses: a timeout is worth re-running,
    // a session that never finished cloning is worth recreating elsewhere.
    // Observed 2026-09-10: session 9532304781847968824 sat in `Cloning
    // maxi-tools/maxi-core` for over two hours on an unthrottled account.
    const stuck = new SessionStuckInSetupError("sess-9", "QUEUED", 300_000);
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
      runJulesReview: vi.fn().mockRejectedValue(stuck),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      recordReviewArtifact: vi.fn().mockResolvedValue(undefined),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);

    // Both planned attempts were spent before giving up.
    expect(deps.runJulesReview).toHaveBeenCalledTimes(2);
    expect(deps.submitReview).not.toHaveBeenCalled();

    const failure = vi.mocked(core.setFailed).mock.calls.at(-1)?.[0] as string;
    expect(failure).toContain("never left QUEUED");
    expect(failure).toContain("clone/setup did not finish");
    expect(failure).not.toContain(reviewTimeoutExplanation(30));

    // "error", not "failure": the reviewer never ran, so there is no verdict.
    const status = deps.setStatus.mock.calls.at(-1);
    expect(status?.[5]).toBe("error");
    expect(status?.[6]).toContain("never left QUEUED");
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
      // A harvested timeout is unreadable without the budget it was judged
      // against, and "timed out" alone reads as a verdict on the code.
      timeoutMinutes: 30,
      // Tracks the function rather than restating it: the point of this
      // assertion is that the harvested artifact carries the SAME explanation
      // the failing job and the commit status carry, not that the sentence
      // reads any particular way. Copying the prose here just meant editing it
      // in two places and calling that a test. `review timeout wording` below
      // is what pins the content.
      outcomeReason: reviewTimeoutExplanation(30),
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
      "No review after 30 min: Jules never replied. Reviewer timeout, not a code finding — re-runs often pass."
    );
    expect(core.warning).toHaveBeenCalledWith(
      `${reviewTimeoutExplanation(30)} Recorded a harvestable review artifact.`
    );
    expect(core.setFailed).toHaveBeenCalledWith(reviewTimeoutExplanation(30));
  });

  it("falls back to the OpenAI-compatible reviewer when Jules returns no review", async () => {
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://jasper:8000/v1";
      if (name === "openai_model") return "Qwen/Qwen3-Coder-30B-A3B-Instruct";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      buildReviewPrompt: vi.fn().mockReturnValue("review this diff"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
        rawResponses: [],
      }),
      runOpenAiReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "comment",
          summary: "Qwen found a panic.",
          resolvedCommentIds: [],
          newComments: [
            {
              file: "src/a.ts",
              line: 1,
              severity: "Warning",
              confidence: "High",
              message: "unwrap panics.",
              promptForAgents: "Return a Result.",
            },
          ],
        },
        sessionId: "openai:Qwen/Qwen3-Coder-30B-A3B-Instruct",
        rawResponses: ['{"verdict":"comment"}'],
      }),
    };

    await runReviewPr(deps);

    expect(deps.runJulesReview).toHaveBeenCalledTimes(1);
    expect(deps.runOpenAiReview).toHaveBeenCalledWith(
      "review this diff",
      expect.objectContaining({
        baseUrl: "http://jasper:8000/v1",
        model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        timeoutMinutes: 8,
      }),
      expect.any(Object)
    );
    expect(deps.submitReview).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      7,
      "head-sha",
      expect.stringContaining("Qwen found a panic."),
      [
        expect.objectContaining({
          file: "src/a.ts",
          line: 1,
          message: "unwrap panics.",
        }),
      ]
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("REVIEWED_WITH_FINDINGS");
    expect(artifact.sessionId).toMatch(/^openai:/);
    expect(artifact.validationErrors[0]).toMatch(
      /review produced by .*openai:Qwen\/Qwen3-Coder-30B-A3B-Instruct/
    );
  });

  it("does not call the fallback when Jules produced a review", async () => {
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "30";
      if (name === "openai_base_url") return "http://jasper:8000/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runOpenAiReview: vi.fn(),
    };

    await runReviewPr(deps);

    expect(deps.runJulesReview).toHaveBeenCalledTimes(1);
    expect(deps.runOpenAiReview).not.toHaveBeenCalled();
  });

  it("uses the OpenAI backend instead of Jules when it is the selected roster reviewer", async () => {
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "30";
      if (name === "reviewer_backend") return "qwen";
      if (name === "openai_base_url") return "http://pearl:8000/v1/";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn(),
      runOpenAiReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "approve",
          summary: "Roster review.",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "openai:Qwen/Qwen3-Coder-30B-A3B-Instruct",
        rawResponses: ["{}"],
      }),
    };

    await runReviewPr(deps);

    expect(deps.runJulesReview).not.toHaveBeenCalled();
    expect(deps.runOpenAiReview).toHaveBeenCalledWith(
      "prompt",
      expect.objectContaining({ baseUrl: "http://pearl:8000/v1" }),
      expect.any(Object)
    );
    expect(deps.submitReview).toHaveBeenCalled();
    expect(deps.setStatus.mock.calls[0][6]).toContain("Qwen is reviewing");
  });

  it("fails the gate as reviewer-unavailable when every configured fallback returns nothing", async () => {
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://jasper:8000/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "openai:timeout:Qwen/Qwen3-Coder-30B-A3B-Instruct",
      }),
    };

    await runReviewPr(deps);

    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(1);
    expect(deps.submitReview).not.toHaveBeenCalled();
    // `setFailed` now carries the reviewer-unavailable text, distinct from
    // the Jules-timeout text that used to be substituted here. The Jules
    // timeout framing was misleading once the chain has been walked: the
    // cause is the chain, and the artifact records which endpoints failed.
    const failureText = vi
      .mocked(core.setFailed)
      .mock.calls.map((call) => call[0] as string)
      .join("\n");
    expect(failureText).toMatch(/reviewer-infrastructure failure/);
    expect(failureText).not.toMatch(/Jules never replied/);
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("TIMED_OUT_NO_CONTENT");
    expect(artifact.sessionId).toMatch(/^openai:all-unavailable:/);
    // Every attempt's failure mode is preserved on the artifact so the
    // on-call can see whether each endpoint timed out, errored, or returned
    // an unparseable body. With a single configured endpoint we use the
    // generic label rather than the URL; the failure mode itself is still
    // surfaced.
    expect(artifact.validationErrors.join("\n")).toMatch(
      /OpenAI-compatible .* returned no review/
    );
  });

  it("walks the fallback chain to a second endpoint when the first one is down", async () => {
    // maxi-config#1028: pearl was offline ~7h; without a second endpoint, every
    // PR whose Jules session was silent for 15 minutes had no review left. The
    // fallback chain must reach the second slot when the first is unreachable.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      if (name === "openai_fallback_base_url")
        return "https://api.example.com/v1";
      if (name === "openai_fallback_api_key") return "hosted-key";
      if (name === "openai_fallback_model")
        return "moonshotai/Kimi-K2-Instruct";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi
        .fn()
        .mockImplementationOnce(async () => ({
          // pearl: simulate a fetch failure by returning no review with the
          // timeout-style session id and the validationErrors that the
          // OpenAI-compatible review path emits when the first turn times out.
          reviewResult: null,
          sessionId: "openai:timeout:Qwen3-Coder-Next",
          validationErrors: [
            "OpenAI-compatible review produced no reply within 8 minutes.",
          ],
        }))
        .mockResolvedValueOnce({
          reviewResult: {
            verdict: "comment",
            summary: "Kimi found an issue.",
            resolvedCommentIds: [],
            newComments: [
              {
                file: "src/a.ts",
                line: 1,
                severity: "Warning",
                confidence: "High",
                message: "Hot path unwrap.",
                promptForAgents: "Return Result.",
              },
            ],
          },
          sessionId: "openai:moonshotai/Kimi-K2-Instruct",
        }),
    };

    await runReviewPr(deps);

    // Both slots were tried, in order. pearl first, then the hosted endpoint.
    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(2);
    expect(deps.runOpenAiReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({ baseUrl: "http://pearl:8000/v1" })
    );
    expect(deps.runOpenAiReview.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        baseUrl: "https://api.example.com/v1",
        model: "moonshotai/Kimi-K2-Instruct",
      })
    );
    // The second attempt produced the review, so the gate stays green.
    expect(deps.submitReview).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("REVIEWED_WITH_FINDINGS");
    expect(artifact.sessionId).toBe("openai:moonshotai/Kimi-K2-Instruct");
  });

  it("records each chain attempt's failure mode on the artifact when the chain exhausts", async () => {
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      if (name === "openai_fallback_base_url")
        return "https://api.example.com/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi
        .fn()
        .mockResolvedValueOnce({
          reviewResult: null,
          sessionId: "openai:timeout:Qwen3-Coder-Next",
          validationErrors: ["fetch failed"],
        })
        .mockResolvedValueOnce({
          reviewResult: null,
          sessionId: "openai:timeout:moonshotai/Kimi-K2-Instruct",
          validationErrors: ["503 service unavailable"],
        }),
    };

    await runReviewPr(deps);

    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(2);
    expect(deps.submitReview).not.toHaveBeenCalled();
    const failureText = vi
      .mocked(core.setFailed)
      .mock.calls.map((call) => call[0] as string)
      .join("\n");
    expect(failureText).toMatch(/reviewer-infrastructure failure/);
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.sessionId).toMatch(/^openai:all-unavailable:/);
    const joined = artifact.validationErrors.join("\n");
    expect(joined).toContain("fetch failed");
    expect(joined).toContain("503 service unavailable");
  });

  it("advances to the next endpoint when the primary throws a transport error", async () => {
    // PR #182: a 5xx, a network error, or an empty 200 body from the primary
    // must NOT short-circuit the chain. The next configured endpoint gets
    // a turn. Today (2a9e869) the throw escapes `runOneOpenAiBackend` and
    // kills the whole run, stranding the PR.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      if (name === "openai_fallback_base_url")
        return "https://api.example.com/v1";
      if (name === "openai_fallback_api_key") return "hosted-key";
      if (name === "openai_fallback_model")
        return "moonshotai/Kimi-K2-Instruct";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "OpenAI-compatible review endpoint returned 503: service unavailable"
          )
        )
        .mockResolvedValueOnce({
          reviewResult: {
            verdict: "comment",
            summary: "Kimi found an issue.",
            resolvedCommentIds: [],
            newComments: [
              {
                file: "src/a.ts",
                line: 1,
                severity: "Warning",
                confidence: "High",
                message: "Hot path unwrap.",
                promptForAgents: "Return Result.",
              },
            ],
          },
          sessionId: "openai:moonshotai/Kimi-K2-Instruct",
        }),
    };

    await runReviewPr(deps);

    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(2);
    expect(deps.runOpenAiReview.mock.calls[0][1]).toEqual(
      expect.objectContaining({ baseUrl: "http://pearl:8000/v1" })
    );
    expect(deps.runOpenAiReview.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        baseUrl: "https://api.example.com/v1",
        model: "moonshotai/Kimi-K2-Instruct",
      })
    );
    expect(deps.submitReview).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("REVIEWED_WITH_FINDINGS");
  });

  it("advances to the next endpoint when the primary returns an empty 200 body", async () => {
    // PR #182: a 200 with an empty `choices[0].message.content` must NOT
    // short-circuit the chain. The next configured endpoint gets a turn.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      if (name === "openai_fallback_base_url")
        return "https://api.example.com/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "OpenAI-compatible review endpoint returned no assistant message."
          )
        )
        .mockResolvedValueOnce({
          reviewResult: {
            verdict: "comment",
            summary: "Fallback review.",
            resolvedCommentIds: [],
            newComments: [],
          },
          sessionId: "openai:moonshotai/Kimi-K2-Instruct",
        }),
    };

    await runReviewPr(deps);

    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(2);
    expect(deps.submitReview).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("advances to the next endpoint when the primary's fetch fails (network error)", async () => {
    // PR #182: a fetch failure (`ECONNREFUSED`, DNS, etc.) on the primary
    // must NOT short-circuit the chain. The next configured endpoint
    // gets a turn.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      if (name === "openai_fallback_base_url")
        return "https://api.example.com/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "OpenAI-compatible review request failed: fetch failed (ECONNREFUSED)"
          )
        )
        .mockResolvedValueOnce({
          reviewResult: {
            verdict: "comment",
            summary: "Fallback review.",
            resolvedCommentIds: [],
            newComments: [],
          },
          sessionId: "openai:moonshotai/Kimi-K2-Instruct",
        }),
    };

    await runReviewPr(deps);

    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(2);
    expect(deps.submitReview).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("fails closed with 'reviewer unavailable' when every endpoint returns an unparseable review", async () => {
    // PR #182: a garbled initial and repair reply on the primary used to
    // be reported as a synthetic "no valid comments" review and the gate
    // was locked green (REVIEWED_NO_FINDINGS) for code that was never
    // actually reviewed. With a second endpoint also garbled, the run
    // must setFailed with the reviewer-unavailable text and never call
    // submitReview. The artifact records the parse failure mode.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      if (name === "openai_fallback_base_url")
        return "https://api.example.com/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi
        .fn()
        .mockResolvedValueOnce({
          // Garbled on both turns: the first call returns the
          // unparseableReview-equivalent null (the chain advances).
          reviewResult: null,
          sessionId: "openai:Qwen/Qwen3-Coder-30B-A3B-Instruct",
          validationErrors: [
            "Failed to parse OpenAI-compatible review: Unexpected token",
            "Failed to parse repaired OpenAI-compatible review: Unexpected token",
          ],
        })
        .mockResolvedValueOnce({
          reviewResult: null,
          sessionId: "openai:moonshotai/Kimi-K2-Instruct",
          validationErrors: [
            "Failed to parse OpenAI-compatible review: Unexpected token",
            "Failed to parse repaired OpenAI-compatible review: Unexpected token",
          ],
        }),
    };

    await runReviewPr(deps);

    // Both slots were tried; no review was published.
    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(2);
    expect(deps.submitReview).not.toHaveBeenCalled();
    const failureText = vi
      .mocked(core.setFailed)
      .mock.calls.map((call) => call[0] as string)
      .join("\n");
    expect(failureText).toMatch(/reviewer-infrastructure failure/);
    expect(failureText).not.toMatch(/Jules never replied/);
    // The artifact records TIMED_OUT_NO_CONTENT (no review was ever produced)
    // and the chain-exhausted session id, distinct from a bare Jules
    // timeout.
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("TIMED_OUT_NO_CONTENT");
    expect(artifact.sessionId).toMatch(/^openai:all-unavailable:/);
    // The parse errors are preserved on the artifact so the on-call can
    // see why each slot was rejected, and the reason is the
    // reviewer-unavailable text, not the Jules-timeout text.
    expect(artifact.validationErrors.join("\n")).toMatch(/parse/i);
    expect(artifact.outcomeReason).toMatch(/reviewer-infrastructure failure/);
  });

  it("never logs or publishes the full endpoint URL with credentials, path, or query", async () => {
    // PR #182: a baseUrl of the form
    //   http://user:pass@host.example:8000/v1/private?token=secret
    // must never reach a log line, the status description, the comment
    // body, or the harvestable artifact. The host alone (`host.example:8000`)
    // is the only endpoint identity that should appear.
    const sensitiveUrl =
      "http://user:pass@host.example:8000/v1/private?token=secret";
    const sensitiveFragments = [
      "user:pass",
      "/private",
      "token=secret",
      "host.example/v1", // path-included host leakage from the old summary
    ];
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "15";
      if (name === "openai_base_url") return sensitiveUrl;
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: null,
        sessionId: "jules-session",
      }),
      runOpenAiReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "comment",
          summary: "Review produced.",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "openai:Qwen/Qwen3-Coder-30B-A3B-Instruct",
      }),
    };

    await runReviewPr(deps);

    // Scan every channel the verifier identified: logs, status text,
    // uploaded artifact, harvested comment.
    const infoCalls = vi
      .mocked(core.info)
      .mock.calls.map((call) => String(call[0] ?? ""));
    const warningCalls = vi
      .mocked(core.warning)
      .mock.calls.map((call) => String(call[0] ?? ""));
    const errorCalls = vi
      .mocked(core.error)
      .mock.calls.map((call) => String(call[0] ?? ""));
    const failedCalls = vi
      .mocked(core.setFailed)
      .mock.calls.map((call) => String(call[0] ?? ""));
    const statusDescriptions = deps.setStatus.mock.calls.map((call) =>
      String(call[6] ?? "")
    );
    const artifactJson = String(deps.uploadArtifact.mock.calls[0]?.[1] ?? "");
    const artifactCommentBody = String(
      deps.recordReviewArtifact.mock.calls[0]?.[5] ?? ""
    );
    const collectedText = [
      ...infoCalls,
      ...warningCalls,
      ...errorCalls,
      ...failedCalls,
      ...statusDescriptions,
      artifactJson,
      artifactCommentBody,
    ].join("\n");

    for (const fragment of sensitiveFragments) {
      expect(collectedText, `leak of "${fragment}"`).not.toContain(fragment);
    }
    // The host must still be visible: a redacted-only log that names no
    // endpoint is its own bug. Verify the bare host is present.
    expect(collectedText).toContain("host.example:8000");
  });

  it("fails closed when the single-slot openai backend throws on transport", async () => {
    // The explicit `reviewer_backend=openai` roster entry is a
    // single-slot path: the run is asking for one endpoint as the sole
    // reviewer. A transport error from that endpoint must NOT crash the
    // job; the run must fail the check (no review) rather than report
    // success for code that was never reviewed.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "never";
      if (name === "timeout_minutes") return "30";
      if (name === "reviewer_backend") return "qwen";
      if (name === "openai_base_url") return "http://pearl:8000/v1";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn(),
      runOpenAiReview: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "OpenAI-compatible review endpoint returned 503: service unavailable"
          )
        ),
    };

    await runReviewPr(deps);

    expect(deps.runOpenAiReview).toHaveBeenCalledTimes(1);
    expect(deps.submitReview).not.toHaveBeenCalled();
    const failureText = vi
      .mocked(core.setFailed)
      .mock.calls.map((call) => call[0] as string)
      .join("\n");
    // The Jules-timeout text would be misleading here: the single-slot
    // openai backend failed, not Jules. The reviewer-unavailable text is
    // the right description.
    expect(failureText).not.toMatch(/Jules never replied/);
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("TIMED_OUT_NO_CONTENT");
    expect(artifact.sessionId).toMatch(/^openai:all-unavailable:/);
    // The 503 is preserved (with the URL sanitised to the host).
    expect(artifact.validationErrors.join("\n")).toMatch(/503/);
    expect(artifact.validationErrors.join("\n")).toContain("pearl:8000");
  });

  it("does not block on a finding outside the PR diff", async () => {
    // #91: a 2-line PR got a blocking failure from findings in a file the PR
    // never touched. fail_on=blocking is the default, so this is the path the
    // issue hit.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "blocking";
      if (name === "timeout_minutes") return "30";
      return "";
    });
    const deps = {
      ...completedReviewDeps(),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "block",
          summary: "Blocking issues found in ci.yml.",
          resolvedCommentIds: [],
          newComments: [
            {
              file: ".github/workflows/ci.yml",
              line: 118,
              severity: "High",
              confidence: "High",
              message: "Workflow condition is wrong.",
              promptForAgents: "Fix it",
            },
          ],
        },
        sessionId: "session-1",
      }),
    };

    await runReviewPr(deps);

    // The out-of-diff finding is never posted...
    expect(deps.submitReview.mock.calls[0][6]).toEqual([]);
    expect(deps.submitReview.mock.calls[0][5]).not.toContain("ci.yml");
    // ...and with it scoped out, the check passes instead of reporting
    // "Blocking issues found"...
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "success",
      "Review complete (verdict: comment)"
    );
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "failure",
      "Blocking issues found"
    );
    // ...while the dropped finding stays visible on the harvestable artifact.
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.validatedReview.verdict).toBe("comment");
    expect(artifact.droppedComments).toEqual([
      expect.objectContaining({
        file: ".github/workflows/ci.yml",
        message: "Workflow condition is wrong.",
        severity: "High",
      }),
    ]);
    expect(artifact.validationErrors).toContainEqual(
      expect.stringContaining(
        "out-of-diff finding dropped: .github/workflows/ci.yml:118"
      )
    );

    // The same pipeline must pass fail_on=any when no in-diff finding remains.
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      if (name === "fail_on") return "any";
      if (name === "timeout_minutes") return "30";
      return "";
    });
    await runReviewPr(deps);
    expect(deps.setStatus.mock.lastCall?.[5]).toBe("success");
    expect(deps.setStatus.mock.lastCall?.[6]).toContain("No in-diff findings");
  });
});

describe("quoted diff paths", () => {
  it("decodes Git octal-quoted UTF-8 filenames", () => {
    const diff =
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n@@ -0,0 +1 @@\n+new\n';
    expect(extractChangedFiles(diff)).toEqual(["café.ts"]);
  });

  it("records added line numbers for octal-quoted UTF-8 filenames", () => {
    const diff =
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n@@ -0,0 +1,2 @@\n+first\n+second\n';
    const lines = extractChangedLines(diff);
    expect(lines.has("café.ts")).toBe(true);
    expect([...lines.get("café.ts")!].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("review timeout wording", () => {
  // The budget has already moved 30 -> 10 -> 15. A minute count written as a
  // literal on any of these surfaces would have been wrong twice over, on the
  // one line a blocked author actually reads.
  it.each([10, 15, 30, 45])(
    "states the configured %i-minute budget everywhere it appears",
    (minutes) => {
      const status = reviewTimeoutStatus(minutes);
      const explanation = reviewTimeoutExplanation(minutes);

      expect(status).toContain(`${minutes} min`);
      expect(explanation).toContain(`within ${minutes} minutes`);
      expect(explanation).toContain(`${minutes}-minute budget`);

      // And no other budget survives from a copied literal.
      for (const stale of [10, 15, 30, 45].filter((m) => m !== minutes)) {
        expect(status).not.toContain(String(stale));
        expect(explanation).not.toContain(String(stale));
      }
    }
  );

  it("says no review exists, that this is not a finding, and that re-running helps", () => {
    const status = reviewTimeoutStatus(15);
    expect(status).toContain("No review");
    expect(status).toContain("not a code finding");
    expect(status).toContain("re-runs often pass");

    const explanation = reviewTimeoutExplanation(15);
    expect(explanation).toContain("no review was produced");
    expect(explanation).toContain("not a verdict on the code");
    expect(explanation).toContain("re-running this job often succeeds");
  });

  it("keeps the status line inside GitHub's 140-character limit", () => {
    // Silent truncation past 140 would eat the tail of the sentence — which is
    // where "re-runs often pass", the only actionable part, lives.
    for (const minutes of [1, 15, 1440, 35791]) {
      expect(reviewTimeoutStatus(minutes).length).toBeLessThanOrEqual(140);
    }
  });
});

describe("reviewer-unavailable wording", () => {
  it("status line names the failed fallback count and stays under the GitHub 140-char cap", () => {
    // The whole reason this exists is that the Jules timeout text misleads
    // the reader when the cause is the chain, not Jules. The status line
    // must surface "Reviewer unavailable" so the PR page reader sees the
    // real cause at a glance.
    for (const attempts of [1, 2, 5]) {
      const status = reviewerUnavailableStatus(attempts);
      expect(status).toContain("Reviewer unavailable");
      expect(status).toContain(String(attempts));
      expect(status.length).toBeLessThanOrEqual(140);
    }
  });

  it("long-form explanation frames it as reviewer-infrastructure, not a code verdict", () => {
    const explanation = reviewerUnavailableExplanation(2);
    expect(explanation).toMatch(/no review/);
    expect(explanation).toMatch(/reviewer-infrastructure failure/);
    expect(explanation).toMatch(/not a verdict on the code/);
  });

  it("lists the attempted endpoints in the harvested-artifact line", () => {
    // The artifact carries the long form so the on-call can see which
    // endpoints failed without scraping job logs.
    const errorLine = reviewerUnavailableError("openai:all-unavailable:x", [
      "OpenAI-compatible fallback 1/2 (pearl:8000/v1)",
      "OpenAI-compatible fallback 2/2 (api.example.com/v1)",
    ]);
    expect(errorLine).toContain("Reviewer unavailable");
    expect(errorLine).toContain("2 OpenAI-compatible fallback endpoint(s)");
    expect(errorLine).toContain("pearl:8000/v1");
    expect(errorLine).toContain("api.example.com/v1");
  });

  it("says nothing was configured rather than printing zero attempts", () => {
    const errorLine = reviewerUnavailableError("openai:all-unavailable:x", []);
    expect(errorLine).toContain(
      "no OpenAI-compatible endpoints were configured"
    );
  });
});

describe("empty review body is never a passing check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      if (name === "jules_api_key") return "jules-key";
      if (name === "github_token") return "github-token";
      // fail_on=never is the path that used to paint an empty body SUCCESS.
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

    vi.mocked(github.getOctokit).mockReturnValue({ rest: {} } as ReturnType<
      typeof github.getOctokit
    >);
    (github as typeof github & { context: typeof github.context }).context = {
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

  it.each([
    { name: "empty", summary: "" },
    { name: "whitespace-only", summary: "  \n\t  " },
  ])("fails the job when the review body is $name", async ({ summary }) => {
    const writeJobSummary = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...completedReviewDeps(),
      writeJobSummary,
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "approve",
          summary,
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "session-empty",
      }),
    };

    await runReviewPr(deps);

    expect(deps.submitReview).not.toHaveBeenCalled();
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
    expect(artifact.outcome).toBe("EMPTY_REVIEW_BODY");
    expect(artifact.outcomeReason).toBe(emptyReviewExplanation(summary.length));
    expect(artifact.validatedReview).toBeNull();
    expect(writeJobSummary).toHaveBeenCalledWith(summary.length);
    expect(core.setFailed).toHaveBeenCalledWith(
      emptyReviewExplanation(summary.length)
    );
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "failure",
      emptyReviewStatus(summary.length)
    );
    const states = deps.setStatus.mock.calls.map((call) => call[5]);
    expect(states).not.toContain("success");
  });

  it("publishes findings and resolves threads despite a blank summary", async () => {
    const finding = {
      file: "src/a.ts",
      line: 1,
      severity: "Warning" as const,
      confidence: "High" as const,
      message: "Fix this",
      promptForAgents: "Fix this",
    };
    const deps = {
      ...completedReviewDeps(),
      writeJobSummary: vi.fn().mockResolvedValue(undefined),
      fetchPullRequestContext: vi.fn().mockResolvedValue({
        diff: "",
        changedFiles: ["src/a.ts"],
        files: new Map(),
        changedLines: new Map(),
        openThreads: [{ index: 1, threadId: "thread-1" }],
        linkedIssues: [],
      }),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "comment",
          summary: " ",
          resolvedCommentIds: [1],
          newComments: [finding],
        },
        sessionId: "session-empty",
      }),
    };
    await runReviewPr(deps);
    expect(deps.resolveThreads).toHaveBeenCalledWith(expect.anything(), [
      "thread-1",
    ]);
    expect(deps.submitReview).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      7,
      "head-sha",
      expect.stringContaining("review body was empty"),
      [finding]
    );
    expect(JSON.parse(deps.uploadArtifact.mock.calls[0][1])).toMatchObject({
      outcome: "EMPTY_REVIEW_BODY",
      validatedReview: null,
    });
    expect(core.setFailed).toHaveBeenCalled();
  });

  it("preserves the blank-review failure when finding delivery fails", async () => {
    const deps = {
      ...completedReviewDeps(),
      writeJobSummary: vi.fn().mockResolvedValue(undefined),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "comment",
          summary: " ",
          resolvedCommentIds: [],
          newComments: [
            {
              file: "src/a.ts",
              line: 1,
              severity: "Warning",
              confidence: "High",
              message: "Fix",
              promptForAgents: "Fix",
            },
          ],
        },
        sessionId: "session-empty",
      }),
      submitReview: vi.fn().mockRejectedValue(new Error("delivery failed")),
    };
    await runReviewPr(deps);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("delivery failed")
    );
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "maxi",
      "example",
      "head-sha",
      "",
      "failure",
      emptyReviewStatus(1)
    );
    expect(deps.writeJobSummary).toHaveBeenCalledWith(1);
    expect(core.setFailed).toHaveBeenCalledWith(emptyReviewExplanation(1));
  });

  it("does not overturn a successful review if the job summary cannot be written", async () => {
    const deps = {
      ...completedReviewDeps(),
      writeJobSummary: vi
        .fn()
        .mockRejectedValue(new Error("summary unavailable")),
    };
    await runReviewPr(deps);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("summary unavailable")
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(deps.setStatus.mock.calls.map((call) => call[5])).toContain(
      "success"
    );
  });

  it("keeps a normal review body as a passing check when fail_on is never", async () => {
    const writeJobSummary = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ...completedReviewDeps(),
      writeJobSummary,
    };

    await runReviewPr(deps);

    expect(deps.submitReview).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(writeJobSummary).toHaveBeenCalledWith("Looks okay.".length);
    const states = deps.setStatus.mock.calls.map((call) => call[5]);
    expect(states).toContain("success");
    expect(states).not.toContain("failure");
  });
});

describe("empty review artifact session resumption", () => {
  it("skips a blank-body session with raw responses and reuses the last valid session", () => {
    expect(
      latestReviewArtifactSessionId([
        artifactComment({ headSha: "older", sessionId: "valid-session" }),
        artifactComment({
          headSha: "newer",
          sessionId: "empty-session",
          outcome: "EMPTY_REVIEW_BODY",
        }),
      ])
    ).toBe("valid-session");
  });
});

describe("isBlankReviewBody", () => {
  it.each([
    { name: "empty", body: "", blank: true },
    { name: "whitespace-only", body: " \n\t", blank: true },
    { name: "normal", body: "Looks okay.", blank: false },
  ])("$name", ({ body, blank }) => {
    expect(isBlankReviewBody(body)).toBe(blank);
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
