import * as core from "@actions/core";
import { existsSync, readFileSync } from "node:fs";
import { CiCheckRun, CiSignal } from "./types.js";

// Keep CI evidence bounded so it never dominates the prompt budget.
const MAX_CHECK_RUNS = 40;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_REPORT_CHARS = 16_000;

/**
 * The slice of the Octokit client this module needs: listing check-runs for a
 * ref. Narrowing to a structural type lets tests pass a typed fake while the
 * full github.getOctokit client still satisfies it.
 */
export interface CheckRunsReadClient {
  rest: {
    checks: {
      listForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        per_page?: number;
      }) => Promise<{
        data: {
          check_runs: Array<{
            name?: string | null;
            status?: string | null;
            conclusion?: string | null;
            details_url?: string | null;
            output?: { title?: string | null; summary?: string | null } | null;
          }>;
        };
      }>;
    };
  };
}

export interface FetchCiSignalInput {
  octokit: CheckRunsReadClient;
  owner: string;
  repo: string;
  headSha: string;
  /** This review own commit-status context, excluded from the evidence. */
  ownStatusContext?: string;
  /** "auto" fetches check-runs; anything else skips the check-run fetch. */
  mode?: string;
  /** Path to a test report file to ingest, if provided. */
  testReportPath?: string;
  /** Path to a coverage summary file to ingest, if provided. */
  coverageSummaryPath?: string;
}

function readReport(
  path: string | undefined,
  label: string
): { text?: string; truncated: boolean } {
  if (!path) return { truncated: false };
  if (!existsSync(path)) {
    core.warning("ci-signal: " + label + " file not found at " + path);
    return { truncated: false };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const truncated = raw.length > MAX_REPORT_CHARS;
    return {
      text: truncated ? raw.slice(0, MAX_REPORT_CHARS) : raw,
      truncated,
    };
  } catch (err) {
    core.warning(
      "ci-signal: failed to read " + label + " at " + path + ": " + String(err)
    );
    return { truncated: false };
  }
}

/**
 * Build a CI signal for the PR head from GitHub check-runs (when mode is
 * "auto") plus any supplied test/coverage report files. Returns undefined when
 * no evidence is available so the prompt omits the section entirely. Failures
 * are logged and skipped: CI evidence is best-effort context, never a hard
 * dependency of the review.
 */
export async function fetchCiSignal(
  input: FetchCiSignalInput
): Promise<CiSignal | undefined> {
  let truncated = false;
  const checkRuns: CiCheckRun[] = [];

  if ((input.mode ?? "off").toLowerCase() === "auto") {
    try {
      const res = await input.octokit.rest.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.headSha,
        per_page: 100,
      });
      const own = input.ownStatusContext
        ? input.ownStatusContext.toLowerCase()
        : undefined;
      for (const run of res.data.check_runs ?? []) {
        const name = (run.name ?? "").trim();
        if (!name) continue;
        // Exclude this review own check so the model never reasons about its
        // own pending/failed status, and to avoid a feedback loop.
        if (own && name.toLowerCase() === own) continue;
        const rawSummary = run.output?.summary ?? run.output?.title ?? "";
        const summaryTruncated = rawSummary.length > MAX_SUMMARY_CHARS;
        if (summaryTruncated) truncated = true;
        checkRuns.push({
          name,
          status: run.status ?? "unknown",
          conclusion: run.conclusion ?? undefined,
          summary: rawSummary
            ? summaryTruncated
              ? rawSummary.slice(0, MAX_SUMMARY_CHARS)
              : rawSummary
            : undefined,
          detailsUrl: run.details_url ?? undefined,
        });
        if (checkRuns.length >= MAX_CHECK_RUNS) break;
      }
    } catch (err) {
      core.warning("ci-signal: failed to list check-runs: " + String(err));
    }
  }

  const testReport = readReport(input.testReportPath, "test_report");
  const coverage = readReport(input.coverageSummaryPath, "coverage_summary");
  if (testReport.truncated || coverage.truncated) truncated = true;

  if (checkRuns.length === 0 && !testReport.text && !coverage.text) {
    return undefined;
  }

  return {
    schema: "maxi.review.v1.ci-signal",
    checkRuns,
    testReport: testReport.text,
    coverageSummary: coverage.text,
    truncated,
  };
}
