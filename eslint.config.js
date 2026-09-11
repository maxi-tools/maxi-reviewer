import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "specs", ".gemini"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      quotes: ["error", "double", { avoidEscape: true }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // vi.waitFor defaults to a 1000ms budget. Under v8 coverage with 28
      // test files in parallel that is not enough headroom -- an observed
      // failure took 2297ms to give up while the action was still settling
      // normally. Every wait must state its own budget so a busy machine
      // cannot turn into a flaky test (#104).
      //
      // This requires the shared SETTLE_OPTIONS constant specifically, not
      // merely "some second argument": arity alone would accept
      // `vi.waitFor(fn, { interval: 25 })`, which keeps the 1000ms default
      // this rule exists to remove. Requiring the identifier also blocks an
      // inline `{ timeout: 200 }` -- the budget is a single reviewed value,
      // not something to re-pick per call site. A selector cannot read
      // through a variable reference, so the identifier is the enforceable
      // form of "states its own budget".
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='waitFor']:not([arguments.1.type='Identifier'][arguments.1.name='SETTLE_OPTIONS'])",
          message:
            "vi.waitFor must pass SETTLE_OPTIONS as its second argument; the 1000ms default flakes under coverage. See #104.",
        },
      ],
    },
  }
);
