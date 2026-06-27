import { describe, it, expect } from "vitest";
import { buildChangedFileContext } from "../src/context-window.js";

const file = (n: number) =>
  Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

describe("buildChangedFileContext", () => {
  it("builds a line-numbered window centred on a changed line", () => {
    const files = new Map([["a.ts", file(100)]]);
    const changed = new Map([["a.ts", new Set([50])]]);

    const ctx = buildChangedFileContext(files, changed, { contextRadius: 2 });

    expect(ctx).toHaveLength(1);
    expect(ctx[0].path).toBe("a.ts");
    expect(ctx[0].windows).toHaveLength(1);
    expect(ctx[0].windows[0]).toMatchObject({ startLine: 48, endLine: 52 });
    expect(ctx[0].windows[0].text).toBe(
      "48\tline48\n49\tline49\n50\tline50\n51\tline51\n52\tline52"
    );
  });

  it("merges overlapping/adjacent windows into one", () => {
    const files = new Map([["a.ts", file(100)]]);
    const changed = new Map([["a.ts", new Set([10, 12, 13])]]);

    const ctx = buildChangedFileContext(files, changed, { contextRadius: 2 });

    expect(ctx[0].windows).toHaveLength(1);
    expect(ctx[0].windows[0]).toMatchObject({ startLine: 8, endLine: 15 });
  });

  it("keeps distant hunks as separate windows", () => {
    const files = new Map([["a.ts", file(100)]]);
    const changed = new Map([["a.ts", new Set([10, 80])]]);

    const ctx = buildChangedFileContext(files, changed, { contextRadius: 2 });

    expect(ctx[0].windows).toHaveLength(2);
    expect(ctx[0].windows.map((w) => w.startLine)).toEqual([8, 78]);
  });

  it("clamps windows to file bounds", () => {
    const files = new Map([["a.ts", file(5)]]);
    const changed = new Map([["a.ts", new Set([1, 5])]]);

    const ctx = buildChangedFileContext(files, changed, { contextRadius: 10 });

    expect(ctx[0].windows).toHaveLength(1);
    expect(ctx[0].windows[0]).toMatchObject({ startLine: 1, endLine: 5 });
  });

  it("skips files with no fetched content", () => {
    const files = new Map<string, string>();
    const changed = new Map([["missing.ts", new Set([3])]]);

    expect(buildChangedFileContext(files, changed)).toEqual([]);
  });

  it("ignores changed line numbers outside the file", () => {
    const files = new Map([["a.ts", file(5)]]);
    const changed = new Map([["a.ts", new Set([99])]]);

    expect(buildChangedFileContext(files, changed)).toEqual([]);
  });

  it("stops emitting once the character budget is exhausted", () => {
    const files = new Map([
      ["a.ts", file(100)],
      ["b.ts", file(100)],
    ]);
    const changed = new Map([
      ["a.ts", new Set([50])],
      ["b.ts", new Set([50])],
    ]);

    // Budget large enough for one small window only.
    const ctx = buildChangedFileContext(files, changed, {
      contextRadius: 1,
      maxChars: 30,
    });

    const totalWindows = ctx.reduce((n, f) => n + f.windows.length, 0);
    expect(totalWindows).toBe(1);
  });
});
