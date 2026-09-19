import { describe, it, expect } from "vitest";
import {
  extractEmittedFindings,
  correlateOutcomes,
  aggregateCalibration,
  lowPrecisionRules,
  buildCalibrationReport,
  ingestCalibration,
  pathGroupOf,
  EmittedFinding,
} from "../src/calibration.js";
import {
  AnalyzerFinding,
  JulesReview,
  JulesReviewComment,
  ReviewArtifact,
  ReviewComment,
  ReviewResult,
} from "../src/types.js";

function analyzerFinding(
  overrides: Partial<AnalyzerFinding> & Pick<AnalyzerFinding, "id">
): AnalyzerFinding {
  return {
    schema: "maxi.review.v1.analyzer-finding",
    tool: "opengrep",
    ruleId: "r1",
    severity: "warning",
    confidence: "high",
    message: "x",
    path: "src/a.ts",
    startLine: 4,
    endLine: 4,
    ...overrides,
  } satisfies AnalyzerFinding;
}

function julesComment(
  overrides: Partial<JulesReviewComment> &
    Pick<JulesReviewComment, "id" | "path" | "line">
): JulesReviewComment {
  return {
    severity: "Warning",
    confidence: "High",
    message: "m",
    ...overrides,
  } satisfies JulesReviewComment;
}

function legacyComment(
  overrides: Partial<ReviewComment> & Pick<ReviewComment, "file" | "line">
): ReviewComment {
  return {
    severity: "Info",
    confidence: "Low",
    message: "m",
    promptForAgents: "p",
    ...overrides,
  } satisfies ReviewComment;
}

function julesReview(comments: JulesReviewComment[]): JulesReview {
  return {
    schema: "maxi.review.v1.jules-review",
    summary: "s",
    verdict: "comment",
    resolvedCommentIds: [],
    comments,
  } satisfies JulesReview;
}

function legacyReview(newComments: ReviewComment[]): ReviewResult {
  return {
    summary: "s",
    verdict: "comment",
    resolvedCommentIds: [],
    newComments,
  } satisfies ReviewResult;
}

function artifact(
  validatedReview: JulesReview | ReviewResult | null,
  analyzerFindings: AnalyzerFinding[] = [],
  legacy = false
): ReviewArtifact {
  const base = {
    schema: "maxi.review.v1.review-artifact" as const,
    createdAt: "2026-06-28T00:00:00.000Z",
    retention: {
      harvestableAfterMerge: true as const,
      channels: ["github-actions-artifact", "github-pr-comment"] as [
        "github-actions-artifact",
        "github-pr-comment",
      ],
      commentMarker: "<!-- maxi-review artifact -->" as const,
    },
    repoFullName: "o/r",
    prNumber: 1,
    headSha: "h",
    baseSha: "b",
    analyzerFindings,
    rawJulesResponses: [] as string[],
    validatedReview,
    validationErrors: [] as string[],
  };
  if (legacy) {
    return base satisfies ReviewArtifact;
  }
  return {
    ...base,
    outcomeSchema: "maxi.review.v1.review-outcome" as const,
    outcome: "REVIEWED_WITH_FINDINGS" as const,
    reviewOutputChars: 1,
    runIdentity: {
      workflowRunId: 101,
      workflowRunAttempt: 1,
      job: "review",
    },
  } satisfies ReviewArtifact;
}

describe("extractEmittedFindings", () => {
  it("attributes a rule from sourceFindingIds via analyzer findings", () => {
    const a = artifact(
      julesReview([
        julesComment({
          id: "c1",
          path: "src/a.ts",
          line: 4,
          sourceFindingIds: ["f1"],
        }),
      ]),
      [
        analyzerFinding({
          id: "f1",
          ruleId: "ts.no-floating-promises",
        }),
      ]
    );
    const found = extractEmittedFindings(a);
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("ts.no-floating-promises");
    expect(found[0].severity).toBe("Warning");
    expect(found[0].path).toBe("src/a.ts");
  });

  it("falls back to code-review when no analyzer source is cited", () => {
    const a = artifact(
      julesReview([julesComment({ id: "c1", path: "src/b.ts", line: 2 })])
    );
    expect(extractEmittedFindings(a)[0].rule).toBe("code-review");
  });

  it("reads the legacy ReviewResult newComments shape", () => {
    const a = artifact(
      legacyReview([legacyComment({ file: "src/c.ts", line: 9 })])
    );
    const found = extractEmittedFindings(a);
    expect(found[0].path).toBe("src/c.ts");
    expect(found[0].rule).toBe("code-review");
  });

  it("returns no findings when the artifact is missing", () => {
    expect(extractEmittedFindings(undefined)).toEqual([]);
    expect(extractEmittedFindings(null)).toEqual([]);
  });

  it("skips a null analyzer finding instead of throwing", () => {
    const found = extractEmittedFindings({
      analyzerFindings: [
        null,
        analyzerFinding({
          id: "f1",
          ruleId: "ts.no-floating-promises",
        }),
      ],
      validatedReview: julesReview([
        julesComment({
          id: "c1",
          path: "src/a.ts",
          line: 4,
          sourceFindingIds: ["f1"],
        }),
      ]),
    });
    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe("ts.no-floating-promises");
  });

  it("skips a null legacy newComments element instead of throwing", () => {
    const found = extractEmittedFindings({
      analyzerFindings: [],
      validatedReview: {
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        newComments: [null, legacyComment({ file: "src/c.ts", line: 9 })],
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("src/c.ts");
  });

  it("skips a null structured comments element instead of throwing", () => {
    const found = extractEmittedFindings({
      analyzerFindings: [],
      validatedReview: {
        schema: "maxi.review.v1.jules-review",
        summary: "s",
        verdict: "comment",
        resolvedCommentIds: [],
        comments: [null, julesComment({ id: "c1", path: "src/d.ts", line: 2 })],
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("src/d.ts");
  });
});

describe("pathGroupOf", () => {
  it.each([
    ["src/a.ts", "src"],
    ["/src/a.ts", "src"],
    ["//src/a.ts", "src"],
    ["a.ts", "a.ts"],
    ["", "(unknown)"],
  ])("groups %s as %s", (input, expected) => {
    expect(pathGroupOf(input)).toBe(expected);
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

  it("treats missing findings or threads as empty instead of throwing", () => {
    expect(correlateOutcomes(undefined, undefined)).toEqual([]);
    expect(correlateOutcomes(null, null)).toEqual([]);
  });

  it("skips a null thread element instead of throwing", () => {
    const out = correlateOutcomes(findings, [
      null,
      { path: "src/a.ts", line: 4, resolved: true },
    ]);
    expect(out[0].outcome).toBe("accepted");
    expect(out[1].outcome).toBe("dismissed");
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
    const a = artifact(
      julesReview([julesComment({ id: "c1", path: "src/a.ts", line: 4 })])
    );
    const report = buildCalibrationReport([
      { artifact: a, threads: [{ path: "src/a.ts", line: 4, resolved: true }] },
    ]);
    const rule = report.byRule.find((g) => g.key === "code-review")!;
    expect(rule.accepted).toBe(1);
    expect(rule.acceptRate).toBe(1);
  });

  it("excludes legacy artifacts instead of inferring acceptance", () => {
    const legacy = artifact(
      julesReview([julesComment({ id: "c1", path: "src/a.ts", line: 4 })]),
      [],
      true
    );

    const report = buildCalibrationReport([
      {
        artifact: legacy,
        threads: [{ path: "src/a.ts", line: 4, resolved: true }],
      },
    ]);

    expect(report.byRule).toEqual([]);
    expect(report.bySeverity).toEqual([]);
    expect(report.byPath).toEqual([]);
  });
});

describe("ingestCalibration", () => {
  const validItem = {
    artifact: artifact(
      julesReview([julesComment({ id: "c1", path: "src/a.ts", line: 4 })])
    ),
    threads: [{ path: "src/a.ts", line: 4, resolved: true }],
  };

  it("excludes a null item and a missing artifact with a visible count", () => {
    const { report, excluded } = ingestCalibration([
      null,
      { artifact: null, threads: [] },
      validItem,
    ]);
    expect(excluded).toHaveLength(2);
    expect(excluded[0]).toEqual({
      index: 0,
      reason: "item must be an object",
    });
    expect(excluded[1]).toEqual({
      index: 1,
      reason: "artifact is missing",
    });
    expect(report.byRule.find((g) => g.key === "code-review")?.accepted).toBe(
      1
    );
  });

  it("excludes a null thread element and still correlates the rest", () => {
    const { report, excluded } = ingestCalibration([
      {
        artifact: validItem.artifact,
        threads: [null, { path: "src/a.ts", line: 4, resolved: true }],
      },
    ]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toMatch(/threads\[0\] is invalid/);
    expect(report.byRule.find((g) => g.key === "code-review")?.accepted).toBe(
      1
    );
  });

  it("excludes an artifact missing a required field", () => {
    const incomplete = { ...validItem.artifact };
    delete (incomplete as { createdAt?: string }).createdAt;
    const { report, excluded } = ingestCalibration([
      { artifact: incomplete, threads: validItem.threads },
    ]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].reason).toMatch(/createdAt/);
    expect(report.byRule).toEqual([]);
  });

  it("excludes an artifact with a null legacy newComments element", () => {
    const { report, excluded } = ingestCalibration([
      {
        artifact: {
          ...validItem.artifact,
          validatedReview: {
            summary: "s",
            verdict: "comment",
            resolvedCommentIds: [],
            newComments: [null, legacyComment({ file: "src/c.ts", line: 9 })],
          },
        },
        threads: [],
      },
    ]);
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.some((e) => /newComments/.test(e.reason))).toBe(true);
    expect(report.byRule).toEqual([]);
  });

  it("returns an empty report when items is not an array", () => {
    const { report, excluded } = ingestCalibration(undefined);
    expect(report.byRule).toEqual([]);
    expect(excluded).toEqual([{ index: -1, reason: "items must be an array" }]);
  });
});
