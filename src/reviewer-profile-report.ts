/**
 * Render a `reviewer-profiles.json` as a readable report.
 *
 * WHY THIS IS CHECKED IN. The first harvest that produced real numbers was
 * read by hand with throwaway scripts, and two of the three conclusions drawn
 * from it were wrong:
 *
 *   - `overall` was quoted as the headline. Three reviewers sat within 0.9
 *     points of each other there, which looked like a broken measurement. It
 *     was aggregation flattening a 44-point gap that existed one level down.
 *   - the per-group table was read as a quality ranking. It was partly
 *     measuring how broad each path bucket is.
 *
 * Reviewer behaviour drifts, so these numbers are never final. Anything that
 * has to be re-derived by hand will be re-derived differently, or not at all.
 * This module exists so the next reading is a re-run rather than a project.
 *
 * It is pure: it takes a parsed profile and returns markdown. The harvest
 * workflow writes the result to `$GITHUB_STEP_SUMMARY`, so every scheduled
 * run publishes its own analysis beside the data it produced.
 */

import type { ReviewerProfiles, PathGroupStats } from "./reviewer-profile.js";

/**
 * Path groups below this many findings are noise, and the README already says
 * so. They still count in `overall`; they just do not get a column.
 */
export const MIN_GROUP_SAMPLES = 40;

/**
 * Below this, one finding moves a rate by more than ten points, so the cell is
 * left blank rather than printed as though it meant something.
 */
export const MIN_CELL_SAMPLES = 8;

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function rateCell(stats: PathGroupStats | undefined): string {
  if (!stats || stats.n < MIN_CELL_SAMPLES) return "–";
  return `${pct(stats.acceptRate)} <sub>n=${stats.n}</sub>`;
}

/** Path groups worth a column, widest bucket first. */
export function rankedGroups(profiles: ReviewerProfiles): string[] {
  const totals = new Map<string, number>();
  for (const stats of Object.values(profiles.reviewers)) {
    for (const [group, s] of Object.entries(stats.byPathGroup)) {
      totals.set(group, (totals.get(group) ?? 0) + s.n);
    }
  }
  return [...totals.entries()]
    .filter(([, n]) => n >= MIN_GROUP_SAMPLES)
    .sort((a, b) => b[1] - a[1])
    .map(([group]) => group);
}

export interface GroupSpread {
  group: string;
  points: number;
  best: string;
  bestRate: number;
  worst: string;
  worstRate: number;
}

/**
 * The gap between the best and worst reviewer WITHIN one path group.
 *
 * This is the number the roster can act on, and the only comparison the data
 * supports. Every reviewer in a group is scored by the same rule against the
 * same bucket, so the gap between them is like-for-like. Comparing one GROUP
 * against another is not: that difference is contaminated by how many files
 * each bucket happens to catch.
 */
export function spreads(profiles: ReviewerProfiles): GroupSpread[] {
  const out: GroupSpread[] = [];
  for (const group of rankedGroups(profiles)) {
    const rated = Object.entries(profiles.reviewers)
      .map(([name, stats]) => ({ name, s: stats.byPathGroup[group] }))
      .filter((r) => r.s !== undefined && r.s.n >= MIN_CELL_SAMPLES)
      .sort((a, b) => a.s!.acceptRate - b.s!.acceptRate);
    if (rated.length < 2) continue;
    const worst = rated[0];
    const best = rated[rated.length - 1];
    out.push({
      group,
      points: Math.round((best.s!.acceptRate - worst.s!.acceptRate) * 100),
      best: best.name,
      bestRate: best.s!.acceptRate,
      worst: worst.name,
      worstRate: worst.s!.acceptRate,
    });
  }
  return out.sort((a, b) => b.points - a.points);
}

export function renderReport(profiles: ReviewerProfiles): string {
  const names = Object.keys(profiles.reviewers).sort();
  const groups = rankedGroups(profiles);
  const lines: string[] = [];

  lines.push("## Reviewer calibration");
  lines.push("");
  lines.push(
    `\`${profiles.schema}\` · ${profiles.windowDays}-day window · generated ${profiles.generatedAt}`
  );
  lines.push("");

  let measured = 0;
  let unmeasurable = 0;
  for (const name of names) {
    const stats = profiles.reviewers[name as keyof typeof profiles.reviewers];
    measured += stats.overall.n;
    unmeasurable += stats.overall.unknownN;
  }

  // A harvest that measured nothing must SAY so rather than render a table of
  // zeroes. #133 published seven reviewers, a correct schema, 6358 samples and
  // 0% across the board because every commit walk was throwing, and the shape
  // was valid the entire time. A report is another place that can launder a
  // failed measurement into data.
  if (measured === 0) {
    lines.push(
      unmeasurable > 0
        ? `> **This harvest measured nothing.** All ${unmeasurable} findings have an unknown outcome, so every rate would be 0% over an empty denominator. Treat this as a failed run, not as a result.`
        : "> **This harvest found no findings at all.** Nothing to report."
    );
    lines.push("");
    return lines.join("\n");
  }

  if (unmeasurable > measured) {
    lines.push(
      `> **Degraded:** ${unmeasurable} unmeasurable against ${measured} measured. The commit walk failed on most PRs; the rates below cover only the minority that worked.`
    );
    lines.push("");
  }

  lines.push(`**${measured} measured**, ${unmeasurable} unmeasurable.`);
  lines.push("");
  lines.push(
    "Rates are *not* comparable across columns — a wider path bucket catches more incidental commits. Compare reviewers **down** a column; that is what the roster routes on."
  );
  lines.push("");

  // Built as one array per row rather than interpolating `groups.join()`
  // between fixed columns. With no qualifying group the interpolation left a
  // trailing empty cell -- `| reviewer | overall |  |` -- and a header one
  // column wider than its separator renders as a broken table rather than a
  // narrow one. That is reachable: a short window, or a new org, can leave
  // every path group under MIN_GROUP_SAMPLES. (codacy)
  const header = ["reviewer", "overall", ...groups];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(
    `| ${header.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`
  );
  for (const name of names) {
    const stats = profiles.reviewers[name as keyof typeof profiles.reviewers];
    const row = [
      name,
      rateCell(stats.overall),
      ...groups.map((g) => rateCell(stats.byPathGroup[g])),
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  const gaps = spreads(profiles);
  if (gaps.length > 0) {
    lines.push("### Where the roster has something to route on");
    lines.push("");
    lines.push("| path group | spread | best | worst |");
    lines.push("| --- | ---: | --- | --- |");
    for (const g of gaps) {
      lines.push(
        `| ${g.group} | ${g.points} pts | ${g.best} ${pct(g.bestRate)} | ${g.worst} ${pct(g.worstRate)} |`
      );
    }
    lines.push("");
  }

  lines.push(
    `<sub>A column needs ≥${MIN_GROUP_SAMPLES} findings across all reviewers; a cell needs ≥${MIN_CELL_SAMPLES} for that reviewer, else “–”.</sub>`
  );
  lines.push("");
  return lines.join("\n");
}
