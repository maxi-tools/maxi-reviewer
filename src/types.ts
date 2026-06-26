export type FailOn = "never" | "blocking" | "any";
export type Verdict = "approve" | "comment" | "block";
export type AnalyzerSeverity = "info" | "warning" | "error";
export type AnalyzerConfidence = "low" | "medium" | "high" | "unknown";

export interface OpenThread {
  index: number;
  threadId: string;
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
  rules?: string;
  openThreads: OpenThread[];
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
