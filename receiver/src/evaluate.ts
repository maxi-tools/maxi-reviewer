/**
 * PR review gate evaluator — port of `.github/actions/pr-review-gate/pr_review_gate.py`.
 *
 * Pure function `evaluate(doc, only)` over the same payload shape the existing
 * `collect-pr-review-state` action writes. Behaviour is identical: same
 * verdicts, same lines, same failure annotations, same waiver label. The
 * Python truth table pinned in `tests/test_pr_review_gate.py` is the spec;
 * the JS test fixtures here mirror that table case-for-case.
 *
 * The only place this differs from the Python source is in I/O-adjacent
 * behaviour: there is no `$GITHUB_OUTPUT` to publish a step output to, and
 * no `main()` to drive. The decision logic — what counts as a passing PR,
 * what the FAIL line names, what `WAIVED:` looks like — is unchanged.
 */

export const ONLY_ALL = "all";
export const ONLY_THREADS = "threads";
export const ONLY_REVIEWER = "non-author-review";
export const ONLY_CHOICES = [ONLY_ALL, ONLY_THREADS, ONLY_REVIEWER] as const;
export type Only = (typeof ONLY_CHOICES)[number];

/** A review in these states is a review signal. */
export const COUNTED_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
]);

export const FANOUT_BRANCH_PREFIX = "maxi-config-sync/";
export const FANOUT_BRANCH_NAMES = new Set(["ci/fanout-pin"]);
export const FANOUT_AUTHORS = new Set([
  "maxi-tools-auth",
  "maxi-tools-auth[bot]",
]);

export const DEPENDABOT_BRANCH_PREFIX = "dependabot/";
export const DEPENDABOT_AUTHORS = new Set(["dependabot", "dependabot[bot]"]);

export const REVIEW_INFRA_LABEL = "review-infra-unavailable";
export const WAIVED_PREFIX = "WAIVED:";

export const ROSTER_CONTEXT = "review-roster";

/**
 * Reviewer label -> the login a review by that reviewer arrives under.
 * Copied verbatim from pr_review_gate.py's LABEL_TO_LOGIN.
 */
export const LABEL_TO_LOGIN: Record<string, string> = {
  "maxi-reviewer": "maxi-reviewer[bot]",
  "qwen-coder-local": "qwen-coder-review",
  coderabbit: "coderabbitai[bot]",
  copilot: "copilot-pull-request-reviewer[bot]",
  "claude-review": "claude-review",
  cubic: "cubic-dev-ai[bot]",
  codacy: "codacy-production",
  qlty: "qlty[bot]",
  qodana: "qodana",
  gemini: "gemini-review",
};

export const ROSTER_DESCRIPTION_RE =
  /^(?:band=[a-z]+\s+)?asked=\[([^\]]*)\]\s+skipped=([^\s]+)(?:\s+unknown=(\d+))?(?:\s+profiles=\S+)?\s*$/;

/** Strip a `[bot]` suffix for bare-slug ↔ bracketed-slug comparison. */
function stripBot(s: string): string {
  return s.endsWith("[bot]") ? s.slice(0, -"[bot]".length) : s;
}

export class Malformed extends Error {}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated?: boolean;
  author?: string | null;
  path?: string | null;
  url?: string | null;
}

export interface Review {
  state?: string;
  author?: string | null;
}

export interface Roster {
  asked: string[];
  skipped: number;
}

export interface Doc {
  author: string;
  isDraft?: boolean;
  headRefName?: string | null;
  labels?: string[] | null;
  reviews: Review[];
  threads: ReviewThread[];
  roster?: Roster | null;
}

export interface EvaluateResult {
  ok: boolean;
  lines: string[];
}

/** The login a label corresponds to, with `[bot]` removed on both sides. */
export function rosterLogins(asked: string[]): Set<string> {
  const logins = new Set<string>();
  for (const label of asked) {
    const bare = stripBot(label);
    const login = LABEL_TO_LOGIN[bare];
    if (login !== undefined) {
      logins.add(stripBot(login));
      continue;
    }
    // A label that already IS a login still resolves — a hand-edited or
    // older publisher could spell the login.
    const allBare = new Set(
      Object.values(LABEL_TO_LOGIN).map((v) => stripBot(v))
    );
    if (allBare.has(bare)) {
      logins.add(bare);
      continue;
    }
    throw new Malformed(
      "review-roster asked for " +
        JSON.stringify(label) +
        ", which is not a known reviewer label"
    );
  }
  return logins;
}

function skippedCount(roster: Roster): number {
  return roster.skipped;
}

/** Parse a `review-roster` description. Returns null for "not a roster". */
export function parseRoster(
  description: string | null | undefined
): Roster | null {
  if (typeof description !== "string" || description.trim() === "") {
    return null;
  }
  const match = ROSTER_DESCRIPTION_RE.exec(description.trim());
  if (!match) {
    const stripped = description.trimStart();
    if (stripped.startsWith("asked=") || stripped.startsWith("band=")) {
      throw new Malformed(
        "review-roster description is not in the expected shape: " +
          JSON.stringify(description)
      );
    }
    return null;
  }
  const askedRaw = match[1];
  const skippedRaw = match[2];
  const asked = askedRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let skipped: number;
  if (/^\d+$/.test(skippedRaw)) {
    skipped = parseInt(skippedRaw, 10);
  } else {
    const names = skippedRaw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    skipped = names.length;
  }

  return { asked, skipped };
}

function _require(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Malformed(msg);
}

function isFanoutBranch(headRef: unknown): boolean {
  if (typeof headRef !== "string") return false;
  return (
    headRef.startsWith(FANOUT_BRANCH_PREFIX) || FANOUT_BRANCH_NAMES.has(headRef)
  );
}

/**
 * Return (ok, lines). Raises Malformed on input that cannot be judged.
 *
 * `only` selects which condition to judge; the unselected one is not
 * evaluated and contributes neither a verdict nor a line. Validation of the
 * payload is NOT narrowed with it — a malformed thread list still fails the
 * reviewer-only check, because a payload we cannot trust is not a payload we
 * can draw half a conclusion from.
 */
export function evaluate(doc: unknown, only: Only = ONLY_ALL): EvaluateResult {
  _require(
    ONLY_CHOICES.includes(only),
    "unknown condition selector: " + String(only)
  );
  _require(
    typeof doc === "object" && doc !== null,
    "payload is not a JSON object"
  );
  const d = doc as Record<string, unknown>;

  const author = d.author;
  _require(
    typeof author === "string" && author.trim().length > 0,
    "payload has no PR author; cannot tell self-review from review"
  );

  const rawLabels = d.labels;
  const labels: unknown[] = Array.isArray(rawLabels) ? rawLabels : [];

  const reviews = d.reviews;
  const threads = d.threads;
  _require(Array.isArray(reviews), 'payload field "reviews" is not a list');
  _require(Array.isArray(threads), 'payload field "threads" is not a list');

  // Roster is OPTIONAL. Absent field, null, or a non-object all mean "no
  // roster was published" — fall back to the pre-roster rule.
  const rawRoster = d.roster;
  let roster: Roster | null = null;
  if (rawRoster !== null && rawRoster !== undefined) {
    _require(
      typeof rawRoster === "object",
      'payload field "roster" is not an object'
    );
    const r = rawRoster as Record<string, unknown>;
    _require(
      Array.isArray(r.asked) && r.asked.every((n) => typeof n === "string"),
      'payload field "roster.asked" is not a list of strings'
    );
    const sk = r.skipped;
    _require(
      typeof sk === "number" && sk >= 0,
      'payload field "roster.skipped" is not a non-negative number'
    );
    roster = r as unknown as Roster;
  }

  const lines: string[] = [];

  if (d.isDraft === true) {
    return {
      ok: true,
      lines: ["draft pull request - review gate not enforced"],
    };
  }

  const headRef = d.headRefName;
  if (isFanoutBranch(headRef) && FANOUT_AUTHORS.has(author as string)) {
    return {
      ok: true,
      lines: ["fan-out branch - reviewed at source (maxi-config or ci)"],
    };
  }

  const dependabot =
    typeof headRef === "string" &&
    headRef.startsWith(DEPENDABOT_BRANCH_PREFIX) &&
    DEPENDABOT_AUTHORS.has(author as string);

  const infraWaiver = labels.some(
    (lbl) => typeof lbl === "string" && lbl === REVIEW_INFRA_LABEL
  );

  // --- condition 1: unresolved threads ---------------------------------
  const unresolved: ReviewThread[] = [];
  for (let i = 0; i < (threads as unknown[]).length; i++) {
    const th = (threads as unknown[])[i];
    _require(
      typeof th === "object" && th !== null,
      "thread " + i + " is not an object"
    );
    const t = th as Record<string, unknown>;
    const resolved = t.isResolved;
    _require(
      typeof resolved === "boolean",
      "thread " + i + " has no boolean isResolved field"
    );
    if (!resolved) unresolved.push(t as unknown as ReviewThread);
  }

  // --- condition 2: a non-author reviewer -------------------------------
  const reviewers: string[] = [];
  for (let i = 0; i < (reviews as unknown[]).length; i++) {
    const rv = (reviews as unknown[])[i];
    _require(
      typeof rv === "object" && rv !== null,
      "review " + i + " is not an object"
    );
    const r = rv as Record<string, unknown>;
    const state = r.state;
    _require(typeof state === "string", "review " + i + " has no state");
    if (!COUNTED_STATES.has(state.toUpperCase())) continue;
    const who = r.author;
    if (typeof who !== "string" || who.trim() === "") continue;
    if (who === author) continue;
    if (!reviewers.includes(who)) reviewers.push(who);
  }

  // Roster narrows condition 2 to the selectors's asked set, when one is
  // present AND non-empty. An absent roster or an empty asked list both
  // fall back to the pre-roster rule.
  let activeRoster: Roster | null = null;
  let askedLogins: Set<string> | null = null;
  let covered: string[];
  if (roster !== null && roster.asked.length > 0) {
    activeRoster = roster;
    askedLogins = rosterLogins(activeRoster["asked"]);
    covered = reviewers.filter((name) => askedLogins!.has(stripBot(name)));
  } else {
    activeRoster = null;
    askedLogins = null;
    covered = [...reviewers];
  }

  let ok = true;

  if ((only === ONLY_ALL || only === ONLY_THREADS) && unresolved.length > 0) {
    ok = false;
    lines.push("FAIL: " + unresolved.length + " unresolved review thread(s):");
    for (const th of unresolved) {
      const where = th.path || "(no file)";
      const url = th.url || "(no url)";
      const who = th.author || "unknown";
      const flag = th.isOutdated === true ? " [outdated]" : "";
      lines.push("  - " + who + " on " + where + flag + " -> " + url);
    }
    lines.push("  Resolving a thread fires no Actions event, so this check");
    lines.push(
      "  will stay red until you re-run it or push. That is expected."
    );
  } else if (only === ONLY_ALL || only === ONLY_THREADS) {
    lines.push(
      "ok: no unresolved review threads (" +
        (threads as unknown[]).length +
        " total)"
    );
  }

  if (
    (only === ONLY_ALL || only === ONLY_REVIEWER) &&
    covered.length === 0 &&
    !dependabot &&
    !infraWaiver
  ) {
    ok = false;
    const selfReviews = (reviews as unknown[]).filter((rv) => {
      if (typeof rv !== "object" || rv === null) return false;
      const r = rv as Record<string, unknown>;
      if (r.author !== author) return false;
      if (typeof r.state !== "string") return false;
      return COUNTED_STATES.has(r.state.toUpperCase());
    }).length;

    if (askedLogins !== null && activeRoster !== null) {
      const askedSorted = [...activeRoster.asked].sort();
      lines.push(
        "FAIL: roster asked for " +
          askedSorted.join(", ") +
          " but none of them has reviewed."
      );
      lines.push("  No human approval is wanted; a COMMENTED review from any");
      lines.push("  reviewer on the asked list satisfies this. Pushing a");
      lines.push("  commit is usually enough to summon them.");
    } else {
      lines.push(
        "FAIL: no review from anyone other than the author (" + author + ")."
      );
      if (selfReviews > 0) {
        lines.push(
          "  " + selfReviews + " review(s) found, but all are by the author."
        );
        lines.push("  Self-review is not review. Every agent lane in this org");
        lines.push(
          "  authenticates as the same account, so this is the common case."
        );
      } else {
        lines.push("  No reviews at all. This does NOT need a human approval:");
        lines.push(
          "  a COMMENTED review from any review bot satisfies it. Pushing"
        );
        lines.push("  a commit is usually enough to summon them.");
      }
    }
  } else if (
    (only === ONLY_ALL || only === ONLY_REVIEWER) &&
    covered.length === 0 &&
    dependabot
  ) {
    lines.push(
      "ok: dependabot pull request - the review lanes cannot run " +
        "without Dependabot secrets, so no reviewer can be summoned"
    );
  } else if (
    (only === ONLY_ALL || only === ONLY_REVIEWER) &&
    covered.length === 0
  ) {
    lines.push(
      WAIVED_PREFIX +
        " " +
        REVIEW_INFRA_LABEL +
        " - no non-author review; merging on the assertion that " +
        "no reviewer could be summoned"
    );
  } else if (only === ONLY_ALL || only === ONLY_REVIEWER) {
    const listed =
      askedLogins !== null ? [...covered].sort() : [...reviewers].sort();
    lines.push(
      "ok: reviewed by " +
        listed.length +
        " non-author reviewer(s): " +
        listed.join(", ")
    );
    if (activeRoster !== null) {
      lines.push(
        "  roster=present asked=" +
          activeRoster.asked.length +
          " skipped=" +
          skippedCount(activeRoster)
      );
    } else {
      lines.push(
        "  roster=absent - behaving as before the roster selector shipped"
      );
    }
  }

  return { ok, lines };
}

/** The waiver label a condition was waived by, or '' when none was. */
export function waiverLabel(lines: string[]): string {
  for (const line of lines) {
    if (line.startsWith(WAIVED_PREFIX)) {
      const after = line.slice(WAIVED_PREFIX.length).trim();
      return after.split(" ", 1)[0];
    }
  }
  return "";
}

/** Each `FAIL:` line the evaluator emits, stripped of its prefix. */
export function failureAnnotations(lines: string[]): string[] {
  const prefix = "FAIL:";
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      out.push(line.slice(prefix.length).trim().replace(/:$/, ""));
    }
  }
  return out;
}
