import { createHash } from "node:crypto";
import {
  AnalyzerConfidence,
  AnalyzerFinding,
  AnalyzerSeverity,
} from "../types.js";

export function normalizeSeverity(raw: unknown): AnalyzerSeverity {
  const text = String(raw || "").toLowerCase();
  if (["error", "high", "critical"].includes(text)) return "error";
  if (["warning", "warn", "medium"].includes(text)) return "warning";
  return "info";
}

export function normalizeConfidence(raw: unknown): AnalyzerConfidence {
  const text = String(raw || "").toLowerCase();
  if (["high", "medium", "low"].includes(text)) {
    return text as AnalyzerConfidence;
  }
  return "unknown";
}

export function findingId(parts: {
  tool: string;
  ruleId: string;
  path: string;
  startLine: number;
  message: string;
}): string {
  return createHash("sha256")
    .update(
      `${parts.tool}\0${parts.ruleId}\0${parts.path}\0${parts.startLine}\0${parts.message}`
    )
    .digest("hex")
    .slice(0, 24);
}

export function buildFinding(
  input: Omit<AnalyzerFinding, "schema" | "id"> & { id?: string }
): AnalyzerFinding {
  const startLine = Math.max(1, input.startLine);
  const endLine = Math.max(startLine, input.endLine);
  return {
    ...input,
    schema: "maxi.review.v1.analyzer-finding",
    id:
      input.id ??
      findingId({
        tool: input.tool,
        ruleId: input.ruleId,
        path: input.path,
        startLine,
        message: input.message,
      }),
    startLine,
    endLine,
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asPositiveInt(value: unknown, fallback = 1): number {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

export function asText(value: unknown): string;
export function asText(value: unknown, fallback: string): string;
export function asText(value: unknown, fallback: undefined): string | undefined;
export function asText(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (arguments.length > 1) {
    return fallback;
  }
  return "";
}
