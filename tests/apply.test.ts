import { describe, expect, it } from "vitest";
import {
  applyStructuredSuggestions,
  buildApplyAllCommitMessage,
  validateApplyAllHead,
} from "../src/apply.js";
import { JulesReviewComment, ReviewComment } from "../src/types.js";

const baseComment = {
  file: "src/example.ts",
  line: 2,
  severity: "Warning",
  confidence: "High",
  message: "Use the safer value.",
  promptForAgents: "",
} satisfies ReviewComment;

describe("applyStructuredSuggestions", () => {
  it("applies explicit single-line structured replacements", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "const a = 1;\nconst b = 2;\n"]]),
      [
        {
          ...baseComment,
          startLine: 2,
          endLine: 2,
          suggestedReplacement: "const b = 3;",
        },
      ]
    );

    expect(result.files.get("src/example.ts")).toBe(
      "const a = 1;\nconst b = 3;\n"
    );
    expect(result.applied).toEqual([
      { file: "src/example.ts", startLine: 2, endLine: 2 },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("applies explicit multi-line structured replacements", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "one\ntwo\nthree\nfour\n"]]),
      [
        {
          ...baseComment,
          line: 2,
          startLine: 2,
          endLine: 3,
          suggestedReplacement: "dos\ntres",
        },
      ]
    );

    expect(result.files.get("src/example.ts")).toBe("one\ndos\ntres\nfour\n");
  });

  it("falls back to a GitHub suggestion fence on the comment line", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "const a = 1;\nconst b = 2;\n"]]),
      [
        {
          ...baseComment,
          message: "Use the safer value.\n```suggestion\nconst b = 4;\n```",
        },
      ]
    );

    expect(result.files.get("src/example.ts")).toBe(
      "const a = 1;\nconst b = 4;\n"
    );
  });

  it("recognizes empty suggestion fences as deletion replacements", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "one\ntwo\nthree\n"]]),
      [
        {
          ...baseComment,
          line: 2,
          message: "Delete this line.\n```suggestion\n```",
        },
      ]
    );

    expect(result.files.get("src/example.ts")).toBe("one\nthree\n");
    expect(result.applied).toEqual([
      { file: "src/example.ts", startLine: 2, endLine: 2 },
    ]);
  });

  it("applies multiple replacements bottom-up so line numbers do not shift", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "one\ntwo\nthree\nfour\n"]]),
      [
        {
          ...baseComment,
          line: 1,
          startLine: 1,
          endLine: 1,
          suggestedReplacement: "ONE\nONE AGAIN",
        },
        {
          ...baseComment,
          line: 4,
          startLine: 4,
          endLine: 4,
          suggestedReplacement: "FOUR",
        },
      ]
    );

    expect(result.files.get("src/example.ts")).toBe(
      "ONE\nONE AGAIN\ntwo\nthree\nFOUR\n"
    );
    expect(result.applied).toEqual([
      { file: "src/example.ts", startLine: 4, endLine: 4 },
      { file: "src/example.ts", startLine: 1, endLine: 1 },
    ]);
  });

  it("applies structured Jules review suggestions", () => {
    const comment = {
      id: "c1",
      path: "src/example.ts",
      line: 2,
      severity: "Warning",
      confidence: "High",
      message: "Use the safer value.",
      suggestion: {
        path: "src/example.ts",
        startLine: 2,
        endLine: 2,
        replacement: "const b = 5;",
      },
    } satisfies JulesReviewComment;

    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "const a = 1;\nconst b = 2;\n"]]),
      [comment]
    );

    expect(result.files.get("src/example.ts")).toBe(
      "const a = 1;\nconst b = 5;\n"
    );
    expect(result.applied).toEqual([
      { file: "src/example.ts", startLine: 2, endLine: 2 },
    ]);
  });

  it("skips missing files, invalid ranges, and unstructured comments", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/example.ts", "const a = 1;\n"]]),
      [
        { ...baseComment, file: "missing.ts", suggestedReplacement: "x" },
        { ...baseComment, startLine: 2, endLine: 1, suggestedReplacement: "x" },
        { ...baseComment, message: "Needs a broader fix." },
      ]
    );

    expect(result.files.get("src/example.ts")).toBe("const a = 1;\n");
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "missing file",
      "invalid range",
      "no structured replacement",
    ]);
  });

  it("rejects stale apply-all heads", () => {
    expect(validateApplyAllHead("head-a", "head-b")).toEqual({
      ok: false,
      reason: "stale head SHA: expected head-a, got head-b",
    });
    expect(validateApplyAllHead("head-a", "head-a")).toEqual({ ok: true });
  });

  it("builds a simple apply-all commit message", () => {
    expect(buildApplyAllCommitMessage(3)).toBe("Apply 3 Maxi suggestions");
    expect(buildApplyAllCommitMessage(1)).toBe("Apply 1 Maxi suggestion");
  });

  it("applies a transactional multi-location fix across files", () => {
    const result = applyStructuredSuggestions(
      new Map([
        ["src/a.ts", "a1\na2\na3\n"],
        ["src/b.ts", "b1\nb2\n"],
      ]),
      [
        {
          id: "f1",
          path: "src/a.ts",
          line: 1,
          severity: "Warning",
          confidence: "High",
          message: "Multi-file fix.",
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "A1" },
              { path: "src/a.ts", startLine: 3, endLine: 3, replacement: "A3" },
              { path: "src/b.ts", startLine: 2, endLine: 2, replacement: "B2" },
            ],
          },
        } satisfies JulesReviewComment,
      ]
    );

    expect(result.files.get("src/a.ts")).toBe("A1\na2\nA3\n");
    expect(result.files.get("src/b.ts")).toBe("b1\nB2\n");
    expect(result.skipped).toEqual([]);
    expect(result.applied).toEqual([
      { file: "src/a.ts", startLine: 3, endLine: 3 },
      { file: "src/a.ts", startLine: 1, endLine: 1 },
      { file: "src/b.ts", startLine: 2, endLine: 2 },
    ]);
  });

  it("skips an entire multi-location fix when any edit is invalid", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/a.ts", "a1\na2\na3\n"]]),
      [
        {
          id: "f2",
          path: "src/a.ts",
          line: 1,
          severity: "Warning",
          confidence: "High",
          message: "Atomic fix.",
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "A1" },
              {
                path: "missing.ts",
                startLine: 1,
                endLine: 1,
                replacement: "X",
              },
            ],
          },
        } satisfies JulesReviewComment,
      ]
    );

    expect(result.files.get("src/a.ts")).toBe("a1\na2\na3\n");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { file: "src/a.ts", startLine: 1, endLine: 1, reason: "incomplete fix" },
      { file: "missing.ts", startLine: 1, endLine: 1, reason: "missing file" },
    ]);
  });

  it("skips a multi-location fix whose edits overlap each other", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/a.ts", "a1\na2\na3\n"]]),
      [
        {
          id: "f3",
          path: "src/a.ts",
          line: 1,
          severity: "Warning",
          confidence: "High",
          message: "Overlapping edits.",
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 1, endLine: 2, replacement: "X" },
              { path: "src/a.ts", startLine: 2, endLine: 3, replacement: "Y" },
            ],
          },
        } satisfies JulesReviewComment,
      ]
    );

    expect(result.files.get("src/a.ts")).toBe("a1\na2\na3\n");
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      "overlapping range",
      "overlapping range",
    ]);
  });

  it("prefers a multi-location fix over a single suggestion on the same comment", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/a.ts", "a1\na2\n"]]),
      [
        {
          id: "f4",
          path: "src/a.ts",
          line: 1,
          severity: "Warning",
          confidence: "High",
          message: "Both present.",
          suggestion: {
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            replacement: "IGNORED",
          },
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 2, endLine: 2, replacement: "A2" },
            ],
          },
        } satisfies JulesReviewComment,
      ]
    );

    expect(result.files.get("src/a.ts")).toBe("a1\nA2\n");
    expect(result.applied).toEqual([
      { file: "src/a.ts", startLine: 2, endLine: 2 },
    ]);
  });

  it("applies a fix carried on a legacy review comment shape", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/a.ts", "a1\na2\n"]]),
      [
        {
          ...baseComment,
          file: "src/a.ts",
          fix: {
            edits: [
              { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "A1" },
            ],
          },
        },
      ]
    );

    expect(result.files.get("src/a.ts")).toBe("A1\na2\n");
    expect(result.applied).toEqual([
      { file: "src/a.ts", startLine: 1, endLine: 1 },
    ]);
  });

  it("gives overlap precedence to the bottom-most single suggestion", () => {
    const result = applyStructuredSuggestions(
      new Map([["src/a.ts", "a1\na2\na3\n"]]),
      [
        {
          ...baseComment,
          file: "src/a.ts",
          startLine: 1,
          endLine: 2,
          suggestedReplacement: "TOP",
        },
        {
          ...baseComment,
          file: "src/a.ts",
          startLine: 2,
          endLine: 3,
          suggestedReplacement: "BOTTOM",
        },
      ]
    );

    expect(result.files.get("src/a.ts")).toBe("a1\nBOTTOM\n");
    expect(result.applied).toEqual([
      { file: "src/a.ts", startLine: 2, endLine: 3 },
    ]);
    expect(result.skipped).toEqual([
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 2,
        reason: "overlapping range",
      },
    ]);
  });
});
