import {
  AnalyzerFinding,
  JulesReview,
  ReviewArtifact,
  ValidationResult,
} from "./types.js";

export function validateAnalyzerFinding(
  value: unknown
): ValidationResult<AnalyzerFinding> {
  const errors: string[] = [];
  const record = asRecord(value, errors, "finding");
  if (!record) return { ok: false, errors };

  requireString(record, "schema", "maxi.review.v1.analyzer-finding", errors);
  requireString(record, "id", undefined, errors);
  requireString(record, "tool", undefined, errors);
  requireString(record, "ruleId", undefined, errors);
  requireEnum(record, "severity", ["info", "warning", "error"], errors);
  requireEnum(
    record,
    "confidence",
    ["low", "medium", "high", "unknown"],
    errors
  );
  requireString(record, "message", undefined, errors);
  requireString(record, "path", undefined, errors);
  requirePositiveInt(record, "startLine", errors);
  requirePositiveInt(record, "endLine", errors);
  if (
    typeof record.startLine === "number" &&
    typeof record.endLine === "number" &&
    Number.isInteger(record.startLine) &&
    Number.isInteger(record.endLine) &&
    record.startLine > 0 &&
    record.endLine > 0 &&
    record.endLine < record.startLine
  ) {
    errors.push("endLine must be greater than or equal to startLine");
  }

  return { ok: errors.length === 0, value: value as AnalyzerFinding, errors };
}

export function validateJulesReview(
  value: unknown
): ValidationResult<JulesReview> {
  const errors: string[] = [];
  const record = asRecord(value, errors, "review");
  if (!record) return { ok: false, errors };

  requireString(record, "schema", "maxi.review.v1.jules-review", errors);
  requireString(record, "summary", undefined, errors);
  requireEnum(record, "verdict", ["approve", "comment", "block"], errors);
  if (!Array.isArray(record.resolvedCommentIds)) {
    errors.push("resolvedCommentIds must be an array");
  }
  if (!Array.isArray(record.comments)) {
    errors.push("comments must be an array");
  } else {
    record.comments.forEach((comment, index) => {
      const item = asRecord(comment, errors, `comments[${index}]`);
      if (!item) return;
      requireString(item, "id", undefined, errors);
      requireString(item, "path", undefined, errors);
      requirePositiveInt(item, "line", errors);
      optionalPositiveInt(item, "startLine", errors);
      optionalPositiveInt(item, "endLine", errors);
      requireEnum(item, "severity", ["Info", "Warning", "High"], errors);
      requireEnum(item, "confidence", ["Low", "Medium", "High"], errors);
      requireString(item, "message", undefined, errors);
      optionalString(item, "promptForAgents", errors);
      optionalStringArray(item, "sourceFindingIds", errors);
      validateSuggestion(
        item.suggestion,
        errors,
        `comments[${index}].suggestion`
      );
    });
  }

  return { ok: errors.length === 0, value: value as JulesReview, errors };
}

export function validateReviewArtifact(
  value: unknown
): ValidationResult<ReviewArtifact> {
  const errors: string[] = [];
  const record = asRecord(value, errors, "artifact");
  if (!record) return { ok: false, errors };

  requireString(record, "schema", "maxi.review.v1.review-artifact", errors);
  requireString(record, "createdAt", undefined, errors);
  validateRetention(record.retention, errors);
  requireString(record, "repoFullName", undefined, errors);
  requirePositiveInt(record, "prNumber", errors);
  requireString(record, "headSha", undefined, errors);
  requireString(record, "baseSha", undefined, errors);
  requireArray(record, "analyzerFindings", errors);
  requireStringArray(record, "rawJulesResponses", errors);
  if (record.validatedReview === undefined) {
    errors.push("validatedReview is required");
  }
  requireStringArray(record, "validationErrors", errors);
  optionalString(record, "sessionId", errors);

  return { ok: errors.length === 0, value: value as ReviewArtifact, errors };
}

function validateRetention(value: unknown, errors: string[]): void {
  const retention = asRecord(value, errors, "retention");
  if (!retention) return;
  if (retention.harvestableAfterMerge !== true) {
    errors.push("retention.harvestableAfterMerge must be true");
  }
  if (
    !Array.isArray(retention.channels) ||
    retention.channels.length !== 2 ||
    retention.channels[0] !== "github-actions-artifact" ||
    retention.channels[1] !== "github-pr-comment"
  ) {
    errors.push(
      "retention.channels must be github-actions-artifact, github-pr-comment"
    );
  }
  if (retention.commentMarker !== "<!-- maxi-review artifact -->") {
    errors.push(
      "retention.commentMarker must be <!-- maxi-review artifact -->"
    );
  }
}

function validateSuggestion(
  value: unknown,
  errors: string[],
  label: string
): void {
  if (value === undefined) return;
  const suggestion = asRecord(value, errors, label);
  if (!suggestion) return;
  requireString(suggestion, "path", undefined, errors, `${label}.`);
  requirePositiveInt(suggestion, "startLine", errors, `${label}.`);
  requirePositiveInt(suggestion, "endLine", errors, `${label}.`);
  if (
    Number.isInteger(suggestion.startLine) &&
    Number.isInteger(suggestion.endLine) &&
    (suggestion.endLine as number) < (suggestion.startLine as number)
  ) {
    errors.push(`${label}.endLine must be greater than or equal to startLine`);
  }
  requireStringValue(suggestion, "replacement", errors, `${label}.`);
}

function asRecord(
  value: unknown,
  errors: string[],
  label: string
): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  errors.push(`${label} must be an object`);
  return undefined;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  exact: string | undefined,
  errors: string[],
  prefix = ""
): void {
  if (typeof record[key] !== "string" || record[key] === "") {
    errors.push(`${prefix}${key} must be a non-empty string`);
    return;
  }
  if (exact !== undefined && record[key] !== exact) {
    errors.push(`${prefix}${key} must be ${exact}`);
  }
}

function requireStringValue(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix = ""
): void {
  if (typeof record[key] !== "string") {
    errors.push(`${prefix}${key} must be a string`);
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  errors: string[]
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    errors.push(`${key} must be a string`);
  }
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[]
): void {
  if (record[key] === undefined) return;
  if (!Array.isArray(record[key])) {
    errors.push(`${key} must be an array`);
    return;
  }
  (record[key] as unknown[]).forEach((item, index) => {
    if (typeof item !== "string" || item === "") {
      errors.push(`${key}[${index}] must be a non-empty string`);
    }
  });
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[]
): void {
  if (!Array.isArray(record[key])) {
    errors.push(`${key} must be an array`);
    return;
  }
  (record[key] as unknown[]).forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(`${key}[${index}] must be a string`);
    }
  });
}

function requireArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[]
): void {
  if (!Array.isArray(record[key])) {
    errors.push(`${key} must be an array`);
  }
}

function requireEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: string[],
  errors: string[]
): void {
  if (
    typeof record[key] !== "string" ||
    !allowed.includes(record[key] as string)
  ) {
    errors.push(`${key} must be one of ${allowed.join(", ")}`);
  }
}

function requirePositiveInt(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  prefix = ""
): void {
  if (!Number.isInteger(record[key]) || (record[key] as number) < 1) {
    errors.push(`${prefix}${key} must be a positive integer`);
  }
}

function optionalPositiveInt(
  record: Record<string, unknown>,
  key: string,
  errors: string[]
): void {
  if (record[key] !== undefined) {
    requirePositiveInt(record, key, errors);
  }
}
