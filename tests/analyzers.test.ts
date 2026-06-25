import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseOpengrepJson,
  parseOpengrepSarif,
} from "../src/analyzers/opengrep.js";
import { parseCpdXml, parsePmdXml } from "../src/analyzers/pmd.js";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

describe("analyzer parsers", () => {
  it("normalizes Semgrep-compatible JSON", () => {
    const findings = parseOpengrepJson(fixture("semgrep.json"));
    expect(findings).toMatchObject([
      {
        schema: "maxi.review.v1.analyzer-finding",
        tool: "opengrep",
        ruleId: "typescript.no-floating-promises",
        severity: "warning",
        confidence: "high",
        path: "src/a.ts",
        startLine: 4,
        endLine: 4,
      },
    ]);
  });

  it("normalizes SARIF results", () => {
    const findings = parseOpengrepSarif(fixture("semgrep.sarif.json"));
    expect(findings[0].ruleId).toBe("python.requests.verify-disabled");
    expect(findings[0].helpUri).toBe("https://example.invalid/rules/verify");
  });

  it("normalizes PMD XML violations", () => {
    const findings = parsePmdXml(fixture("pmd.xml"));
    expect(findings[0].tool).toBe("pmd");
    expect(findings[0].path).toBe("src/Main.java");
  });

  it("normalizes CPD XML duplicates", () => {
    const findings = parseCpdXml(fixture("cpd.xml"));
    expect(findings[0].tool).toBe("cpd");
    expect(findings[0].ruleId).toBe("copy-paste-duplicate");
  });
});
