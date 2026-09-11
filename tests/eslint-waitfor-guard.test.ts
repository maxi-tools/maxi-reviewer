import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

// The waitFor guard in eslint.config.js has been wrong four times: it checked
// arity rather than the budget, then a name rather than a value, then rejected
// a quoted `"timeout"` key, then counted a nested object's `timeout` as the
// outer object's own. Each was found by a reviewer after the rule shipped.
// These cases are that history, pinned.
const eslint = new ESLint({ overrideConfigFile: "eslint.config.js" });

const countGuardErrors = async (source: string): Promise<number> => {
  const [result] = await eslint.lintText(source, {
    filePath: "tests/fixture.test.ts",
  });
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax")
    .length;
};

const wrap = (body: string) => `export function f() {\n  ${body}\n}\n`;

describe("vi.waitFor guard", () => {
  describe("call sites", () => {
    const cases: [string, string, number][] = [
      ["no options at all", "vi.waitFor(() => true);", 1],
      ["empty options", "vi.waitFor(() => true, {});", 1],
      [
        "options without a timeout",
        "vi.waitFor(() => true, { interval: 25 });",
        1,
      ],
      ["an inline budget", "vi.waitFor(() => true, { timeout: 200 });", 1],
      ["a differently named constant", "vi.waitFor(() => true, OTHER);", 1],
      ["the shared constant", "vi.waitFor(() => true, SETTLE_OPTIONS);", 0],
    ];
    it.each(cases)("%s", async (_label, body, expected) => {
      expect(await countGuardErrors(wrap(body))).toBe(expected);
    });
  });

  describe("SETTLE_OPTIONS definitions", () => {
    const cases: [string, string, number][] = [
      ["a plain timeout", "const SETTLE_OPTIONS = { timeout: 5000 };", 0],
      [
        "a quoted timeout key",
        'const SETTLE_OPTIONS = { "timeout": 5000 };',
        0,
      ],
      [
        "timeout under as const",
        "const SETTLE_OPTIONS = { timeout: 5000 } as const;",
        0,
      ],
      ["no timeout", "const SETTLE_OPTIONS = { interval: 25 };", 1],
      [
        "no timeout under as const",
        "const SETTLE_OPTIONS = { interval: 25 } as const;",
        1,
      ],
      [
        "no timeout under satisfies",
        "const SETTLE_OPTIONS = { interval: 25 } satisfies object;",
        1,
      ],
      [
        "a timeout only on a nested object",
        "const SETTLE_OPTIONS = { interval: 25, nested: { timeout: 1 } };",
        1,
      ],
    ];
    it.each(cases)("%s", async (_label, body, expected) => {
      expect(
        await countGuardErrors(wrap(`${body}\n  return SETTLE_OPTIONS;`))
      ).toBe(expected);
    });
  });
});
