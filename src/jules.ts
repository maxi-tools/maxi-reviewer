import * as core from "@actions/core";
import { jules } from "@google/jules-sdk";
import { ReviewResult, StructuredFix } from "./types.js";
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
import {
  formatInvalidRetrievalRequest,
  formatRetrievalResults,
  parseRetrievalRequest,
  RetrievalProvider,
  RetrievalResult,
} from "./retrieval.js";
import { ReviewProgress } from "./review-heartbeat.js";

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
  /**
   * Optional agentic retrieval loop. When set, the model may emit
   * maxi.review.v1.retrieval-request objects before its verdict; each is
   * fulfilled at the PR head and fed back nonce-fenced, bounded by maxSteps.
   */
  retrieval?: {
    provider: RetrievalProvider;
    maxSteps: number;
    nonce: string;
  };
  /**
   * Called on each poll tick while waiting for the review. Used to keep the
   * pending commit status current so a stalled session is distinguishable from
   * one that merely started recently. Errors are swallowed.
   */
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
  /**
   * How long the first poll tolerates a session that has not started work
   * before declaring it stuck in repository setup. Defaults to
   * {@link DEFAULT_SETUP_BUDGET_MS}.
   */
  setupBudgetMs?: number;
}

/**
 * Five minutes, against measured replies of 21-190s (slowest 546s).
 *
 * The budget is deliberately longer than the slowest observed reply even
 * though it only ever applies to a session that has NOT started work: the
 * cost of being wrong is asymmetric. Abandoning a live session throws away a
 * review; waiting an extra few minutes on a dead one costs a few minutes.
 */
export const DEFAULT_SETUP_BUDGET_MS = 300_000;

/**
 * How long the first poll may wait on a session that has not started work.
 *
 * Zero -- no watch at all -- for a resumed session: it went through repository
 * setup runs ago and has already worked, so it cannot be stuck in a setup it
 * finished. It can sit in QUEUED for a while picking up the new prompt, which
 * is the same normal behaviour the follow-up polls are not watched for.
 */
function setupBudgetFor(
  resumed: boolean,
  options: RunJulesReviewOptions
): number {
  if (resumed) return 0;
  return options.setupBudgetMs ?? DEFAULT_SETUP_BUDGET_MS;
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

  const { session, afterMessage, resumed } = await startReviewSession(
    customJules,
    prompt,
    source,
    options.previousSessionId
  );
  core.info(`Jules session: ${session.id}`);

  if (!afterMessage) {
    await waitUntilSessionReady(session);
  }

  let reviewMessage = await pollForReview(
    session,
    timeoutMinutes * 60 * 1000,
    afterMessage,
    options.onProgress,
    setupBudgetFor(resumed, options)
  );
  core.info(`Collected review (${reviewMessage.length} chars)`);

  if (!reviewMessage) {
    return { reviewResult: null, sessionId: session.id };
  }

  if (options.retrieval) {
    reviewMessage = await runRetrievalLoop({
      session,
      firstMessage: reviewMessage,
      retrieval: options.retrieval,
      timeoutMs: timeoutMinutes * 60 * 1000,
      onProgress: options.onProgress,
    });
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
      reviewMessage,
      options.onProgress
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
      latestReviewMessage,
      options.onProgress
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
      onProgress: options.onProgress,
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

/**
 * Drive the optional agentic retrieval loop. Starting from the model's first
 * reply, while it asks for retrieval (a maxi.review.v1.retrieval-request) and
 * budget remains, fulfil each request at the PR head and feed the results back
 * nonce-fenced. Returns the first non-retrieval reply (the final review), or
 * the last reply if the budget or session is exhausted.
 */
async function runRetrievalLoop(input: {
  session: JulesSession;
  firstMessage: string;
  retrieval: { provider: RetrievalProvider; maxSteps: number; nonce: string };
  timeoutMs: number;
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
}): Promise<string> {
  const { session, retrieval, timeoutMs, onProgress } = input;
  const deadline = Date.now() + timeoutMs;
  let message = input.firstMessage;
  for (let step = 0; step < retrieval.maxSteps; step++) {
    const parsed = parseRetrievalRequest(message);
    if (parsed.kind === "none") return message;
    const roundsLeft = retrieval.maxSteps - step - 1;
    if (parsed.kind === "invalid") {
      core.info(
        "Retrieval step " +
          (step + 1) +
          ": invalid retrieval-request; returning schema errors for repair."
      );
      await sendSessionMessage(
        session,
        formatInvalidRetrievalRequest(
          retrieval.nonce,
          parsed.errors,
          roundsLeft
        )
      );
      const repaired = await pollForReview(
        session,
        Math.max(0, deadline - Date.now()),
        message,
        onProgress
      );
      if (!repaired) {
        core.warning(
          "Retrieval loop: no agent reply after invalid-request feedback; stopping."
        );
        return message;
      }
      message = repaired;
      continue;
    }
    const request = parsed.request;
    core.info(
      `Retrieval step ${step + 1}/${retrieval.maxSteps}: fulfilling ${request.requests.length} request(s); ${roundsLeft} round(s) left.`
    );
    const results: RetrievalResult[] = [];
    for (const req of request.requests) {
      try {
        results.push(await retrieval.provider.fulfill(req));
      } catch (err) {
        results.push({ tool: req.tool, ok: false, error: errorMessage(err) });
      }
    }
    await sendSessionMessage(
      session,
      formatRetrievalResults(retrieval.nonce, results, roundsLeft)
    );
    const next = await pollForReview(
      session,
      Math.max(0, deadline - Date.now()),
      message,
      onProgress
    );
    if (!next) {
      core.warning(
        "Retrieval loop: no agent reply after returning results; stopping."
      );
      return message;
    }
    message = next;
  }
  // Budget exhausted but the model is still requesting retrieval: nudge once
  // for the final review so we don't return an unparseable request message.
  if (parseRetrievalRequest(message).kind !== "none") {
    core.info("Retrieval budget exhausted; requesting the final review.");
    await sendSessionMessage(
      session,
      formatRetrievalResults(retrieval.nonce, [], 0)
    );
    const finalMessage = await pollForReview(
      session,
      Math.max(0, deadline - Date.now()),
      message,
      onProgress
    );
    if (finalMessage) return finalMessage;
  }
  return message;
}

async function startReviewSession(
  customJules: JulesSessionClient,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any,
  previousSessionId?: string
): Promise<{
  session: JulesSession;
  afterMessage?: string;
  /**
   * Whether this is a session that already existed and worked.
   *
   * Reported separately from `afterMessage`, which is empty when a resumed
   * session had never replied, and separately from `previousSessionId`, which
   * is only what the caller ASKED for -- a resume that throws falls through to
   * a brand new session below, and that one does need watching.
   */
  resumed: boolean;
}> {
  if (previousSessionId) {
    try {
      core.info(`Continuing Jules review session ${previousSessionId}…`);
      const session = customJules.session(previousSessionId) as JulesSession;
      await session.info();
      const afterMessage = await latestAgentMessage(session);
      await sendSessionMessage(session, prompt);
      return { session, afterMessage, resumed: true };
    } catch (err) {
      core.warning(
        `Could not continue Jules session ${previousSessionId}; starting a new review session: ${String(err)}`
      );
    }
  }

  core.info("Creating Jules review session…");
  const rawSession = await createReviewSession(customJules, prompt, source);
  return { session: rawSession as unknown as JulesSession, resumed: false };
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
  onProgress?: (progress: ReviewProgress) => void | Promise<void>;
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
    input.latestReviewMessage,
    input.onProgress
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

  const jsonMatch = message.match(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/i);
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
    fix?: StructuredFix;
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
      fix: comment.fix,
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

/**
 * A session that never left repository setup, distinguished from one that
 * worked and stayed silent.
 *
 * Observed directly on 2026-09-10: session 9532304781847968824, created for
 * maxi-core#3942, sat on "Cloning maxi-tools/maxi-core / Setting up the
 * repository..." for over two hours. The full prompt had been delivered; no
 * agent turn ever began, so `agentMessaged` never appeared and the poll below
 * spent its entire budget waiting for something that was never coming.
 *
 * That is not the same failure as "the reviewer had nothing to say", and the
 * caller has to be able to tell them apart: this one is worth retrying on
 * another account at once. Measured across 26 reviews, replies arrive in
 * 21-190s (slowest 546s) or never -- so waiting out the budget buys nothing
 * here, and the timeout text claiming replies "cluster near the end of the
 * budget" is wrong about this case in particular.
 */
export class SessionStuckInSetupError extends Error {
  readonly sessionId: string;
  readonly state: string;
  constructor(sessionId: string, state: string, waitedMs: number) {
    super(
      `Jules session ${sessionId} never left ${state} after ` +
        `${Math.round(waitedMs / 1000)}s: repository clone/setup did not ` +
        "finish, so no review was ever started. Retry on another account " +
        "rather than waiting out the review budget."
    );
    this.name = "SessionStuckInSetupError";
    this.sessionId = sessionId;
    this.state = state;
  }
}

/**
 * States meaning the agent has not begun work yet.
 *
 * `IN_PROGRESS` and everything after it are deliberately absent: a session
 * that is working may legitimately be slow, and the slowest real reply
 * measured took 546s. The discriminator is the STATE, not the clock -- a
 * session queued for five minutes is stuck; one in progress for nine minutes
 * is thinking.
 */
const PRE_WORK_STATES = new Set(["STATE_UNSPECIFIED", "QUEUED", ""]);

/** The session's state, or "" when it cannot be read. */
export function readSessionState(info: unknown): string {
  if (typeof info !== "object" || info === null) return "";
  const raw = (info as { state?: unknown }).state;
  return typeof raw === "string" ? raw : "";
}

/**
 * Watches a session for a setup that never finishes.
 *
 * Owns the whole decision -- reading the state, remembering that work has
 * started, and the abandon call -- so the poll loop keeps one line of it. Call
 * {@link SetupWatch.check} once per poll: it throws
 * {@link SessionStuckInSetupError} when the session should be given up on and
 * returns otherwise.
 */
interface SetupWatch {
  check(attempt: number): Promise<void>;
}

/**
 * A watch that never fires, for polls that are not watching for setup.
 *
 * Only the first poll of a session watches. By the time a repair or retrieval
 * prompt is sent the session has already worked, and it may legitimately
 * re-enter QUEUED while it picks that prompt up; watching there would abandon
 * sessions for doing something normal.
 */
const NO_SETUP_WATCH: SetupWatch = { check: async () => {} };

function createSetupWatch(
  session: JulesSession,
  startedAt: number,
  budgetMs: number
): SetupWatch {
  if (budgetMs <= 0) return NO_SETUP_WATCH;

  // Sticky: once the session has been seen working, a later unreadable or
  // flapping state must not retract that and abandon a session mid-review.
  let sawWorkStart = false;
  let lastState = "";

  return {
    async check(attempt: number): Promise<void> {
      // Nothing left to decide: `sawWorkStart` is sticky, so from here every
      // call could only return without acting. Polling on would spend an
      // `info()` per tick -- ~90 more requests over a 30-minute review -- to
      // learn something that can no longer change the outcome.
      if (sawWorkStart) return;
      // Never throws. A poll that could not read the state has to behave
      // exactly like one taken before this check existed -- an API blip must
      // not abandon a session. An auth failure still surfaces:
      // `session.hydrate()` runs moments later on the same credentials.
      let state: string;
      try {
        state = readSessionState(await session.info());
      } catch (err) {
        core.info(
          `session.info() unreadable (attempt ${attempt}): ${errorMessage(err)}`
        );
        return;
      }

      if (!state) return;
      if (state !== lastState) {
        core.info(`Jules session state: ${lastState || "?"} -> ${state}`);
        lastState = state;
      }
      if (!PRE_WORK_STATES.has(state)) {
        sawWorkStart = true;
        return;
      }
      // Reached only on POSITIVE evidence of a pre-work state, so an
      // unreadable one leaves the loop waiting, as it did before this existed:
      // being wrong here throws away a review that would have arrived, and a
      // real reply is cheap to wait for.
      const waited = Date.now() - startedAt;
      if (!sawWorkStart && waited > budgetMs) {
        throw new SessionStuckInSetupError(session.id, state, waited);
      }
    },
  };
}

async function pollForReview(
  session: JulesSession,
  timeoutMs: number,
  afterMessage?: string,
  onProgress?: (progress: ReviewProgress) => void | Promise<void>,
  // Off unless a caller opts in. Only the first poll of a session is watching
  // for a setup that never finished; by the time a repair or retrieval prompt
  // is sent the session has already worked, and it may legitimately re-enter
  // QUEUED while it picks that prompt up. Defaulting this on would abandon
  // those sessions for doing something normal.
  setupBudgetMs = 0
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempt = 0;
  // Sticky across iterations on purpose. Declared inside the loop it reset to
  // false on every tick, so a single transient hydrate/history error would make
  // the heartbeat retract "agent replied" and claim no output had arrived — the
  // status would appear to go backwards. Having seen agent output is a fact
  // about the session, not about the current poll.
  let sawAgentOutput = false;
  const setupWatch = createSetupWatch(session, startedAt, setupBudgetMs);
  while (Date.now() < deadline) {
    attempt++;
    // Outside the try below on purpose: the state read must not be able to
    // cancel the hydrate/history poll that actually collects the review, and
    // SessionStuckInSetupError is a verdict about the session rather than a
    // poll hiccup, so it must not land in a catch that resumes waiting.
    await setupWatch.check(attempt);
    try {
      await session.hydrate();
      let last = "";
      for await (const a of session.history()) {
        if (a.type === "agentMessaged") last = a.message;
      }
      if (last) {
        sawAgentOutput = true;
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
    // Purely diagnostic: a progress sink must never interrupt or fail polling.
    if (onProgress) {
      try {
        await onProgress({ sawAgentOutput });
      } catch (err) {
        core.info(`Review progress callback failed: ${errorMessage(err)}`);
      }
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
