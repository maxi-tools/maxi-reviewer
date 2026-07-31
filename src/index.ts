import * as core from "@actions/core";
import * as github from "@actions/github";
import { runReviewPr } from "./review-pr.js";
import { runReviewCommand } from "./review-command.js";
import { armHardDeadline, resolveHardTimeoutMinutes } from "./hard-deadline.js";
import { setStatus } from "./github.js";

const run =
  github.context.eventName === "issue_comment" ||
  github.context.eventName === "workflow_dispatch"
    ? runReviewCommand
    : runReviewPr;

async function publishHardDeadlineStatus(message: string): Promise<void> {
  // Best-effort: flip pending maxi/review to error so a required status check
  // cannot stay pending forever after process.exit (#59 residual P1).
  try {
    if (github.context.eventName !== "pull_request") {
      return;
    }
    const pr = github.context.payload.pull_request;
    if (!pr?.head?.sha) {
      return;
    }
    const token = core.getInput("github_token", { required: true });
    const statusContext = core.getInput("status_context") || "maxi/review";
    const octokit = github.getOctokit(token);
    const description =
      message.length > 140 ? `${message.slice(0, 137)}...` : message;
    await setStatus(
      octokit,
      github.context.repo.owner,
      github.context.repo.repo,
      pr.head.sha,
      statusContext,
      "error",
      description
    );
  } catch (err) {
    core.warning(
      `hard-deadline status cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function main(): Promise<void> {
  const timeoutMinutesRaw = core.getInput("timeout_minutes") || "30";
  const timeoutMinutes = Math.max(1, parseInt(timeoutMinutesRaw, 10) || 30);
  const hardMinutes = resolveHardTimeoutMinutes(
    timeoutMinutes,
    core.getInput("hard_timeout_minutes") || undefined
  );

  core.info(
    `Hard deadline armed: ${hardMinutes} minute(s) (timeout_minutes=${timeoutMinutes}).`
  );

  const deadline = armHardDeadline({
    timeoutMs: hardMinutes * 60 * 1000,
    onFire: () => {
      const message = `maxi-reviewer hard deadline exceeded after ${hardMinutes} minutes (silent hang or overrun). Releasing runner.`;
      core.setFailed(message);
      // Status update then force-exit so a stuck await cannot keep the process.
      // Cap wait so a hung GitHub API cannot re-block the runner indefinitely.
      const cleanup = publishHardDeadlineStatus(message);
      const cap = new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000);
      });
      void Promise.race([cleanup, cap]).finally(() => {
        process.exit(1);
      });
    },
    onHeartbeat: (remainingMs) => {
      const remainingMin = Math.ceil(remainingMs / 60_000);
      core.info(
        `maxi-reviewer still running; hard deadline in ~${remainingMin} minute(s).`
      );
    },
    heartbeatMs: 60_000,
  });

  try {
    await run();
  } finally {
    deadline.clear();
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
