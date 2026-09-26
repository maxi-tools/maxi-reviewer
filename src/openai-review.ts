import * as core from "@actions/core";
import { holdBlockToItsEvidence } from "./evidence.js";
import {
  buildFormatRepairPrompt,
  buildJsonRepairPrompt,
  findReviewFormatIssues,
} from "./format.js";
import { ReviewProgress } from "./review-heartbeat.js";
import {
  formatInvalidRetrievalRequest,
  formatRetrievalResults,
  parseRetrievalRequest,
  RetrievalProvider,
  RetrievalResult,
} from "./retrieval.js";
import { ReviewResult } from "./types.js";
import {
  buildReviewRepairPrompt,
  parseJulesReview,
  VerificationContext,
  verifyJulesReview,
} from "./verify-format.js";

/**
 * Which model produces the review.
 *
 * `jules` is the historical default. `openai` is any OpenAI-compatible
 * chat-completions endpoint — the intended target is Qwen3-Coder served by
 * vLLM on the DGX Sparks (jasper, pearl, peridot), but the client does not
 * know that. It only knows a base URL.
 */
export type ReviewerBackend = "jules" | "openai";

export const DEFAULT_OPENAI_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";

/**
 * Fallback budget when the caller did not set one. A local vLLM reply is
 * seconds, not the 15-25 minutes Jules takes, so a Jules-sized wait here
 * would hide a dead endpoint behind a long silence.
 */
export const DEFAULT_OPENAI_TIMEOUT_MINUTES = 8;

export interface OpenAiReviewConfig {
  /** Origin plus optional `/v1`, with no trailing slash and no route. */
  baseUrl: string;
  /** Bearer token. Omitted from the request when unset (vLLM `--api-key` off). */
  apiKey?: string;
  model: string;
  timeoutMinutes: number;
}

export interface RunOpenAiReviewOptions {
  verificationContext?: VerificationContext;
  retrieval?: {
    provider: RetrievalProvider;
    maxSteps: number;
    nonce: string;
  };
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
  /** Test seam. Production uses {@link completeOpenAiChat}. */
  complete?: (request: OpenAiCompletionRequest) => Promise<string>;
}

export interface OpenAiCompletionRequest extends OpenAiReviewConfig {
  messages: OpenAiMessage[];
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiReviewRunResult {
  reviewResult: ReviewResult | null;
  sessionId: string;
  rawResponses?: string[];
  validationErrors?: string[];
}

/**
 * A turn that produced no body because the budget ran out.
 *
 * Distinct from an HTTP error: the caller of {@link runOpenAiReview} turns
 * this into "no review" so a dead Spark does not fail the whole job before
 * the Jules path, or a configured fallback, has been considered.
 */
export class OpenAiTimeoutError extends Error {
  constructor(timeoutMinutes: number) {
    super(
      `OpenAI-compatible review produced no reply within ${timeoutMinutes} minutes.`
    );
    this.name = "OpenAiTimeoutError";
  }
}

export function parseReviewerBackend(raw: string | undefined): ReviewerBackend {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "jules") return "jules";
  // `qwen` is the roster name operators will actually type. The wire protocol
  // is OpenAI-compatible either way.
  if (value === "openai" || value === "openai-compatible" || value === "qwen") {
    return "openai";
  }
  throw new Error(
    `Invalid reviewer_backend: "${raw}". Must be one of: jules, openai.`
  );
}

/**
 * True when a fallback endpoint is configured, even if the primary backend
 * is still Jules. An empty base URL means "no fallback", not "call localhost".
 */
export function openAiFallbackConfigured(
  getInput: (name: string) => string
): boolean {
  return getInput("openai_base_url").trim() !== "";
}

export function resolveOpenAiReviewConfig(
  getInput: (name: string) => string,
  julesTimeoutMinutes: number
): OpenAiReviewConfig {
  const baseUrl = normalizeBaseUrl(getInput("openai_base_url"));
  if (!baseUrl) {
    throw new Error(
      "openai_base_url is required when reviewer_backend is openai " +
        "(or when it is the configured Jules-timeout fallback). " +
        "Point it at the vLLM OpenAI server, e.g. http://jasper:8000/v1."
    );
  }
  const model = getInput("openai_model").trim() || DEFAULT_OPENAI_MODEL;
  const key = getInput("openai_api_key").trim();
  const requested = parsePositiveInt(getInput("openai_timeout_minutes"));
  // Never wait longer than the review the caller already budgeted. A fallback
  // that outlives the Jules budget it is replacing holds the runner for a
  // second full review after the first one already failed to arrive.
  const timeoutMinutes = Math.min(
    requested ?? DEFAULT_OPENAI_TIMEOUT_MINUTES,
    Math.max(1, julesTimeoutMinutes)
  );
  return {
    baseUrl,
    ...(key ? { apiKey: key } : {}),
    model,
    timeoutMinutes,
  };
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

/**
 * One chat-completions turn.
 *
 * Uses `fetch` rather than an SDK: the Spark serves the OpenAI wire shape
 * through vLLM, and an SDK would pin us to one vendor's client while the
 * point of this backend is that any compatible server will do.
 */
export async function completeOpenAiChat(
  request: OpenAiCompletionRequest
): Promise<string> {
  const timeoutMs = request.timeoutMinutes * 60 * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`;
    let response: Response;
    try {
      response = await fetch(`${request.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: request.model,
          temperature: 0,
          messages: request.messages,
        }),
      });
    } catch (err) {
      if (isAbortError(err))
        throw new OpenAiTimeoutError(request.timeoutMinutes);
      throw new Error(
        `OpenAI-compatible review request failed: ${errorMessage(err)}`,
        { cause: err }
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenAI-compatible review endpoint returned ${response.status}` +
          (body ? `: ${body.slice(0, 300)}` : ".")
      );
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(
        "OpenAI-compatible review endpoint returned no assistant message."
      );
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError")
  );
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
  const complete = options.complete ?? completeOpenAiChat;
  const messages: OpenAiMessage[] = [{ role: "user", content: prompt }];
  const rawResponses: string[] = [];
  const validationErrors: string[] = [];
  const sessionId = `openai:${config.model}`;

  let reply: string;
  try {
    reply = await turn(complete, config, messages, options.onProgress);
  } catch (err) {
    if (err instanceof OpenAiTimeoutError) {
      core.warning(err.message);
      return {
        reviewResult: null,
        sessionId: `openai:timeout:${config.model}`,
      };
    }
    throw err;
  }
  rawResponses.push(reply);

  if (options.retrieval) {
    reply = await runRetrievalLoop({
      complete,
      config,
      messages,
      firstReply: reply,
      retrieval: options.retrieval,
      onProgress: options.onProgress,
    });
    if (reply !== rawResponses[rawResponses.length - 1]) {
      rawResponses.push(reply);
    }
  }

  let reviewResult: ReviewResult;
  try {
    reviewResult = parseOpenAiReview(reply);
  } catch (err) {
    validationErrors.push(
      `Failed to parse OpenAI-compatible review: ${errorMessage(err)}`
    );
    core.warning(
      `OpenAI-compatible review was not valid JSON; requesting a repair: ${err}`
    );
    const repaired = await repairTurn(
      complete,
      config,
      messages,
      buildJsonRepairPrompt(reply, err),
      options.onProgress
    );
    if (!repaired) {
      return {
        reviewResult: null,
        sessionId,
        rawResponses,
        validationErrors,
      };
    }
    rawResponses.push(repaired);
    try {
      reviewResult = parseOpenAiReview(repaired);
      reply = repaired;
    } catch (repairErr) {
      validationErrors.push(
        `Failed to parse repaired OpenAI-compatible review: ${errorMessage(repairErr)}`
      );
      return {
        reviewResult: {
          summary:
            "The OpenAI-compatible reviewer returned a response that could not be parsed after one repair attempt. No valid code review comments are present.",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId,
        rawResponses,
        validationErrors,
      };
    }
  }

  const formatIssues = findReviewFormatIssues(reviewResult);
  if (formatIssues.length > 0) {
    validationErrors.push(...formatIssues);
    const revised = await repairTurn(
      complete,
      config,
      messages,
      buildFormatRepairPrompt(reviewResult, formatIssues),
      options.onProgress
    );
    if (revised) {
      rawResponses.push(revised);
      try {
        const revisedResult = parseOpenAiReview(revised);
        const remaining = findReviewFormatIssues(revisedResult);
        if (remaining.length === 0) {
          reviewResult = revisedResult;
          reply = revised;
        } else {
          validationErrors.push(...remaining);
        }
      } catch (err) {
        validationErrors.push(
          `Failed to parse formatting revision: ${errorMessage(err)}`
        );
      }
    }
  }

  if (options.verificationContext) {
    const verified = await requestValidationRepair({
      complete,
      config,
      messages,
      reply,
      verificationContext: options.verificationContext,
      onProgress: options.onProgress,
    });
    if (verified) {
      reviewResult = verified.reviewResult;
      rawResponses.push(verified.reply);
      validationErrors.push(...verified.validationErrors);
    }
  }

  const evidence = holdBlockToItsEvidence(reviewResult);
  reviewResult = evidence.review;
  validationErrors.push(...evidence.issues);

  return {
    reviewResult,
    sessionId,
    ...(rawResponses.length > 0 ? { rawResponses } : {}),
    ...(validationErrors.length > 0 ? { validationErrors } : {}),
  };
}

async function turn(
  complete: (request: OpenAiCompletionRequest) => Promise<string>,
  config: OpenAiReviewConfig,
  messages: OpenAiMessage[],
  onProgress?: (progress: ReviewProgress) => void | Promise<void>
): Promise<string> {
  await notify(onProgress, false);
  const content = await complete({ ...config, messages });
  messages.push({ role: "assistant", content });
  await notify(onProgress, true);
  return content;
}

async function repairTurn(
  complete: (request: OpenAiCompletionRequest) => Promise<string>,
  config: OpenAiReviewConfig,
  messages: OpenAiMessage[],
  repairPrompt: string,
  onProgress?: (progress: ReviewProgress) => void | Promise<void>
): Promise<string | null> {
  messages.push({ role: "user", content: repairPrompt });
  try {
    return await turn(complete, config, messages, onProgress);
  } catch (err) {
    if (err instanceof OpenAiTimeoutError) {
      core.warning(`OpenAI-compatible repair timed out: ${err.message}`);
      return null;
    }
    throw err;
  }
}

async function runRetrievalLoop(input: {
  complete: (request: OpenAiCompletionRequest) => Promise<string>;
  config: OpenAiReviewConfig;
  messages: OpenAiMessage[];
  firstReply: string;
  retrieval: { provider: RetrievalProvider; maxSteps: number; nonce: string };
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
}): Promise<string> {
  const { complete, config, messages, retrieval, onProgress } = input;
  let message = input.firstReply;
  for (let step = 0; step < retrieval.maxSteps; step++) {
    const parsed = parseRetrievalRequest(message);
    if (parsed.kind === "none") return message;
    const roundsLeft = retrieval.maxSteps - step - 1;
    const followUp =
      parsed.kind === "invalid"
        ? formatInvalidRetrievalRequest(
            retrieval.nonce,
            parsed.errors,
            roundsLeft
          )
        : await fulfilAndFormat(retrieval, parsed.request.requests, roundsLeft);
    const next = await repairTurn(
      complete,
      config,
      messages,
      followUp,
      onProgress
    );
    if (!next) return message;
    message = next;
  }
  if (parseRetrievalRequest(message).kind !== "none") {
    const finalMessage = await repairTurn(
      complete,
      config,
      messages,
      formatRetrievalResults(retrieval.nonce, [], 0),
      onProgress
    );
    if (finalMessage) return finalMessage;
  }
  return message;
}

async function fulfilAndFormat(
  retrieval: { provider: RetrievalProvider; nonce: string },
  requests: Parameters<RetrievalProvider["fulfill"]>[0][],
  roundsLeft: number
): Promise<string> {
  const results: RetrievalResult[] = [];
  for (const request of requests) {
    try {
      results.push(await retrieval.provider.fulfill(request));
    } catch (err) {
      results.push({
        tool: request.tool,
        ok: false,
        error: errorMessage(err),
      });
    }
  }
  return formatRetrievalResults(retrieval.nonce, results, roundsLeft);
}

async function requestValidationRepair(input: {
  complete: (request: OpenAiCompletionRequest) => Promise<string>;
  config: OpenAiReviewConfig;
  messages: OpenAiMessage[];
  reply: string;
  verificationContext: VerificationContext;
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
}): Promise<{
  reviewResult: ReviewResult;
  reply: string;
  validationErrors: string[];
} | null> {
  let structured;
  try {
    structured = parseJulesReview(input.reply);
  } catch {
    return null;
  }
  const issues = verifyJulesReview(structured, input.verificationContext);
  if (issues.length === 0) return null;
  const revised = await repairTurn(
    input.complete,
    input.config,
    input.messages,
    buildReviewRepairPrompt(input.reply, issues),
    input.onProgress
  );
  if (!revised) return null;
  const validationErrors = issues.map(
    (issue) => `${issue.kind}: ${issue.message}`
  );
  try {
    const review = parseJulesReview(revised);
    const remaining = verifyJulesReview(review, input.verificationContext);
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
      reply: input.reply,
      validationErrors,
    };
  }
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

function convertStructuredReview(review: {
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
}): ReviewResult {
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

async function notify(
  onProgress: ((progress: ReviewProgress) => void | Promise<void>) | undefined,
  sawAgentOutput: boolean
): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress({ sawAgentOutput });
  } catch (err) {
    core.info(`Could not publish OpenAI review progress: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
