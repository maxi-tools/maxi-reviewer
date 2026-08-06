import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("action metadata", () => {
  it("uses the maxi-review identity and Node 24 runtime", () => {
    const action = readFileSync(
      new URL("../action.yml", import.meta.url),
      "utf8"
    );
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      name: string;
    };

    expect(pkg.name).toBe("maxi-review");
    expect(action).toContain('name: "Maxi Review"');
    expect(action).toContain('using: "node24"');
    expect(action).toContain("analyzer_mode:");
    expect(action).toContain("hard_timeout_minutes:");
    expect(action).toContain("command:");
    expect(action).toContain("pr_number:");
    expect(action).toContain("review_artifacts:");
    expect(action).toContain('default: "maxi-review-override"');
    expect(action).toContain('default: "maxi/review"');
    expect(action).not.toContain("jules-pr-reviewer");
    expect(action).not.toContain("jules-override");
    expect(action).not.toContain("jules/review");
    expect(action).not.toContain("node20");
  });

  it("keeps docs and workflows on Maxi-owned identity defaults", () => {
    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");

    const readme = read("../README.md");
    const selfTestWorkflow = read("../.github/workflows/self-test.yml");

    expect(readme).toContain(".github/maxi-review-rules.md");
    expect(readme).not.toContain(".github/jules-review-rules.md");
    expect(selfTestWorkflow).toContain("group: maxi-review-");
    expect(selfTestWorkflow).not.toContain("group: jules-review-");
  });

  it("builds the local action before dogfooding it", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/self-test.yml", import.meta.url),
      "utf8"
    );

    const setupIndex = workflow.indexOf("actions/setup-node@v7");
    const installIndex = workflow.indexOf("npm install");
    const buildIndex = workflow.indexOf("npm run build");
    const dogfoodIndex = workflow.indexOf("uses: ./");

    expect(setupIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(setupIndex);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(dogfoodIndex).toBeGreaterThan(buildIndex);
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("skip_drafts: false");
  });

  it("keeps CI Node setup compatible with the checked-in lockfiles", () => {
    const ci = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );
    const selfTest = readFileSync(
      new URL("../.github/workflows/self-test.yml", import.meta.url),
      "utf8"
    );

    for (const workflow of [ci, selfTest]) {
      expect(workflow).toContain("actions/setup-node@v7");
      expect(workflow).toContain('node-version: "24"');
      expect(workflow).not.toContain('cache: "npm"');
    }
  });

  it("uses the non-coverage test gate in required CI", () => {
    const ci = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );

    expect(ci).toContain("run: npm test");
    expect(ci).not.toContain("run: npm run coverage");
  });

  it("skips SonarCloud when the repository token is not configured", () => {
    const ci = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );

    // The guard must read `env`, not `secrets`: the `secrets` context is not
    // available in an `if:` expression, and referencing it there makes GitHub
    // reject the workflow at parse time — a startup failure that creates zero
    // jobs, which is why this workflow had never once run. The value is still
    // sourced from `secrets`: at job level to feed the guard, and in the
    // step's own env for the scanner itself.
    expect(ci).toContain("if: ${{ env.SONAR_TOKEN != ''");
    expect(ci).not.toContain("if: ${{ secrets.SONAR_TOKEN");
    expect(ci).toContain("SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}");
  });

  it("sets a step-level timeout on the maxi-reviewer action invocation", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/maxi-review.yml", import.meta.url),
      "utf8"
    );
    // 35, not 55: the bound must sit ABOVE the action's own Jules deadline
    // (timeout_minutes: 30) and BELOW the job's timeout-minutes: 40, or the job
    // cap fires first and the step bound is dead config. #59 specifies 35; the
    // 55 this previously asserted was never applied to the workflow at all.
    expect(workflow).toContain("timeout-minutes: 35");
    expect(workflow).toMatch(
      /name: Run maxi-reviewer[\s\S]*?timeout-minutes: 35[\s\S]*?uses: maxi-tools\/maxi-reviewer@/
    );
  });
});
