export interface ReviewArtifactInput {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
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
