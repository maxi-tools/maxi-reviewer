import * as core from "@actions/core";
import { jules } from "@google/jules-sdk";
import { ReviewResult } from "./types.js";
import {
  buildFormatRepairPrompt,
  buildJsonRepairPrompt,
  findReviewFormatIssues,
} from "./format.js";
import {
  buildReviewRepairPrompt,
  parseJulesReview,
  VerificationContext,
  verifyJulesReview,
} from "./verify-format.js";

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

interface JulesSessionClient {
  session(config: {
    prompt: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source?: any;
    requireApproval: false;
    autoPr: false;
  }): Promise<unknown>;
  session(id: string): unknown;
}

export interface RunJulesReviewOptions {
  verificationContext?: VerificationContext;
  previousSessionId?: string;
}

export async function runJulesReview(
  apiKey: string,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any,
  timeoutMinutes: number,
  options: RunJulesReviewOptions = {}
): Promise<{
  reviewResult: ReviewResult | null;
  sessionId: string;
  rawResponses?: string[];
  validationErrors?: string[];
}> {
  const customJules = jules.with({ apiKey }) as JulesSessionClient;

  const { session, afterMessage } = await startReviewSession(
    customJules,
    prompt,
    source,
    options.previousSessionId
  );
  core.info(`Jules session: ${session.id}`);

  if (!afterMessage) {
    await waitUntilSessionReady(session);
  }

  const reviewMessage = await pollForReview(
    session,
    timeoutMinutes * 60 * 1000,
    afterMessage
  );
  core.info(`Collected review (${reviewMessage.length} chars)`);

  if (!reviewMessage) {
    return { reviewResult: null, sessionId: session.id };
  }

  let latestReviewMessage = reviewMessage;
  const rawResponses = [reviewMessage];
  const validationErrors: string[] = [];
  let reviewResult: ReviewResult;
  try {
    reviewResult = parseJulesResponse(latestReviewMessage);
  } catch (err) {
    validationErrors.push(
      `Failed to parse Jules response: ${errorMessage(err)}`
    );
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
    rawResponses.push(repairedMessage);
    try {
      reviewResult = parseJulesResponse(repairedMessage);
      latestReviewMessage = repairedMessage;
    } catch (repairErr) {
      validationErrors.push(
        `Failed to parse repaired Jules response: ${errorMessage(repairErr)}`
      );
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
        rawResponses,
        validationErrors,
      };
    }
  }

  const formatIssues = findReviewFormatIssues(reviewResult);
  if (formatIssues.length > 0) {
    validationErrors.push(...formatIssues);
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
      rawResponses.push(revisedMessage);
      try {
        const revisedResult = parseJulesResponse(revisedMessage);
        const remainingIssues = findReviewFormatIssues(revisedResult);
        if (remainingIssues.length > 0) {
          validationErrors.push(...remainingIssues);
          core.warning(
            `Jules revised response still has suggested-change formatting issue(s): ${remainingIssues.join(" ")}`
          );
        } else {
          reviewResult = revisedResult;
          latestReviewMessage = revisedMessage;
        }
      } catch (revisionErr) {
        validationErrors.push(
          `Failed to parse Jules formatting revision: ${errorMessage(revisionErr)}`
        );
        core.warning(
          `Failed to parse Jules formatting revision; keeping previous parsed review result: ${revisionErr}`
        );
      }
    }
  }

  if (options.verificationContext) {
    const verified = await requestStructuredValidationRepair({
      session,
      latestReviewMessage,
      timeoutMinutes,
      verificationContext: options.verificationContext,
    });
    if (verified) {
      reviewResult = verified.reviewResult;
      rawResponses.push(verified.latestReviewMessage);
      validationErrors.push(...verified.validationErrors);
    }
  }

  return {
    reviewResult,
    sessionId: session.id,
    ...(rawResponses.length > 1 ? { rawResponses } : {}),
    ...(validationErrors.length > 0 ? { validationErrors } : {}),
  };
}

async function startReviewSession(
  customJules: JulesSessionClient,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any,
  previousSessionId?: string
): Promise<{ session: JulesSession; afterMessage?: string }> {
  if (previousSessionId) {
    try {
      core.info(`Continuing Jules review session ${previousSessionId}…`);
      const session = customJules.session(previousSessionId) as JulesSession;
      await session.info();
      const afterMessage = await latestAgentMessage(session);
      await sendSessionMessage(session, prompt);
      return { session, afterMessage };
    } catch (err) {
      core.warning(
        `Could not continue Jules session ${previousSessionId}; starting a new review session: ${String(err)}`
      );
    }
  }

  core.info("Creating Jules review session…");
  const rawSession = await createReviewSession(customJules, prompt, source);
  return { session: rawSession as unknown as JulesSession };
}

async function createReviewSession(
  customJules: JulesSessionClient,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any
): Promise<unknown> {
  try {
    return await customJules.session({
      prompt,
      source,
      requireApproval: false,
      autoPr: false,
    });
  } catch (err) {
    if (!isSourceNotFoundError(err) || source === undefined) {
      throw err;
    }
    core.warning(
      `Jules could not access source ${formatJulesSource(source)}; retrying review without source context.`
    );
    return customJules.session({
      prompt,
      requireApproval: false,
      autoPr: false,
    });
  }
}

async function latestAgentMessage(session: JulesSession): Promise<string> {
  await session.hydrate();
  let last = "";
  for await (const activity of session.history()) {
    if (activity.type === "agentMessaged") {
      last = activity.message;
    }
  }
  return last;
}

function isSourceNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /^Could not get source /.test(err.message);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatJulesSource(source: any): string {
  if (source && typeof source.github === "string") {
    return source.github;
  }
  return "configured for this review";
}

async function requestStructuredValidationRepair(input: {
  session: JulesSession;
  latestReviewMessage: string;
  timeoutMinutes: number;
  verificationContext: VerificationContext;
}): Promise<{
  reviewResult: ReviewResult;
  latestReviewMessage: string;
  validationErrors: string[];
} | null> {
  let structuredReview;
  try {
    structuredReview = parseJulesReview(input.latestReviewMessage);
  } catch {
    return null;
  }

  const issues = verifyJulesReview(structuredReview, input.verificationContext);
  if (issues.length === 0) return null;
  const validationErrors = issues.map(
    (issue) => `${issue.kind}: ${issue.message}`
  );

  core.warning(
    `Jules structured review has ${issues.length} validation issue(s); requesting a same-session revision.`
  );
  await sendSessionMessage(
    input.session,
    buildReviewRepairPrompt(structuredReview, issues)
  );
  const revisedMessage = await pollForReview(
    input.session,
    input.timeoutMinutes * 60 * 1000,
    input.latestReviewMessage
  );
  try {
    const revisedStructuredReview = parseJulesReview(revisedMessage);
    const remainingIssues = verifyJulesReview(
      revisedStructuredReview,
      input.verificationContext
    );
    if (remainingIssues.length > 0) {
      validationErrors.push(
        ...remainingIssues.map((issue) => `${issue.kind}: ${issue.message}`)
      );
      core.warning(
        `Jules revised structured review still has validation issue(s): ${remainingIssues.map((issue) => issue.message).join(" ")}`
      );
      return null;
    }
    return {
      reviewResult: convertStructuredReview(revisedStructuredReview),
      latestReviewMessage: revisedMessage,
      validationErrors,
    };
  } catch (err) {
    validationErrors.push(
      `Failed to parse Jules structured validation revision: ${errorMessage(err)}`
    );
    core.warning(
      `Failed to parse Jules structured validation revision; keeping previous parsed review result: ${err}`
    );
    return null;
  }
}

export async function startJulesHandsOnFix(
  apiKey: string,
  prompt: string,
  source: { github: string; baseBranch: string }
): Promise<string> {
  const customJules = jules.with({ apiKey });
  const rawSession = await customJules.session({
    prompt,
    source,
    requireApproval: false,
    autoPr: true,
  });
  const session = rawSession as unknown as JulesSession;
  core.info(`Jules hands-on fix session: ${session.id}`);
  return session.id;
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
    suggestion?: {
      path?: string;
      startLine?: number;
      endLine?: number;
      replacement: string;
    };
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
      message: comment.message,
      promptForAgents: comment.promptForAgents ?? "",
      suggestedReplacement: comment.suggestion?.replacement,
    })),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
