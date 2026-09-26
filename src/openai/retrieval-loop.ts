import {
  formatInvalidRetrievalRequest,
  formatRetrievalResults,
  parseRetrievalRequest,
  RetrievalProvider,
  RetrievalResult,
} from "../retrieval.js";
import { errorMessage } from "./client.js";
import { OpenAiConversation, repairTurn } from "./conversation.js";

export interface RetrievalLoopOptions {
  provider: RetrievalProvider;
  maxSteps: number;
  nonce: string;
}

/**
 * Let the model ask for repository context mid-review. Each assistant reply
 * is checked for a retrieval request; fulfilled results (or the reason the
 * request was rejected) go back as the next user message. Returns the last
 * assistant reply — the one the caller should parse as the review.
 */
export async function runRetrievalLoop(
  conv: OpenAiConversation,
  firstReply: string,
  retrieval: RetrievalLoopOptions
): Promise<string> {
  let message = firstReply;
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
    const next = await repairTurn(conv, followUp);
    if (!next) return message;
    message = next;
  }
  return nudgeForVerdict(conv, message, retrieval);
}

/**
 * The budget ran out while the model was still asking for context. Send one
 * final empty result set so it has to answer with the review itself.
 */
async function nudgeForVerdict(
  conv: OpenAiConversation,
  message: string,
  retrieval: RetrievalLoopOptions
): Promise<string> {
  if (parseRetrievalRequest(message).kind === "none") return message;
  const finalMessage = await repairTurn(
    conv,
    formatRetrievalResults(retrieval.nonce, [], 0)
  );
  return finalMessage ?? message;
}

async function fulfilAndFormat(
  retrieval: RetrievalLoopOptions,
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
