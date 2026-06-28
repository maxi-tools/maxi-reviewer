import { describe, it, expect } from "vitest";
import {
  computeAnchor,
  resolveAnchor,
  enrichCommentsWithAnchors,
} from "../src/anchor.js";
import { ReviewComment } from "../src/types.js";

const sample =
  "function alpha() {\n" +
  "  return 1;\n" +
  "}\n" +
  "\n" +
  "function beta() {\n" +
  "  return 2;\n" +
  "}\n";

describe("computeAnchor", () => {
  it("captures line, span, hashes and enclosing symbol", () => {
    const anchor = computeAnchor(sample, 2);
    expect(anchor).toBeDefined();
    expect(anchor?.schema).toBe("maxi.review.v1.finding-anchor");
    expect(anchor?.line).toBe(2);
    expect(anchor?.lineCount).toBe(1);
    expect(anchor?.symbol).toBe("alpha");
    expect(anchor?.lineHash).toMatch(/^[0-9a-f]{16}$/);
    expect(anchor?.contextHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns undefined for an out-of-range line", () => {
    expect(computeAnchor(sample, 999)).toBeUndefined();
    expect(computeAnchor(sample, 0)).toBeUndefined();
  });

  it("spans multiple lines when endLine is given", () => {
    const anchor = computeAnchor(sample, 1, 3);
    expect(anchor?.lineCount).toBe(3);
  });
});

describe("resolveAnchor", () => {
  it("re-resolves the same line when content is unchanged", () => {
    const anchor = computeAnchor(sample, 2)!;
    expect(resolveAnchor(sample, anchor)).toBe(2);
  });

  it("follows the line after lines are inserted above (drift)", () => {
    const anchor = computeAnchor(sample, 2)!;
    const drifted = "// added\n// added two\n" + sample;
    expect(resolveAnchor(drifted, anchor)).toBe(4);
  });

  it("returns null when the target content is gone", () => {
    const anchor = computeAnchor(sample, 2)!;
    const changed = sample.replace("  return 1;", "  return 42;");
    expect(resolveAnchor(changed, anchor)).toBeNull();
  });

  it("disambiguates duplicate lines by surrounding context", () => {
    const dup =
      "function alpha() {\n" +
      "  return x;\n" +
      "}\n" +
      "function beta() {\n" +
      "  return x;\n" +
      "}\n";
    const anchor = computeAnchor(dup, 5)!;
    expect(anchor.symbol).toBe("beta");
    expect(resolveAnchor(dup, anchor)).toBe(5);
  });
});

describe("enrichCommentsWithAnchors", () => {
  function comment(over: Partial<ReviewComment>): ReviewComment {
    return {
      file: "a.ts",
      line: 2,
      severity: "Warning",
      confidence: "High",
      message: "m",
      promptForAgents: "p",
      ...over,
    };
  }

  it("attaches anchors for files with known head content and skips others", () => {
    const comments = [comment({}), comment({ file: "missing.ts", line: 1 })];
    enrichCommentsWithAnchors(comments, new Map([["a.ts", sample]]));
    expect(comments[0].anchor?.symbol).toBe("alpha");
    expect(comments[0].anchor?.line).toBe(2);
    expect(comments[1].anchor).toBeUndefined();
  });

  it("uses startLine/endLine when present", () => {
    const comments = [comment({ startLine: 5, endLine: 6, line: 5 })];
    enrichCommentsWithAnchors(comments, new Map([["a.ts", sample]]));
    expect(comments[0].anchor?.lineCount).toBe(2);
    expect(comments[0].anchor?.symbol).toBe("beta");
  });
});
