import { describe, expect, it } from "vitest";
import {
  validateAnalyzerFinding,
  validateJulesReview,
  validateReviewArtifact,
} from "../src/schema.js";

describe("maxi.review.v1 schemas", () => {
  it("accepts a normalized analyzer finding", () => {
    const result = validateAnalyzerFinding({
      schema: "maxi.review.v1.analyzer-finding",
      id: "semgrep:typescript:no-floating-promises:src/a.ts:3",
      tool: "opengrep",
      ruleId: "typescript.no-floating-promises",
      severity: "warning",
      confidence: "high",
      message: "Promise is not awaited.",
      path: "src/a.ts",
      startLine: 3,
      endLine: 3,
      helpUri: "https://example.invalid/rules/no-floating-promises",
      license: "LGPL-2.1-only",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects analyzer findings with inverted line ranges", () => {
    const result = validateAnalyzerFinding({
      schema: "maxi.review.v1.analyzer-finding",
      id: "f1",
      tool: "opengrep",
      ruleId: "r1",
      severity: "warning",
      confidence: "high",
      message: "Message.",
      path: "src/a.ts",
      startLine: 9,
      endLine: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "endLine must be greater than or equal to startLine"
    );
  });

  it("rejects a review comment missing changed-line location", () => {
    const result = validateJulesReview({
      schema: "maxi.review.v1.jules-review",
      summary: "Review summary.",
      verdict: "comment",
      resolvedCommentIds: [],
      comments: [
        {
          id: "c1",
          path: "src/a.ts",
          severity: "Warning",
          confidence: "High",
          message: "Missing line.",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("line");
  });

  it("rejects malformed structured suggestions", () => {
    const result = validateJulesReview({
      schema: "maxi.review.v1.jules-review",
      summary: "Review summary.",
      verdict: "comment",
      resolvedCommentIds: [],
      comments: [
        {
          id: "c1",
          path: "src/a.ts",
          line: 3,
          severity: "Warning",
          confidence: "High",
          message: "Use a structured suggestion.",
          suggestion: {
            path: "src/a.ts",
            startLine: 4,
            endLine: 2,
            replacement: 42,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("suggestion.endLine");
    expect(result.errors.join("\n")).toContain("suggestion.replacement");
  });

  it("accepts a harvestable review artifact", () => {
    const result = validateReviewArtifact({
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-06-26T03:05:23.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
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
      sessionId: "session-1",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects review artifacts with malformed nested analyzer findings", () => {
    const result = validateReviewArtifact({
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-06-26T03:05:23.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      analyzerFindings: [
        {
          schema: "maxi.review.v1.analyzer-finding",
          id: "f1",
          tool: "opengrep",
          ruleId: "r1",
          severity: "warning",
          confidence: "high",
          message: "Message.",
          path: "src/a.ts",
          startLine: 9,
          endLine: 3,
        },
      ],
      rawJulesResponses: [],
      validatedReview: null,
      validationErrors: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "analyzerFindings[0].endLine must be greater than or equal to startLine"
    );
  });

  it("rejects review artifacts with malformed nested Jules reviews", () => {
    const result = validateReviewArtifact({
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-06-26T03:05:23.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      analyzerFindings: [],
      rawJulesResponses: [],
      validatedReview: {
        schema: "maxi.review.v1.jules-review",
        summary: "Review summary.",
        verdict: "approve",
        resolvedCommentIds: [],
        comments: [{ id: "c1", path: "src/a.ts" }],
      },
      validationErrors: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "validatedReview.comments[0].line"
    );
  });

  it("rejects review artifacts without harvest retention metadata", () => {
    const result = validateReviewArtifact({
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-06-26T03:05:23.000Z",
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      analyzerFindings: [],
      rawJulesResponses: [],
      validatedReview: null,
      validationErrors: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("retention");
  });

  it("rejects mismatched review outcome metadata", () => {
    const result = validateReviewArtifact({
      schema: "maxi.review.v1.review-artifact",
      createdAt: "2026-06-26T03:05:23.000Z",
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      },
      repoFullName: "maxi/example",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      analyzerFindings: [],
      rawJulesResponses: [],
      validatedReview: null,
      validationErrors: [],
      outcomeSchema: "maxi.review.v0.guessed-outcome",
      outcome: "TIMED_OUT_NO_CONTENT",
      reviewOutputChars: 0,
      runIdentity: {
        workflowRunId: 101,
        workflowRunAttempt: 1,
        job: "review",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("outcomeSchema");
  });
});
