import {
  AnalyzerFinding,
  JulesReview,
  ReviewArtifact,
  ReviewResult,
} from "./types.js";

/**
 * Closing the feedback loop (issue #17). ReviewArtifacts are harvestable after
 * merge, but nothing fed which findings humans accepted vs dismissed back into
 * calibration. This module is the pure engine for that: it extracts the emitted
 * findings from a harvested artifact, correlates each with the merge-time
 * outcome of its review thread, and aggregates accept-rate by rule, severity,
 * and path group so low-precision rules can be surfaced for tuning.
 *
 * It is intentionally side-effect-free: the GitHub-specific harvesting (reading
 * artifacts + thread states at merge/close) and any auto-suppression belong to a
 * separate scheduled job that calls this engine.
 */

export type FindingOutcome = "accepted" | "dismissed" | "unaddressed";

export interface EmittedFinding {
  /** Analyzer ruleId when the comment cited one, else "code-review". */
  rule: string;
  severity: string;
  path: string;
  line: number;
}

/** Merge-time state of a review thread, as observed on the PR. */
export interface ThreadState {
  path: string;
  line: number;
  resolved: boolean;
}

export interface OutcomeRecord extends EmittedFinding {
  outcome: FindingOutcome;
}

export interface CalibrationGroup {
  key: string;
  total: number;
  accepted: number;
  dismissed: number;
  unaddressed: number;
  /** accepted / (accepted + dismissed); 0 when nothing was decided. */
  acceptRate: number;
}

export interface CalibrationReport {
  byRule: CalibrationGroup[];
  bySeverity: CalibrationGroup[];
  byPath: CalibrationGroup[];
}

export interface LowPrecisionOptions {
  /** Minimum decided (accepted + dismissed) samples before a rule is judged. */
  minSamples?: number;
  /** Accept-rate at or below which a rule is flagged low-precision. */
  maxAcceptRate?: number;
}

function pathGroupOf(path: string): string {
  if (!path) return "(unknown)";
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

interface CommentRow {
  path: string;
  line: number;
  severity: string;
  sourceFindingIds?: string[];
}

function reviewCommentRows(
  review: JulesReview | ReviewResult | null | undefined
): CommentRow[] {
  if (!review || typeof review !== "object") return [];
  if (Array.isArray((review as JulesReview).comments)) {
    return (review as JulesReview).comments.map((c) => ({
      path: c.path || "",
      line: c.line || 0,
      severity: String(c.severity || "Unknown"),
      sourceFindingIds: c.sourceFindingIds,
    }));
  }
  if (Array.isArray((review as ReviewResult).newComments)) {
    return (review as ReviewResult).newComments.map((c) => ({
      path: c.file || "",
      line: c.line || 0,
      severity: String(c.severity || "Unknown"),
    }));
  }
  return [];
}

function ruleFor(
  ids: string[] | undefined,
  analyzerRule: Map<string, string>
): string {
  if (ids) {
    for (const id of ids) {
      const rule = analyzerRule.get(id);
      if (rule) return rule;
    }
  }
  return "code-review";
}

/** Extract the findings a review artifact emitted, attributed to a rule. */
export function extractEmittedFindings(
  artifact: ReviewArtifact
): EmittedFinding[] {
  const analyzerRule = new Map<string, string>();
  for (const finding of artifact.analyzerFindings ?? []) {
    if (finding && typeof finding === "object") {
      const af = finding as AnalyzerFinding;
      if (af.id) analyzerRule.set(af.id, af.ruleId || af.tool || "analyzer");
    }
  }
  return reviewCommentRows(artifact.validatedReview).map((row) => ({
    rule: ruleFor(row.sourceFindingIds, analyzerRule),
    severity: row.severity,
    path: row.path,
    line: row.line,
  }));
}

/**
 * Correlate each emitted finding with the merge-time outcome of its thread:
 *  - accepted: a thread at the same path/line was resolved (fixed/acknowledged).
 *  - unaddressed: a thread is still open at merge.
 *  - dismissed: no surviving thread (deleted/minimized) for the emitted finding.
 */
export function correlateOutcomes(
  findings: EmittedFinding[],
  threads: ThreadState[]
): OutcomeRecord[] {
  return findings.map((finding) => {
    const match = threads.find(
      (t) => t.path === finding.path && t.line === finding.line
    );
    let outcome: FindingOutcome;
    if (!match) outcome = "dismissed";
    else if (match.resolved) outcome = "accepted";
    else outcome = "unaddressed";
    return { ...finding, outcome };
  });
}

function groupBy(
  records: OutcomeRecord[],
  keyFn: (r: OutcomeRecord) => string
): CalibrationGroup[] {
  const groups = new Map<string, CalibrationGroup>();
  for (const record of records) {
    const key = keyFn(record);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        total: 0,
        accepted: 0,
        dismissed: 0,
        unaddressed: 0,
        acceptRate: 0,
      };
      groups.set(key, group);
    }
    group.total++;
    if (record.outcome === "accepted") group.accepted++;
    else if (record.outcome === "dismissed") group.dismissed++;
    else group.unaddressed++;
  }
  for (const group of groups.values()) {
    const decided = group.accepted + group.dismissed;
    group.acceptRate = decided > 0 ? group.accepted / decided : 0;
  }
  return [...groups.values()].sort(
    (a, b) => b.total - a.total || a.key.localeCompare(b.key)
  );
}

export function aggregateCalibration(
  records: OutcomeRecord[]
): CalibrationReport {
  return {
    byRule: groupBy(records, (r) => r.rule),
    bySeverity: groupBy(records, (r) => r.severity),
    byPath: groupBy(records, (r) => pathGroupOf(r.path)),
  };
}

/** Surface rules whose decided accept-rate is low enough to warrant tuning. */
export function lowPrecisionRules(
  report: CalibrationReport,
  options: LowPrecisionOptions = {}
): CalibrationGroup[] {
  const minSamples = options.minSamples ?? 5;
  const maxAcceptRate = options.maxAcceptRate ?? 0.3;
  return report.byRule.filter(
    (g) =>
      g.accepted + g.dismissed >= minSamples && g.acceptRate <= maxAcceptRate
  );
}

/** End-to-end: build a calibration report from harvested artifacts + outcomes. */
export function buildCalibrationReport(
  items: Array<{ artifact: ReviewArtifact; threads: ThreadState[] }>
): CalibrationReport {
  const records: OutcomeRecord[] = [];
  for (const item of items) {
    records.push(
      ...correlateOutcomes(extractEmittedFindings(item.artifact), item.threads)
    );
  }
  return aggregateCalibration(records);
}
