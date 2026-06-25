/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { runAnalyzers, runReviewPr } from "../src/review-pr.js";

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
        diff: "diff --git a/src/a.ts b/src/a.ts",
      })
    );
    expect(deps.buildReviewPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        analyzerFindings,
        rules: "# TypeScript",
      })
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
    ]);
  });
});
