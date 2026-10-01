/**
 * Truth-table tests for the JS port of `pr_review_gate.evaluate()`.
 *
 * These tests are a 1:1 port of the cases in
 * `maxi-config/maxi-review/tests/test_pr_review_gate.py`, with Python-isms
 * stripped (no `main()`, no `$GITHUB_OUTPUT`, no `quietly()`). Anything
 * that lands in this file is a behaviour the Cloudflare Worker inherits
 * unchanged — a verdict divergence here is a divergence on the live gate.
 *
 * Where the Python test class is named, the JS describe block carries the
 * same name, so a reader cross-checking can grep for it directly.
 */

import { describe, expect, it } from "vitest";
import {
  evaluate,
  failureAnnotations,
  Malformed,
  parseRoster,
  waiverLabel,
  type Doc,
  type Review,
  type ReviewThread,
  type Roster,
} from "../src/evaluate.js";

// ---------- helpers -------------------------------------------------------

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    author: "octocat",
    isDraft: false,
    headRefName: "feature/x",
    labels: [],
    reviews: [],
    threads: [],
    roster: null,
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    isResolved: true,
    isOutdated: false,
    author: "reviewer",
    path: "src/x.ts",
    url: "https://github.com/o/r/pull/1#discussion_r1",
    ...overrides,
  };
}

function review(
  state: string,
  author: string,
  overrides: Partial<Review> = {}
): Review {
  return { state, author, ...overrides };
}

// ---------- Conditions ----------------------------------------------------

describe("Conditions", () => {
  it("clean_pr_passes", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "alice")],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.startsWith("ok: no unresolved"))).toBe(
      true
    );
    expect(result.lines.some((l) => l.startsWith("ok: reviewed by"))).toBe(
      true
    );
  });

  it("no_threads_at_all_passes", () => {
    const result = evaluate(
      doc({
        reviews: [review("COMMENTED", "alice")],
      })
    );
    expect(result.ok).toBe(true);
  });

  it("one_unresolved_thread_fails", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [review("COMMENTED", "alice")],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/FAIL: 1 unresolved review thread/);
  });

  it("unresolved_among_resolved_fails", () => {
    const result = evaluate(
      doc({
        threads: [
          thread({ isResolved: true, url: "u1" }),
          thread({ isResolved: false, url: "u2" }),
          thread({ isResolved: true, url: "u3" }),
        ],
        reviews: [review("COMMENTED", "alice")],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.includes("u2"))).toBe(true);
    expect(result.lines.some((l) => l.includes("u1"))).toBe(false);
  });

  it("only_the_author_has_reviewed_fails", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("APPROVED", "octocat")],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.includes("no review from anyone"))).toBe(
      true
    );
  });

  it("many_self_reviews_still_fail", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [
          review("APPROVED", "octocat"),
          review("CHANGES_REQUESTED", "octocat"),
          review("COMMENTED", "octocat"),
        ],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.includes("all are by the author"))).toBe(
      true
    );
  });

  it("no_reviews_at_all_fails", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.includes("No reviews at all"))).toBe(
      true
    );
  });

  it("author_plus_a_real_reviewer_passes", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("APPROVED", "octocat"), review("COMMENTED", "alice")],
      })
    );
    expect(result.ok).toBe(true);
  });

  it("the_reason_names_self_review_when_that_is_the_cause", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "octocat")],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.includes("all are by the author"))).toBe(
      true
    );
  });

  it("unresolved_threads_are_listed_with_their_urls", () => {
    const result = evaluate(
      doc({
        threads: [
          thread({
            isResolved: false,
            path: "src/foo.ts",
            url: "https://example/1",
            author: "reviewer-1",
          }),
          thread({
            isResolved: false,
            path: "src/bar.ts",
            url: "https://example/2",
            author: "reviewer-2",
            isOutdated: true,
          }),
        ],
        reviews: [review("COMMENTED", "alice")],
      })
    );
    expect(result.ok).toBe(false);
    const block = result.lines.join("\n");
    expect(block).toContain("reviewer-1 on src/foo.ts -> https://example/1");
    expect(block).toContain(
      "reviewer-2 on src/bar.ts [outdated] -> https://example/2"
    );
  });
});

// ---------- FailureAnnotations -------------------------------------------

describe("FailureAnnotations", () => {
  it("a_passing_gate_annotates_nothing", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "alice")],
      })
    ).lines;
    expect(failureAnnotations(lines)).toEqual([]);
  });

  it("thread_failure_annotation_names_threads_not_review", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [review("COMMENTED", "alice")],
      })
    ).lines;
    const ann = failureAnnotations(lines);
    expect(ann.length).toBe(1);
    expect(ann[0]).toMatch(/unresolved review thread/);
    expect(ann[0]).not.toMatch(/non-author/);
  });

  it("review_failure_annotation_names_review_not_threads", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "octocat")],
      })
    ).lines;
    const ann = failureAnnotations(lines);
    expect(ann.length).toBe(1);
    expect(ann[0]).toMatch(/no review from anyone other/);
  });

  it("both_halves_failing_annotate_separately", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [],
      })
    ).lines;
    const ann = failureAnnotations(lines);
    expect(ann.length).toBe(2);
  });

  it("annotations_are_single_line_and_not_left_dangling", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [review("COMMENTED", "alice")],
      })
    ).lines;
    for (const a of failureAnnotations(lines)) {
      expect(a).not.toContain("\n");
    }
  });
});

// ---------- ReviewStates --------------------------------------------------

describe("ReviewStates", () => {
  it("dismissed_review_is_not_a_reviewer", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("DISMISSED", "alice")],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("pending_review_is_not_a_reviewer", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("PENDING", "alice")],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("changes_requested_counts_as_a_reviewer_present", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("CHANGES_REQUESTED", "alice")],
      })
    );
    expect(result.ok).toBe(true);
  });

  it("review_with_unidentifiable_author_is_not_credited", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "")],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("state_matching_is_case_insensitive", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("commented", "alice")],
      })
    );
    expect(result.ok).toBe(true);
  });
});

// ---------- Drafts --------------------------------------------------------

describe("Drafts", () => {
  it("draft_is_not_gated", () => {
    const result = evaluate(
      doc({
        isDraft: true,
        threads: [thread({ isResolved: false })],
        reviews: [],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(/draft pull request/);
  });
});

// ---------- FanOutBranches ------------------------------------------------

describe("FanOutBranches", () => {
  const baseFanOut = {
    threads: [thread({ isResolved: false })],
    reviews: [],
  };

  it("fan_out_branch_bypasses_a_missing_reviewer", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "maxi-config-sync/runner-setup",
        author: "maxi-tools-auth",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(/fan-out branch/);
  });

  it("the_other_manifest_bypasses_too", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "ci/fanout-pin",
        author: "maxi-tools-auth",
      })
    );
    expect(result.ok).toBe(true);
  });

  it("fan_out_branch_also_bypasses_unresolved_threads", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "maxi-config-sync/runner-setup",
        author: "maxi-tools-auth",
      })
    );
    expect(result.ok).toBe(true);
  });

  it("an_ordinary_branch_is_still_gated", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "feature/widget",
        author: "octocat",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("a_branch_that_merely_contains_the_prefix_is_still_gated", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "maxi-config-sync-and-evil",
        author: "octocat",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("a_missing_or_unreadable_head_ref_still_enforces", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: undefined,
        author: "octocat",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("an_impostor_on_a_fan_out_shaped_branch_is_still_gated", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "maxi-config-sync/runner-setup",
        author: "octocat",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("the_rest_spelling_of_the_bot_also_bypasses", () => {
    const result = evaluate(
      doc({
        ...baseFanOut,
        headRefName: "maxi-config-sync/runner-setup",
        author: "maxi-tools-auth[bot]",
      })
    );
    expect(result.ok).toBe(true);
  });
});

// ---------- DependabotPullRequests ---------------------------------------

describe("DependabotPullRequests", () => {
  it("a_dependabot_pr_passes_with_no_reviewer", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        headRefName: "dependabot/npm_and_yarn/lodash",
        author: "dependabot",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("dependabot"))).toBe(true);
  });

  it("the_rest_spelling_of_dependabot_also_passes", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        headRefName: "dependabot/pip/requests",
        author: "dependabot[bot]",
      })
    );
    expect(result.ok).toBe(true);
  });

  it("threads_are_still_enforced_on_a_dependabot_pr", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [],
        headRefName: "dependabot/npm_and_yarn/lodash",
        author: "dependabot",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("an_impostor_on_a_dependabot_shaped_branch_is_still_gated", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        headRefName: "dependabot/npm_and_yarn/lodash",
        author: "octocat",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("dependabot_on_an_ordinary_branch_is_still_gated", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        headRefName: "feature/x",
        author: "dependabot",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("a_real_review_is_still_reported_as_a_review", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "alice")],
        headRefName: "dependabot/npm_and_yarn/lodash",
        author: "dependabot",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("alice"))).toBe(true);
  });
});

// ---------- ReviewInfrastructureWaiver -----------------------------------

describe("ReviewInfrastructureWaiver", () => {
  it("it_waives_a_missing_non_author_review", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["review-infra-unavailable"],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.startsWith("WAIVED:"))).toBe(true);
  });

  it("it_does_not_waive_unresolved_threads", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [review("COMMENTED", "alice")],
        labels: ["review-infra-unavailable"],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("the_threads_selector_never_sees_the_waiver", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["review-infra-unavailable"],
      }),
      "threads"
    ).lines;
    expect(lines.some((l) => l.startsWith("WAIVED:"))).toBe(false);
  });

  it("an_unrelated_label_waives_nothing", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["some-other-label"],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("the_retired_label_waives_nothing", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["maxi-review-override"],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("matching_is_exact_not_prefix_or_substring", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["review-infra-unavailable-followup"],
      })
    );
    expect(result.ok).toBe(false);
  });

  it("an_unreadable_label_field_still_enforces", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        // @ts-expect-error intentionally wrong shape
        labels: "review-infra-unavailable",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("dependabot_is_reported_by_its_structural_reason_not_the_label", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["review-infra-unavailable"],
        headRefName: "dependabot/npm/lodash",
        author: "dependabot",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("dependabot"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("WAVED:"))).toBe(false);
    expect(result.lines.some((l) => l.startsWith("WAIVED:"))).toBe(false);
  });
});

// ---------- WaiverIsVisibleInTheVerdict ----------------------------------

describe("WaiverIsVisibleInTheVerdict", () => {
  it("a_waived_pass_names_its_label", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
        labels: ["review-infra-unavailable"],
      })
    ).lines;
    expect(waiverLabel(lines)).toBe("review-infra-unavailable");
  });

  it("an_ordinary_pass_names_nothing", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "alice")],
      })
    ).lines;
    expect(waiverLabel(lines)).toBe("");
  });

  it("a_failure_names_nothing", () => {
    const lines = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [],
      })
    ).lines;
    expect(waiverLabel(lines)).toBe("");
  });
});

// ---------- FailsClosed ---------------------------------------------------

describe("FailsClosed", () => {
  it("not_an_object", () => {
    expect(() => evaluate("nope" as unknown as Doc)).toThrow(Malformed);
  });

  it("missing_author", () => {
    expect(() => evaluate(doc({ author: "" }))).toThrow(Malformed);
    expect(() => evaluate(doc({ author: "   " }))).toThrow(Malformed);
    // @ts-expect-error intentionally wrong
    expect(() => evaluate(doc({ author: undefined }))).toThrow(Malformed);
  });

  it("reviews_not_a_list", () => {
    expect(() =>
      // @ts-expect-error intentionally wrong
      evaluate(doc({ reviews: "no" }))
    ).toThrow(Malformed);
  });

  it("threads_not_a_list", () => {
    expect(() =>
      // @ts-expect-error intentionally wrong
      evaluate(doc({ threads: {} }))
    ).toThrow(Malformed);
  });

  it("thread_without_isResolved_is_not_treated_as_resolved", () => {
    expect(() =>
      evaluate(
        doc({
          threads: [
            // @ts-expect-error intentionally wrong
            { author: "x", path: "p", url: "u", isOutdated: false },
          ],
        })
      )
    ).toThrow(Malformed);
  });

  it("thread_isResolved_must_be_a_bool", () => {
    expect(() =>
      evaluate(
        doc({
          threads: [thread({ isResolved: "true" as unknown as boolean })],
        })
      )
    ).toThrow(Malformed);
  });

  it("review_without_state", () => {
    expect(() =>
      evaluate(
        doc({
          reviews: [
            // @ts-expect-error intentionally wrong
            { author: "alice" },
          ],
        })
      )
    ).toThrow(Malformed);
  });

  it("non_object_entries", () => {
    expect(() =>
      evaluate(
        doc({
          threads: [
            // @ts-expect-error intentionally wrong
            "not an object",
          ],
        })
      )
    ).toThrow(Malformed);
  });
});

// ---------- ConditionSelector ---------------------------------------------

describe("ConditionSelector", () => {
  it("threads_only_ignores_a_missing_reviewer", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
      }),
      "threads"
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("no review"))).toBe(false);
  });

  it("reviewer_only_ignores_unresolved_threads", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [review("COMMENTED", "alice")],
      }),
      "non-author-review"
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("unresolved"))).toBe(false);
  });

  it("threads_only_still_fails_on_unresolved", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: false })],
        reviews: [review("COMMENTED", "alice")],
      }),
      "threads"
    );
    expect(result.ok).toBe(false);
  });

  it("reviewer_only_still_fails_without_one", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [],
      }),
      "non-author-review"
    );
    expect(result.ok).toBe(false);
  });

  it("draft_short_circuits_under_every_selector", () => {
    expect(
      evaluate(
        doc({ isDraft: true, threads: [thread({ isResolved: false })] }),
        "threads"
      ).ok
    ).toBe(true);
    expect(
      evaluate(doc({ isDraft: true, reviews: [] }), "non-author-review").ok
    ).toBe(true);
  });

  it("unknown_selector_is_malformed_not_a_pass", () => {
    expect(() =>
      // @ts-expect-error intentionally wrong
      evaluate(doc(), "anything")
    ).toThrow(Malformed);
  });

  it("malformed_payload_fails_closed_under_a_narrow_selector", () => {
    expect(() =>
      evaluate(
        // @ts-expect-error intentionally wrong
        { reviews: [], threads: [] },
        "threads"
      )
    ).toThrow(Malformed);
  });
});

// ---------- Roster parsing ------------------------------------------------

describe("RosterParsing", () => {
  it("parses the current wire format", () => {
    const r = parseRoster("asked=[coderabbit,copilot] skipped=2 unknown=1");
    expect(r).not.toBeNull();
    expect(r!.asked).toEqual(["coderabbit", "copilot"]);
    expect(r!.skipped).toBe(2);
  });

  it("parses the previous wire format with name-list skipped", () => {
    const r = parseRoster(
      "band=trivial asked=[copilot] skipped=[coderabbit,gemini] profiles=ready"
    );
    expect(r).not.toBeNull();
    expect(r!.asked).toEqual(["copilot"]);
    expect(r!.skipped).toBe(2);
  });

  it("returns null for an unrelated description", () => {
    expect(parseRoster("reviewed by a non-author")).toBeNull();
  });

  it("throws Malformed for a corrupted roster description", () => {
    expect(() => parseRoster("asked=[unclosed")).toThrow(Malformed);
  });
});

// ---------- Roster-narrowed reviewer condition ----------------------------

describe("Roster", () => {
  it("roster_narrows_the_asked_set_to_those_logins", () => {
    const roster: Roster = { asked: ["coderabbit"], skipped: 0 };
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        // coderabbitai[bot] is the login for `coderabbit` label
        reviews: [review("COMMENTED", "coderabbitai")],
        roster,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("roster=present"))).toBe(true);
  });

  it("roster_failure_names_the_asked_set", () => {
    const roster: Roster = { asked: ["coderabbit"], skipped: 0 };
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        // copilot reviewed, but coderabbit was asked
        reviews: [review("COMMENTED", "copilot-pull-request-reviewer")],
        roster,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.includes("roster asked for"))).toBe(true);
    expect(result.lines.some((l) => l.includes("coderabbit"))).toBe(true);
  });

  it("absent_roster_falls_back_to_pre_roster_rule", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "alice")],
        roster: null,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes("roster=absent"))).toBe(true);
  });

  it("empty_asked_list_falls_back_to_pre_roster_rule", () => {
    const result = evaluate(
      doc({
        threads: [thread({ isResolved: true })],
        reviews: [review("COMMENTED", "alice")],
        roster: { asked: [], skipped: 0 },
      })
    );
    expect(result.ok).toBe(true);
  });

  it("unknown_roster_label_fails_closed", () => {
    expect(() =>
      evaluate(
        doc({
          threads: [thread({ isResolved: true })],
          reviews: [review("COMMENTED", "alice")],
          roster: { asked: ["made-up"], skipped: 0 },
        })
      )
    ).toThrow(Malformed);
  });
});
