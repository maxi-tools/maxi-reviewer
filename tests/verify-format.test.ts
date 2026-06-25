import { describe, expect, it } from "vitest";
import { parseJulesReview, verifyJulesReview } from "../src/verify-format.js";

describe("Jules review verification", () => {
  it("parses fenced maxi.review.v1 JSON", () => {
    const review = parseJulesReview(
      '```json\n{"schema":"maxi.review.v1.jules-review","summary":"s","verdict":"comment","resolvedCommentIds":[],"comments":[]}\n```'
    );
    expect(review.schema).toBe("maxi.review.v1.jules-review");
  });

  it("rejects suggestions that target unchanged lines", () => {
    const issues = verifyJulesReview(
      {
        schema: "maxi.review.v1.jules-review",
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        comments: [
          {
            id: "c1",
            path: "src/a.ts",
            line: 9,
            severity: "Warning",
            confidence: "High",
            message: "Use this.\n```suggestion\nconst a = 1;\n```",
            suggestion: {
              path: "src/a.ts",
              startLine: 9,
              endLine: 9,
              replacement: "const a = 1;",
            },
          },
        ],
      },
      {
        changedLines: new Map([["src/a.ts", new Set([3])]]),
        files: new Map([["src/a.ts", "one\ntwo\nthree\n"]]),
      }
    );

    expect(issues.map((issue) => issue.kind)).toContain("unchanged-line");
  });

  it("rejects no-op structured suggestions as non-applying", () => {
    const issues = verifyJulesReview(
      {
        schema: "maxi.review.v1.jules-review",
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        comments: [
          {
            id: "c1",
            path: "src/a.ts",
            line: 2,
            severity: "Warning",
            confidence: "High",
            message: "Use this.\n```suggestion\nconst b = 2;\n```",
            suggestion: {
              path: "src/a.ts",
              startLine: 2,
              endLine: 2,
              replacement: "const b = 2;",
            },
          },
        ],
      },
      {
        changedLines: new Map([["src/a.ts", new Set([2])]]),
        files: new Map([["src/a.ts", "const a = 1;\nconst b = 2;\n"]]),
      }
    );

    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: "non-applying",
        message: expect.stringContaining("does not change"),
      })
    );
  });
});
