import { describe, expect, it } from "vitest";
import { buildReviewArtifact } from "../src/late-feedback-harvest.js";

describe("late feedback harvest artifacts", () => {
  it("records the harvest contract for feedback that finishes after merge", () => {
    const artifact = JSON.parse(
      buildReviewArtifact({
        repoFullName: "maxi/example",
        prNumber: 7,
        headSha: "head-sha",
        baseSha: "base-sha",
        outcomeSchema: "maxi.review.v1.review-outcome",
        outcome: "REVIEWED_NO_FINDINGS",
        reviewOutputChars: 0,
        runIdentity: {
          workflowRunId: 101,
          workflowRunAttempt: 1,
          job: "review",
        },
        analyzerFindings: [],
        rawJulesResponses: [],
        validatedReview: {
          verdict: "approve",
          summary: "Looks good.",
          resolvedCommentIds: [],
          newComments: [],
        },
        validationErrors: [],
        sessionId: "session-1",
      })
    );

    expect(artifact.retention).toEqual({
      harvestableAfterMerge: true,
      channels: ["github-actions-artifact", "github-pr-comment"],
      commentMarker: "<!-- maxi-review artifact -->",
    });
  });
});
