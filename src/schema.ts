import { AnalyzerFinding, JulesReview, ValidationResult } from "./types.js";

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
      requireEnum(item, "severity", ["Info", "Warning", "High"], errors);
      requireEnum(item, "confidence", ["Low", "Medium", "High"], errors);
      requireString(item, "message", undefined, errors);
    });
  }

  return { ok: errors.length === 0, value: value as JulesReview, errors };
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
  errors: string[]
): void {
  if (typeof record[key] !== "string" || record[key] === "") {
    errors.push(`${key} must be a non-empty string`);
    return;
  }
  if (exact !== undefined && record[key] !== exact) {
    errors.push(`${key} must be ${exact}`);
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
  errors: string[]
): void {
  if (!Number.isInteger(record[key]) || (record[key] as number) < 1) {
    errors.push(`${key} must be a positive integer`);
  }
}
