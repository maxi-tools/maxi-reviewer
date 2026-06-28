import { createHash } from "node:crypto";
import { ReviewComment, FindingAnchor } from "./types.js";

const HASH_LEN = 16;
const CONTEXT_RADIUS = 3;

// Best-effort, language-agnostic enclosing-definition detectors. Used only as a
// coarse relocation hint; the line hash is the primary locator.
const SYMBOL_PATTERNS = [
  /(?:function|fn|def|class|interface|type|struct|enum|impl|trait)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/,
  /([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]\s*(?:async\s+)?(?:function|\()/,
];

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, HASH_LEN);
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function normalizedRange(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    if (i >= 0 && i < lines.length) out.push(normalize(lines[i]));
  }
  return out.join("\n");
}

function enclosingSymbol(
  lines: string[],
  startIdx: number
): string | undefined {
  for (let i = Math.min(startIdx, lines.length - 1); i >= 0; i--) {
    const line = lines[i];
    for (const re of SYMBOL_PATTERNS) {
      const m = re.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * Compute a drift-tolerant anchor for the finding at startLine..endLine of the
 * given file content at PR head. Returns undefined when the range is out of
 * bounds or the target is blank, so callers simply omit the anchor.
 */
export function computeAnchor(
  content: string,
  startLine: number,
  endLine?: number
): FindingAnchor | undefined {
  const lines = splitLines(content);
  if (
    !Number.isFinite(startLine) ||
    startLine < 1 ||
    startLine > lines.length
  ) {
    return undefined;
  }
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.min(
    lines.length,
    Math.max(start, Math.floor(endLine ?? start))
  );
  const target = normalizedRange(lines, start - 1, end - 1);
  if (!target) return undefined;
  const context = normalizedRange(
    lines,
    start - 1 - CONTEXT_RADIUS,
    end - 1 + CONTEXT_RADIUS
  );
  return {
    schema: "maxi.review.v1.finding-anchor",
    line: start,
    lineCount: end - start + 1,
    lineHash: shortHash(target),
    contextHash: shortHash(context),
    symbol: enclosingSymbol(lines, start - 1),
  };
}

/**
 * Re-resolve the current line number of a finding from its anchor against
 * (possibly drifted) file content. Returns the matching line (1-based) or null
 * when the target content can no longer be found. When several lines match the
 * same hash, disambiguate by the surrounding-context hash, then by proximity to
 * the hint line (the consumer last-known line, else the anchor original line).
 */
export function resolveAnchor(
  content: string,
  anchor: FindingAnchor,
  hintLine?: number
): number | null {
  const lines = splitLines(content);
  const span = Math.max(1, anchor.lineCount || 1);
  const matches: number[] = [];
  for (let i = 0; i + span - 1 < lines.length; i++) {
    if (
      shortHash(normalizedRange(lines, i, i + span - 1)) === anchor.lineHash
    ) {
      matches.push(i + 1);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const byContext = matches.filter(
    (ln) =>
      shortHash(
        normalizedRange(
          lines,
          ln - 1 - CONTEXT_RADIUS,
          ln - 1 + span - 1 + CONTEXT_RADIUS
        )
      ) === anchor.contextHash
  );
  const pool = byContext.length > 0 ? byContext : matches;
  if (pool.length === 1) return pool[0];
  const hint = typeof hintLine === "number" ? hintLine : anchor.line;
  let best = pool[0];
  for (const ln of pool) {
    if (Math.abs(ln - hint) < Math.abs(best - hint)) best = ln;
  }
  return best;
}

/**
 * Attach a drift-tolerant anchor to each comment whose file content is known at
 * PR head. Mutates in place. Purely additive: comments without resolvable head
 * content are left unchanged.
 */
export function enrichCommentsWithAnchors(
  comments: ReviewComment[],
  files: Map<string, string>
): void {
  for (const comment of comments) {
    if (!comment.file) continue;
    const content = files.get(comment.file);
    if (content === undefined) continue;
    const startLine = comment.startLine ?? comment.line;
    const endLine = comment.endLine ?? comment.line;
    const anchor = computeAnchor(content, startLine, endLine);
    if (anchor) comment.anchor = anchor;
  }
}
