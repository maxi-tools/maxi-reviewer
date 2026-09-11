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
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='waitFor'][arguments.length<2]",
          message:
            "vi.waitFor needs an explicit timeout (pass SETTLE_OPTIONS); the 1000ms default flakes under coverage. See #104.",
        },
      ],
    },
  }
);
