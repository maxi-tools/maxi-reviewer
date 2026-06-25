import { describe, expect, it } from "vitest";
import { validateAnalyzerFinding, validateJulesReview } from "../src/schema.js";

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
});
