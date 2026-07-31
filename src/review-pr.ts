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
import { buildReviewPrompt } from "./prompt.js";
import { fetchCiSignal } from "./ci-signal.js";
import { enrichCommentsWithAnchors } from "./anchor.js";
import { createGithubRetrievalProvider } from "./retrieval.js";
import { fetchLinkedIssues, parseClosingIssueRefs } from "./linked-issues.js";
import { makeNonce } from "./untrusted.js";
import { buildChangedFileContext } from "./context-window.js";
import {
  DEFAULT_GENERATED_GLOBS,
  filterDiffByPaths,
  matchesAnyGlob,
  parseIgnoreGlobs,
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

export interface PullRequestContext {
  diff: string;
  changedFiles: string[];
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
  submitReview: typeof submitReview;
  resolveThreads: typeof resolveThreads;
  setStatus: typeof setStatus;
  uploadArtifact: (name: string, content: string) => Promise<void>;
  recordReviewArtifact: typeof recordReviewArtifactComment;
  listReviewArtifactComments: typeof listReviewArtifactComments;
  wrapPermissionError: typeof wrapPermissionError;
  writeJobSummary: (collectedCharacters: number) => Promise<void>;
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
  submitReview,
  resolveThreads,
  setStatus,
  uploadArtifact: uploadReviewArtifact,
  recordReviewArtifact: recordReviewArtifactComment,
  listReviewArtifactComments,
  wrapPermissionError,
  writeJobSummary: async (collectedCharacters: number) => {
    await core.summary
      .addHeading("Maxi Review")
      .addRaw(`Collected characters: ${collectedCharacters}`)
      .write();
  },
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

    const { reviewResult, sessionId, rawResponses, validationErrors } =
      await deps.runJulesReview(
        apiKey,
        prompt,
        { github: `${owner}/${repo}`, baseBranch: pr.base.ref },
        timeoutMinutes,
        julesOptions
      );

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
    try {
      await deps.recordReviewArtifact(
        octokit,
        owner,
        repo,
        prNumber,
        artifactName,
        buildArtifactCommentContent(artifactContent)
      );
    } catch (err) {
      core.warning(`Failed to record review artifact comment: ${String(err)}`);
    }

    if (!reviewResult) {
      await deps.setStatus(
        octokit,
        owner,
        repo,
        headSha,
        statusContext,
        "failure",
        "Review timed out; see harvested artifact"
      );
      core.warning(
        `Jules returned no review message within ${timeoutMinutes} minutes; recorded a harvestable review artifact.`
      );
      await deps.writeJobSummary(0);
      core.setFailed(
        `Jules returned no review message within ${timeoutMinutes} minutes; recorded a harvestable review artifact.`
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

export function extractChangedFiles(diff: string): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/.* b\/(.+)$/gm)) {
    paths.add(match[1]);
  }
  return [...paths];
}

export function extractChangedLines(diff: string): Map<string, Set<number>> {
  const changedLines = new Map<string, Set<number>>();
  let currentPath: string | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/.* b\/(.+)$/);
    if (fileMatch) {
      currentPath = fileMatch[1];
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
