import { ChangedFileContext } from "./types.js";

export interface BuildChangedFileContextOptions {
  /** Lines of context to include above and below each changed hunk. */
  contextRadius?: number;
  /** Hard cap on total characters across all rendered windows. */
  maxChars?: number;
}

const DEFAULT_CONTEXT_RADIUS = 25;
const DEFAULT_MAX_CHARS = 40_000;

/**
 * Build line-numbered context windows around the changed lines of each file,
 * reusing head-file contents already fetched for suggestion validation (no extra
 * API calls). Windows that overlap or touch after ±contextRadius expansion are
 * merged. Output is budget-capped: files and windows are processed in stable
 * order and emission stops cleanly once the first window that would exceed the
 * character budget is reached, so the result is deterministic.
 */
export function buildChangedFileContext(
  files: Map<string, string>,
  changedLines: Map<string, Set<number>>,
  options: BuildChangedFileContextOptions = {}
): ChangedFileContext[] {
  const contextRadius = Math.max(
    0,
    options.contextRadius ?? DEFAULT_CONTEXT_RADIUS
  );
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const result: ChangedFileContext[] = [];
  let budget = maxChars;

  for (const [path, lineSet] of changedLines) {
    if (budget <= 0) break;
    const content = files.get(path);
    if (content === undefined || lineSet.size === 0) continue;

    const fileLines = content.split("\n");
    const changed = [...lineSet]
      .filter((n) => n >= 1 && n <= fileLines.length)
      .sort((a, b) => a - b);
    if (changed.length === 0) continue;

    // Expand each changed line to a ±radius range, then merge ranges that
    // overlap or are adjacent (gap of one line or less).
    const ranges: Array<{ start: number; end: number }> = [];
    for (const ln of changed) {
      const start = Math.max(1, ln - contextRadius);
      const end = Math.min(fileLines.length, ln + contextRadius);
      const last = ranges[ranges.length - 1];
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    }

    const windows: ChangedFileContext["windows"] = [];
    let stop = false;
    for (const range of ranges) {
      const text = fileLines
        .slice(range.start - 1, range.end)
        .map((line, i) => `${range.start + i}\t${line}`)
        .join("\n");
      const cost = text.length + 1;
      if (cost > budget) {
        budget = 0;
        stop = true;
        break;
      }
      budget -= cost;
      windows.push({ startLine: range.start, endLine: range.end, text });
    }

    if (windows.length > 0) {
      result.push({ path, windows });
    }
    if (stop) break;
  }

  return result;
}
