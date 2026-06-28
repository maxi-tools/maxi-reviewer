import { describe, it, expect } from "vitest";
import {
  DEFAULT_GENERATED_GLOBS,
  globToRegExp,
  matchesAnyGlob,
  parseIgnoreGlobs,
  filterDiffByPaths,
} from "../src/diff-filter.js";

const fileSection = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

describe("globToRegExp", () => {
  it("matches dist/** against nested dist paths only", () => {
    const re = globToRegExp("dist/**");
    expect(re.test("dist/index.js")).toBe(true);
    expect(re.test("dist/chunks/5.js")).toBe(true);
    expect(re.test("src/index.js")).toBe(false);
  });

  it("matches **/*.map at any depth", () => {
    const re = globToRegExp("**/*.map");
    expect(re.test("index.js.map")).toBe(true);
    expect(re.test("dist/index.js.map")).toBe(true);
    expect(re.test("index.js")).toBe(false);
  });

  it("matches a bare lockfile name at root and nested", () => {
    const re = globToRegExp("**/pnpm-lock.yaml");
    expect(re.test("pnpm-lock.yaml")).toBe(true);
    expect(re.test("packages/app/pnpm-lock.yaml")).toBe(true);
    expect(re.test("pnpm-lock.yaml.bak")).toBe(false);
  });

  it("does not let * cross directory separators", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/a.ts")).toBe(false);
  });
});

describe("parseIgnoreGlobs", () => {
  it("splits on newlines and commas and trims", () => {
    expect(parseIgnoreGlobs("dist/**\n **/*.map , a.txt ")).toEqual([
      "dist/**",
      "**/*.map",
      "a.txt",
    ]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseIgnoreGlobs("  \n , ")).toEqual([]);
  });
});

describe("filterDiffByPaths", () => {
  const diff = fileSection("src/a.ts") + fileSection("dist/index.js");

  it("drops generated sections and reports excluded paths", () => {
    const result = filterDiffByPaths(diff, DEFAULT_GENERATED_GLOBS);
    expect(result.excludedPaths).toEqual(["dist/index.js"]);
    expect(result.diff).toContain("a/src/a.ts");
    expect(result.diff).not.toContain("dist/index.js");
  });

  it("returns the diff unchanged when nothing matches", () => {
    const result = filterDiffByPaths(diff, ["does/not/match/**"]);
    expect(result.excludedPaths).toEqual([]);
    expect(result.diff).toBe(diff);
  });

  it("returns the diff unchanged when no globs are given", () => {
    const result = filterDiffByPaths(diff, []);
    expect(result.excludedPaths).toEqual([]);
    expect(result.diff).toBe(diff);
  });

  it("keeps the original diff when filtering would remove everything", () => {
    const onlyGenerated = fileSection("dist/index.js") + fileSection("a.map");
    const result = filterDiffByPaths(onlyGenerated, DEFAULT_GENERATED_GLOBS);
    expect(result.excludedPaths).toEqual([]);
    expect(result.diff).toBe(onlyGenerated);
  });

  it('extracts paths containing " b/" without mis-splitting', () => {
    const tricky = "src/folder b/file.ts";
    const result = filterDiffByPaths(
      fileSection(tricky) + fileSection("dist/x.js"),
      DEFAULT_GENERATED_GLOBS
    );
    expect(result.excludedPaths).toEqual(["dist/x.js"]);
    expect(result.diff).toContain(tricky);
  });
});

describe("matchesAnyGlob", () => {
  it("returns true only when a glob matches", () => {
    expect(matchesAnyGlob("dist/index.js", DEFAULT_GENERATED_GLOBS)).toBe(true);
    expect(matchesAnyGlob("pnpm-lock.yaml", DEFAULT_GENERATED_GLOBS)).toBe(
      true
    );
    expect(matchesAnyGlob("src/index.ts", DEFAULT_GENERATED_GLOBS)).toBe(false);
  });

  it("is false for an empty glob list", () => {
    expect(matchesAnyGlob("dist/index.js", [])).toBe(false);
  });
});
