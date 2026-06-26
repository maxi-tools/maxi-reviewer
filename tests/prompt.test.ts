import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../src/prompt.js";

describe("buildReviewPrompt", () => {
  it("should build a prompt without open threads or rules or extra instructions", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "owner/repo",
      prNumber: 123,
      prTitle: "My PR",
      prBody: "PR Description",
      diff: "+ const a = 1;",
      openThreads: [],
    });

    expect(prompt).toContain("# Repository (trusted)\nowner/repo (PR #123)");
    expect(prompt).toContain("# PR title (UNTRUSTED data)");
    expect(prompt).toContain("<<<BEGIN PR_TITLE ");
    expect(prompt).toContain("My PR");
    expect(prompt).toContain("# PR description (UNTRUSTED data)");
    expect(prompt).toContain("<<<BEGIN PR_BODY ");
    expect(prompt).toContain("PR Description");
    expect(prompt).toContain("# Incremental diff to review (UNTRUSTED data)");
    expect(prompt).toContain("<<<BEGIN DIFF ");
    expect(prompt).toContain("+ const a = 1;");
    expect(prompt).toContain('"schema": "maxi.review.v1.jules-review"');
    expect(prompt).toContain('"suggestion"');
    expect(prompt).toContain('"startLine"');
    expect(prompt).toContain('"endLine"');
    expect(prompt).not.toContain("# Project rules (authoritative");
    expect(prompt).not.toContain("NOTE: The diff was truncated");
    expect(prompt).not.toContain("# Open Review Comments");
  });

  it("should include diff truncated note", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "owner/repo",
      prNumber: 123,
      prTitle: "My PR",
      prBody: "PR Description",
      diff: "+ const a = 1;",
      diffTruncatedNote: "The diff was truncated",
      openThreads: [],
    });

    expect(prompt).toContain("NOTE: The diff was truncated");
  });

  it("should fallback to (no description) when prBody is empty", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "owner/repo",
      prNumber: 123,
      prTitle: "My PR",
      prBody: "",
      diff: "+ const a = 1;",
      openThreads: [],
    });

    expect(prompt).toContain("# PR description (UNTRUSTED data)");
    expect(prompt).toContain("(no description)");
  });

  it("should include project specific rules", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "owner/repo",
      prNumber: 123,
      prTitle: "My PR",
      prBody: "desc",
      diff: "+ const a = 1;",
      rulesFromFile: "Do not use console.log",
      openThreads: [],
    });

    expect(prompt).toContain("# Project rules (authoritative");
    expect(prompt).toContain("Do not use console.log");
  });

  it("should include extra instructions", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "owner/repo",
      prNumber: 123,
      prTitle: "My PR",
      prBody: "desc",
      diff: "+ const a = 1;",
      extraInstructions: "Be nice",
      openThreads: [],
    });

    expect(prompt).toContain("# Project rules (authoritative");
    expect(prompt).toContain("Be nice");
  });

  it("should include open threads", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "owner/repo",
      prNumber: 123,
      prTitle: "My PR",
      prBody: "desc",
      diff: "+ const a = 1;",
      openThreads: [
        {
          index: 1,
          threadId: "t1",
          path: "file.ts",
          line: 10,
          body: "Bad code",
        },
      ],
    });

    expect(prompt).toContain("# Open Review Comments");
    expect(prompt).toContain("[Index 1] File: file.ts, Line: 10");
    expect(prompt).toContain("<<<BEGIN THREAD 1 ");
    expect(prompt).toContain("Bad code");
  });

  it("places schema, analyzer findings, and rules before untrusted diff", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "maxi/example",
      prNumber: 7,
      prTitle: "title",
      prBody: "body",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      openThreads: [],
      analyzerFindings: [
        {
          schema: "maxi.review.v1.analyzer-finding",
          id: "f1",
          tool: "opengrep",
          ruleId: "typescript.no-floating-promises",
          severity: "warning",
          confidence: "high",
          message: "Promise is not awaited.",
          path: "src/a.ts",
          startLine: 4,
          endLine: 4,
        },
      ],
      rules: "# TypeScript\n\n- Flag floating promises.",
    });

    expect(prompt.indexOf("maxi.review.v1.jules-review")).toBeLessThan(
      prompt.indexOf("Analyzer findings")
    );
    expect(prompt.indexOf("Analyzer findings")).toBeLessThan(
      prompt.indexOf("PR title")
    );
    expect(prompt).toContain("typescript.no-floating-promises");
    expect(prompt).toContain("# TypeScript");
  });

  it("requires authoritative evidence before blocking on external tool compatibility", () => {
    const prompt = buildReviewPrompt({
      repoFullName: "maxi/example",
      prNumber: 7,
      prTitle: "Update workflow",
      prBody: "Use a GitHub App token",
      diff: "+ uses: actions/create-github-app-token@v3\n+ with:\n+   client-id: ${{ vars.APP_CLIENT_ID }}",
      openThreads: [],
    });

    expect(prompt).toContain("External tool and platform compatibility");
    expect(prompt).toContain("authoritative evidence");
    expect(prompt).toContain("do not use `block`");
  });
});
