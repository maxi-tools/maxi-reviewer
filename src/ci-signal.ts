import * as core from "@actions/core";
import { open } from "node:fs/promises";
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

async function readReport(
  path: string | undefined,
  label: string
): Promise<{ text?: string; truncated: boolean }> {
  if (!path) return { truncated: false };
  // Async fs (not existsSync + readFileSync) avoids blocking the event loop and
  // the TOCTOU race between the existence check and the read. We read at most
  // MAX_REPORT_CHARS+1 bytes via a file handle rather than the whole file, so a
  // user-supplied path to a multi-gigabyte file cannot OOM the process.
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      core.warning("ci-signal: " + label + " file not found at " + path);
    } else {
      core.warning(
        "ci-signal: failed to open " +
          label +
          " at " +
          path +
          ": " +
          String(err)
      );
    }
    return { truncated: false };
  }
  try {
    // One extra byte so a file exactly at the cap is not falsely flagged.
    const cap = MAX_REPORT_CHARS + 1;
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    const truncated = bytesRead > MAX_REPORT_CHARS;
    const text = buffer
      .subarray(0, Math.min(bytesRead, MAX_REPORT_CHARS))
      .toString("utf8");
    return { text, truncated };
  } catch (err) {
    core.warning(
      "ci-signal: failed to read " + label + " at " + path + ": " + String(err)
    );
    return { truncated: false };
  } finally {
    await handle.close();
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
      const currentRunId = process.env.GITHUB_RUN_ID;
      for (const run of res.data.check_runs ?? []) {
        const name = (run.name ?? "").trim();
        if (!name) continue;
        // Exclude this workflow run own check-run (matched by run id in the
        // details URL) and any check sharing this review status context, so the
        // model never reasons about the review own pending/failed status, and to
        // avoid a feedback loop. Check-run names rarely equal the status
        // context, so the run-id match is the reliable guard.
        if (
          currentRunId &&
          run.details_url &&
          run.details_url.includes("/actions/runs/" + currentRunId)
        ) {
          continue;
        }
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

  const testReport = await readReport(input.testReportPath, "test_report");
  const coverage = await readReport(
    input.coverageSummaryPath,
    "coverage_summary"
  );
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
