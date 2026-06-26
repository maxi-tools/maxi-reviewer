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

    const setupIndex = workflow.indexOf("actions/setup-node@v5");
    const installIndex = workflow.indexOf("npm install");
    const buildIndex = workflow.indexOf("npm run build");
    const dogfoodIndex = workflow.indexOf("uses: ./");

    expect(setupIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(setupIndex);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(dogfoodIndex).toBeGreaterThan(buildIndex);
    expect(workflow).toContain('node-version: "24"');
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
      expect(workflow).toContain("actions/setup-node@v5");
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
});
