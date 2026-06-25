/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { runReviewPr } from "../src/review-pr.js";

vi.mock("@actions/core");
vi.mock("@actions/github");

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
        diff: "diff --git a/src/a.ts b/src/a.ts",
        changedFiles: ["src/a.ts", "README.md"],
        rulesFromFile: undefined,
        openThreads: [],
      }),
      selectRuleFiles: vi
        .fn()
        .mockReturnValue(["rules/typescript.md", "rules/markdown.md"]),
      loadSelectedRules: vi.fn().mockReturnValue("# TypeScript"),
      runAnalyzers: vi.fn().mockResolvedValue(analyzerFindings),
      buildReviewPrompt: vi.fn().mockReturnValue("prompt"),
      runJulesReview: vi.fn().mockResolvedValue({
        reviewResult: {
          verdict: "comment",
          summary: "Looks okay.",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "session-1",
        rawResponses: ["raw response"],
        validationErrors: ["non-applying suggestion"],
      }),
      submitReview: vi.fn().mockResolvedValue(undefined),
      resolveThreads: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      uploadArtifact: vi.fn().mockResolvedValue(undefined),
      wrapPermissionError: vi.fn((err: unknown) => err),
    };

    await runReviewPr(deps);

    expect(deps.selectRuleFiles).toHaveBeenCalledWith([
      "src/a.ts",
      "README.md",
    ]);
    expect(deps.runAnalyzers).toHaveBeenCalledWith({
      changedFiles: ["src/a.ts", "README.md"],
      diff: "diff --git a/src/a.ts b/src/a.ts",
    });
    expect(deps.buildReviewPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        analyzerFindings,
        rules: "# TypeScript",
      })
    );
    expect(deps.submitReview).toHaveBeenCalled();
    expect(deps.uploadArtifact).toHaveBeenCalledWith(
      "maxi-review-7-head-sha.json",
      expect.stringContaining("\"analyzerFindings\"")
    );
    const artifact = JSON.parse(deps.uploadArtifact.mock.calls[0][1]);
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
    });
  });
});
