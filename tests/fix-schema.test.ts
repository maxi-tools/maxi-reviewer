import { describe, expect, it } from "vitest";
import { validateJulesReview } from "../src/schema.js";

describe("validateJulesReview structured fix", () => {
  it("accepts a comment with a valid multi-location fix", () => {
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
          message: "Apply a multi-location fix.",
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "x" },
              { path: "src/b.ts", startLine: 2, endLine: 4, replacement: "y" },
            ],
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an empty fix and a fix with a malformed edit", () => {
    const empty = validateJulesReview({
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
          message: "Empty fix.",
          fix: { edits: [] },
        },
      ],
    });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(" ")).toContain(
      "fix.edits must be a non-empty array"
    );

    const malformed = validateJulesReview({
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
          message: "Bad edit.",
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 5, endLine: 2, replacement: "z" },
            ],
          },
        },
      ],
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.errors.join(" ")).toContain("fix.edits[0].endLine");
  });
});
