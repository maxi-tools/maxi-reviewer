import { describe, expect, it } from "vitest";
import { selectRuleFiles } from "../src/rules/select.js";

describe("rule selection", () => {
  it("selects each language once in stable order", () => {
    expect(
      selectRuleFiles([
        "src/a.ts",
        "src/b.py",
        ".github/workflows/review.yml",
        "README.md",
        "src/c.ts",
      ])
    ).toEqual([
      "rules/typescript.md",
      "rules/python.md",
      "rules/markdown.md",
      "rules/github-actions.md",
    ]);
  });
});
