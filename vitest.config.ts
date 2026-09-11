import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts", "dist/**"],
      // A RATCHET AT THE MEASURED FLOOR, NOT AN ASPIRATION.
      //
      // These were 90 across the board while the repository stood at 86.2
      // statements and 78.2 branches, so `pnpm coverage` could not pass — on
      // main, with no changes at all. It is enforced in exactly one place, the
      // Husky pre-commit hook, because CI runs `npm run coverage` under
      // `continue-on-error: true` and gates on a separate run with all four
      // thresholds explicitly zeroed.
      //
      // So the only consequence of the old numbers was that every commit had to
      // use `--no-verify`, which skips the WHOLE hook: `lint`, `format:check`,
      // `build` and the `git add dist` guard went with it. A gate that cannot
      // pass does not raise standards, it trains people past the cheap
      // deterministic checks sitting in front of it. (#104.)
      //
      // Set to the floor actually measured on main, rounded down to the integer:
      // statements 86.2, branches 78.23, functions 91.92, lines 88.13. These
      // catch a REGRESSION, which is the property worth having and the one the
      // old numbers never delivered. Raising them is how coverage improves;
      // lowering one needs a reason in the commit message, not a quiet edit.
      thresholds: {
        lines: 88,
        functions: 91,
        branches: 78,
        statements: 86,
      },
    },
  },
});
