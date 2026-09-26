import {
  AnalyzerFinding,
  JulesReview,
  ReviewArtifact,
  ReviewResult,
  ThreadState,
} from "./types.js";
import { validateReviewArtifact, validateThreadState } from "./schema.js";

export type { ThreadState };

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

/** One harvested row the engine refused to correlate, with a visible reason. */
export interface ExcludedObservation {
  index: number;
  reason: string;
}

export interface CalibrationInput {
  artifact: ReviewArtifact;
  threads: ThreadState[];
}

export interface LowPrecisionOptions {
  /** Minimum decided (accepted + dismissed) samples before a rule is judged. */
  minSamples?: number;
  /** Accept-rate at or below which a rule is flagged low-precision. */
  maxAcceptRate?: number;
}

/**
 * The top-level path segment used to bucket a finding for `byPath`. Exported
 * so callers can bucket paths the same way this module does.
 *
 * Strips leading `/` (and repeats of it) before bucketing so a repository
 * path with a leading slash, e.g. `/src/a.ts`, lands in the same `src`
 * bucket as `src/a.ts` instead of the meaningless `""` key.
 */
export function pathGroupOf(path: string): string {
  const normalized = (path || "").replace(/^\/+/, "");
  if (!normalized) return "(unknown)";
  const slash = normalized.indexOf("/");
  return slash === -1 ? normalized : normalized.slice(0, slash);
}

interface CommentRow {
  path: string;
  line: number;
  severity: string;
  sourceFindingIds?: string[];
}

function reviewCommentRows(review: unknown, excluded?: string[]): CommentRow[] {
  if (!review || typeof review !== "object") return [];
  if (Array.isArray((review as JulesReview).comments)) {
    return (review as JulesReview).comments.flatMap((c, i) => {
      if (c == null || typeof c !== "object") {
        excluded?.push(`comments[${i}] must be an object`);
        return [];
      }
      return [
        {
          path: c.path || "",
          line: c.line || 0,
          severity: String(c.severity || "Unknown"),
          sourceFindingIds: c.sourceFindingIds,
        },
      ];
    });
  }
  if (Array.isArray((review as ReviewResult).newComments)) {
    return (review as ReviewResult).newComments.flatMap((c, i) => {
      if (c == null || typeof c !== "object") {
        excluded?.push(`newComments[${i}] must be an object`);
        return [];
      }
      return [
        {
          path: c.file || "",
          line: c.line || 0,
          severity: String(c.severity || "Unknown"),
        },
      ];
    });
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
  artifact:
    | {
        analyzerFindings?: readonly unknown[] | null;
        validatedReview?: unknown;
      }
    | null
    | undefined,
  excluded?: string[]
): EmittedFinding[] {
  if (!artifact || typeof artifact !== "object") return [];
  const analyzerRule = new Map<string, string>();
  const findings = Array.isArray(artifact.analyzerFindings)
    ? artifact.analyzerFindings
    : [];
  for (const finding of findings) {
    if (finding && typeof finding === "object") {
      const af = finding as AnalyzerFinding;
      if (af.id) analyzerRule.set(af.id, af.ruleId || af.tool || "analyzer");
    }
  }
  return reviewCommentRows(artifact.validatedReview, excluded).map((row) => ({
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
  findings: EmittedFinding[] | null | undefined,
  threads: Array<ThreadState | null | undefined> | null | undefined
): OutcomeRecord[] {
  const safeFindings = Array.isArray(findings) ? findings : [];
  const safeThreads = Array.isArray(threads)
    ? threads.filter(
        (t): t is ThreadState => t != null && typeof t === "object"
      )
    : [];
  return safeFindings.map((finding) => {
    const match = safeThreads.find(
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

/**
 * Validated-input boundary for harvested artifacts and thread observations.
 * Malformed items are counted, not thrown or silently coerced.
 */
export function ingestCalibration(items: unknown): {
  report: CalibrationReport;
  excluded: ExcludedObservation[];
} {
  const excluded: ExcludedObservation[] = [];
  if (!Array.isArray(items)) {
    return {
      report: aggregateCalibration([]),
      excluded: [{ index: -1, reason: "items must be an array" }],
    };
  }

  const records: OutcomeRecord[] = [];
  items.forEach((item, index) => {
    if (item == null || typeof item !== "object") {
      excluded.push({ index, reason: "item must be an object" });
      return;
    }
    const rec = item as { artifact?: unknown; threads?: unknown };
    if (rec.artifact == null) {
      excluded.push({ index, reason: "artifact is missing" });
      return;
    }
    const artifactResult = validateReviewArtifact(rec.artifact);
    if (!artifactResult.ok || !artifactResult.value) {
      excluded.push({
        index,
        reason: `artifact is invalid: ${artifactResult.errors.join("; ")}`,
      });
      return;
    }
    const artifact = artifactResult.value;

    const threads: ThreadState[] = [];
    if (rec.threads == null) {
      // Missing threads is "no surviving thread", not a malformed item.
    } else if (!Array.isArray(rec.threads)) {
      excluded.push({ index, reason: "threads must be an array" });
      return;
    } else {
      rec.threads.forEach((thread, threadIndex) => {
        const result = validateThreadState(thread);
        if (!result.ok || !result.value) {
          excluded.push({
            index,
            reason: `threads[${threadIndex}] is invalid: ${result.errors.join("; ")}`,
          });
          return;
        }
        threads.push(result.value);
      });
    }

    const commentExcluded: string[] = [];
    const findings = extractEmittedFindings(artifact, commentExcluded);
    for (const reason of commentExcluded) {
      excluded.push({ index, reason });
    }

    if (artifact.outcome !== "REVIEWED_WITH_FINDINGS") return;
    records.push(...correlateOutcomes(findings, threads));
  });

  return { report: aggregateCalibration(records), excluded };
}

/** End-to-end: build a calibration report from harvested artifacts + outcomes. */
export function buildCalibrationReport(
  items: Array<CalibrationInput>
): CalibrationReport {
  return ingestCalibration(items).report;
}
