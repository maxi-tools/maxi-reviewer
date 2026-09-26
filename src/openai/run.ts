import * as core from "@actions/core";
import { holdBlockToItsEvidence } from "../evidence.js";
import {
  buildFormatRepairPrompt,
  buildJsonRepairPrompt,
  findReviewFormatIssues,
} from "../format.js";
import { ReviewResult } from "../types.js";
import {
  buildReviewRepairPrompt,
  parseJulesReview,
  VerificationContext,
  verifyJulesReview,
} from "../verify-format.js";
import {
  completeOpenAiChat,
  errorMessage,
  OpenAiReviewConfig,
  OpenAiReviewRunResult,
  OpenAiTimeoutError,
  RunOpenAiReviewOptions,
} from "./client.js";
import { OpenAiConversation, repairTurn, turn } from "./conversation.js";
import { convertStructuredReview, parseOpenAiReview } from "./parse.js";
import { runRetrievalLoop } from "./retrieval-loop.js";

/**
 * The moving parts of a review run: the shared conversation plus the
 * transcript and the problems collected along the way.
 */
interface ReviewRun {
  conv: OpenAiConversation;
  sessionId: string;
  rawResponses: string[];
  validationErrors: string[];
}

/**
 * Run one review against an OpenAI-compatible endpoint.
 *
 * The prompt, the schema, and the repair loop are the same ones Jules uses.
 * What changes is the transport: each turn is one chat-completions call, and
 * the conversation so far is resent because vLLM has no session to resume.
 * A timeout returns `reviewResult: null` — the same shape Jules uses when it
 * never replies — so the caller can fall through without a special case.
 */
export async function runOpenAiReview(
  prompt: string,
  config: OpenAiReviewConfig,
  options: RunOpenAiReviewOptions = {}
): Promise<OpenAiReviewRunResult> {
  const run: ReviewRun = {
    conv: {
      complete: options.complete ?? completeOpenAiChat,
      config,
      messages: [{ role: "user", content: prompt }],
      onProgress: options.onProgress,
    },
    sessionId: `openai:${config.model}`,
    rawResponses: [],
    validationErrors: [],
  };

  const first = await firstTurn(run);
  if (!first) return noReviewOnTimeout(config);
  run.rawResponses.push(first);

  const reply = options.retrieval
    ? await retrievalStage(run, first, options.retrieval)
    : first;

  const parsed = await parseWithRepair(run, reply);
  if (!parsed) return finish(run, null);
  if (parsed.unparseable) return finish(run, parsed.reviewResult);
  let { reviewResult } = parsed;
  let current = parsed.reply;

  reviewResult = await formatRepairStage(run, reviewResult, (revised) => {
    current = revised;
  });

  if (options.verificationContext) {
    reviewResult = await verificationStage(
      run,
      current,
      options.verificationContext,
      reviewResult
    );
  }

  const evidence = holdBlockToItsEvidence(reviewResult);
  run.validationErrors.push(...evidence.issues);
  return finish(run, evidence.review);
}

/**
 * The opening turn is the only one whose timeout means "no review at all":
 * later stages already hold a reply worth keeping.
 */
async function firstTurn(run: ReviewRun): Promise<string | null> {
  try {
    return await turn(run.conv);
  } catch (err) {
    if (err instanceof OpenAiTimeoutError) {
      core.warning(err.message);
      return null;
    }
    throw err;
  }
}

function noReviewOnTimeout(config: OpenAiReviewConfig): OpenAiReviewRunResult {
  return {
    reviewResult: null,
    sessionId: `openai:timeout:${config.model}`,
  };
}

async function retrievalStage(
  run: ReviewRun,
  firstReply: string,
  retrieval: NonNullable<RunOpenAiReviewOptions["retrieval"]>
): Promise<string> {
  const reply = await runRetrievalLoop(run.conv, firstReply, retrieval);
  if (reply !== run.rawResponses[run.rawResponses.length - 1]) {
    run.rawResponses.push(reply);
  }
  return reply;
}

/**
 * Parse the reply, asking the model to repair its own output once when it
 * is not valid review JSON. Returns `null` only when the repair turn timed
 * out; a repair that still does not parse yields the empty "could not be
 * parsed" review so the run still has something to post.
 */
async function parseWithRepair(
  run: ReviewRun,
  reply: string
): Promise<{
  reviewResult: ReviewResult;
  reply: string;
  unparseable?: boolean;
} | null> {
  let parseError: unknown;
  try {
    return { reviewResult: parseOpenAiReview(reply), reply };
  } catch (err) {
    parseError = err;
    run.validationErrors.push(
      `Failed to parse OpenAI-compatible review: ${errorMessage(err)}`
    );
    core.warning(
      `OpenAI-compatible review was not valid JSON; requesting a repair: ${err}`
    );
  }
  const repaired = await repairTurn(
    run.conv,
    buildJsonRepairPrompt(reply, parseError)
  );
  if (!repaired) return null;
  run.rawResponses.push(repaired);
  try {
    return { reviewResult: parseOpenAiReview(repaired), reply: repaired };
  } catch (repairErr) {
    run.validationErrors.push(
      `Failed to parse repaired OpenAI-compatible review: ${errorMessage(repairErr)}`
    );
    return {
      reviewResult: unparseableReview(),
      reply: repaired,
      unparseable: true,
    };
  }
}

function unparseableReview(): ReviewResult {
  return {
    summary:
      "The OpenAI-compatible reviewer returned a response that could not be parsed after one repair attempt. No valid code review comments are present.",
    verdict: "comment",
    resolvedCommentIds: [],
    newComments: [],
  };
}

/**
 * Fix comment-shape problems (broken suggestion fences and the like) with
 * one formatting repair turn. A revision that parses cleanly and passes the
 * format checks replaces the review; anything else is recorded and the
 * original review stands.
 */
async function formatRepairStage(
  run: ReviewRun,
  reviewResult: ReviewResult,
  onRevised: (reply: string) => void
): Promise<ReviewResult> {
  const formatIssues = findReviewFormatIssues(reviewResult);
  if (formatIssues.length === 0) return reviewResult;
  run.validationErrors.push(...formatIssues);
  const revised = await repairTurn(
    run.conv,
    buildFormatRepairPrompt(reviewResult, formatIssues)
  );
  if (!revised) return reviewResult;
  run.rawResponses.push(revised);
  try {
    const revisedResult = parseOpenAiReview(revised);
    const remaining = findReviewFormatIssues(revisedResult);
    if (remaining.length > 0) {
      run.validationErrors.push(...remaining);
      return reviewResult;
    }
    onRevised(revised);
    return revisedResult;
  } catch (err) {
    run.validationErrors.push(
      `Failed to parse formatting revision: ${errorMessage(err)}`
    );
    return reviewResult;
  }
}

/**
 * Check the review against the diff (comment lines must be changed lines)
 * and give the model one chance to correct misplaced comments.
 */
async function verificationStage(
  run: ReviewRun,
  reply: string,
  verificationContext: VerificationContext,
  reviewResult: ReviewResult
): Promise<ReviewResult> {
  const verified = await requestValidationRepair(
    run.conv,
    reply,
    verificationContext
  );
  if (!verified) return reviewResult;
  run.rawResponses.push(verified.reply);
  run.validationErrors.push(...verified.validationErrors);
  return verified.reviewResult;
}

async function requestValidationRepair(
  conv: OpenAiConversation,
  reply: string,
  verificationContext: VerificationContext
): Promise<{
  reviewResult: ReviewResult;
  reply: string;
  validationErrors: string[];
} | null> {
  let structured;
  try {
    structured = parseJulesReview(reply);
  } catch {
    return null;
  }
  const issues = verifyJulesReview(structured, verificationContext);
  if (issues.length === 0) return null;
  const revised = await repairTurn(
    conv,
    buildReviewRepairPrompt(reply, issues)
  );
  if (!revised) return null;
  const validationErrors = issues.map(
    (issue) => `${issue.kind}: ${issue.message}`
  );
  try {
    const review = parseJulesReview(revised);
    const remaining = verifyJulesReview(review, verificationContext);
    if (remaining.length > 0) {
      validationErrors.push(
        ...remaining.map((issue) => `${issue.kind}: ${issue.message}`)
      );
    }
    // A revision that parsed is the review we have, even if a location is
    // still off: dropping it would publish the comment the repair was asked
    // to fix. Remaining issues stay on the artifact.
    return {
      reviewResult: parseOpenAiReview(revised),
      reply: revised,
      validationErrors,
    };
  } catch (err) {
    validationErrors.push(
      `Failed to parse validation revision: ${errorMessage(err)}`
    );
    return {
      reviewResult: convertStructuredReview(structured),
      reply,
      validationErrors,
    };
  }
}

function finish(
  run: ReviewRun,
  reviewResult: ReviewResult | null
): OpenAiReviewRunResult {
  return {
    reviewResult,
    sessionId: run.sessionId,
    ...(run.rawResponses.length > 0 ? { rawResponses: run.rawResponses } : {}),
    ...(run.validationErrors.length > 0
      ? { validationErrors: run.validationErrors }
      : {}),
  };
}
