import { describe, it, expect } from "vitest";
import {
  extractEmittedFindings,
  correlateOutcomes,
  aggregateCalibration,
  lowPrecisionRules,
  buildCalibrationReport,
  EmittedFinding,
} from "../src/calibration.js";
import { ReviewArtifact } from "../src/types.js";

function artifact(
  validatedReview: unknown,
  analyzerFindings: unknown[] = []
): ReviewArtifact {
  return {
    schema: "maxi.review.v1.review-artifact",
    createdAt: "2026-06-28T00:00:00.000Z",
    retention: {
      harvestableAfterMerge: true,
      channels: ["github-actions-artifact", "github-pr-comment"],
      commentMarker: "<!-- maxi-review artifact -->",
    },
    repoFullName: "o/r",
    prNumber: 1,
    headSha: "h",
    baseSha: "b",
    analyzerFindings,
    rawJulesResponses: [],
    validatedReview,
    validationErrors: [],
  } as unknown as ReviewArtifact;
}

describe("extractEmittedFindings", () => {
  it("attributes a rule from sourceFindingIds via analyzer findings", () => {
    const a = artifact(
      {
        schema: "maxi.review.v1.jules-review",
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        comments: [
          {
            id: "c1",
            path: "src/a.ts",
            line: 4,
            severity: "Warning",
            confidence: "High",
            message: "m",
            sourceFindingIds: ["f1"],
          },
        ],
      },
      [
        {
          schema: "maxi.review.v1.analyzer-finding",
          id: "f1",
          tool: "opengrep",
          ruleId: "ts.no-floating-promises",
          severity: "warning",
          confidence: "high",
          message: "x",
          path: "src/a.ts",
          startLine: 4,
          endLine: 4,
        },
      ]
    );
    const found = extractEmittedFindings(a);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("ts.no-floating-promises");
    expect(found[0].severity).toBe("Warning");
    expect(found[0].path).toBe("src/a.ts");
  });

  it("falls back to code-review when no analyzer source is cited", () => {
    const a = artifact({
      schema: "maxi.review.v1.jules-review",
      summary: "s",
      verdict: "comment",
      resolvedCommentIds: [],
      comments: [
        {
          id: "c1",
          path: "src/b.ts",
          line: 2,
          severity: "High",
          confidence: "High",
          message: "m",
        },
      ],
    });
    expect(extractEmittedFindings(a)[0].rule).toBe("code-review");
  });

  it("reads the legacy ReviewResult newComments shape", () => {
    const a = artifact({
      summary: "s",
      verdict: "comment",
      resolvedCommentIds: [],
      newComments: [
        {
          file: "src/c.ts",
          line: 9,
          severity: "Info",
          confidence: "Low",
          message: "m",
          promptForAgents: "p",
        },
      ],
    });
    const found = extractEmittedFindings(a);
    expect(found[0].path).toBe("src/c.ts");
    expect(found[0].rule).toBe("code-review");
  });
});

describe("correlateOutcomes", () => {
  const findings: EmittedFinding[] = [
    { rule: "r1", severity: "Warning", path: "src/a.ts", line: 4 },
    { rule: "r1", severity: "Warning", path: "src/a.ts", line: 8 },
    { rule: "r2", severity: "High", path: "src/b.ts", line: 1 },
  ];

  it("maps resolved, open, and missing threads to outcomes", () => {
    const out = correlateOutcomes(findings, [
      { path: "src/a.ts", line: 4, resolved: true },
      { path: "src/a.ts", line: 8, resolved: false },
    ]);
    expect(out[0].outcome).toBe("accepted");
    expect(out[1].outcome).toBe("unaddressed");
    expect(out[2].outcome).toBe("dismissed");
  });
});

describe("aggregateCalibration and lowPrecisionRules", () => {
  it("computes per-rule accept-rate and flags low-precision rules", () => {
    const records = [
      {
        rule: "noisy",
        severity: "Warning",
        path: "src/a.ts",
        line: 1,
        outcome: "dismissed" as const,
      },
      {
        rule: "noisy",
        severity: "Warning",
        path: "src/a.ts",
        line: 2,
        outcome: "dismissed" as const,
      },
      {
        rule: "noisy",
        severity: "Warning",
        path: "src/a.ts",
        line: 3,
        outcome: "accepted" as const,
      },
      {
        rule: "noisy",
        severity: "Warning",
        path: "src/a.ts",
        line: 4,
        outcome: "unaddressed" as const,
      },
      {
        rule: "good",
        severity: "High",
        path: "lib/x.ts",
        line: 1,
        outcome: "accepted" as const,
      },
      {
        rule: "good",
        severity: "High",
        path: "lib/x.ts",
        line: 2,
        outcome: "accepted" as const,
      },
      {
        rule: "good",
        severity: "High",
        path: "lib/x.ts",
        line: 3,
        outcome: "accepted" as const,
      },
    ];
    const report = aggregateCalibration(records);
    const noisy = report.byRule.find((g) => g.key === "noisy")!;
    expect(noisy.total).toBe(4);
    expect(noisy.accepted).toBe(1);
    expect(noisy.dismissed).toBe(2);
    expect(noisy.unaddressed).toBe(1);
    expect(noisy.acceptRate).toBeCloseTo(1 / 3);

    const flagged = lowPrecisionRules(report, {
      minSamples: 3,
      maxAcceptRate: 0.5,
    });
    expect(flagged.map((g) => g.key)).toContain("noisy");
    expect(flagged.map((g) => g.key)).not.toContain("good");

    expect(report.byPath.map((g) => g.key)).toContain("src");
    expect(report.byPath.map((g) => g.key)).toContain("lib");
  });
});

describe("buildCalibrationReport", () => {
  it("combines artifacts and thread states end to end", () => {
    const a = artifact({
      schema: "maxi.review.v1.jules-review",
      summary: "s",
      verdict: "comment",
      resolvedCommentIds: [],
      comments: [
        {
          id: "c1",
          path: "src/a.ts",
          line: 4,
          severity: "Warning",
          confidence: "High",
          message: "m",
        },
      ],
    });
    const report = buildCalibrationReport([
      { artifact: a, threads: [{ path: "src/a.ts", line: 4, resolved: true }] },
    ]);
    const rule = report.byRule.find((g) => g.key === "code-review")!;
    expect(rule.accepted).toBe(1);
    expect(rule.acceptRate).toBe(1);
  });
});
