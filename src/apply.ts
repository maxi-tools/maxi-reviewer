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
    | "overlapping range"
    | "incomplete fix";
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

interface AcceptedEdit {
  file: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export function applyStructuredSuggestions(
  files: Map<string, string>,
  comments: Array<ReviewComment | JulesReviewComment>
): ApplyResult {
  const resultFiles = new Map(files);
  const applied: AppliedSuggestion[] = [];
  const skipped: SkippedSuggestion[] = [];
  // Ranges claimed by accepted edits, per file, so a later group cannot edit a
  // range that overlaps one an earlier accepted group already owns.
  const claimed = new Map<string, AppliedSuggestion[]>();
  const acceptedEdits: AcceptedEdit[] = [];

  const lineCountOf = (file: string): number | undefined => {
    const content = files.get(file);
    return content === undefined
      ? undefined
      : splitPreservingFinalNewline(content).bodyLines.length;
  };

  const rangeOf = (edit: NormalizedSuggestion): AppliedSuggestion => ({
    file: edit.file,
    startLine: edit.startLine,
    endLine: edit.endLine,
  });

  const reasonFor = (
    edit: NormalizedSuggestion,
    groupEdits: NormalizedSuggestion[]
  ): SkippedSuggestion["reason"] | undefined => {
    if (!resultFiles.has(edit.file)) return "missing file";
    if (edit.replacement === undefined) return "no structured replacement";
    const lineCount = lineCountOf(edit.file);
    if (
      lineCount === undefined ||
      edit.startLine < 1 ||
      edit.endLine < edit.startLine ||
      edit.endLine > lineCount
    ) {
      return "invalid range";
    }
    if (overlaps(claimed.get(edit.file) || [], rangeOf(edit))) {
      return "overlapping range";
    }
    const clashesWithSibling = groupEdits.some(
      (other) =>
        other !== edit &&
        other.file === edit.file &&
        other.startLine <= edit.endLine &&
        other.endLine >= edit.startLine
    );
    if (clashesWithSibling) return "overlapping range";
    return undefined;
  };

  // One group per comment: a multi-edit `fix` is applied transactionally
  // (all-or-nothing), while a single suggestion/legacy replacement is a group of
  // one — preserving the original single-suggestion behaviour.
  for (const comment of comments) {
    const groupEdits = normalizeComment(comment);
    if (groupEdits.length === 0) continue;
    const reasons = groupEdits.map((edit) => reasonFor(edit, groupEdits));
    if (reasons.some((reason) => reason !== undefined)) {
      groupEdits.forEach((edit, index) =>
        skipped.push({
          ...rangeOf(edit),
          reason: reasons[index] ?? "incomplete fix",
        })
      );
      continue;
    }
    for (const edit of groupEdits) {
      if (edit.replacement === undefined) continue;
      claimed.set(edit.file, [
        ...(claimed.get(edit.file) || []),
        rangeOf(edit),
      ]);
      acceptedEdits.push({
        file: edit.file,
        startLine: edit.startLine,
        endLine: edit.endLine,
        replacement: edit.replacement,
      });
    }
  }

  // Apply accepted edits bottom-to-top within each file so lower edits never
  // shift the line numbers of higher ones; validation guarantees they do not
  // overlap.
  const editsByFile = new Map<string, AcceptedEdit[]>();
  for (const edit of acceptedEdits) {
    editsByFile.set(edit.file, [...(editsByFile.get(edit.file) || []), edit]);
  }
  for (const file of [...editsByFile.keys()].sort()) {
    const edits = editsByFile.get(file) || [];
    edits.sort((a, b) => b.startLine - a.startLine || a.endLine - b.endLine);
    for (const edit of edits) {
      const content = resultFiles.get(file);
      if (content === undefined) continue;
      resultFiles.set(
        file,
        replaceLines(content, edit.startLine, edit.endLine, edit.replacement)
      );
      applied.push({ file, startLine: edit.startLine, endLine: edit.endLine });
    }
  }

  return { files: resultFiles, applied, skipped };
}

function normalizeComment(
  comment: ReviewComment | JulesReviewComment
): NormalizedSuggestion[] {
  if (
    "fix" in comment &&
    comment.fix &&
    Array.isArray(comment.fix.edits) &&
    comment.fix.edits.length > 0
  ) {
    return comment.fix.edits.map((edit) => ({
      file: edit.path,
      startLine: edit.startLine,
      endLine: edit.endLine,
      replacement: edit.replacement,
    }));
  }
  return [normalizeSuggestion(comment)];
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
