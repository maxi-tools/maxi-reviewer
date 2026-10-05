import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  AnalyzerFinding,
  CiSignal,
  ExistingFinding,
  FailOn,
  LinkedIssue,
  OpenThread,
  ReviewArtifact,
  ReviewComment,
  ReviewOutcome,
  ReviewRunIdentity,
  Verdict,
} from "./types.js";
import {
  fetchDiff,
  loadRulesFromBase,
  fetchOpenThreads,
  fetchExistingFindings,
  resolveThreads,
  submitReview,
  setStatus,
  recordReviewArtifactComment,
  listReviewArtifactComments,
} from "./github.js";
import {
  runJulesReview,
  wrapPermissionError,
  RunJulesReviewOptions,
} from "./jules.js";
import {
  planAttempts,
  runReviewWithSetupEscalation,
} from "./jules-escalation.js";
import {
  countOpenAiFallbackConfigs,
  openAiFallbackConfigured,
  parseReviewerBackend,
  resolveOpenAiFallbackConfigs,
  runOpenAiReview,
  type OpenAiReviewConfig,
  type ReviewerBackend,
} from "./openai-review.js";
import { buildReviewPrompt } from "./prompt.js";
import { fetchCiSignal } from "./ci-signal.js";
import { enrichCommentsWithAnchors } from "./anchor.js";
import { createGithubRetrievalProvider } from "./retrieval.js";
import { createHeartbeat } from "./review-heartbeat.js";
import { fetchLinkedIssues, parseClosingIssueRefs } from "./linked-issues.js";
import { makeNonce } from "./untrusted.js";
import { buildChangedFileContext } from "./context-window.js";
import {
  DEFAULT_GENERATED_GLOBS,
  filterDiffByPaths,
  matchesAnyGlob,
  parseIgnoreGlobs,
  scopeReviewToDiff,
} from "./diff-filter.js";
import { loadSelectedRules, selectRuleFiles } from "./rules/select.js";
import { buildReviewArtifact } from "./late-feedback-harvest.js";
import { parseOpengrepJson, parseOpengrepSarif } from "./analyzers/opengrep.js";
import { parseCpdXml, parsePmdXml } from "./analyzers/pmd.js";
import { validateReviewArtifact } from "./schema.js";

const COMMENT_MARKER = "<!-- maxi-review -->";
const VALID_FAIL_ON: FailOn[] = ["never", "blocking", "any"];
const ANALYZER_TIMEOUT_MS = 5 * 60 * 1000;
const RETRIEVAL_MAX_STEPS = 4;
const execFileAsync = promisify(execFile);

interface ArtifactUploader {
  uploadArtifact: (
    name: string,
    files: string[],
    rootDirectory: string,
    options?: { retentionDays?: number }
  ) => Promise<{ id?: number; size?: number; digest?: string }>;
}

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * GitHub silently truncates commit status descriptions past 140 characters, so
 * the status line is the constrained surface of the three below.
 */
const STATUS_DESCRIPTION_MAX = 140;

/**
 * Wording for the one outcome that is not about the code: Jules never sent an
 * agent message before the budget ran out.
 *
 * `Review timed out; see harvested artifact` said neither how long it waited
 * nor that nothing had been reviewed, so it read as a verdict. It is not one —
 * no review exists to disagree with. And it is worth re-running rather than
 * investigating: measured across 26 reviews, a reply that is coming arrives in
 * 21-190s, slowest 546s, or never -- so a job whose budget covers that did not
 * have a slow reviewer, it had none, and the next attempt frequently gets one.
 * Stated as a conditional on purpose: `timeout_minutes` is an input, and at a
 * budget shorter than 546s a reply that WAS coming gets cut off, so the flat
 * claim would be false exactly where someone had shortened the budget.
 *
 * An earlier version of this comment read that reply times "cluster against
 * the deadline", from two reviews on 2026-08-30 landing on poll attempts 26
 * and 29 of ~30. Those are the same ~550s replies -- they only looked like
 * clustering because the budget was 10 minutes at the time. Against 15 they
 * are early, and the shape of the distribution never changed.
 *
 * Every number here is threaded through from the configured `timeout_minutes`
 * and never written as a literal. The budget has already moved twice (30 -> 10
 * -> 15); a hardcoded minute count on a status line nobody re-reads would have
 * been wrong twice. `tests/review-pr.test.ts` pins that it tracks the input.
 */
export function reviewTimeoutStatus(timeoutMinutes: number): string {
  return truncate(
    `No review after ${timeoutMinutes} min: Jules never replied. Reviewer timeout, not a code finding — re-runs often pass.`,
    STATUS_DESCRIPTION_MAX
  );
}

/** Long-form of {@link reviewTimeoutStatus} for the log and the job failure. */
export function reviewTimeoutExplanation(timeoutMinutes: number): string {
  return [
    `Jules returned no review message within ${timeoutMinutes} minutes, so no review was produced and there are no findings to read.`,
    "This is a reviewer-infrastructure timeout, not a verdict on the code.",
    `Across 26 measured reviews a reply that comes arrives in 21-190s, slowest 546s; where the ${timeoutMinutes}-minute budget covers that, running out means none came rather than one being slow.`,
    // Unconditional on purpose, unlike the sentence above it: whatever the
    // budget was, another attempt is the cheap thing to try, and this is the
    // only actionable half of the message.
    "Either way, re-running this job often succeeds.",
  ].join(" ");
}

/** True when a review body is missing any non-whitespace content. */
export function isBlankReviewBody(body: string): boolean {
  return body.trim().length === 0;
}

/**
 * Status line for a parsed review whose body is empty or whitespace-only.
 * Distinct from a timeout: something came back, but it was not a review.
 */
export function emptyReviewStatus(collectedCharacters: number): string {
  return truncate(
    `Empty review body (${collectedCharacters} chars) — no review was produced.`,
    STATUS_DESCRIPTION_MAX
  );
}

/** Long-form of {@link emptyReviewStatus} for the log and the job failure. */
export function emptyReviewExplanation(collectedCharacters: number): string {
  return [
    `Collected an empty or whitespace-only review body (${collectedCharacters} chars), so no review was produced.`,
    "This is not a verdict on the code.",
  ].join(" ");
}

export interface PullRequestContext {
  diff: string;
  changedFiles: string[];
  /** Full PR file set (base...head), used for scoping. Defaults to changedFiles when absent. */
  prChangedFiles?: string[];
  files?: Map<string, string>;
  changedLines?: Map<string, Set<number>>;
  rulesFromFile?: string;
  openThreads: OpenThread[];
  linkedIssues: LinkedIssue[];
}

export interface RunAnalyzerInput {
  changedFiles: string[];
  diff: string;
  analyzerMode?: string;
  executeAnalyzer?: (command: string, args: string[]) => Promise<string>;
  analyzerOutputPaths?: {
    opengrepJson?: string;
    opengrepSarif?: string;
    pmdXml?: string;
    cpdXml?: string;
  };
}

export interface JulesReviewRunResult {
  reviewResult: {
    verdict: Verdict;
    summary: string;
    resolvedCommentIds?: number[];
    newComments?: ReviewComment[];
  } | null;
  sessionId: string;
  rawResponses?: string[];
  validationErrors?: string[];
}

export interface ReviewPrDeps {
  fetchPullRequestContext: (input: {
    octokit: Octokit;
    owner: string;
    repo: string;
    pr: { number: number; body?: string | null };
    baseSha: string;
    baseShaForDiff: string;
    headSha: string;
    rulesFilePath: string;
    groundInLinkedIssues: boolean;
  }) => Promise<PullRequestContext>;
  selectRuleFiles: typeof selectRuleFiles;
  loadSelectedRules: typeof loadSelectedRules;
  runAnalyzers: (input: RunAnalyzerInput) => Promise<AnalyzerFinding[]>;
  fetchExistingFindings: (
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number
  ) => Promise<ExistingFinding[]>;
  fetchCiSignal: (input: {
    octokit: Octokit;
    owner: string;
    repo: string;
    headSha: string;
    ownStatusContext?: string;
    mode?: string;
    testReportPath?: string;
    coverageSummaryPath?: string;
  }) => Promise<CiSignal | undefined>;
  buildReviewPrompt: typeof buildReviewPrompt;
  runJulesReview: (
    apiKey: string,
    prompt: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source: any,
    timeoutMinutes: number,
    options?: RunJulesReviewOptions
  ) => Promise<JulesReviewRunResult>;
  /**
   * OpenAI-compatible reviewer. Injected so tests can prove fallback selection
   * without standing up a server. Defaults to {@link runOpenAiReview}.
   */
  runOpenAiReview: typeof runOpenAiReview;
  submitReview: typeof submitReview;
  resolveThreads: typeof resolveThreads;
  setStatus: typeof setStatus;
  uploadArtifact: (name: string, content: string) => Promise<void>;
  recordReviewArtifact: typeof recordReviewArtifactComment;
  listReviewArtifactComments: typeof listReviewArtifactComments;
  wrapPermissionError: typeof wrapPermissionError;
  writeJobSummary: (collectedCharacters: number) => Promise<void>;
}

/**
 * Pick the reviewer and, when Jules is primary, walk the OpenAI-compatible
 * fallback chain if it doesn't reply.
 *
 * Two ways the OpenAI-compatible endpoint is used, matching the two ways an
 * operator asks for it:
 *
 * - `reviewer_backend=openai` (or `qwen`) runs it instead of Jules. That is the
 *   explicit roster entry: a second workflow job can post its own review.
 * - `reviewer_backend=jules` (the default) still runs Jules, including the
 *   stuck-setup escalation. Only a review that came back empty — Jules timed
 *   out, which is what happened on 2026-10-05 (maxi-config#1028, ~7h pearl
 *   outage) — falls through, and only when at least one fallback endpoint is
 *   configured. A Jules error that is not "no review" is still a Jules error;
 *   the fallback is not a retry of a bad answer.
 *
 * The fallback chain is ordered: the legacy `openai_*` slot first, then
 * `openai_fallback_*`. A review from any endpoint in the chain succeeds; only
 * when all configured endpoints also return no review does the run surface a
 * distinct "reviewer unavailable" failure rather than the Jules-timeout text.
 * Without this, a single downed Spark strands every PR whose Jules session
 * was silent, because the artifact records the Jules timeout even when the
 * timeout had nothing to do with Jules.
 *
 * The fallback attempts themselves never throw: a transport error or an
 * unparseable reply from one slot is "no review" on that slot, and the next
 * slot gets a turn. The chain only short-circuits on a real review.
 */
export async function runSelectedReview(input: {
  deps: ReviewPrDeps;
  backend: ReviewerBackend;
  apiKey: string;
  fallbackApiKey: string;
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any;
  timeoutMinutes: number;
  julesOptions: RunJulesReviewOptions;
}): Promise<JulesReviewRunResult> {
  if (input.backend === "openai") {
    return runOpenAiBackend(input.deps, input.prompt, input.timeoutMinutes, {
      verificationContext: input.julesOptions.verificationContext,
      retrieval: input.julesOptions.retrieval,
      onProgress: input.julesOptions.onProgress,
    });
  }

  const julesResult = await runReviewWithSetupEscalation({
    run: input.deps.runJulesReview,
    attempts: planAttempts(input.apiKey, input.fallbackApiKey),
    prompt: input.prompt,
    source: input.source,
    timeoutMinutes: input.timeoutMinutes,
    options: input.julesOptions,
  });
  if (julesResult.reviewResult || !openAiFallbackConfigured(core.getInput)) {
    return julesResult;
  }

  const fallback = await runOpenAiFallbackChain(
    input.deps,
    input.prompt,
    input.timeoutMinutes,
    input.julesOptions,
    julesResult
  );
  if (fallback.reviewResult) {
    return fallback;
  }
  // All configured endpoints returned nothing. Surface the failure as
  // "reviewer unavailable" rather than the Jules-timeout text: the reader on
  // the PR page should see that no reviewer ran, not that Jules specifically
  // failed, and a follow-up workflow looking at the artifact should see the
  // same.
  //
  // The session id is the discriminator the artifact builder uses to pick
  // reviewer-unavailable text over Jules-timeout text; it MUST be the chain
  // id, not the underlying Jules session.
  //
  // `runOpenAiFallbackChain` already aggregates julesResult.rawResponses
  // and julesResult.validationErrors into its returned arrays (lines
  // 383/384-386), so the outer merge only needs the chain result.
  return {
    reviewResult: null,
    sessionId: fallback.sessionId,
    ...(fallback.rawResponses
      ? { rawResponses: [...(fallback.rawResponses ?? [])] }
      : {}),
    validationErrors: [
      ...(fallback.validationErrors ?? []),
      reviewerUnavailableError(fallback.sessionId, fallback.attempts),
    ],
  };
}

/**
 * Walk the OpenAI-compatible fallback chain in order. Stops on the first
 * endpoint that returns a review; returns an empty result (plus the
 * accumulated per-attempt transcripts and error messages) when none do.
 *
 * The harvest keeps every attempt's `rawResponses` and `validationErrors`
 * so the on-call engineer can see why each endpoint in the chain failed —
 * a generic `fetch failed` from one slot and a 503 from the next are very
 * different causes.
 */
async function runOpenAiFallbackChain(
  deps: ReviewPrDeps,
  prompt: string,
  timeoutMinutes: number,
  julesOptions: RunJulesReviewOptions,
  julesResult: JulesReviewRunResult
): Promise<JulesReviewRunResult & { attempts: string[] }> {
  const configs = resolveOpenAiFallbackConfigs(core.getInput, timeoutMinutes);
  if (configs.length === 0) {
    // Defensive: openAiFallbackConfigured already returned true above. If the
    // resolver disagrees, fall back to the legacy single-slot resolution
    // rather than silently succeeding with no review.
    core.warning(
      "OpenAI-compatible fallback was configured but resolved to zero endpoints; " +
        "treating the run as reviewer-unavailable."
    );
    return emptyFallbackChain("unknown", []);
  }

  const attempts: string[] = [];
  const allRawResponses: string[] = [...(julesResult.rawResponses ?? [])];
  const allValidationErrors: string[] = [
    ...(julesResult.validationErrors ?? []),
  ];
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const hostLabel = summariseEndpoint(config);
    const label =
      configs.length === 1
        ? "the configured OpenAI-compatible reviewer"
        : `OpenAI-compatible fallback ${i + 1}/${configs.length} (${hostLabel})`;
    if (i === 0) {
      core.warning(
        `Jules returned no review within ${timeoutMinutes} minutes; ` +
          `trying ${label}.`
      );
    } else {
      core.warning(`${attempts[i - 1]} returned no review; trying ${label}.`);
    }
    // runOneOpenAiBackend swallows per-slot transport / empty-body / parse
    // throws into a "no review" result; the chain then advances to the
    // next configured endpoint rather than crashing the whole job.
    const result = await runOneOpenAiBackend(
      deps,
      prompt,
      config,
      julesOptions
    );
    attempts.push(label);
    if (result.reviewResult) {
      return {
        ...result,
        attempts,
        rawResponses: [...allRawResponses, ...(result.rawResponses ?? [])],
        validationErrors: [
          ...allValidationErrors,
          `Jules timed out after ${timeoutMinutes} minutes; review produced by ${label} (${result.sessionId}).`,
          ...(result.validationErrors ?? []),
        ],
      };
    }
    allRawResponses.push(...(result.rawResponses ?? []));
    if (result.validationErrors?.length) {
      allValidationErrors.push(
        `${label} returned no review: ${result.validationErrors.join(" | ")}`
      );
    } else {
      allValidationErrors.push(`${label} returned no review.`);
    }
  }
  return {
    ...emptyFallbackChain(attempts[attempts.length - 1] ?? "unknown", attempts),
    rawResponses: allRawResponses,
    validationErrors: allValidationErrors,
  };
}

function emptyFallbackChain(
  lastAttempt: string,
  attempts: string[]
): JulesReviewRunResult & { attempts: string[] } {
  return {
    reviewResult: null,
    sessionId: `openai:all-unavailable:${lastAttempt}`,
    attempts,
  };
}

function summariseEndpoint(config: OpenAiReviewConfig): string {
  // Logs, status text, and the artifact must NEVER carry the full URL:
  // userinfo holds credentials, path and query can hold tokens, and the
  // host alone is enough for a reader to identify which endpoint failed.
  // On parse failure the input is not safe to echo (the caller may have
  // pasted a malformed secret into the URL), so return a fixed label.
  try {
    const url = new URL(config.baseUrl);
    if (!url.host) return INVALID_ENDPOINT_LABEL;
    return url.host;
  } catch {
    return INVALID_ENDPOINT_LABEL;
  }
}

const INVALID_ENDPOINT_LABEL = "<invalid-endpoint>";

/**
 * Strip the raw baseUrl out of a transport error message before it lands
 * on a log line, a status description, or the artifact. A 5xx response
 * from a Spark often echoes the request path (e.g. `/v1/chat/completions`)
 * and an upstream proxy can echo a full URL with embedded credentials.
 * Replace any URL-shaped substring with the already-computed `hostLabel`
 * so the on-call still knows which endpoint failed, but the secret-bearing
 * payload never reaches a printer.
 *
 * Two passes, because one is not enough:
 *
 * 1. The literal `rawUrl` is removed by exact match. This is the pass that
 *    matters for the case the scheme regex cannot see: a baseUrl that never
 *    parses as a URL at all (no `//`, so no scheme to key off) — e.g.
 *    `user:pass@host` — which Node's `fetch` still echoes verbatim inside
 *    its `TypeError: Invalid URL`. There is no scheme in that string for the
 *    regex to match, so a regex-only implementation leaks the credential.
 * 2. Any remaining scheme-prefixed URL is replaced wholesale, which catches
 *    the paths and upstream errors that mention a URL other than ours.
 *
 * `rawUrl` is optional so existing callers that have no URL in hand (or
 * callers deliberately passing a synthetic string) keep compiling; when it
 * is absent or empty, the exact-match pass is a no-op.
 */
export function sanitiseTransportError(
  message: string,
  hostLabel: string,
  rawUrl?: string
): string {
  const withoutExactMatch = rawUrl
    ? message.split(rawUrl).join(hostLabel)
    : message;
  return withoutExactMatch.replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s)>'"`]+/gi,
    hostLabel
  );
}

/**
 * Human-readable line for the harvested artifact when no reviewer produced
 * a review. Distinct from the Jules-timeout text: that one reads "Jules
 * never replied", which is the wrong message when the cause is the whole
 * fallback chain (and Jules may have replied with an empty body for reasons
 * unrelated to reviewer availability).
 */
export function reviewerUnavailableError(
  lastSessionId: string,
  attempts: string[]
): string {
  const list =
    attempts.length > 0
      ? attempts.map((a) => ` - ${a}`).join("\n")
      : " - (no OpenAI-compatible endpoints were configured)";
  return [
    `Reviewer unavailable: Jules returned no review and ${attempts.length} OpenAI-compatible fallback endpoint(s) did not produce one either (last attempt session: ${lastSessionId}). Attempted:`,
    list,
    "This is not a verdict on the code. The review gate stays red because nothing was reviewed; the PR was not inspected.",
  ].join("\n");
}

/**
 * Status-line text for the reviewer-unavailable outcome. Bounded by the 140
 * char GitHub limit on commit status descriptions; the long-form reason lives
 * on the artifact via {@link reviewerUnavailableError}.
 */
export function reviewerUnavailableStatus(attempts: number): string {
  return truncate(
    `Reviewer unavailable: ${attempts} fallback endpoint(s) failed to produce a review`,
    STATUS_DESCRIPTION_MAX
  );
}

/**
 * Long-form text for the job failure when every reviewer failed. Distinct
 * from {@link reviewTimeoutExplanation}: that one frames the missing review
 * as a Jules problem, which is misleading when the cause was the fallback
 * chain, not Jules.
 */
export function reviewerUnavailableExplanation(attempts: number): string {
  return [
    `Jules returned no review and none of the ${attempts} configured OpenAI-compatible fallback endpoint(s) produced one either.`,
    "This is a reviewer-infrastructure failure, not a verdict on the code.",
    "The harvested artifact records every attempt and its failure mode so the on-call has the evidence to triage.",
  ].join(" ");
}

async function runOpenAiBackend(
  deps: ReviewPrDeps,
  prompt: string,
  timeoutMinutes: number,
  options: RunJulesReviewOptions
): Promise<JulesReviewRunResult> {
  // When the caller picked `reviewer_backend=openai`, the workflow is asking
  // for the OpenAI-compatible path as the sole reviewer. Pick the first
  // configured endpoint and surface a missing-config error if none is set.
  const configs = resolveOpenAiFallbackConfigs(core.getInput, timeoutMinutes);
  const config = configs[0];
  if (!config) {
    throw new Error(
      "openai_base_url is required when reviewer_backend is openai " +
        "(or when it is the configured Jules-timeout fallback). " +
        "Point it at the vLLM OpenAI server, e.g. http://jasper:8000/v1."
    );
  }
  const result = await runOneOpenAiBackend(deps, prompt, config, options);
  // Stamp the session id with the chain-exhausted prefix so the run-level
  // surface (status, setFailed, artifact outcomeReason) renders the
  // reviewer-unavailable text rather than the misleading Jules-timeout
  // text. The single-slot case is effectively a chain of length 1.
  if (result.reviewResult === null) {
    return {
      ...result,
      sessionId: `openai:all-unavailable:${summariseEndpoint(config)}`,
    };
  }
  return result;
}

async function runOneOpenAiBackend(
  deps: ReviewPrDeps,
  prompt: string,
  config: OpenAiReviewConfig,
  options: RunJulesReviewOptions
): Promise<JulesReviewRunResult> {
  if (config.apiKey) core.setSecret(config.apiKey);
  // Log the host only — the raw baseUrl can carry userinfo, a private
  // path, or a token query, and those strings would land in the workflow
  // log that everyone in the org can read. `setSecret` above masks the
  // api key from the same surface; the URL has no equivalent knob, so the
  // only safe move is to log the already-redacted label.
  const hostLabel = summariseEndpoint(config);
  core.info(
    `OpenAI-compatible review: model=${config.model} timeout=${config.timeoutMinutes}m endpoint=${hostLabel}`
  );
  try {
    return await deps.runOpenAiReview(prompt, config, {
      verificationContext: options.verificationContext,
      retrieval: options.retrieval,
      onProgress: options.onProgress,
    });
  } catch (err) {
    // A transport error / 5xx / empty body / parse-throw from one slot is
    // a failed attempt, not a job-ending crash. The chain wrapper advances
    // to the next endpoint; the single-slot `reviewer_backend=openai` path
    // surfaces a null review so the run fails closed (no REVIEWED_NO_FINDINGS
    // for code that was never reviewed). The cause stays on the artifact
    // with the URL sanitised.
    const message = err instanceof Error ? err.message : String(err);
    const safeMessage = sanitiseTransportError(
      message,
      hostLabel,
      config.baseUrl
    );
    core.warning(
      `OpenAI-compatible review at ${hostLabel} failed: ${safeMessage}`
    );
    return {
      reviewResult: null,
      sessionId: `openai:error:${hostLabel}`,
      rawResponses: [`[error] ${safeMessage}`],
      validationErrors: [
        `OpenAI-compatible review at ${hostLabel} failed: ${safeMessage}`,
      ],
    };
  }
}

const defaultDeps: ReviewPrDeps = {
  fetchPullRequestContext,
  selectRuleFiles,
  loadSelectedRules,
  runAnalyzers,
  fetchCiSignal,
  fetchExistingFindings,
  buildReviewPrompt,
  runJulesReview,
  runOpenAiReview,
  submitReview,
  resolveThreads,
  setStatus,
  uploadArtifact: uploadReviewArtifact,
  recordReviewArtifact: recordReviewArtifactComment,
  listReviewArtifactComments,
  wrapPermissionError,
  writeJobSummary: async (collectedCharacters: number) => {
    core.summary.addHeading("Maxi Review");
    core.summary.addRaw(`Collected characters: ${collectedCharacters}`);
    await core.summary.write();
  },
};

export async function runReviewPr(
  overrides: Partial<ReviewPrDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const reviewerBackend = parseReviewerBackend(
    core.getInput("reviewer_backend")
  );
  // Jules is required only when it is the backend that will run. An explicit
  // openai roster entry must be able to review with Jules unconfigured — that
  // is the point of a second reviewer, not a second key for the first one.
  const apiKey = core.getInput("jules_api_key", {
    required: reviewerBackend === "jules",
  });
  if (apiKey) core.setSecret(apiKey);
  // Optional second Jules account. A session that never finishes cloning is
  // recreated here rather than waited out; see jules-escalation.ts.
  const fallbackApiKey = core.getInput("jules_api_key_fallback");
  if (fallbackApiKey) core.setSecret(fallbackApiKey);

  const token = core.getInput("github_token", { required: true });
  const failOnRaw = core.getInput("fail_on");
  if (!VALID_FAIL_ON.includes(failOnRaw as FailOn)) {
    core.setFailed(
      `Invalid fail_on: "${failOnRaw}". Must be one of: ${VALID_FAIL_ON.join(", ")}.`
    );
    return;
  }
  const failOn = failOnRaw as FailOn;
  const skipDrafts = core.getBooleanInput("skip_drafts");
  const skipForks = core.getBooleanInput("skip_forks");
  const bypassLabel = core.getInput("bypass_label");
  const statusContext = core.getInput("status_context");
  const extraInstructions = core.getInput("extra_instructions");
  const rulesFilePath = core.getInput("rules_file");
  const analyzerMode = core.getInput("analyzer_mode") || "auto";
  const retrievalMode = (
    core.getInput("retrieval_mode") || "off"
  ).toLowerCase();
  const ciSignalMode = (core.getInput("ci_signal") || "off").toLowerCase();
  const testReportPath = core.getInput("test_report") || undefined;
  const coverageSummaryPath = core.getInput("coverage_summary") || undefined;
  const dedupeReviewers = (
    core.getInput("dedupe_reviewers") || "off"
  ).toLowerCase();
  const analyzerOutputPaths = {
    opengrepJson: core.getInput("opengrep_json") || undefined,
    opengrepSarif: core.getInput("opengrep_sarif") || undefined,
    pmdXml: core.getInput("pmd_xml") || undefined,
    cpdXml: core.getInput("cpd_xml") || undefined,
  };
  const timeoutMinutesRaw = core.getInput("timeout_minutes") || "30";
  const timeoutMinutes = Math.max(1, parseInt(timeoutMinutesRaw, 10) || 30);

  const ctx = github.context;
  if (ctx.eventName === "pull_request_target") {
    core.setFailed(
      "pull_request_target is not supported — it runs with base-repo write tokens and exposes the action to prompt-injection via attacker-controlled diffs. Use on: pull_request instead."
    );
    return;
  }
  if (ctx.eventName !== "pull_request") {
    core.setFailed(
      `Unsupported event: ${ctx.eventName}. Use on: pull_request.`
    );
    return;
  }

  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.setFailed("No pull_request payload found.");
    return;
  }

  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const prNumber = pr.number;
  const headSha: string = pr.head.sha;
  const baseSha: string = pr.base.sha;
  const isDraft: boolean = !!pr.draft;
  const isFork: boolean = pr.head.repo?.full_name !== `${owner}/${repo}`;
  const labels: string[] = (pr.labels || []).map(
    (l: { name: string }) => l.name
  );

  const octokit = github.getOctokit(token);

  // Fork pull_request tokens can be read-only even when statuses:write is
  // requested. A skipped review must not fail just because its status cannot
  // be published; report the limitation rather than attempting the review.
  const publishSkippedStatus = async (description: string): Promise<void> => {
    try {
      await deps.setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "success",
        description
      );
    } catch (err) {
      const permissionError = deps.wrapPermissionError(
        err,
        "statuses:write",
        "createCommitStatus"
      );
      core.warning(
        `Could not publish skipped status: ${String(permissionError)}`
      );
    }
  };

  if (isDraft && skipDrafts) {
    core.info("Skipping draft PR.");
    await publishSkippedStatus("skipped: draft");
    return;
  }
  if (isFork && skipForks) {
    core.info("Skipping fork PR (skip_forks=true).");
    await publishSkippedStatus("skipped: fork");
    return;
  }
  if (labels.includes(bypassLabel)) {
    core.info(`Bypass label "${bypassLabel}" present — skipping review.`);
    await publishSkippedStatus(`skipped: bypass label (${bypassLabel})`);
    return;
  }

  try {
    try {
      await deps.setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "pending",
        reviewerBackend === "openai"
          ? "Qwen is reviewing this PR…"
          : "Jules is reviewing this PR…"
      );
    } catch (err) {
      throw deps.wrapPermissionError(
        err,
        "statuses:write",
        "createCommitStatus"
      );
    }

    // Determine the base SHA for incremental diffing
    let baseShaForDiff = baseSha;
    if (ctx.payload.action === "synchronize" && ctx.payload.before) {
      baseShaForDiff = ctx.payload.before;
      core.info(
        `Synchronize event detected. Reviewing incremental changes from ${baseShaForDiff} to ${headSha}`
      );
    } else {
      core.info(`Reviewing full PR diff from ${baseShaForDiff} to ${headSha}`);
    }

    const isIncrementalReview =
      ctx.payload.action === "synchronize" && !!ctx.payload.before;
    // GitHub only honours PR-body closing keywords when the PR targets the
    // repository default branch; for backport/release PRs to other branches the
    // referenced issues are not actually linked, so skip acceptance-criteria
    // grounding there to avoid false unmet-requirement findings.
    const defaultBranch = ctx.payload.repository?.default_branch;
    const groundInLinkedIssues =
      !defaultBranch || pr.base.ref === defaultBranch;

    const context = await deps.fetchPullRequestContext({
      octokit,
      owner,
      repo,
      pr,
      baseSha,
      baseShaForDiff,
      headSha,
      rulesFilePath,
      groundInLinkedIssues,
    });

    // Empty input → default generated-file globs; "none" → disable filtering;
    // otherwise the input is the explicit override list.
    const ignoreGlobsInput = core.getInput("review_ignore_globs").trim();
    const ignoreGlobs =
      ignoreGlobsInput.toLowerCase() === "none"
        ? []
        : ignoreGlobsInput
          ? parseIgnoreGlobs(ignoreGlobsInput)
          : DEFAULT_GENERATED_GLOBS;

    const allAnalyzerFindings = await deps.runAnalyzers({
      changedFiles: context.changedFiles,
      diff: context.diff,
      analyzerMode,
      analyzerOutputPaths,
    });
    // Drop findings on excluded generated files so they cannot seed comments.
    const analyzerFindings = allAnalyzerFindings.filter(
      (f) => !matchesAnyGlob(f.path, ignoreGlobs)
    );
    const selectedRuleFiles = deps.selectRuleFiles(context.changedFiles);
    const selectedRules =
      selectedRuleFiles.length > 0
        ? deps.loadSelectedRules(context.changedFiles)
        : "";

    const { diff: reviewDiff, excludedPaths } = filterDiffByPaths(
      context.diff,
      ignoreGlobs
    );
    if (excludedPaths.length > 0) {
      core.info(
        `Excluded ${excludedPaths.length} generated file(s) from the reviewed diff: ${excludedPaths.join(", ")}`
      );
    }
    const { text: diffText, truncatedNote } = truncateDiff(reviewDiff, 80_000);

    const ciSignal = await deps.fetchCiSignal({
      octokit,
      owner,
      repo,
      headSha,
      ownStatusContext: statusContext,
      mode: ciSignalMode,
      testReportPath,
      coverageSummaryPath,
    });

    // Other reviewers active inline findings, so the model can avoid restating
    // them (issue #15). Opt-in; best-effort (an empty list when disabled).
    const existingFindings =
      dedupeReviewers === "auto"
        ? await deps.fetchExistingFindings(octokit, owner, repo, prNumber)
        : [];

    const nonce = makeNonce();
    const prompt = deps.buildReviewPrompt({
      nonce,
      retrievalMode: retrievalMode === "auto",
      ciSignal,
      existingFindings,
      repoFullName: `${owner}/${repo}`,
      prNumber,
      prTitle: pr.title || "",
      prBody: pr.body || "",
      diff: diffText,
      diffTruncatedNote: truncatedNote,
      extraInstructions: extraInstructions || undefined,
      rulesFromFile: context.rulesFromFile,
      analyzerFindings,
      rules: selectedRules || undefined,
      openThreads: context.openThreads,
      linkedIssues: context.linkedIssues,
      incrementalReview: isIncrementalReview,
      excludedGeneratedPaths:
        excludedPaths.length > 0 ? excludedPaths : undefined,
      changedFileContext: buildChangedFileContext(
        context.files ?? new Map(),
        // Derive from the (possibly truncated) diff the model actually sees, so
        // context never covers hunks absent from the visible diff payload.
        extractChangedLines(diffText)
      ),
    });

    const previousSessionId = await loadPreviousReviewSessionId(
      deps,
      octokit,
      owner,
      repo,
      prNumber
    );
    const julesOptions = buildJulesReviewOptions(context);
    if (retrievalMode === "auto") {
      julesOptions.retrieval = {
        provider: createGithubRetrievalProvider({
          octokit,
          owner,
          repo,
          headSha,
          seedFiles: context.files,
        }),
        maxSteps: RETRIEVAL_MAX_STEPS,
        nonce,
      };
    }
    if (previousSessionId) {
      julesOptions.previousSessionId = previousSessionId;
    }

    // Keep the pending status current while the reviewer works. Without this the
    // status is written once and never touched again, so a review that started
    // seconds ago and one that has hung for half an hour look identical from
    // the PR page — a misread that has cost several early merges.
    julesOptions.onProgress = createHeartbeat({
      publish: (description) =>
        deps.setStatus(
          octokit,
          owner,
          repo,
          headSha,
          statusContext,
          "pending",
          description
        ),
      onError: (err) =>
        core.info(
          `Could not refresh review status: ${err instanceof Error ? err.message : String(err)}`
        ),
    });

    const reviewRun = await runSelectedReview({
      deps,
      backend: reviewerBackend,
      apiKey,
      fallbackApiKey,
      prompt,
      source: { github: `${owner}/${repo}`, baseBranch: pr.base.ref },
      timeoutMinutes,
      julesOptions,
    });
    const { sessionId, rawResponses } = reviewRun;
    // Scope the review to the PR's changed files before anything downstream
    // reads it (issue #91). A finding in a file the diff does not touch cannot
    // be actioned in this PR, so it is dropped before publishing, recorded on
    // the artifact, and a `block` resting only on such findings is downgraded
    // to `comment` — out-of-diff findings must never block.
    const scoped = reviewRun.reviewResult
      ? scopeReviewToDiff(
          reviewRun.reviewResult,
          context.prChangedFiles ?? context.changedFiles
        )
      : null;
    if (scoped && scoped.droppedComments.length > 0) {
      const dropped = scoped.droppedComments
        .map((comment) => `${comment.file}:${comment.line}`)
        .join(", ");
      core.warning(`Dropped out-of-diff finding(s): ${dropped}`);
    }
    const reviewResult = scoped ? scoped.review : null;
    const validationErrors = [
      ...(reviewRun.validationErrors ?? []),
      ...(scoped?.issues ?? []),
    ];
    const blankReview =
      reviewResult != null && isBlankReviewBody(reviewResult.summary);
    const outcome: ReviewOutcome = !reviewResult
      ? "TIMED_OUT_NO_CONTENT"
      : blankReview
        ? "EMPTY_REVIEW_BODY"
        : (reviewResult.newComments?.length ?? 0) > 0
          ? "REVIEWED_WITH_FINDINGS"
          : "REVIEWED_NO_FINDINGS";
    const reviewOutputChars = (rawResponses ?? []).reduce(
      (total, response) => total + response.length,
      0
    );
    const runIdentity: ReviewRunIdentity = {
      workflowRunId: ctx.runId,
      workflowRunAttempt: ctx.runAttempt,
      job: ctx.job,
    };

    // Attach drift-tolerant anchors so consumers can re-locate findings after a
    // rebase or force-push moves the line (issue #16). Additive: a no-op for
    // comments whose head content is unavailable.
    if (reviewResult?.newComments && reviewResult.newComments.length > 0) {
      enrichCommentsWithAnchors(
        reviewResult.newComments,
        context.files ?? new Map()
      );
    }

    const artifactName = `maxi-review-${prNumber}-${headSha}.json`;
    const artifactOutcomeReason: string | undefined = (() => {
      if (outcome === "TIMED_OUT_NO_CONTENT") {
        // The chain-exhausted case is reviewer-unavailable, distinct from the
        // bare Jules timeout. `runSelectedReview` tags that session id with
        // `openai:all-unavailable:`; everything else is the original
        // Jules-timeout text.
        const isReviewerUnavailable =
          typeof sessionId === "string" &&
          sessionId.startsWith("openai:all-unavailable:");
        return isReviewerUnavailable
          ? reviewerUnavailableExplanation(
              countOpenAiFallbackConfigs(core.getInput)
            )
          : reviewTimeoutExplanation(timeoutMinutes);
      }
      if (blankReview) {
        return emptyReviewExplanation(reviewResult.summary.length);
      }
      return undefined;
    })();
    const artifactContent = buildReviewArtifact({
      repoFullName: `${owner}/${repo}`,
      prNumber,
      headSha,
      baseSha,
      outcomeSchema: "maxi.review.v1.review-outcome",
      outcome,
      timeoutMinutes,
      outcomeReason: artifactOutcomeReason,
      reviewOutputChars,
      runIdentity,
      analyzerFindings,
      rawJulesResponses: rawResponses || [],
      validatedReview: blankReview ? null : reviewResult,
      validationErrors,
      droppedComments: scoped?.droppedComments ?? [],
      sessionId,
    });
    // The verdict is already decided -- it is in `reviewResult` above. What
    // follows only moves the record of it off this runner, over two independent
    // channels: the Actions artifact store (a 90-day archive humans download)
    // and a hidden PR comment (the channel `/maxi harvest` and calibration
    // actually read back, via listReviewArtifactComments). Neither channel
    // grades the PR, so a transport outage must not be reported as a failed
    // review.
    //
    // It has been. Artifact storage is a SHARED org-wide quota; when it is
    // exhausted every upload in the org fails with "Artifact storage quota has
    // been hit", and this call was unguarded, so a completed review surfaced as
    // "Jules PR review failed: Failed to CreateArtifact". Whether the org has
    // artifact storage left today is not a property of the code under review.
    //
    // Each channel is tolerated on its own; losing BOTH is still fatal. At that
    // point the review genuinely was not recorded anywhere and there is nothing
    // left to harvest, so failing loudly beats passing silently.
    let artifactUploaded = false;
    try {
      await deps.uploadArtifact(artifactName, artifactContent);
      artifactUploaded = true;
    } catch (err) {
      core.warning(
        `Failed to upload review artifact ${artifactName}: ${String(err)}`
      );
    }

    let artifactRecorded = false;
    try {
      await deps.recordReviewArtifact(
        octokit,
        owner,
        repo,
        prNumber,
        artifactName,
        buildArtifactCommentContent(artifactContent)
      );
      artifactRecorded = true;
    } catch (err) {
      core.warning(`Failed to record review artifact comment: ${String(err)}`);
    }

    if (!artifactUploaded && !artifactRecorded) {
      throw new Error(
        `Review completed but could not be recorded: both the artifact upload and the harvestable PR comment failed for ${artifactName}.`
      );
    }

    if (!reviewResult) {
      // Distinguish the chain-exhausted case from the bare Jules-no-review
      // case. `runSelectedReview` stamps session IDs with `openai:all-unavailable:`
      // when the entire fallback chain returned no review; that is the only
      // path that surfaces the "reviewer unavailable" wording rather than
      // the Jules-timeout one. Anything else (no fallback configured, the
      // primary reviewer alone was tried) keeps the original text.
      const reviewerUnavailable =
        typeof sessionId === "string" &&
        sessionId.startsWith("openai:all-unavailable:");
      const statusDescription = reviewerUnavailable
        ? reviewerUnavailableStatus(countOpenAiFallbackConfigs(core.getInput))
        : reviewTimeoutStatus(timeoutMinutes);
      const failureMessage = reviewerUnavailable
        ? reviewerUnavailableExplanation(
            countOpenAiFallbackConfigs(core.getInput)
          )
        : reviewTimeoutExplanation(timeoutMinutes);
      await deps.setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "failure",
        statusDescription
      );
      core.warning(`${failureMessage} Recorded a harvestable review artifact.`);
      await deps.writeJobSummary(0);
      core.setFailed(failureMessage);
      return;
    }

    const { verdict, summary, resolvedCommentIds, newComments } = reviewResult;

    // A parsed result with no body is the quiet sibling of a timeout: the
    // job used to return normally, so the Actions check stayed SUCCESS even
    // though nothing was reviewed. fail_on=never must not paint that green.
    if (isBlankReviewBody(summary)) {
      // A missing narrative must fail the check, but do not hide independently
      // actionable findings or thread resolutions returned by the reviewer.
      if (resolvedCommentIds?.length) {
        const threadIds = context.openThreads
          .filter((t) => resolvedCommentIds.includes(t.index))
          .map((t) => t.threadId);
        if (threadIds.length) {
          try {
            await deps.resolveThreads(octokit, threadIds);
          } catch (err) {
            core.warning(
              `Could not resolve empty-review threads: ${String(err)}`
            );
          }
        }
      }
      const publishableComments = (newComments || []).filter(
        (c) => !matchesAnyGlob(c.file, ignoreGlobs)
      );
      if (publishableComments.length) {
        try {
          await deps.submitReview(
            octokit,
            owner,
            repo,
            prNumber,
            headSha,
            `${COMMENT_MARKER}\n## Maxi Review\n\nThe review body was empty; the check failed, but these findings were returned.\n\n---\n_Session: \`${sessionId}\`_`,
            publishableComments
          );
        } catch (err) {
          core.warning(
            `Could not publish empty-review findings: ${String(err)}`
          );
        }
      }
      await deps.setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "failure",
        emptyReviewStatus(summary.length)
      );
      try {
        await deps.writeJobSummary(summary.length);
      } catch (err) {
        core.warning(`Could not write job summary: ${String(err)}`);
      }
      core.setFailed(emptyReviewExplanation(summary.length));
      return;
    }

    // Resolve threads that the LLM identified as fixed
    if (resolvedCommentIds && resolvedCommentIds.length > 0) {
      const threadIdsToResolve = context.openThreads
        .filter((t) => resolvedCommentIds.includes(t.index))
        .map((t) => t.threadId);

      if (threadIdsToResolve.length > 0) {
        await deps.resolveThreads(octokit, threadIdsToResolve);
      }
    }

    // Prepare body for the PR review
    const finalBody = `${COMMENT_MARKER}\n## Maxi Review\n\n${summary}\n\n---\n_Session: \`${sessionId}\`_`;

    await deps.submitReview(
      octokit,
      owner,
      repo,
      prNumber,
      headSha,
      finalBody,
      // Never post comments on excluded generated files, even if the model or
      // an analyzer produced one.
      (newComments || []).filter((c) => !matchesAnyGlob(c.file, ignoreGlobs))
    );

    const { state, description } =
      scoped &&
      scoped.droppedComments.length > 0 &&
      (scoped.review.newComments?.length ?? 0) === 0 &&
      failOn === "any"
        ? {
            state: "success" as const,
            description: "No in-diff findings; out-of-diff findings excluded",
          }
        : statusFromVerdict(verdict, failOn);
    await deps.setStatus(
      octokit,
      owner,
      repo,
      headSha,
      statusContext,
      state,
      description
    );
    try {
      await deps.writeJobSummary(summary.length);
    } catch (err) {
      core.warning(`Could not write job summary: ${String(err)}`);
    }

    core.info(`Verdict: ${verdict}. Status check: ${state}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.error(`Review failed: ${msg}`);

    await deps
      .setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "error",
        truncate(msg, 140)
      )
      .catch(() => {});
    core.setFailed(`Jules PR review failed: ${msg}`);
  }
}

export async function fetchPullRequestContext(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pr: { number: number; body?: string | null };
  baseSha: string;
  baseShaForDiff: string;
  headSha: string;
  rulesFilePath: string;
  groundInLinkedIssues: boolean;
}): Promise<PullRequestContext> {
  const diff = await fetchDiff(
    input.octokit,
    input.owner,
    input.repo,
    input.pr,
    input.baseShaForDiff,
    input.headSha
  );

  let rulesFromFile: string | undefined;
  if (input.rulesFilePath) {
    rulesFromFile = await loadRulesFromBase(
      input.octokit,
      input.owner,
      input.repo,
      input.rulesFilePath,
      input.baseSha
    );
  }

  const openThreads = await fetchOpenThreads(
    input.octokit,
    input.owner,
    input.repo,
    input.pr.number
  );
  const changedFiles = extractChangedFiles(diff);
  // On an incremental (synchronize) review the diff only covers the latest
  // push. Scoping must see every file the PR touches, or a finding on a file
  // changed by an earlier push is dropped and a block resting on it is
  // downgraded. Fetch the full PR diff only when the incremental base differs.
  const prChangedFiles =
    input.baseShaForDiff === input.baseSha
      ? changedFiles
      : extractChangedFiles(
          await fetchDiff(
            input.octokit,
            input.owner,
            input.repo,
            input.pr,
            input.baseSha,
            input.headSha
          )
        );

  const linkedIssueRefs = input.groundInLinkedIssues
    ? parseClosingIssueRefs(input.pr.body, {
        owner: input.owner,
        repo: input.repo,
      })
    : [];
  const linkedIssues =
    linkedIssueRefs.length > 0
      ? await fetchLinkedIssues(input.octokit, linkedIssueRefs)
      : [];

  return {
    diff,
    changedFiles,
    prChangedFiles,
    linkedIssues,
    files: await loadHeadFiles(
      input.octokit,
      input.owner,
      input.repo,
      input.headSha,
      changedFiles
    ),
    changedLines: extractChangedLines(diff),
    rulesFromFile,
    openThreads,
  };
}

export async function runAnalyzers(
  input: RunAnalyzerInput
): Promise<AnalyzerFinding[]> {
  if (input.analyzerMode === "off") return [];

  const findings: AnalyzerFinding[] = [];
  const paths = input.analyzerOutputPaths || {};
  findings.push(...parseAnalyzerFile(paths.opengrepJson, parseOpengrepJson));
  findings.push(...parseAnalyzerFile(paths.opengrepSarif, parseOpengrepSarif));
  findings.push(...parseAnalyzerFile(paths.pmdXml, parsePmdXml));
  findings.push(...parseAnalyzerFile(paths.cpdXml, parseCpdXml));
  if (findings.length > 0 || hasConfiguredAnalyzerOutput(paths)) {
    return findings;
  }

  const executeAnalyzer = input.executeAnalyzer || executeExternalAnalyzer;
  findings.push(
    ...(await runAnalyzerCommand(
      executeAnalyzer,
      "opengrep",
      ["scan", "--json", "--metrics", "off", "--disable-version-check", "."],
      parseOpengrepJson
    ))
  );
  findings.push(
    ...(await runAnalyzerCommand(
      executeAnalyzer,
      "pmd",
      [
        "check",
        "--format",
        "xml",
        "--dir",
        ".",
        "--rulesets",
        "category/java/bestpractices.xml",
      ],
      parsePmdXml
    ))
  );
  findings.push(
    ...(await runAnalyzerCommand(
      executeAnalyzer,
      "pmd",
      ["cpd", "--format", "xml", "--dir", ".", "--minimum-tokens", "100"],
      parseCpdXml
    ))
  );
  return findings;
}

export async function uploadReviewArtifact(
  name: string,
  content: string,
  uploader?: ArtifactUploader
): Promise<void> {
  const client = uploader || (await loadArtifactUploader());
  const root = await mkdtemp(join(tmpdir(), "maxi-review-"));
  const filename = basename(name);
  const path = join(root, filename);
  try {
    await writeFile(path, content, "utf8");
    const uploaded = await client.uploadArtifact(name, [path], root, {
      retentionDays: 90,
    });
    core.info(
      `Uploaded review artifact ${name} (${content.length} bytes${uploaded.id ? `, id ${uploaded.id}` : ""}).`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function unquoteGitPath(path: string): string {
  // Git quotes non-ASCII UTF-8 as octal bytes (core.quotePath=true).
  const bytes: number[] = [];
  for (const match of path.matchAll(/\\([0-7]{3}|.)|[^\\]+/g)) {
    if (!match[1]) bytes.push(...Buffer.from(match[0]));
    else if (/^[0-7]{3}$/.test(match[1])) bytes.push(parseInt(match[1], 8));
    else bytes.push(...Buffer.from({ t: "\t", n: "\n" }[match[1]] ?? match[1]));
  }
  return Buffer.from(bytes).toString("utf8");
}

function diffHeaderPath(line: string): string | undefined {
  const plain = line.match(/^diff --git a\/.*? b\/(.+)$/);
  if (plain) return plain[1];
  const quoted = line.match(
    /^diff --git "a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/
  );
  return quoted ? unquoteGitPath(quoted[2]) : undefined;
}

export function extractChangedFiles(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const path = diffHeaderPath(line);
    if (path) paths.add(path);
  }
  return [...paths];
}

export function extractChangedLines(diff: string): Map<string, Set<number>> {
  const changedLines = new Map<string, Set<number>>();
  let currentPath: string | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const headerPath = diffHeaderPath(line);
    if (headerPath !== undefined) {
      currentPath = headerPath;
      if (!changedLines.has(currentPath)) {
        changedLines.set(currentPath, new Set());
      }
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (!currentPath || line.length === 0) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      changedLines.get(currentPath)?.add(newLine);
      newLine++;
      continue;
    }
    if (line.startsWith("-")) continue;
    newLine++;
  }

  return new Map([...changedLines].filter(([, lines]) => lines.size > 0));
}

async function loadHeadFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  paths: string[]
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of paths) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: headSha,
      });
      if (
        "content" in response.data &&
        typeof response.data.content === "string"
      ) {
        files.set(
          path,
          Buffer.from(response.data.content, "base64").toString("utf8")
        );
      }
    } catch (err) {
      core.warning(
        `Failed to load ${path} at PR head for validation: ${String(err)}`
      );
    }
  }
  return files;
}

function buildJulesReviewOptions(
  context: PullRequestContext
): RunJulesReviewOptions {
  if (!context.files || !context.changedLines) return {};
  return {
    verificationContext: {
      files: context.files,
      changedLines: context.changedLines,
    },
  };
}

async function loadPreviousReviewSessionId(
  deps: ReviewPrDeps,
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string | undefined> {
  try {
    const comments = await deps.listReviewArtifactComments(
      octokit,
      owner,
      repo,
      prNumber
    );
    return latestReviewArtifactSessionId(comments);
  } catch (err) {
    core.warning(
      `Failed to load previous Maxi review artifact session: ${String(err)}`
    );
    return undefined;
  }
}

export function latestReviewArtifactSessionId(
  comments: string[]
): string | undefined {
  for (const body of [...comments].reverse()) {
    const artifact = extractReviewArtifactFromComment(body);
    if (!artifact?.sessionId) continue;
    if (artifact.outcome === "EMPTY_REVIEW_BODY") continue;
    // Never resume a session that produced no review. A hung/stuck Jules session
    // (no responses, no validated review) would otherwise be resumed on every
    // retry via startReviewSession(previousSessionId) and time out identically,
    // trapping the PR. Treat it as dead, keep looking for an older session that
    // actually responded, and fall back to a fresh session when none did.
    const responded =
      (artifact.rawJulesResponses?.length ?? 0) > 0 ||
      artifact.validatedReview != null;
    if (!responded) continue;
    return artifact.sessionId;
  }
  return undefined;
}

function extractReviewArtifactFromComment(body: string): ReviewArtifact | null {
  if (!body.includes("<!-- maxi-review artifact -->")) return null;
  const encodedMatch = body.match(
    /<!-- maxi-review artifact[\s\S]*?encoding:\s*base64\s*\n([A-Za-z0-9+/=\s]+?)\n-->/
  );
  if (encodedMatch) {
    return parseReviewArtifactJson(
      Buffer.from(encodedMatch[1].replace(/\s/g, ""), "base64").toString("utf8")
    );
  }

  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  return parseReviewArtifactJson(match[1]);
}

function parseReviewArtifactJson(json: string): ReviewArtifact | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    const validated = validateReviewArtifact(parsed);
    return validated.ok ? (parsed as ReviewArtifact) : null;
  } catch {
    return null;
  }
}

function parseAnalyzerFile(
  path: string | undefined,
  parser: (text: string) => AnalyzerFinding[]
): AnalyzerFinding[] {
  if (!path) return [];
  if (!existsSync(path)) {
    core.warning(`Analyzer output path does not exist: ${path}`);
    return [];
  }
  try {
    return parser(readFileSync(path, "utf8"));
  } catch (err) {
    core.warning(`Failed to parse analyzer output ${path}: ${String(err)}`);
    return [];
  }
}

async function runAnalyzerCommand(
  executeAnalyzer: (command: string, args: string[]) => Promise<string>,
  command: string,
  args: string[],
  parser: (text: string) => AnalyzerFinding[]
): Promise<AnalyzerFinding[]> {
  try {
    const output = await executeAnalyzer(command, args);
    return output.trim() ? parser(output) : [];
  } catch (err) {
    if (isCommandNotFoundError(err)) {
      core.warning(
        `Optional analyzer command not found (${command}); skipping this analyzer. Install ${command} or provide a machine-readable output file to include its findings.`
      );
      return [];
    }
    core.warning(
      `Analyzer command failed (${command} ${args.join(" ")}): ${String(err)}`
    );
    return [];
  }
}

function isCommandNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

async function executeExternalAnalyzer(
  command: string,
  args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: ANALYZER_TIMEOUT_MS,
  });
  return stdout;
}

async function loadArtifactUploader(): Promise<ArtifactUploader> {
  const artifact = await import("@actions/artifact");
  return artifact.default;
}

export function buildArtifactCommentContent(content: string): string {
  try {
    const artifact = JSON.parse(content) as { rawJulesResponses?: unknown };
    if (!artifact || typeof artifact !== "object") {
      return content;
    }
    if (Array.isArray(artifact.rawJulesResponses)) {
      artifact.rawJulesResponses = [];
    }
    return JSON.stringify(artifact, null, 2);
  } catch {
    return content;
  }
}

function hasConfiguredAnalyzerOutput(
  paths: NonNullable<RunAnalyzerInput["analyzerOutputPaths"]>
): boolean {
  return Boolean(
    paths.opengrepJson || paths.opengrepSarif || paths.pmdXml || paths.cpdXml
  );
}

function truncateDiff(
  diff: string,
  maxChars: number
): { text: string; truncatedNote?: string } {
  if (diff.length <= maxChars) return { text: diff };
  const text = diff.slice(0, maxChars);
  return {
    text,
    truncatedNote: `The diff was truncated: original ${diff.length} chars, kept first ${maxChars}. Some changes are not visible in the diff above; your review of the visible portion should state this caveat.`,
  };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function statusFromVerdict(
  verdict: Verdict,
  failOn: FailOn
): { state: "success" | "failure"; description: string } {
  if (failOn === "never") {
    return {
      state: "success",
      description: `Review complete (verdict: ${verdict})`,
    };
  }
  if (failOn === "any") {
    return verdict === "approve"
      ? { state: "success", description: "Approved" }
      : { state: "failure", description: `Review verdict: ${verdict}` };
  }
  return verdict === "block"
    ? { state: "failure", description: "Blocking issues found" }
    : {
        state: "success",
        description: `Review complete (verdict: ${verdict})`,
      };
}
