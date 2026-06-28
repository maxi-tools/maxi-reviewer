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
    const match = section.match(/^diff --git a\/.* b\/(.+)$/m);
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
