export type FailOn = "never" | "blocking" | "any";
export type Verdict = "approve" | "comment" | "block";
export type ReviewOutcome =
  | "TIMED_OUT_NO_CONTENT"
  | "REVIEWED_NO_FINDINGS"
  | "REVIEWED_WITH_FINDINGS";

export interface ReviewRunIdentity {
  workflowRunId: number;
  workflowRunAttempt: number;
  job: string;
}

export type AnalyzerSeverity = "info" | "warning" | "error";
export type AnalyzerConfidence = "low" | "medium" | "high" | "unknown";

export interface OpenThreadComment {
  author: string;
  body: string;
  line: number;
  viewerDidAuthor: boolean;
  createdAt?: string;
}

export interface OpenThread {
  index: number;
  threadId: string;
  path: string;
  line: number;
  body: string;
  comments: OpenThreadComment[];
}

/** A line-numbered slice of a changed file, centred on a changed hunk. */
export interface ChangedFileContextWindow {
  startLine: number;
  endLine: number;
  /** Lines [startLine..endLine] of the file at PR head, each prefixed `<n>\t`. */
  text: string;
}

/** Surrounding context for one changed file (one or more merged hunk windows). */
export interface ChangedFileContext {
  path: string;
  windows: ChangedFileContextWindow[];
}

/**
 * Issues this PR declares it closes (via closing keywords in the PR body),
 * fetched so the model can check the diff against their acceptance criteria.
 * Title/body are attacker-controllable and MUST be nonce-fenced when rendered.
 */
export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** True when the body was truncated to the per-issue character cap. */
  truncated: boolean;
}

/**
 * CI / test / coverage evidence for the PR head, fetched from GitHub check-runs
 * and/or supplied report files. Grounds the missing-tests judgement and
 * the external-tool-compatibility rule (which already asks for an observed
 * CI/runtime failure) in what CI actually reported. All fields are tool-derived
 * and rendered as nonce-fenced UNTRUSTED data.
 */
export interface CiCheckRun {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | skipped */
  conclusion?: string;
  /** Check-run output title/summary, capped. */
  summary?: string;
  detailsUrl?: string;
}

export interface CiSignal {
  schema: "maxi.review.v1.ci-signal";
  /** Check-runs at the PR head (this review check is excluded). */
  checkRuns: CiCheckRun[];
  /** Optional test report text (e.g. a JUnit summary) supplied via input. */
  testReport?: string;
  /** Optional coverage summary text (e.g. a coverage delta) supplied via input. */
  coverageSummary?: string;
  /** True when any check summary or report text was truncated to its cap. */
  truncated: boolean;
}

/**
 * A finding another reviewer (bot or human) already posted as an inline comment
 * on this PR, fetched so the model can avoid restating it. The author and body
 * are attacker-influenceable and rendered as nonce-fenced UNTRUSTED data.
 */
export interface ExistingFinding {
  author: string;
  path: string;
  line: number;
  body: string;
}

export interface PromptArgs {
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  diff: string;
  diffTruncatedNote?: string;
  extraInstructions?: string;
  rulesFromFile?: string;
  analyzerFindings?: AnalyzerFinding[];
  /**
   * CI / test / coverage evidence for the PR head. Rendered as nonce-fenced
   * UNTRUSTED data so the model can ground missing-tests and external-tool
   * findings in what CI observed instead of speculation.
   */
  ciSignal?: CiSignal;
  /**
   * Active inline findings from OTHER reviewers (CodeRabbit, Codacy, Codex,
   * cubic, ...) so the model can avoid restating them. Nonce-fenced UNTRUSTED.
   */
  existingFindings?: ExistingFinding[];
  rules?: string;
  openThreads: OpenThread[];
  /**
   * Line-numbered source around each changed hunk at PR head, derived from the
   * already-fetched head files. Lets the model reason about callers, types, and
   * control flow the diff alone omits. Context only — not the review target.
   */
  changedFileContext?: ChangedFileContext[];
  /**
   * Paths of generated/vendored files excluded from the reviewed diff, so the
   * model knows they changed but are intentionally not under review.
   */
  excludedGeneratedPaths?: string[];
  /**
   * Per-review nonce for untrusted fences. Supplied by the orchestrator so the
   * agentic retrieval loop can fence its results with the same token the prompt
   * uses. When omitted, the prompt builder generates its own.
   */
  nonce?: string;
  /**
   * When true, include instructions enabling the optional agentic retrieval
   * step (read_file / grep / list_references at the PR head) before the verdict.
   */
  retrievalMode?: boolean;
  /**
   * Issues this PR declares it closes, fetched for acceptance-criteria
   * grounding. Rendered as nonce-fenced UNTRUSTED data.
   */
  linkedIssues?: LinkedIssue[];
  /**
   * True when this is an incremental (synchronize) review whose diff covers
   * only the latest push, not the whole PR. Lets the prompt qualify linked-issue
   * grounding so a partial diff does not trigger spurious unmet-criteria findings.
   */
  incrementalReview?: boolean;
}

/**
 * Drift-tolerant locator for a finding. The {file,line} pair drifts after a
 * rebase or force-push; this lets a consumer re-resolve the target by the
 * hashed content of the line(s) and the enclosing symbol when the line number
 * no longer matches. Purely additive, emitted alongside line.
 */
export interface FindingAnchor {
  schema: "maxi.review.v1.finding-anchor";
  /** Line the anchor was computed at (the original, pre-drift location). */
  line: number;
  /** Number of lines the target spans (startLine..endLine inclusive). */
  lineCount: number;
  /** Hash of the normalized target line(s). */
  lineHash: string;
  /** Hash of the target plus surrounding context lines, to disambiguate. */
  contextHash: string;
  /** Enclosing definition name when detectable, for coarse relocation. */
  symbol?: string;
}

export interface ReviewComment {
  file: string;
  line: number;
  startLine?: number;
  endLine?: number;
  severity: "Info" | "Warning" | "High";
  confidence: "Low" | "Medium" | "High";
  message: string;
  promptForAgents: string;
  suggestedReplacement?: string;
  /**
   * Optional multi-location fix carried from a structured review (see
   * StructuredFix). apply.ts prefers this over suggestion/suggestedReplacement.
   */
  fix?: StructuredFix;
  /**
   * Optional drift-tolerant anchor (content/symbol hash) so consumers can
   * re-resolve this finding after a rebase or force-push moves the line.
   */
  anchor?: FindingAnchor;
}

export interface ReviewResult {
  summary: string;
  verdict: Verdict;
  resolvedCommentIds: number[];
  newComments: ReviewComment[];
}

export interface AnalyzerFinding {
  schema: "maxi.review.v1.analyzer-finding";
  id: string;
  tool: string;
  toolVersion?: string;
  ruleId: string;
  ruleName?: string;
  severity: AnalyzerSeverity;
  confidence: AnalyzerConfidence;
  message: string;
  path: string;
  startLine: number;
  endLine: number;
  helpUri?: string;
  license?: string;
  raw?: unknown;
}

export interface StructuredSuggestion {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface StructuredFix {
  /**
   * Edits across one or more files that together make up a single fix. apply.ts
   * applies them transactionally: either every edit lands or none do.
   */
  edits: StructuredSuggestion[];
}

export interface JulesReviewComment {
  id: string;
  path: string;
  line: number;
  startLine?: number;
  endLine?: number;
  severity: "Info" | "Warning" | "High";
  confidence: "Low" | "Medium" | "High";
  message: string;
  promptForAgents?: string;
  sourceFindingIds?: string[];
  suggestion?: StructuredSuggestion;
  /**
   * Optional machine-applicable multi-location fix: one or more edits, possibly
   * across files, applied transactionally. Use when the change cannot be
   * expressed as the single-range suggestion. The suggestion field is still
   * used for the GitHub inline-suggestion UX.
   */
  fix?: StructuredFix;
}

export interface JulesReview {
  schema: "maxi.review.v1.jules-review";
  summary: string;
  verdict: Verdict;
  resolvedCommentIds: number[];
  comments: JulesReviewComment[];
}

export interface ReviewArtifactRetention {
  harvestableAfterMerge: true;
  channels: ["github-actions-artifact", "github-pr-comment"];
  commentMarker: "<!-- maxi-review artifact -->";
}

export interface ReviewArtifact {
  schema: "maxi.review.v1.review-artifact";
  /** Absent only on permanently ambiguous legacy artifacts. */
  outcomeSchema?: "maxi.review.v1.review-outcome";
  /** Producer-written result; consumers must never infer this from payload shape. */
  outcome?: ReviewOutcome;
  reviewOutputChars?: number;
  runIdentity?: ReviewRunIdentity;
  createdAt: string;
  retention: ReviewArtifactRetention;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  analyzerFindings: AnalyzerFinding[];
  rawJulesResponses: string[];
  validatedReview: JulesReview | ReviewResult | null;
  validationErrors: string[];
  sessionId?: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}
