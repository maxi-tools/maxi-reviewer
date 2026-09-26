import { ReviewProgress } from "../review-heartbeat.js";
import { RetrievalProvider } from "../retrieval.js";
import { VerificationContext } from "../verify-format.js";
import { ReviewResult } from "../types.js";

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
 * Distinct from an HTTP error: the caller of the review run turns this into
 * "no review" so a dead Spark does not fail the whole job before the Jules
 * path, or a configured fallback, has been considered.
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
