import * as core from "@actions/core";
import * as github from "@actions/github";
import { runReviewPr } from "./review-pr.js";
import { runReviewCommand } from "./review-command.js";

const run =
  github.context.eventName === "issue_comment" ||
  github.context.eventName === "workflow_dispatch"
    ? runReviewCommand
    : runReviewPr;

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
