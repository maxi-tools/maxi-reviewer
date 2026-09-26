/**
 * CLI entry point for the scheduled calibration harvest. The workflow
 * `calibration-harvest.yml` builds this file via ncc into
 * `dist/calibration-harvest/index.js` and runs it directly. We keep this
 * separate from `src/index.ts` (the action's user-facing entry) so the
 * harvester's runtime is independent of the PR review orchestrator's.
 *
 * Required environment variables:
 *   - GITHUB_TOKEN           — the workflow's actions token, with read on
 *                               pulls, comments, and contents, plus
 *                               metadata:read so the search API is callable.
 *   - INPUT_ORG              — the org to scan (default `maxi-tools`).
 *   - INPUT_WINDOW_DAYS      — how far back to look (default 30).
 *   - INPUT_MAX_PULLS        — safety cap on PRs walked per run (default 500).
 *   - INPUT_PROFILES_PATH    — where to write reviewer-profiles.json.
 *   - INPUT_CALIBRATION_PATH — where to write calibration.json (maxi-reviewer
 *                               own-artifacts report from calibration.ts).
 *   - INPUT_DRY_RUN          — `1` writes to /tmp and skips the release push.
 */

import * as core from "@actions/core";
import * as path from "node:path";
import { runScheduledHarvest } from "./reviewer-profile-build.js";
import { renderReport } from "./reviewer-profile-report.js";

function readInput(name: string, fallback: string): string {
  const raw = process.env["INPUT_" + name.toUpperCase()];
  if (!raw || raw.length === 0) return fallback;
  return raw;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    core.setFailed("GITHUB_TOKEN is required for the calibration harvest.");
    return;
  }

  const org = readInput("org", "maxi-tools");
  const windowDaysRaw = readInput("window_days", "30");
  const windowDays = Math.max(1, parseInt(windowDaysRaw, 10) || 30);
  const maxPullsRaw = readInput("max_pulls", "500");
  const maxPulls = Math.max(1, parseInt(maxPullsRaw, 10) || 500);
  const dryRun = readInput("dry_run", "0") === "1";

  const profilesPath = dryRun
    ? path.join("/tmp", "reviewer-profiles.json")
    : path.resolve(readInput("profiles_path", "reviewer-profiles.json"));
  const calibrationPath = dryRun
    ? path.join("/tmp", "calibration.json")
    : path.resolve(readInput("calibration_path", "calibration.json"));

  core.info(
    `calibration-harvest starting: org=${org} window_days=${windowDays} max_pulls=${maxPulls} dry_run=${dryRun}`
  );

  const result = await runScheduledHarvest({
    outPath: profilesPath,
    calibrationOutPath: calibrationPath,
    org,
    windowDays,
    maxPulls,
    token,
  });

  // Print to stdout in addition to the actions log so `::group::`-less
  // `gh run view --log` output shows the headline numbers.
  core.info(
    `calibration-harvest done: ${
      Object.values(result.profiles.reviewers).filter(
        (stats) => stats.overall.n > 0
      ).length
    } reviewers sampled, ${result.artifactsObserved} calibration artifacts`
  );
  if (result.profiles) {
    process.stdout.write(
      `REVIEWER_PROFILES_PATH=${profilesPath}\nCALIBRATION_PATH=${calibrationPath}\n`
    );
  }

  // Publish the analysis beside the data, on every run.
  //
  // The first harvest that produced real numbers was read by hand with
  // throwaway scripts, and two of the three conclusions drawn from it were
  // wrong. Reviewer behaviour drifts, so this measurement is never final --
  // and anything that has to be re-derived by hand will be re-derived
  // differently, or not at all. Writing the report here means the next
  // reading is a re-run, not a research project.
  //
  // Non-fatal: a summary that cannot be written must never lose a harvest
  // that succeeded. GITHUB_STEP_SUMMARY is absent when this is run locally.
  try {
    await core.summary.addRaw(renderReport(result.profiles)).write();
  } catch (err) {
    core.warning(
      `could not write the run summary: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Set outputs for downstream steps (release creation).
  core.setOutput("profiles-path", profilesPath);
  core.setOutput("calibration-path", calibrationPath);
  core.setOutput(
    "samples",
    String(
      Object.values(result.profiles.reviewers).reduce(
        (sum, stats) => sum + stats.overall.n,
        0
      )
    )
  );
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
