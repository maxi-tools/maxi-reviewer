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

export function buildReviewArtifact(input: ReviewArtifactInput): string {
  return JSON.stringify(
    {
      schema: "maxi.review.v1.review-artifact",
      createdAt: new Date().toISOString(),
      ...input,
    },
    null,
    2
  );
}
