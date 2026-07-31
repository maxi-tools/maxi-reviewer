import * as core from "@actions/core";
import * as github from "@actions/github";
import { runReviewPr } from "./review-pr.js";
import { runReviewCommand } from "./review-command.js";
import {
  armHardDeadline,
  resolveHardTimeoutMinutes,
} from "./hard-deadline.js";

const run =
  github.context.eventName === "issue_comment" ||
  github.context.eventName === "workflow_dispatch"
    ? runReviewCommand
    : runReviewPr;

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
      core.setFailed(
        `maxi-reviewer hard deadline exceeded after ${hardMinutes} minutes (silent hang or overrun). Releasing runner.`
      );
      // Force-exit so a stuck await cannot keep the job process alive past the wall.
      process.exit(1);
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
