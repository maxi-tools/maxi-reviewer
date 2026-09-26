/**
 * Public surface of the OpenAI-compatible reviewer backend.
 *
 * The implementation lives in cohesive modules under `./openai/`:
 * `client.ts` (endpoint configuration and the chat-completions transport),
 * `conversation.ts` (turn and repair-turn plumbing), `retrieval-loop.ts`
 * (mid-review repository context requests), `parse.ts` (reply parsing), and
 * `run.ts` (the review orchestration that ties them together). This barrel
 * keeps the historical `./openai-review.js` import path stable.
 */
export {
  completeOpenAiChat,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_TIMEOUT_MINUTES,
  openAiFallbackConfigured,
  OpenAiTimeoutError,
  parseReviewerBackend,
  resolveOpenAiReviewConfig,
  type OpenAiCompletionRequest,
  type OpenAiMessage,
  type OpenAiReviewConfig,
  type OpenAiReviewRunResult,
  type ReviewerBackend,
  type RunOpenAiReviewOptions,
} from "./openai/client.js";
export { parseOpenAiReview } from "./openai/parse.js";
export { runOpenAiReview } from "./openai/run.js";
