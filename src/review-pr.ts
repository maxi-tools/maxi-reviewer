import * as core from "@actions/core";
import * as github from "@actions/github";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import {
  AnalyzerFinding,
  FailOn,
  OpenThread,
  ReviewComment,
  Verdict,
} from "./types.js";
import {
  fetchDiff,
  loadRulesFromBase,
  fetchOpenThreads,
  resolveThreads,
  submitReview,
  setStatus,
  recordReviewArtifactComment,
} from "./github.js";
import { runJulesReview, wrapPermissionError } from "./jules.js";
import { buildReviewPrompt } from "./prompt.js";
import { loadSelectedRules, selectRuleFiles } from "./rules/select.js";
import { buildReviewArtifact } from "./late-feedback-harvest.js";
import { parseOpengrepJson, parseOpengrepSarif } from "./analyzers/opengrep.js";
import { parseCpdXml, parsePmdXml } from "./analyzers/pmd.js";

const COMMENT_MARKER = "<!-- jules-pr-reviewer -->";
const VALID_FAIL_ON: FailOn[] = ["never", "blocking", "any"];
const execFileAsync = promisify(execFile);

type Octokit = ReturnType<typeof github.getOctokit>;

export interface PullRequestContext {
  diff: string;
  changedFiles: string[];
  rulesFromFile?: string;
  openThreads: OpenThread[];
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
    pr: { number: number };
    baseSha: string;
    baseShaForDiff: string;
    headSha: string;
    rulesFilePath: string;
  }) => Promise<PullRequestContext>;
  selectRuleFiles: typeof selectRuleFiles;
  loadSelectedRules: typeof loadSelectedRules;
  runAnalyzers: (input: RunAnalyzerInput) => Promise<AnalyzerFinding[]>;
  buildReviewPrompt: typeof buildReviewPrompt;
  runJulesReview: (
    apiKey: string,
    prompt: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source: any,
    timeoutMinutes: number
  ) => Promise<JulesReviewRunResult>;
  submitReview: typeof submitReview;
  resolveThreads: typeof resolveThreads;
  setStatus: typeof setStatus;
  uploadArtifact: (name: string, content: string) => Promise<void>;
  recordReviewArtifact: typeof recordReviewArtifactComment;
  wrapPermissionError: typeof wrapPermissionError;
}

const defaultDeps: ReviewPrDeps = {
  fetchPullRequestContext,
  selectRuleFiles,
  loadSelectedRules,
  runAnalyzers,
  buildReviewPrompt,
  runJulesReview,
  submitReview,
  resolveThreads,
  setStatus,
  uploadArtifact: uploadReviewArtifact,
  recordReviewArtifact: recordReviewArtifactComment,
  wrapPermissionError,
};

export async function runReviewPr(
  overrides: Partial<ReviewPrDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps, ...overrides };
  const apiKey = core.getInput("jules_api_key", { required: true });
  core.setSecret(apiKey);

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

  if (isDraft && skipDrafts) {
    core.info("Skipping draft PR.");
    return;
  }
  if (isFork && skipForks) {
    core.info("Skipping fork PR (skip_forks=true).");
    return;
  }
  if (labels.includes(bypassLabel)) {
    core.info(`Bypass label "${bypassLabel}" present — skipping review.`);
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
        "Jules is reviewing this PR…"
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

    const context = await deps.fetchPullRequestContext({
      octokit,
      owner,
      repo,
      pr,
      baseSha,
      baseShaForDiff,
      headSha,
      rulesFilePath,
    });

    const analyzerFindings = await deps.runAnalyzers({
      changedFiles: context.changedFiles,
      diff: context.diff,
      analyzerMode,
      analyzerOutputPaths,
    });
    const selectedRuleFiles = deps.selectRuleFiles(context.changedFiles);
    const selectedRules =
      selectedRuleFiles.length > 0
        ? deps.loadSelectedRules(context.changedFiles)
        : "";

    const { text: diffText, truncatedNote } = truncateDiff(
      context.diff,
      80_000
    );

    const prompt = deps.buildReviewPrompt({
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
    });

    const { reviewResult, sessionId, rawResponses, validationErrors } =
      await deps.runJulesReview(
        apiKey,
        prompt,
        { github: `${owner}/${repo}`, baseBranch: pr.base.ref },
        timeoutMinutes
      );

    const artifactName = `maxi-review-${prNumber}-${headSha}.json`;
    const artifactContent = buildReviewArtifact({
      repoFullName: `${owner}/${repo}`,
      prNumber,
      headSha,
      baseSha,
      analyzerFindings,
      rawJulesResponses: rawResponses || [],
      validatedReview: reviewResult,
      validationErrors: validationErrors || [],
      sessionId,
    });
    await deps.uploadArtifact(artifactName, artifactContent);
    await deps.recordReviewArtifact(
      octokit,
      owner,
      repo,
      prNumber,
      artifactName,
      artifactContent
    );

    if (!reviewResult) {
      await deps.setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "error",
        "Jules did not return a valid review in time"
      );
      core.setFailed(
        `Jules returned no review message within ${timeoutMinutes} minutes.`
      );
      return;
    }

    const { verdict, summary, resolvedCommentIds, newComments } = reviewResult;

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
    const finalBody = `${COMMENT_MARKER}\n## 🤖 Jules Review\n\n${summary}\n\n---\n_Session: \`${sessionId}\`_`;

    await deps.submitReview(
      octokit,
      owner,
      repo,
      prNumber,
      headSha,
      finalBody,
      newComments || []
    );

    const { state, description } = statusFromVerdict(verdict, failOn);
    await deps.setStatus(
      octokit,
      owner,
      repo,
      headSha,
      statusContext,
      state,
      description
    );

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
  pr: { number: number };
  baseSha: string;
  baseShaForDiff: string;
  headSha: string;
  rulesFilePath: string;
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

  return {
    diff,
    changedFiles: extractChangedFiles(diff),
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
  content: string
): Promise<void> {
  core.info(`Prepared review artifact ${name} (${content.length} bytes).`);
}

export function extractChangedFiles(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/.* b\/(.+)$/gm)) {
    paths.add(match[1]);
  }
  return [...paths];
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
    core.warning(
      `Analyzer command failed (${command} ${args.join(" ")}): ${String(err)}`
    );
    return [];
  }
}

async function executeExternalAnalyzer(
  command: string,
  args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
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
