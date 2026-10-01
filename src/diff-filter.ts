import { ReviewComment, Verdict } from "./types.js";

/**
 * Default globs for generated / vendored paths that bloat a PR diff without
 * being meaningful review targets. For bundled GitHub Actions the committed
 * `dist/` bundle alone can dwarf the source changes and exhaust the diff budget.
 */
export const DEFAULT_GENERATED_GLOBS = [
  "dist/**",
  "**/dist/**",
  "**/*.map",
  "**/*-lock.yaml",
  "**/*-lock.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/generated/**",
];

// Literal backslash, kept out of string literals so the source has no escaped
// backslash sequences.
const BACKSLASH = String.fromCharCode(92);
const REGEXP_SPECIAL = ".+?^${}()|[]" + BACKSLASH;

/** Convert a glob (star and double-star wildcards) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // '**/' matches zero or more leading directories
          i += 2;
        } else {
          re += ".*"; // '**' matches across directory separators
          i += 1;
        }
      } else {
        re += "[^/]*"; // '*' matches within a single path segment
      }
    } else if (REGEXP_SPECIAL.includes(c)) {
      re += BACKSLASH + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Parse a newline/comma-separated ignore-glob input into a trimmed list. */
export function parseIgnoreGlobs(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True if `path` matches any of the given globs. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export interface FilteredDiff {
  diff: string;
  excludedPaths: string[];
}

/**
 * Remove per-file sections whose target path matches any ignore glob from a
 * unified git diff. Returns the filtered diff plus the list of excluded paths.
 * If filtering would remove everything, the original diff is returned unchanged
 * (a PR that only touches generated files still gets something to review).
 */
export function filterDiffByPaths(
  diff: string,
  ignoreGlobs: string[]
): FilteredDiff {
  if (ignoreGlobs.length === 0) return { diff, excludedPaths: [] };
  const matchers = ignoreGlobs.map(globToRegExp);

  // Each file section starts with a `diff --git a/<path> b/<path>` line.
  const sections = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const excludedPaths: string[] = [];

  for (const section of sections) {
    if (!section.startsWith("diff --git ")) {
      if (section.length > 0) kept.push(section); // preamble before first file
      continue;
    }
    // Non-greedy a/ path so a filename containing " b/" is not mis-split.
    const match = section.match(/^diff --git a\/.*? b\/(.+)$/m);
    const path = match ? match[1].trim() : undefined;
    if (path && matchers.some((re) => re.test(path))) {
      excludedPaths.push(path);
      continue;
    }
    kept.push(section);
  }

  if (excludedPaths.length === 0) return { diff, excludedPaths: [] };
  const filtered = kept.join("");
  if (filtered.trim().length === 0) return { diff, excludedPaths: [] };
  return { diff: filtered, excludedPaths };
}

/** The review fields the diff-scope filter reads and, when needed, rewrites. */
export interface DiffScopeReview {
  verdict: Verdict;
  summary: string;
  resolvedCommentIds?: number[];
  newComments?: ReviewComment[];
}

export interface DiffScopeResult {
  review: DiffScopeReview;
  droppedComments: ReviewComment[];
  issues: string[];
}

/**
 * Scope a review's findings to the PR's changed files (issue #91).
 *
 * A finding in a file the PR does not touch cannot be actioned here: there is
 * no edit to this branch that resolves it, and GitHub rejects an inline
 * comment on a file outside the diff, so the whole review falls back to a
 * plain PR comment. Such findings are dropped before publishing and recorded
 * in `issues` and `droppedComments` for the harvestable artifact.
 *
 * The verdict is scoped with them. When `block` was chosen and every finding
 * behind it was dropped as out-of-diff, nothing in the diff supports a block,
 * so the verdict is downgraded to `comment`: findings outside the diff must
 * never block. Only a retained High finding can support a block. A summary-only
 * block (no findings either way) is not touched — nothing identifies its basis.
 */
export function scopeReviewToDiff(
  review: DiffScopeReview,
  changedFiles: Iterable<string>
): DiffScopeResult {
  const changed = new Set(changedFiles);
  const comments = review.newComments ?? [];
  const kept = comments.filter((comment) => changed.has(comment.file));
  const droppedComments = comments.filter(
    (comment) => !changed.has(comment.file)
  );
  if (droppedComments.length === 0) {
    return { review, droppedComments: [], issues: [] };
  }

  const issues = droppedComments.map(
    (comment) =>
      `out-of-diff finding dropped: ${comment.file}:${comment.line} is not among the PR's changed files.`
  );

  let verdict = review.verdict;
  if (verdict === "block" && !kept.some((c) => c.severity === "High")) {
    verdict = "comment";
    issues.unshift(
      "verdict downgraded from block to comment: no in-diff High finding supports a block."
    );
  }

  // The original narrative may still describe excluded files or demand fixes
  // outside this PR. Do not publish it after filtering its supporting findings.
  // A blank original summary stays blank so the EMPTY_REVIEW_BODY check can
  // still fire — replacing it with generated text would mask a missing review.
  const summary =
    review.summary.trim().length === 0
      ? review.summary
      : kept.length
        ? `Review scoped to this PR: ${kept.length} in-diff finding(s) retained; ${droppedComments.length} out-of-diff finding(s) excluded. See inline findings.`
        : `Review scoped to this PR: ${droppedComments.length} out-of-diff finding(s) excluded; no in-diff findings remain.`;
  return {
    review: { ...review, verdict, summary, newComments: kept },
    droppedComments,
    issues,
  };
}
