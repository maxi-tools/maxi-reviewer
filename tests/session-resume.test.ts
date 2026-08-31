import { describe, it, expect } from "vitest";
import { buildReviewArtifact } from "../src/late-feedback-harvest.js";
import {
  buildArtifactCommentContent,
  latestReviewArtifactSessionId,
} from "../src/review-pr.js";

// Reproduce the persisted PR-comment shape extractReviewArtifactFromComment
// parses: a base64-encoded artifact (rawJulesResponses are stripped by
// buildArtifactCommentContent, so validatedReview is the liveness signal).
function comment(sessionId: string, validatedReview: unknown): string {
  const json = buildArtifactCommentContent(
    buildReviewArtifact({
      repoFullName: "o/r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
      outcomeSchema: "maxi.review.v1.review-outcome",
      outcome:
        validatedReview === null
          ? "TIMED_OUT_NO_CONTENT"
          : "REVIEWED_NO_FINDINGS",
      timeoutMinutes: 30,
      reviewOutputChars: validatedReview === null ? 0 : 12,
      runIdentity: {
        workflowRunId: 101,
        workflowRunAttempt: 1,
        job: "review",
      },
      analyzerFindings: [],
      rawJulesResponses: validatedReview === null ? [] : ["raw response"],
      validatedReview,
      validationErrors: [],
      sessionId,
    })
  );
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return (
    "<!-- maxi-review artifact -->\n" +
    "<!-- maxi-review artifact-data\n" +
    "name: a.json\n" +
    "encoding: base64\n" +
    b64 +
    "\n-->"
  );
}

const review = {
  summary: "ok",
  verdict: "comment",
  resolvedCommentIds: [],
  newComments: [],
};

const dead = (id: string) => comment(id, null);
const alive = (id: string) => comment(id, review);

describe("latestReviewArtifactSessionId", () => {
  it("does not resume a session that never produced a review (timed out)", () => {
    expect(latestReviewArtifactSessionId([dead("s-dead")])).toBeUndefined();
  });

  it("resumes a session that produced a validated review", () => {
    expect(latestReviewArtifactSessionId([alive("s-live")])).toBe("s-live");
  });

  it("skips a newer dead session and resumes an older live one", () => {
    expect(latestReviewArtifactSessionId([alive("s-old"), dead("s-new")])).toBe(
      "s-old"
    );
  });

  it("returns undefined when every recorded session is dead", () => {
    expect(
      latestReviewArtifactSessionId([dead("a"), dead("b"), dead("c")])
    ).toBeUndefined();
  });
});
