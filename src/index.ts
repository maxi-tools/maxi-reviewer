import * as core from "@actions/core";
import { runReviewPr } from "./review-pr.js";

runReviewPr().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
