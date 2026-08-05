import { ReviewOutcome, ReviewRunIdentity } from "./types.js";

export interface ReviewArtifactInput {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  outcomeSchema: "maxi.review.v1.review-outcome";
  outcome: ReviewOutcome;
  reviewOutputChars: number;
  runIdentity: ReviewRunIdentity;
  analyzerFindings: unknown[];
  rawJulesResponses: string[];
  validatedReview: unknown;
  validationErrors: string[];
  sessionId?: string;
}

export interface ReviewArtifactRetention {
  harvestableAfterMerge: true;
  channels: ["github-actions-artifact", "github-pr-comment"];
  commentMarker: "<!-- maxi-review artifact -->";
}

export function buildReviewArtifact(input: ReviewArtifactInput): string {
  return JSON.stringify(
    {
      schema: "maxi.review.v1.review-artifact",
      createdAt: new Date().toISOString(),
      retention: {
        harvestableAfterMerge: true,
        channels: ["github-actions-artifact", "github-pr-comment"],
        commentMarker: "<!-- maxi-review artifact -->",
      } satisfies ReviewArtifactRetention,
      ...input,
    },
    null,
    2
  );
}
