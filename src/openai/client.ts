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
  return resolveOpenAiFallbackConfigs(getInput).length > 0;
}

/**
 * The ordered list of fallback endpoints to try, in turn, when the primary
 * reviewer (Jules) returns no review.
 *
 * The primary endpoint is the legacy `openai_base_url` slot, preserved verbatim
 * so an existing workflow that sets just that input keeps working. A second
 * `openai_fallback_*` triple slots in after it and is tried only when the
 * first returns nothing. The org already pays for both, per
 * maxi-config#1028; without the second slot, a single downed Spark strands
 * every PR whose Jules session was silent for 15 minutes.
 *
 * An entry whose URL is empty is skipped, so a workflow that does not want
 * the second endpoint just leaves the input blank; one whose URL parses but
 * whose key/model inputs are empty uses the same defaults as the primary.
 */
export function resolveOpenAiFallbackConfigs(
  getInput: (name: string) => string,
  julesTimeoutMinutes: number = 0
): OpenAiReviewConfig[] {
  const slots: Array<{
    baseUrl: string;
    apiKey: string;
    model: string;
  }> = [
    {
      baseUrl: normalizeBaseUrl(getInput("openai_base_url")),
      apiKey: getInput("openai_api_key").trim(),
      model: getInput("openai_model").trim() || DEFAULT_OPENAI_MODEL,
    },
    {
      baseUrl: normalizeBaseUrl(getInput("openai_fallback_base_url")),
      apiKey: getInput("openai_fallback_api_key").trim(),
      model: getInput("openai_fallback_model").trim() || DEFAULT_OPENAI_MODEL,
    },
  ];
  const configured = slots.filter((slot) => slot.baseUrl !== "");
  // Cap each attempt at jules_budget / N so the full chain fits inside the
  // hard wall-clock deadline (timeout_minutes + 20, the default headroom).
  // With the per-endpoint cap at julesTimeoutMinutes alone, N endpoints could
  // consume N * julesTimeoutMinutes and exceed the hard deadline mid-chain,
  // stranding the PR. See PR #182 review thread PRRT_kwDOTFepzM6o8Onb.
  const timeoutMinutes = resolveTimeoutMinutes(
    getInput,
    julesTimeoutMinutes,
    configured.length
  );
  return configured.map((slot) => {
    const config: OpenAiReviewConfig = {
      baseUrl: slot.baseUrl,
      model: slot.model,
      timeoutMinutes,
    };
    if (slot.apiKey) config.apiKey = slot.apiKey;
    return config;
  });
}

function resolveTimeoutMinutes(
  getInput: (name: string) => string,
  julesTimeoutMinutes: number,
  configuredCount: number
): number {
  const requested = parsePositiveInt(getInput("openai_timeout_minutes"));
  // Per-attempt cap is the Jules budget divided by the number of fallback
  // endpoints so the chain as a whole never outruns the caller's wall-clock
  // budget. A chain of N endpoints each capped at the full Jules budget
  // could consume N * julesTimeoutMinutes, which can exceed the hard
  // deadline (julesTimeoutMinutes + 20 by default).
  const safeCount = Math.max(1, configuredCount);
  const capPerAttempt = Math.max(
    1,
    Math.floor(julesTimeoutMinutes / safeCount)
  );
  return Math.min(requested ?? DEFAULT_OPENAI_TIMEOUT_MINUTES, capPerAttempt);
}

/**
 * @deprecated Kept for callers that still expect a single OpenAI-compatible
 * config. New code should iterate {@link resolveOpenAiFallbackConfigs} so the
 * fallback chain is honoured. Returns the first configured entry, or throws
 * when nothing is configured.
 */
export function resolveOpenAiReviewConfig(
  getInput: (name: string) => string,
  julesTimeoutMinutes: number
): OpenAiReviewConfig {
  const configs = resolveOpenAiFallbackConfigs(getInput, julesTimeoutMinutes);
  const first = configs[0];
  if (!first) {
    throw new Error(
      "openai_base_url is required when reviewer_backend is openai " +
        "(or when it is the configured Jules-timeout fallback). " +
        "Point it at the vLLM OpenAI server, e.g. http://jasper:8000/v1."
    );
  }
  return first;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Count of fallback endpoints currently configured. Used to render the
 * reviewer-unavailable status description ("Reviewer unavailable: 2
 * fallback endpoint(s) failed..."). Reads inputs through the standard
 * `core.getInput` so it picks up the same overrides the rest of the chain
 * resolver sees.
 */
export function countOpenAiFallbackConfigs(
  getInput: (name: string) => string
): number {
  return resolveOpenAiFallbackConfigs(getInput).length;
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
