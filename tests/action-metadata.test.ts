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

    // SHA-pinned rather than the @v7 tag; see the note above.
    const setupIndex = workflow.indexOf(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
    );
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

    // Pinned to the v7 SHA rather than the floating @v7 tag:
    // tests/test_workflow_policy.py requires every `uses:` in ci.yml to be
    // SHA-pinned, and a bare tag fails it. The two suites previously demanded
    // contradictory things — nothing surfaced that, because ci.yml never ran.
    // What this test is actually for is the two workflows agreeing on the
    // major version and the Node line, so assert that, not the tag syntax.
    const setupNodeV7 =
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7";
    for (const workflow of [ci, selfTest]) {
      expect(workflow).toContain(setupNodeV7);
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
    // sourced from `secrets`, in the env of each of the two steps that need
    // it: the presence check that feeds the guard, and the scanner itself.
    expect(ci).toContain("steps.sonar.outputs.present == 'true'");
    expect(ci).not.toContain("if: ${{ secrets.SONAR_TOKEN");
    expect(ci).toContain("SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}");
    // Never job-wide. A step's env key is indented deeper than any job-level
    // one, so anything shallower than a step key is out of scope by
    // construction. tests/test_workflow_policy.py carries the structural
    // version of this, which also names the two steps that may own it.
    const shallowTokenLines = ci
      .split("\n")
      .filter((line) => /^ {0,7}SONAR_TOKEN:/.test(line));
    expect(shallowTokenLines).toEqual([]);
  });

  it("sets a step-level timeout on the maxi-reviewer action invocation", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/maxi-review.yml", import.meta.url),
      "utf8"
    );
    // 55, and this assertion was right all along — an earlier revision of this
    // PR lowered it to 35 by reasoning from #59's prose instead of the shipped
    // behaviour, which was a regression. The action enforces its own deadline
    // in-process at `hard_timeout_minutes` = `timeout_minutes + 20` = 50, and
    // the README requires the step bound above that (>=55) plus cleanup
    // headroom, because a blocked event loop can stop the in-process timers and
    // this outer bound is the real runner-release watchdog. 35 would fire first
    // and kill a review still inside its own deadline.
    expect(workflow).toContain("timeout-minutes: 55");
    expect(workflow).toMatch(
      /name: Run maxi-reviewer[\s\S]*?timeout-minutes: 55[\s\S]*?uses: maxi-tools\/maxi-reviewer@/
    );
    // And the job cap sits above it with room for setup. The cap covers the
    // whole job — checkout, app-token mint, the pinned maxi-lint cargo
    // install, the rules fetch — so a cap only five minutes above the step
    // bound lets slow setup cancel the job before the step timeout can fire,
    // and a cancellation skips the graceful status cleanup the bound exists
    // to preserve.
    expect(workflow).toMatch(/^ {4}timeout-minutes: 70$/m);
  });
});
