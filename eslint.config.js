import js from "@eslint/js";

// A SETTLE_OPTIONS declaration with no `timeout` anywhere in its initializer.
//
// This deliberately asks about the *declarator*, not the object literal under
// it. Three earlier versions matched the object through its parent chain and
// each was defeated by a new wrapper shape -- `as const`, then `satisfies`,
// then `as const satisfies`, which stacks two. A selector language cannot say
// "the object at the root of this initializer, however wrapped", so every fix
// was one more shape rather than the last one.
//
// Asking the declarator sidesteps wrapper shape entirely: no combinator walks
// the initializer, so no new TS syntax can break it.
//
// The trade, stated rather than discovered later: a `timeout` on a NESTED
// object satisfies this, e.g. `{ interval: 25, nested: { timeout: 1 } }`.
// That shape is contrived, where stacked type assertions are ordinary TS. One
// contrived miss is worth immunity to every wrapper form.
//
// `key.value` as well as `key.name`, or a quoted `{ "timeout": 5000 }` is
// rejected as invalid -- a false positive, which is worse than a miss because
// it blocks correct code.
const NO_TIMEOUT_SELECTORS = [
  "VariableDeclarator[id.name='SETTLE_OPTIONS']" +
    ":not(:has(Property[key.name='timeout']))" +
    ":not(:has(Property[key.value='timeout']))",
];
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
      // Two selectors, because either alone is bypassable. The call-site one
      // requires the shared SETTLE_OPTIONS constant rather than merely "some
      // second argument": arity alone would accept `vi.waitFor(fn, {
      // interval: 25 })`, which keeps the 1000ms default this rule exists to
      // remove. It also blocks an inline `{ timeout: 200 }` -- the budget is
      // a single reviewed value, not one to re-pick per call site.
      //
      // But a name is not a value, so the second selector pins the
      // definition: a SETTLE_OPTIONS initialised without a `timeout` key is
      // itself an error. Otherwise `const SETTLE_OPTIONS = { interval: 25 }`
      // would satisfy every call site while restoring the default.
      //
      // What this does NOT catch, stated so the comment does not outrun the
      // rule: a selector cannot resolve bindings, so a SETTLE_OPTIONS
      // shadowed in a nested scope, or initialised from another variable
      // rather than an object literal, passes both. Closing that needs a
      // custom rule doing scope analysis; these two cover the shapes anyone
      // writes by accident, which is what the rule is for.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='waitFor']:not([arguments.1.type='Identifier'][arguments.1.name='SETTLE_OPTIONS'])",
          message:
            "vi.waitFor must pass SETTLE_OPTIONS as its second argument; the 1000ms default flakes under coverage. See #104.",
        },
        ...NO_TIMEOUT_SELECTORS.map((selector) => ({
          selector,
          message:
            "SETTLE_OPTIONS must define a timeout; without one, every wait that names it silently keeps vi.waitFor's 1000ms default. See #104.",
        })),
      ],
    },
  }
);
