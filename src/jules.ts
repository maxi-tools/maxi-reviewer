import * as core from "@actions/core";
import { jules } from "@google/jules-sdk";
import { ReviewResult } from "./types.js";
import {
  buildFormatRepairPrompt,
  buildJsonRepairPrompt,
  findReviewFormatIssues,
} from "./format.js";
import { parseJulesReview } from "./verify-format.js";

interface JulesSession {
  id: string;
  info: () => Promise<unknown>;
  hydrate: () => Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  history: () => AsyncIterable<any>;
  prompt?: (message: string) => Promise<unknown>;
  message?: (message: string) => Promise<unknown>;
  sendMessage?: (message: string) => Promise<unknown>;
  send?: (message: string) => Promise<unknown>;
}

export async function runJulesReview(
  apiKey: string,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any,
  timeoutMinutes: number
): Promise<{ reviewResult: ReviewResult | null; sessionId: string }> {
  const customJules = jules.with({ apiKey });

  core.info("Creating Jules review session…");

  const rawSession = await customJules.session({
    prompt,
    source,
    requireApproval: false,
    autoPr: false,
  });
  const session = rawSession as unknown as JulesSession;
  core.info(`Jules session: ${session.id}`);

  await waitUntilSessionReady(session);

  const reviewMessage = await pollForReview(
    session,
    timeoutMinutes * 60 * 1000
  );
  core.info(`Collected review (${reviewMessage.length} chars)`);

  if (!reviewMessage) {
    return { reviewResult: null, sessionId: session.id };
  }

  let latestReviewMessage = reviewMessage;
  let reviewResult: ReviewResult;
  try {
    reviewResult = parseJulesResponse(latestReviewMessage);
  } catch (err) {
    core.warning(
      `Failed to parse Jules response; requesting same-session JSON repair: ${err}`
    );
    await sendSessionMessage(
      session,
      buildJsonRepairPrompt(reviewMessage, err)
    );
    const repairedMessage = await pollForReview(
      session,
      timeoutMinutes * 60 * 1000,
      reviewMessage
    );
    try {
      reviewResult = parseJulesResponse(repairedMessage);
      latestReviewMessage = repairedMessage;
    } catch (repairErr) {
      core.error(`Failed to parse repaired Jules response: ${repairErr}`);
      return {
        reviewResult: {
          summary:
            "Jules returned an invalid response that could not be parsed after a same-session repair attempt. No valid code review comments are present.",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: session.id,
      };
    }
  }

  const formatIssues = findReviewFormatIssues(reviewResult);
  if (formatIssues.length > 0) {
    core.warning(
      `Jules response has ${formatIssues.length} suggested-change formatting issue(s); requesting a same-session revision.`
    );
    await sendSessionMessage(
      session,
      buildFormatRepairPrompt(reviewResult, formatIssues)
    );
    const revisedMessage = await pollForReview(
      session,
      timeoutMinutes * 60 * 1000,
      latestReviewMessage
    );
    if (revisedMessage) {
      try {
        const revisedResult = parseJulesResponse(revisedMessage);
        const remainingIssues = findReviewFormatIssues(revisedResult);
        if (remainingIssues.length > 0) {
          core.warning(
            `Jules revised response still has suggested-change formatting issue(s): ${remainingIssues.join(" ")}`
          );
        } else {
          reviewResult = revisedResult;
          latestReviewMessage = revisedMessage;
        }
      } catch (revisionErr) {
        core.warning(
          `Failed to parse Jules formatting revision; keeping previous parsed review result: ${revisionErr}`
        );
      }
    }
  }

  return { reviewResult, sessionId: session.id };
}

function parseJulesResponse(message: string): ReviewResult {
  try {
    return convertStructuredReview(parseJulesReview(message));
  } catch {
    // Fall back to the legacy Jules response shape while callers migrate.
  }

  const jsonMatch = message.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]) as ReviewResult;
    } catch {
      // fallback
    }
  }
  // Try parsing the whole message if no codeblocks
  try {
    return JSON.parse(message) as ReviewResult;
  } catch (e) {
    throw new Error("Failed to parse Jules response as JSON", { cause: e });
  }
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
    promptForAgents?: string;
    suggestion?: { replacement: string };
  }>;
}): ReviewResult {
  return {
    summary: review.summary,
    verdict: review.verdict,
    resolvedCommentIds: review.resolvedCommentIds,
    newComments: review.comments.map((comment) => ({
      file: comment.path,
      line: comment.line,
      startLine: comment.startLine,
      endLine: comment.endLine,
      severity: comment.severity,
      confidence: comment.confidence,
      message: comment.message,
      promptForAgents: comment.promptForAgents ?? "",
      suggestedReplacement: comment.suggestion?.replacement,
    })),
  };
}

async function waitUntilSessionReady(session: {
  id: string;
  info: () => Promise<unknown>;
}): Promise<void> {
  const maxAttempts = 20;
  let delay = 2000;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await session.info();
      core.info(`Session ${session.id} is ready after ${i + 1} attempt(s).`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(
          `Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`,
          { cause: err }
        );
      }
      if (!msg.includes("404")) {
        throw new Error(`Jules session.info() failed: ${msg}`, { cause: err });
      }
      core.info(`Session not yet ready (attempt ${i + 1}/${maxAttempts})…`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15000);
    }
  }
  throw new Error("Session did not become ready within timeout.");
}

async function pollForReview(
  session: JulesSession,
  timeoutMs: number,
  afterMessage?: string
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      await session.hydrate();
      let last = "";
      for await (const a of session.history()) {
        if (a.type === "agentMessaged") last = a.message;
      }
      if (last) {
        if (afterMessage !== undefined && last === afterMessage) {
          core.info(`Latest agentMessaged is unchanged (attempt ${attempt})…`);
        } else {
          core.info(`Got agentMessaged on attempt ${attempt}.`);
          return last;
        }
      }
      core.info(`No agentMessaged yet (attempt ${attempt})…`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthError(msg)) {
        throw new Error(
          `Jules API rejected request (${msg}). Check JULES_API_KEY is valid.`,
          { cause: err }
        );
      }
      core.info(`hydrate/history error (attempt ${attempt}): ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  return "";
}

async function sendSessionMessage(
  session: JulesSession,
  message: string
): Promise<void> {
  const send =
    session.prompt || session.message || session.sendMessage || session.send;
  if (!send) {
    throw new Error(
      "Jules session does not expose a same-session message method for review repair."
    );
  }
  await send.call(session, message);
}

export function isAuthError(msg: string): boolean {
  return /\b(?:401|403)\b/.test(msg);
}

export function wrapPermissionError(
  err: unknown,
  needed: string,
  op: string
): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (isAuthError(msg) || msg.includes("Resource not accessible")) {
    return new Error(
      `${op} failed with 403. The github_token likely lacks ${needed}. Add to your workflow:\n` +
        "    permissions:\n      pull-requests: write\n      contents: read\n      statuses: write\n" +
        `(original: ${msg})`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}
