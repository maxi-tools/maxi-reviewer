import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCiSignal } from "../src/ci-signal.js";

function octokitWith(runs: unknown[]) {
  return {
    rest: {
      checks: {
        listForRef: vi.fn(async () => ({ data: { check_runs: runs } })),
      },
    },
  };
}

describe("fetchCiSignal", () => {
  it("maps check-runs and excludes the review own status context", async () => {
    const octokit = octokitWith([
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        details_url: "u1",
        output: { summary: "all green" },
      },
      {
        name: "maxi/review",
        status: "completed",
        conclusion: "failure",
        output: { summary: "self" },
      },
      { name: "", status: "completed" },
    ]);
    const sig = await fetchCiSignal({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
      ownStatusContext: "maxi/review",
      mode: "auto",
    });
    expect(sig).toBeDefined();
    expect(sig?.schema).toBe("maxi.review.v1.ci-signal");
    expect(sig?.checkRuns).toHaveLength(1);
    expect(sig?.checkRuns[0]).toMatchObject({
      name: "build",
      status: "completed",
      conclusion: "success",
      summary: "all green",
      detailsUrl: "u1",
    });
  });

  it("does not fetch check-runs when mode is off", async () => {
    const octokit = octokitWith([{ name: "build", status: "completed" }]);
    const sig = await fetchCiSignal({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
      mode: "off",
    });
    expect(octokit.rest.checks.listForRef).not.toHaveBeenCalled();
    expect(sig).toBeUndefined();
  });

  it("truncates an oversized check summary and flags truncation", async () => {
    const big = "x".repeat(5000);
    const octokit = octokitWith([
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        output: { summary: big },
      },
    ]);
    const sig = await fetchCiSignal({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
      mode: "auto",
    });
    expect(sig?.truncated).toBe(true);
    expect(sig?.checkRuns[0].summary?.length).toBe(2000);
  });

  it("ingests supplied test and coverage report files regardless of mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-signal-"));
    try {
      const testReportPath = join(dir, "report.txt");
      const coveragePath = join(dir, "cov.txt");
      writeFileSync(testReportPath, "5 passed, 0 failed");
      writeFileSync(coveragePath, "coverage 92pct (+1pct)");
      const octokit = octokitWith([]);
      const sig = await fetchCiSignal({
        octokit: octokit as never,
        owner: "o",
        repo: "r",
        headSha: "HEAD",
        mode: "off",
        testReportPath,
        coverageSummaryPath: coveragePath,
      });
      expect(octokit.rest.checks.listForRef).not.toHaveBeenCalled();
      expect(sig?.testReport).toContain("5 passed");
      expect(sig?.coverageSummary).toContain("92pct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when there is no evidence", async () => {
    const octokit = octokitWith([]);
    const sig = await fetchCiSignal({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
      mode: "auto",
    });
    expect(sig).toBeUndefined();
  });
});
