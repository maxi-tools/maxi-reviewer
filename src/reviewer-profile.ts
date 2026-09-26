/**
 * Per-reviewer calibration profile. The scheduled `calibration-harvest`
 * workflow (see .github/workflows/calibration-harvest.yml) runs this engine
 * against merged/closed PRs across the org and publishes the resulting
 * `reviewer-profiles.json` to the rolling tag `reviewer-profiles-latest`.
 *
 * Design notes
 * ------------
 * - Per-bot accept-rate is derived from inline review threads, not from the
 *   artifact comment channel: the comment channel only carries `maxi-reviewer`
 *   findings; the other six bots (codacy-production, coderabbitai, qltysh,
 *   chatgpt-codex-connector, cubic-dev-ai, github-advanced-security) post
 *   inline comments on the diff and never emit a `maxi.review.v1.*` payload.
 *   So a single observation unit is one inline review comment posted on a PR
 *   by one of the seven bot authors during the harvest window.
 * - The classifier is side-effect-free. The GitHub-side harvesting
 *   (pulls, review threads, commits) is the workflow's job; this module only
 *   turns the harvested observations into aggregate stats.
 * - Path grouping is a routing signal, not a verdict on the bot. A low
 *   accept-rate on `python` says "route this reviewer less aggressively on
 *   python PRs," not "this reviewer is bad." The README carries that caveat.
 * - This module does NOT call calibration.ts's own correlation. That engine
 *   expects a `ReviewArtifact` and the list of `ThreadState`s the artifact
 *   generated, and is the right tool for maxi-reviewer's own artifacts. But
 *   the schema we publish here is reviewer-by-reviewer overall + by-path-group
 *   — not the per-rule / per-severity buckets calibration.ts produces — so
 *   importing it would be a wording mismatch: we re-use its outcome vocabulary
 *   (`accepted` / `dismissed` / `unaddressed`) and the same path-group
 *   bucketer, but compute the aggregate stats directly.
 */

export const BOT_REVIEWERS = [
  "codacy-production",
  "coderabbitai",
  "qltysh",
  "chatgpt-codex-connector",
  "cubic-dev-ai",
  "github-advanced-security",
  "maxi-reviewer",
] as const;

export type BotReviewer = (typeof BOT_REVIEWERS)[number];

/**
 * `unknown` is not a verdict about the finding, it is the ABSENCE of one:
 * the paths touched after the comment could not be determined, so there is
 * no evidence either way.
 *
 * It exists because the alternative is worse. Without it, a failed lookup
 * produces an empty `subsequentTouchedPaths`, which is indistinguishable
 * from "nothing was touched" and classifies as `dismissed` — a real verdict,
 * against the reviewer, manufactured out of a network error. That is how a
 * 270-PR harvest reported a 0% accept rate for all seven bot reviewers at
 * once while every commit fetch was failing (#133).
 *
 * `unknown` findings are counted and reported separately; they never enter
 * an accept rate.
 */
export type ReviewOutcome =
  "accepted" | "dismissed" | "unaddressed" | "unknown";

export interface InlineReviewFinding {
  /** The bot's GitHub login. Must be one of BOT_REVIEWERS. */
  reviewer: BotReviewer;
  /** Repository the comment lives in (owner/name). */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** File path the comment was attached to (may be empty for repo-level). */
  path: string;
  /** Line number the comment was attached to (0 for file-level comments). */
  line: number;
  /** Whether the review thread is currently resolved. */
  threadResolved: boolean;
  /**
   * Files touched by commits that landed after this comment was posted. Used
   * to decide whether a still-open thread was effectively accepted by a later
   * edit.
   */
  subsequentTouchedPaths: string[];
  /**
   * Whether `subsequentTouchedPaths` is a real observation.
   *
   * `false` means the commit walk for this PR did not complete, so an empty
   * list means "we could not look", NOT "nothing was touched". Defaults to
   * `true` when omitted so existing callers keep their meaning; the
   * harvester sets it explicitly.
   */
  touchedPathsKnown?: boolean;
  /**
   * How many commits landed on the PR after this comment was posted.
   *
   * `0` means the finding had no opportunity to be actioned: the PR merged
   * or closed without another commit, so nothing about it can be read as
   * evidence for or against the reviewer. See `classifyOutcome`.
   *
   * Recorded as a COUNT rather than derived from `subsequentTouchedPaths`
   * being empty. The two are nearly equivalent -- that list is the union of
   * every path from every later commit -- but "nearly" is the whole subject
   * of this file: an empty array standing in for a fact nobody measured is
   * the shape of #133. A commit that reports no files (an empty commit, or
   * one whose file list we could not read) would make the array empty while
   * a commit really did land, and the count says so.
   *
   * Optional for backwards compatibility with callers written before this
   * existed; `undefined` means "not recorded" and preserves the old
   * behaviour. The harvester always sets it, and "records the commit count
   * so an un-amendable PR is measurable" in
   * tests/reviewer-profile-build.test.ts fails if that stops being true.
   */
  subsequentCommitCount?: number;
}

export interface PathGroupStats {
  /** Findings with a KNOWN outcome. The denominator of `acceptRate`. */
  n: number;
  acceptRate: number;
  /**
   * Findings whose outcome could not be determined, excluded from `n` and
   * from `acceptRate`.
   *
   * A consumer that ignores this field still gets a correct rate over the
   * evidence that exists. A consumer that reads it can tell a genuine 0%
   * from a harvest that measured nothing — which is the distinction #133
   * was about.
   */
  unknownN: number;
}

export interface ReviewerStats {
  overall: PathGroupStats;
  byPathGroup: Record<string, PathGroupStats>;
}

export interface ReviewerProfiles {
  schema: "maxi.review.v1.reviewer-profiles";
  generatedAt: string;
  windowDays: number;
  reviewers: Record<BotReviewer, ReviewerStats>;
}

/**
 * Bucket a file path into a coarse group. The group names are the routing
 * vocabulary used by downstream selectors (maxi-reviewer issue #17 follow-up
 * work, the per-language review-intensity knob in `prompt.ts`). A path that
 * doesn't fit any named group falls into its top-level directory.
 *
 * The bucketing is intentionally coarse: a path group with N < 20 in a
 * 30-day window is too noisy to drive routing, and the README says so.
 */
export function pathGroupFor(path: string): string {
  if (!path) return "(unknown)";
  const normalised = path.startsWith("/") ? path.slice(1) : path;
  if (
    normalised.startsWith(".github/workflows/") ||
    normalised.startsWith(".github/workflow/")
  ) {
    return "workflows";
  }
  if (
    normalised === ".github/CODEOWNERS" ||
    normalised === ".github/dependabot.yml" ||
    normalised === ".github/labeler.yml" ||
    normalised === ".github/labeler.yaml" ||
    normalised.startsWith(".github/")
  ) {
    return "config";
  }
  if (
    normalised === "Cargo.lock" ||
    normalised === "package-lock.json" ||
    normalised === "pnpm-lock.yaml" ||
    normalised === "yarn.lock" ||
    normalised === "Cargo.toml" ||
    normalised.endsWith(".lock") ||
    normalised.endsWith(".lockfile")
  ) {
    return "lockfile";
  }
  const segments = normalised.split("/");
  const filename = segments[segments.length - 1] || "";
  const lang = filename.split(".").pop()?.toLowerCase();
  if (
    lang === "py" ||
    normalised.includes("/python/") ||
    normalised.includes("/py/")
  ) {
    return "python";
  }
  if (
    lang === "sh" ||
    lang === "bash" ||
    filename === "Makefile" ||
    filename === "justfile"
  ) {
    return "shell";
  }
  if (
    normalised.endsWith(".md") ||
    normalised.endsWith(".rst") ||
    normalised.endsWith(".txt") ||
    normalised === "LICENSE" ||
    normalised === "README"
  ) {
    return "docs";
  }
  if (lang === "rs") {
    if (
      normalised.includes("/tests/") ||
      normalised.includes("/test/") ||
      normalised.includes("/testing/") ||
      normalised.startsWith("tests/") ||
      filename.startsWith("test_") ||
      filename.endsWith("_test.rs") ||
      filename.endsWith(".test.rs")
    ) {
      return "rust-test";
    }
    return "rust-src";
  }
  // First-path-segment fallback. calibration.ts uses the same convention
  // ("src", "lib", "crates", ...). Keeping the bucketer in two places is
  // intentional: this one is the *output* group the README documents, the
  // other is the *internal* group used for per-rule debugging.
  return segments[0] || "(unknown)";
}

/**
 * Decide what happened to one inline review finding. A thread is:
 *   - "accepted" when a commit AFTER it landed touched THAT FILE. This covers
 *     the most common case (the author fixed the line in a follow-up commit)
 *     and the case where the comment author is satisfied by an unrelated
 *     touch to the same file. File-level, not line-level, because most bot
 *     threads do not preserve line numbers across rebases and the harvest
 *     window often spans pushes that move lines.
 *
 *     It compared the PATH GROUP as well until 2026-09-19, which is not what
 *     the paragraph above has ever described. `pathGroupFor` buckets coarsely
 *     -- every `.rs` file outside a test directory is `rust-src` -- so a
 *     finding on `crates/a/src/foo.rs` was accepted by a later commit to
 *     `crates/z/src/unrelated.rs`. On a Rust PR that means any subsequent
 *     Rust commit accepted every Rust finding on the PR.
 *
 *     It is visible in the first harvest that produced real numbers
 *     (2026-09-19, 6357 measured): `rust-src` was the top group for six of
 *     seven reviewers (87-100%) while `docs`, `lockfile` and `config` sat
 *     lowest. That ordering tracks how BROAD each bucket is, not how good
 *     any reviewer is. Cross-group comparison was measuring the bucketer.
 *
 *     Rates drop after this change, and they should: the old ones counted
 *     coincidence. Comparisons WITHIN one path group were always sound --
 *     every reviewer in a group was scored through the same clause -- so the
 *     routing signal survives; the absolute numbers do not.
 *   - "dismissed" when the thread was resolved with no subsequent commit on
 *     the same file. Resolved is treated as a deliberate close by either the
 *     thread author or the PR author; "no commit on the file" is the evidence
 *     the finding was not actioned.
 *   - "unaddressed" when the thread is still open and no commit has touched
 *     the file. Open + no edit = the finding is sitting there unresolved.
 *
 * The classifier is pure: callers pass in the touched-paths set they observed
 * for the window between the comment and the merge/close time, and the
 * classifier does not look at the network.
 */
export function classifyOutcome(finding: InlineReviewFinding): ReviewOutcome {
  // No evidence is not evidence. If the commit walk did not complete, an
  // empty touched-paths list means "we could not look", and reading it as
  // "nothing was touched" would classify the finding as `dismissed` — a
  // verdict against the reviewer invented from a failed request.
  if (finding.touchedPathsKnown === false) return "unknown";
  const touched = finding.subsequentTouchedPaths.includes(finding.path);
  if (touched) return "accepted";
  // NO COMMIT COULD HAVE LANDED, so the silence says nothing.
  //
  // `dismissed` and `unaddressed` both mean "the author saw this and did not
  // change the code". That reading requires the author to have been ABLE to
  // change the code. On a PR that merged with no further commit they were
  // not, and the strongest case is the one this org generates most: 1,237 of
  // the 3,039 PRs merged across maxi-tools in the 30 days to 2026-09-21 --
  // 41% -- are `maxi-config-sync/*` fan-out PRs, whose every file carries the
  // `# maxi-config-owned ` marker that `check-owned-files.py` refuses to let
  // a consumer touch. The only moves available are "merge exactly as
  // generated" or "close".
  //
  // Scoring those as not-accepted made a reviewer's rate a function of how
  // much fan-out traffic the window happened to contain. Worse, the CORRECT
  // response to a finding there -- fix it at the source in maxi-config and
  // re-fan -- produced no commit on the consumer PR, so being right and
  // acting on it scored against the reviewer.
  //
  // This is the same principle as the `touchedPathsKnown` clause above, from
  // #133: an absent observation must not become a verdict. There the paths
  // could not be read; here there was nothing to read. Both are `unknown`,
  // counted in `unknownN` and excluded from every accept rate.
  if (finding.subsequentCommitCount === 0) return "unknown";
  if (finding.threadResolved) return "dismissed";
  return "unaddressed";
}

function statsFor(counts: {
  accepted: number;
  total: number;
  unknown: number;
}): PathGroupStats {
  return {
    n: counts.total,
    acceptRate: counts.total > 0 ? counts.accepted / counts.total : 0,
    unknownN: counts.unknown,
  };
}

function emptyStats(): PathGroupStats {
  return { n: 0, acceptRate: 0, unknownN: 0 };
}

/** Fold one finding into a running bucket. */
function accumulate(
  prev: PathGroupStats,
  outcome: ReviewOutcome
): PathGroupStats {
  if (outcome === "unknown") {
    // Counted, but kept out of the numerator AND the denominator: an
    // unmeasurable finding must not move a rate in either direction.
    return statsFor({
      accepted: prev.acceptRate * prev.n,
      total: prev.n,
      unknown: prev.unknownN + 1,
    });
  }
  return statsFor({
    accepted: prev.acceptRate * prev.n + (outcome === "accepted" ? 1 : 0),
    total: prev.n + 1,
    unknown: prev.unknownN,
  });
}

/**
 * Aggregate inline findings into per-reviewer overall + by-path-group stats.
 * Findings whose `reviewer` is not in BOT_REVIEWERS are dropped — the schema
 * covers the seven bots the org runs and adding more is a schema break, not
 * a quiet extension.
 */
export function aggregateReviewerProfiles(
  findings: InlineReviewFinding[],
  generatedAt: string,
  windowDays: number
): ReviewerProfiles {
  const reviewers: Record<string, ReviewerStats> = {};
  for (const bot of BOT_REVIEWERS) {
    reviewers[bot] = { overall: emptyStats(), byPathGroup: {} };
  }

  for (const finding of findings) {
    const stats = reviewers[finding.reviewer];
    if (!stats) continue;
    const outcome = classifyOutcome(finding);
    stats.overall = accumulate(stats.overall, outcome);
    const group = pathGroupFor(finding.path);
    stats.byPathGroup[group] = accumulate(
      stats.byPathGroup[group] ?? emptyStats(),
      outcome
    );
  }

  return {
    schema: "maxi.review.v1.reviewer-profiles",
    generatedAt,
    windowDays,
    reviewers: reviewers as Record<BotReviewer, ReviewerStats>,
  };
}

export function isBotReviewer(login: string): login is BotReviewer {
  return (BOT_REVIEWERS as readonly string[]).includes(login);
}
