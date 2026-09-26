import { describe, expect, it } from "vitest";
import {
  MIN_CELL_SAMPLES,
  MIN_GROUP_SAMPLES,
  rankedGroups,
  renderReport,
  spreads,
} from "../src/reviewer-profile-report.js";
import type { ReviewerProfiles } from "../src/reviewer-profile.js";

const BOTS = [
  "codacy-production",
  "coderabbitai",
  "qltysh",
  "chatgpt-codex-connector",
  "cubic-dev-ai",
  "github-advanced-security",
  "maxi-reviewer",
] as const;

function stats(n: number, acceptRate: number, unknownN = 0) {
  return { n, acceptRate, unknownN };
}

function profiles(
  per: Partial<
    Record<(typeof BOTS)[number], Record<string, ReturnType<typeof stats>>>
  >,
  overall?: Partial<Record<(typeof BOTS)[number], ReturnType<typeof stats>>>
): ReviewerProfiles {
  const reviewers = {} as ReviewerProfiles["reviewers"];
  for (const bot of BOTS) {
    const byPathGroup = per[bot] ?? {};
    const totals = Object.values(byPathGroup);
    reviewers[bot] = {
      overall:
        overall?.[bot] ??
        stats(
          totals.reduce((a, s) => a + s.n, 0),
          totals.length
            ? totals.reduce((a, s) => a + s.acceptRate * s.n, 0) /
                Math.max(
                  1,
                  totals.reduce((a, s) => a + s.n, 0)
                )
            : 0,
          totals.reduce((a, s) => a + s.unknownN, 0)
        ),
      byPathGroup,
    };
  }
  return {
    schema: "maxi.review.v1.reviewer-profiles",
    generatedAt: "2026-09-19T14:27:03.752Z",
    windowDays: 30,
    reviewers,
  };
}

describe("renderReport", () => {
  it("refuses to render a table when nothing was measured", () => {
    // The whole point. #133 published a structurally perfect file of zeroes
    // because every commit walk was throwing, and the shape check passed. A
    // report is one more place that can launder a failed measurement into
    // data, so it must say so in words rather than print 0% seven times.
    const p = profiles({}, {
      coderabbitai: stats(0, 0, 4210),
      "codacy-production": stats(0, 0, 900),
    } as never);
    const out = renderReport(p);
    expect(out).toContain("measured nothing");
    expect(out).toContain("failed run");
    expect(out).not.toContain("| reviewer |");
  });

  it("distinguishes no findings at all from findings it could not measure", () => {
    const out = renderReport(profiles({}));
    expect(out).toContain("no findings at all");
    expect(out).not.toContain("measured nothing");
  });

  it("warns when most findings were unmeasurable but still reports", () => {
    const p = profiles({ coderabbitai: { "rust-src": stats(50, 0.5) } }, {
      coderabbitai: stats(50, 0.5, 400),
    } as never);
    const out = renderReport(p);
    expect(out).toContain("Degraded");
    expect(out).toContain("| reviewer |");
  });

  it("stays a valid table when no path group qualifies for a column", () => {
    // Reachable on a short window or a new org: every group can sit under
    // MIN_GROUP_SAMPLES while `overall` still has plenty of findings.
    // Interpolating an empty `groups.join()` between fixed columns left a
    // trailing empty cell, making the header one column wider than its
    // separator -- which renders as a broken table, not a narrow one.
    const p = profiles({
      coderabbitai: { docs: stats(MIN_GROUP_SAMPLES - 1, 0.8) },
    });
    const out = renderReport(p);
    const rows = out
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.endsWith(" |"));
    expect(rows.length).toBeGreaterThan(2);
    const widths = new Set(rows.map((r) => r.split("|").length));
    expect(widths.size, `ragged table: ${[...widths].join(", ")}`).toBe(1);
    expect(out).not.toContain("|  |");
  });

  it("says plainly that columns are not comparable to each other", () => {
    // The trap the first hand-reading fell into: `rust-src` outscored `docs`
    // for nearly every reviewer, which reads as a quality ranking and is
    // mostly a statement about how many files each bucket catches.
    const out = renderReport(
      profiles({ coderabbitai: { "rust-src": stats(100, 0.9) } })
    );
    expect(out).toMatch(/not.{0,20}comparable across columns/i);
  });
});

describe("rankedGroups", () => {
  it("drops groups too small to mean anything, widest first", () => {
    const p = profiles({
      coderabbitai: {
        "rust-src": stats(MIN_GROUP_SAMPLES * 3, 0.9),
        docs: stats(MIN_GROUP_SAMPLES, 0.7),
        hooks: stats(MIN_GROUP_SAMPLES - 1, 1),
      },
    });
    expect(rankedGroups(p)).toEqual(["rust-src", "docs"]);
  });

  it("sums a group across reviewers before deciding it is too small", () => {
    // One reviewer alone is under the bar; together they clear it. Judging
    // per-reviewer would drop a column the roster can legitimately use.
    const half = Math.ceil(MIN_GROUP_SAMPLES / 2);
    const p = profiles({
      coderabbitai: { ios: stats(half, 0.5) },
      "cubic-dev-ai": { ios: stats(half, 0.9) },
    });
    expect(rankedGroups(p)).toEqual(["ios"]);
  });
});

describe("spreads", () => {
  it("ranks path groups by the gap between best and worst reviewer", () => {
    const p = profiles({
      coderabbitai: {
        ios: stats(77, 0.52),
        "rust-src": stats(2202, 0.92),
      },
      "chatgpt-codex-connector": {
        ios: stats(73, 0.96),
        "rust-src": stats(948, 0.87),
      },
    });
    const [first, second] = spreads(p);
    expect(first.group).toBe("ios");
    expect(first.points).toBe(44);
    expect(first.best).toBe("chatgpt-codex-connector");
    expect(first.worst).toBe("coderabbitai");
    expect(second.group).toBe("rust-src");
    expect(second.points).toBe(5);
  });

  it("ignores a reviewer with too few samples to place", () => {
    // A 100% rate on n=1 would otherwise manufacture the widest spread in
    // the report and send the roster chasing it.
    const p = profiles({
      coderabbitai: { ios: stats(60, 0.5) },
      "cubic-dev-ai": { ios: stats(40, 0.6) },
      qltysh: { ios: stats(MIN_CELL_SAMPLES - 1, 1) },
    });
    const [only] = spreads(p);
    expect(only.best).toBe("cubic-dev-ai");
    expect(only.points).toBe(10);
  });

  it("returns nothing for a group only one reviewer covers", () => {
    const p = profiles({ coderabbitai: { ios: stats(60, 0.5) } });
    expect(spreads(p)).toEqual([]);
  });
});
