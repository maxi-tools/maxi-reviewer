import { JulesReviewComment, ReviewComment } from "./types.js";

export interface AppliedSuggestion {
  file: string;
  startLine: number;
  endLine: number;
}

export interface SkippedSuggestion extends AppliedSuggestion {
  reason:
    | "missing file"
    | "invalid range"
    | "no structured replacement"
    | "overlapping range";
}

export interface ApplyResult {
  files: Map<string, string>;
  applied: AppliedSuggestion[];
  skipped: SkippedSuggestion[];
}

interface NormalizedSuggestion {
  file: string;
  startLine: number;
  endLine: number;
  replacement?: string;
}

export function applyStructuredSuggestions(
  files: Map<string, string>,
  comments: Array<ReviewComment | JulesReviewComment>
): ApplyResult {
  const resultFiles = new Map(files);
  const applied: AppliedSuggestion[] = [];
  const skipped: SkippedSuggestion[] = [];
  const appliedRanges = new Map<string, AppliedSuggestion[]>();
  // Apply each file's suggestions from bottom to top so replacements that add or
  // remove lines cannot shift the original line numbers of suggestions above.
  const sortedSuggestions = comments
    .map((comment) => normalizeSuggestion(comment))
    .sort(compareSuggestionsForApply);

  for (const suggestion of sortedSuggestions) {
    const skipBase = {
      file: suggestion.file,
      startLine: suggestion.startLine,
      endLine: suggestion.endLine,
    };

    const content = resultFiles.get(suggestion.file);
    if (content === undefined) {
      skipped.push({ ...skipBase, reason: "missing file" });
      continue;
    }
    if (suggestion.replacement === undefined) {
      skipped.push({ ...skipBase, reason: "no structured replacement" });
      continue;
    }
    if (
      suggestion.startLine < 1 ||
      suggestion.endLine < suggestion.startLine ||
      suggestion.endLine > splitPreservingFinalNewline(content).bodyLines.length
    ) {
      skipped.push({ ...skipBase, reason: "invalid range" });
      continue;
    }
    if (overlaps(appliedRanges.get(suggestion.file) || [], suggestion)) {
      skipped.push({ ...skipBase, reason: "overlapping range" });
      continue;
    }

    resultFiles.set(
      suggestion.file,
      replaceLines(
        content,
        suggestion.startLine,
        suggestion.endLine,
        suggestion.replacement
      )
    );
    const appliedSuggestion = {
      file: suggestion.file,
      startLine: suggestion.startLine,
      endLine: suggestion.endLine,
    };
    applied.push(appliedSuggestion);
    appliedRanges.set(suggestion.file, [
      ...(appliedRanges.get(suggestion.file) || []),
      appliedSuggestion,
    ]);
  }

  return { files: resultFiles, applied, skipped };
}

export function validateApplyAllHead(
  expectedHeadSha: string,
  currentHeadSha: string
): { ok: true } | { ok: false; reason: string } {
  if (expectedHeadSha !== currentHeadSha) {
    return {
      ok: false,
      reason: `stale head SHA: expected ${expectedHeadSha}, got ${currentHeadSha}`,
    };
  }
  return { ok: true };
}

export function buildApplyAllCommitMessage(appliedCount: number): string {
  return `Apply ${appliedCount} Maxi suggestion${appliedCount === 1 ? "" : "s"}`;
}

function normalizeSuggestion(
  comment: ReviewComment | JulesReviewComment
): NormalizedSuggestion {
  if ("suggestion" in comment && comment.suggestion) {
    return {
      file: comment.suggestion.path,
      startLine: comment.suggestion.startLine,
      endLine: comment.suggestion.endLine,
      replacement: comment.suggestion.replacement,
    };
  }

  const legacy = comment as ReviewComment;
  return {
    file: legacy.file,
    startLine: legacy.startLine || legacy.line,
    endLine: legacy.endLine || legacy.startLine || legacy.line,
    replacement:
      legacy.suggestedReplacement ?? extractSuggestionFence(legacy.message),
  };
}

function extractSuggestionFence(message: string): string | undefined {
  const match = message.match(/```suggestion\s*\n([\s\S]*?)(?:\n)?```/);
  return match?.[1];
}

function replaceLines(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  const { bodyLines, hasFinalNewline } = splitPreservingFinalNewline(content);
  const replacementLines = replacement === "" ? [] : replacement.split("\n");
  bodyLines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  return bodyLines.join("\n") + (hasFinalNewline ? "\n" : "");
}

function splitPreservingFinalNewline(content: string): {
  bodyLines: string[];
  hasFinalNewline: boolean;
} {
  const hasFinalNewline = content.endsWith("\n");
  const body = hasFinalNewline ? content.slice(0, -1) : content;
  return {
    bodyLines: body.length === 0 ? [] : body.split("\n"),
    hasFinalNewline,
  };
}

function overlaps(
  applied: AppliedSuggestion[],
  next: AppliedSuggestion
): boolean {
  return applied.some(
    (existing) =>
      next.startLine <= existing.endLine && next.endLine >= existing.startLine
  );
}

function compareSuggestionsForApply(
  left: NormalizedSuggestion,
  right: NormalizedSuggestion
): number {
  const fileOrder = left.file.localeCompare(right.file);
  if (fileOrder !== 0) return fileOrder;
  return right.startLine - left.startLine || left.endLine - right.endLine;
}
