import { ReviewResult } from "../types.js";
import { parseJulesReview } from "../verify-format.js";

/**
 * The structured review contract the prompt asks for.
 */
export interface StructuredReview {
  summary: string;
  verdict: ReviewResult["verdict"];
  resolvedCommentIds: number[];
  comments: Array<{
    path: string;
    line: number;
    startLine?: number;
    endLine?: number;
    severity: "Info" | "Warning" | "High";
    confidence: "Low" | "Medium" | "High";
    message: string;
    evidenceSource?: ReviewResult["newComments"][number]["evidenceSource"];
    promptForAgents?: string;
    suggestion?: {
      startLine?: number;
      endLine?: number;
      replacement: string;
    };
    fix?: ReviewResult["newComments"][number]["fix"];
  }>;
}

/**
 * Parse a model reply into the review the rest of the action already posts.
 *
 * Structured `maxi.review.v1.jules-review` is the contract. A bare object in
 * the legacy `{summary, verdict, newComments}` shape is accepted too, because
 * a local model that followed the example's field names but dropped `schema`
 * still produced a review, and throwing it away is the failure this backend
 * exists to avoid.
 */
export function parseOpenAiReview(message: string): ReviewResult {
  try {
    return convertStructuredReview(parseJulesReview(message));
  } catch {
    // Fall through to the legacy shape.
  }
  const fenced = message.match(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/i);
  const candidates = [fenced?.[1], message];
  let lastError: unknown;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Partial<ReviewResult> & {
        comments?: ReviewResult["newComments"];
      };
      if (
        typeof parsed.summary !== "string" ||
        !parsed.verdict ||
        (!parsed.newComments && !parsed.comments)
      ) {
        throw new Error("review JSON is missing summary, verdict, or comments");
      }
      return {
        summary: parsed.summary,
        verdict: parsed.verdict,
        resolvedCommentIds: parsed.resolvedCommentIds ?? [],
        newComments: parsed.newComments ?? parsed.comments ?? [],
      };
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("missing summary")) {
        throw err;
      }
    }
  }
  throw new Error("Failed to parse OpenAI-compatible review as JSON", {
    cause: lastError,
  });
}

export function convertStructuredReview(
  review: StructuredReview
): ReviewResult {
  return {
    summary: review.summary,
    verdict: review.verdict,
    resolvedCommentIds: review.resolvedCommentIds,
    newComments: review.comments.map((comment) => ({
      file: comment.path,
      line: comment.line,
      startLine: comment.startLine ?? comment.suggestion?.startLine,
      endLine: comment.endLine ?? comment.suggestion?.endLine,
      severity: comment.severity,
      confidence: comment.confidence,
      ...(comment.evidenceSource
        ? { evidenceSource: comment.evidenceSource }
        : {}),
      message: comment.message,
      promptForAgents: comment.promptForAgents ?? "",
      suggestedReplacement: comment.suggestion?.replacement,
      fix: comment.fix,
    })),
  };
}
