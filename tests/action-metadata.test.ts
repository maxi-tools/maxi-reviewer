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
    expect(action).toContain("reviewer_backend:");
    expect(action).toContain("openai_base_url:");
    expect(action).toContain("Qwen/Qwen3-Coder-30B-A3B-Instruct");
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
    expect(selfTestWorkflow).not.toContain("group: jules-review-");
  });

  it("gives the dogfood lane its own concurrency group", () => {
    // These two shared `maxi-review-<pr>`, and maxi-review.yml sets
    // cancel-in-progress: true, so starting it evicted the self-test --
    // 14 of 20 runs, usually before a step executed (#108). Asserting the
    // groups merely differ, rather than pinning either literal, so renaming
    // one later does not fail this for the wrong reason.
    // Walks the top-level concurrency block line by line rather than matching
    // its shape. The regex this replaces required `group:` to be the first key
    // after the header (comments aside), so putting `cancel-in-progress` first
    // would have failed the test for a reason having nothing to do with
    // concurrency groups, and it hard-coded LF. Scanning the block is
    // order-independent, tolerates CRLF, and says what it is looking for.
    // Collects EVERY concurrency group in the file, at any indent.
    //
    // This scanned only a TOP-LEVEL `concurrency:` block and threw when it
    // found none. maxi-review.yml is maxi-config-owned and moved its groups
    // from the workflow level to per-job, so the scan threw and this suite
    // failed on a file this repo does not control. What the test actually
    // cares about is that the dogfood lane cannot evict the self-test, and
    // that holds wherever the groups are declared.
    const groupsOf = (workflow: string): string[] => {
      const groups = workflow
        .split(/\r?\n/)
        .map((line) => /^\s*group:\s*(.+?)\s*$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        // A trailing YAML comment is not part of the value, and neither are
        // the quotes around it. Without this, `group: x # why` compares as
        // `x # why`, so two groups that genuinely differ could compare equal
        // -- or two identical ones differ -- for a reason having nothing to
        // do with concurrency, which is exactly the failure this test was
        // rewritten to stop making. Quotes come off FIRST when the value is
        // quoted, because a `#` inside quotes is data, not a comment.
        .map((m) => {
          const quoted = /^(['"])(.*)\1(?:\s+#.*)?$/.exec(m[1]);
          return quoted ? quoted[2] : m[1].replace(/\s+#.*$/, "").trim();
        });
      if (groups.length === 0) throw new Error("no concurrency group declared");
      return groups;
    };

    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    const selfTest = groupsOf(read("../.github/workflows/self-test.yml"));
    const maxiReview = groupsOf(read("../.github/workflows/maxi-review.yml"));

    // No group in common: sharing one is what let maxi-review.yml's
    // cancel-in-progress evict the self-test, 14 of 20 runs (#108).
    const shared = selfTest.filter((g) => maxiReview.includes(g));
    expect(shared, `shared concurrency group(s): ${shared.join(", ")}`).toEqual(
      []
    );
    // EVERY group, not the concatenation. `groupsOf` returns all of them and
    // `join(" ")` then let a single per-PR group vouch for the rest: add one
    // constant group beside it and the assertion still passed, while that
    // group shared a slot across pull requests and -- with
    // cancel-in-progress on -- cancelled somebody else's run. Checking one
    // lock does not prove every door is locked, and reporting the subset as
    // the whole is the defect this PR exists to remove.
    const isPerPullRequest = (group: string) =>
      group.includes("github.event.pull_request.number");
    expect(
      selfTest.filter((g) => !isPerPullRequest(g)),
      "self-test.yml declares a concurrency group that is not per-PR"
    ).toEqual([]);
    expect(
      maxiReview.filter((g) => !isPerPullRequest(g)),
      "maxi-review.yml declares a concurrency group that is not per-PR"
    ).toEqual([]);
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
    // Every binding, enumerated — not "the string appears somewhere". A
    // containment check still passes if one of the two steps has its value
    // swapped for a non-secret, or if a third step is handed the token.
    const tokenBindings = ci
      .split("\n")
      .filter((line) => /^\s*SONAR_TOKEN:/.test(line))
      .map((line) => line.trim());
    expect(tokenBindings).toEqual([
      "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}",
      "SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}",
    ]);
    // And never job-wide. A step's env key is indented deeper than any
    // job-level one, so anything shallower than a step key is out of scope by
    // construction. tests/test_workflow_policy.py carries the structural
    // version, pairing each value with the step that owns it.
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
    // The RELATIONSHIP, not the literal. This asserted `timeout-minutes: 55`,
    // which was correct when the lane passed `timeout_minutes: 35` — but
    // maxi-review.yml is maxi-config-owned, maxi-config lowered the input to
    // 15, and the fan-out delivered a step bound of 40. The literal broke
    // this suite on a change that was internally consistent at the source,
    // which is the wrong thing to be pinned on: a repo should not assert a
    // VALUE inside a file it does not own, only the invariant it depends on.
    //
    // The invariant: the action enforces its own deadline in-process at
    // `hard_timeout_minutes` = `timeout_minutes + 20`, and the step bound must
    // clear that with cleanup headroom, because a blocked event loop can stop
    // the in-process timers and this outer bound is the real runner-release
    // watchdog. A step bound at or below the in-process deadline would kill a
    // review still inside its own budget — the regression this test exists to
    // catch, and it catches it at any input value.
    const inputMinutes = /timeout_minutes:\s*"?(\d+)"?/.exec(workflow);
    expect(
      inputMinutes,
      "maxi-review.yml declares no timeout_minutes"
    ).not.toBeNull();
    // Anchored on the STEP NAME, and tempered so it cannot leave that step.
    // This used to require `uses:` on the line immediately after
    // `timeout-minutes:`; YAML keys are unordered, so inserting an `id:` or
    // reordering the two would have failed this suite on a file that was
    // still internally consistent -- the same class of mistake as pinning
    // the literal 55. `(?:(?!\n\s*- )[\s\S])*?` stops the scan at the next
    // list item, so a reviewer step with NO bound cannot silently borrow the
    // bound of a later step and pass.
    const stepMinutes =
      /name: Run maxi-reviewer(?:(?!\n\s*- )[\s\S])*?timeout-minutes:\s*"?(\d+)"?/.exec(
        workflow
      );
    expect(
      stepMinutes,
      "no timeout-minutes on the maxi-reviewer step"
    ).not.toBeNull();
    const input = Number(inputMinutes![1]);
    const step = Number(stepMinutes![1]);
    const hardDeadline = input + 20;
    expect(
      step,
      `step bound ${step} must clear the in-process deadline ${hardDeadline} ` +
        `(timeout_minutes ${input} + 20) with cleanup headroom`
    ).toBeGreaterThan(hardDeadline);
    // `\d+`, not the literal, for the same reason as above: this pins the
    // SHAPE -- a named step, carrying a step bound, invoking the pinned
    // action -- which is what stops the bound being dropped entirely. The
    // VALUE is checked by the arithmetic immediately above, against whatever
    // maxi-config currently passes.
    expect(workflow).toMatch(
      /name: Run maxi-reviewer(?:(?!\n\s*- )[\s\S])*?timeout-minutes: \d+(?:(?!\n\s*- )[\s\S])*?uses: maxi-tools\/maxi-reviewer@/
    );
    // And the job cap sits above it with room for setup. The cap covers the
    // whole job — checkout, app-token mint, the pinned maxi-lint cargo
    // install, the rules fetch — so a cap only five minutes above the step
    // bound lets slow setup cancel the job before the step timeout can fire,
    // and a cancellation skips the graceful status cleanup the bound exists
    // to preserve.
    // Scoped to the reviewer job, like the step assertion above: a bare
    // `timeout-minutes: 70` match would be satisfied by any other job in the
    // file (lint-gate is at 10), so the reviewer's cap could be dropped and
    // this would still pass.
    expect(workflow).toMatch(
      /^ {2}review:\n(?: {4}.*\n| *\n)*? {4}timeout-minutes: 70$/m
    );
  });
});
