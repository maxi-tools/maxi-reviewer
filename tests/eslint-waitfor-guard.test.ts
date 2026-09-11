import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

// The waitFor guard in eslint.config.js has been wrong five times: it checked
// arity rather than the budget, then a name rather than a value, then rejected
// a quoted `"timeout"` key, then counted a nested object's `timeout` as the
// outer object's own, then missed `as const satisfies` because it traverses
// two TS wrapper nodes rather than one. Every one was found by a reviewer
// after the rule shipped. These cases are that history, pinned.
//
// The last of those ended the shape-matching approach: the definition check
// now asks the declarator, not the object beneath it, so wrapper syntax
// cannot reach it. See the comment in eslint.config.js for the trade.
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
      [
        "timeout under as const satisfies",
        "const SETTLE_OPTIONS = { timeout: 5000 } as const satisfies object;",
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
        "no timeout under as const satisfies",
        "const SETTLE_OPTIONS = { interval: 25 } as const satisfies object;",
        1,
      ],
      // Known limit, not an oversight: the check asks the declarator for a
      // `timeout` anywhere beneath it, so a nested one satisfies it. That is
      // the price of being immune to wrapper syntax, and this case is here to
      // record the price rather than let it be rediscovered as a bug.
      [
        "KNOWN LIMIT: a timeout only on a nested object is accepted",
        "const SETTLE_OPTIONS = { interval: 25, nested: { timeout: 1 } };",
        0,
      ],
    ];
    it.each(cases)("%s", async (_label, body, expected) => {
      expect(
        await countGuardErrors(wrap(`${body}\n  return SETTLE_OPTIONS;`))
      ).toBe(expected);
    });
  });
});
