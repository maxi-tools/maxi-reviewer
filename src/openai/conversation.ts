import * as core from "@actions/core";
import { ReviewProgress } from "../review-heartbeat.js";
import {
  errorMessage,
  OpenAiCompletionRequest,
  OpenAiMessage,
  OpenAiReviewConfig,
  OpenAiTimeoutError,
} from "./client.js";

/**
 * The dependencies every stage of the review run shares: how to complete a
 * turn, the endpoint configuration, the conversation so far, and the
 * optional progress heartbeat.
 */
export interface OpenAiConversation {
  complete: (request: OpenAiCompletionRequest) => Promise<string>;
  config: OpenAiReviewConfig;
  messages: OpenAiMessage[];
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
}

/**
 * One user-less turn: send the conversation, append the assistant reply.
 */
export async function turn(conv: OpenAiConversation): Promise<string> {
  await notify(conv.onProgress, false);
  const content = await conv.complete({
    ...conv.config,
    messages: conv.messages,
  });
  conv.messages.push({ role: "assistant", content });
  await notify(conv.onProgress, true);
  return content;
}

/**
 * A turn initiated by a fresh user message (repair prompt, retrieval
 * follow-up). A timeout is a soft failure — the caller keeps whatever reply
 * it already had — so it resolves to `null` rather than throwing.
 */
export async function repairTurn(
  conv: OpenAiConversation,
  repairPrompt: string
): Promise<string | null> {
  conv.messages.push({ role: "user", content: repairPrompt });
  try {
    return await turn(conv);
  } catch (err) {
    if (err instanceof OpenAiTimeoutError) {
      core.warning(`OpenAI-compatible repair timed out: ${err.message}`);
      return null;
    }
    throw err;
  }
}

export async function notify(
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
