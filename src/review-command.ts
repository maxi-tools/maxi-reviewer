import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  applyStructuredSuggestions,
  ApplyResult,
  buildApplyAllCommitMessage,
  validateApplyAllHead,
} from "./apply.js";
import { authorizeHandsOnFix, buildHandsOnFixPrompt } from "./hands-on-fix.js";
import { startJulesHandsOnFix } from "./jules.js";
import { JulesReviewComment, ReviewComment } from "./types.js";

export type ReviewCommand =
  | { kind: "apply-all" }
  | { kind: "fix"; findingId: string }
  | { kind: "unknown" };

export interface ReviewArtifactLike {
  schema?: string;
  headSha?: string;
  validatedReview?: unknown;
}

export interface ApplyAllPlanInput {
  artifact: ReviewArtifactLike;
  files: Map<string, string>;
  expectedHeadSha: string;
  currentHeadSha: string;
}

export interface ApplyAllPlan {
  ok: boolean;
  reason?: string;
  result?: ApplyResult;
  commitMessage?: string;
}

export interface ReviewCommandContext {
  body: string;
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface ReviewCommandPullRequest {
  number: number;
  headSha: string;
  headRef: string;
  headRepository: string;
  repository: string;
  tokenPermissions: { contents?: string; pullRequests?: string };
}

export interface ReviewCommandDeps {
  getContext: () => ReviewCommandContext;
  fetchPullRequest: (
    owner: string,
    repo: string,
    issueNumber: number
  ) => Promise<ReviewCommandPullRequest | null>;
  listArtifactComments: (
    owner: string,
    repo: string,
    issueNumber: number
  ) => Promise<string[]>;
  readFiles: (input: {
    owner: string;
    repo: string;
    ref: string;
    paths: string[];
  }) => Promise<Map<string, string>>;
  commitFiles: (input: {
    owner: string;
    repo: string;
    branch: string;
    expectedHeadSha: string;
    message: string;
    files: Map<string, string>;
  }) => Promise<void>;
  startHandsOnFix: (input: {
    owner: string;
    repo: string;
    prNumber: number;
    branch: string;
    findingId: string;
    prompt: string;
  }) => Promise<void>;
  comment: (body: string) => Promise<void>;
}

export function parseReviewCommand(body: string): ReviewCommand {
  const text = body.trim();
  if (/^\/maxi\s+apply-all\b/.test(text)) {
    return { kind: "apply-all" };
  }
  const fix = text.match(/^\/maxi\s+fix\s+([A-Za-z0-9_.:-]+)\b/);
  if (fix) {
    return { kind: "fix", findingId: fix[1] };
  }
  return { kind: "unknown" };
}

export async function runReviewCommand(
  overrides: Partial<ReviewCommandDeps> = {}
): Promise<void> {
  const deps = hasAllReviewCommandDeps(overrides)
    ? overrides
    : { ...defaultReviewCommandDeps(), ...overrides };
  const context = deps.getContext();
  const command = parseReviewCommand(context.body);
  if (command.kind === "unknown") {
    core.info("Ignoring non-Maxi review command.");
    return;
  }

  const pr = await deps.fetchPullRequest(
    context.owner,
    context.repo,
    context.issueNumber
  );
  if (!pr) {
    await deps.comment("Maxi review commands only work on pull requests.");
    return;
  }

  const artifact = await latestReviewArtifact(
    deps,
    context.owner,
    context.repo,
    context.issueNumber
  );
  if (!artifact) {
    await deps.comment(
      "No Maxi review artifact was found for this pull request."
    );
    return;
  }

  if (command.kind === "apply-all") {
    await runApplyAllCommand(deps, context, pr, artifact);
    return;
  }

  await runFixCommand(deps, context, pr, artifact, command.findingId);
}

export function extractReviewArtifact(body: string): ReviewArtifactLike | null {
  if (!body.includes("<!-- maxi-review artifact -->")) return null;
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ReviewArtifactLike;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildApplyAllPlan(input: ApplyAllPlanInput): ApplyAllPlan {
  const head = validateApplyAllHead(
    input.expectedHeadSha,
    input.currentHeadSha
  );
  if (!head.ok) {
    return { ok: false, reason: head.reason };
  }

  const comments = artifactComments(input.artifact);
  const result = applyStructuredSuggestions(input.files, comments);
  return {
    ok: true,
    result,
    commitMessage: buildApplyAllCommitMessage(result.applied.length),
  };
}

function artifactComments(
  artifact: ReviewArtifactLike
): Array<ReviewComment | JulesReviewComment> {
  const review = asRecord(artifact.validatedReview);
  if (!review) return [];
  if (Array.isArray(review.comments)) {
    return review.comments as JulesReviewComment[];
  }
  if (Array.isArray(review.newComments)) {
    return review.newComments as ReviewComment[];
  }
  return [];
}

async function runApplyAllCommand(
  deps: ReviewCommandDeps,
  context: ReviewCommandContext,
  pr: ReviewCommandPullRequest,
  artifact: ReviewArtifactLike
): Promise<void> {
  const comments = artifactComments(artifact);
  const paths = [...new Set(comments.map((comment) => commentPath(comment)))];
  const files = await deps.readFiles({
    owner: context.owner,
    repo: context.repo,
    ref: pr.headSha,
    paths,
  });
  const plan = buildApplyAllPlan({
    artifact,
    files,
    expectedHeadSha: artifact.headSha || "",
    currentHeadSha: pr.headSha,
  });
  if (!plan.ok || !plan.result || !plan.commitMessage) {
    await deps.comment(`Could not apply Maxi suggestions: ${plan.reason}`);
    return;
  }
  if (plan.result.applied.length === 0) {
    await deps.comment(
      `No Maxi suggestions were applied. Skipped ${plan.result.skipped.length}.`
    );
    return;
  }

  try {
    await deps.commitFiles({
      owner: context.owner,
      repo: context.repo,
      branch: pr.headRef,
      expectedHeadSha: pr.headSha,
      message: plan.commitMessage,
      files: changedFilesOnly(files, plan.result.files),
    });
  } catch (err) {
    await deps.comment(
      `Could not apply Maxi suggestions: ${errorMessage(err)}`
    );
    return;
  }
  await deps.comment(
    `Applied ${plan.result.applied.length} Maxi suggestion${
      plan.result.applied.length === 1 ? "" : "s"
    }. Skipped ${plan.result.skipped.length}.`
  );
}

async function runFixCommand(
  deps: ReviewCommandDeps,
  context: ReviewCommandContext,
  pr: ReviewCommandPullRequest,
  artifact: ReviewArtifactLike,
  findingId: string
): Promise<void> {
  const comments = artifactComments(artifact);
  const availableFindingIds = comments
    .map((comment) => ("id" in comment ? comment.id : undefined))
    .filter((id): id is string => !!id);
  const authorization = authorizeHandsOnFix({
    command: context.body.trim(),
    repository: pr.repository,
    headRepository: pr.headRepository,
    requestedFindingId: findingId,
    availableFindingIds,
    tokenPermissions: pr.tokenPermissions,
  });
  if (!authorization.ok) {
    await deps.comment(
      `Could not start hands-on Maxi fix: ${authorization.reason}`
    );
    return;
  }

  const comment = comments.find(
    (candidate): candidate is JulesReviewComment =>
      "id" in candidate && candidate.id === findingId
  );
  if (!comment) {
    await deps.comment(`Could not find Maxi review finding ${findingId}.`);
    return;
  }

  await deps.startHandsOnFix({
    owner: context.owner,
    repo: context.repo,
    prNumber: pr.number,
    branch: pr.headRef,
    findingId,
    prompt: buildHandsOnFixPrompt(comment),
  });
  await deps.comment(`Started hands-on Maxi fix session for ${findingId}.`);
}

async function latestReviewArtifact(
  deps: ReviewCommandDeps,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<ReviewArtifactLike | null> {
  const comments = await deps.listArtifactComments(owner, repo, issueNumber);
  for (const body of comments.slice().reverse()) {
    const artifact = extractReviewArtifact(body);
    if (artifact) return artifact;
  }
  return null;
}

function commentPath(comment: ReviewComment | JulesReviewComment): string {
  return "suggestion" in comment && comment.suggestion
    ? comment.suggestion.path
    : (comment as ReviewComment).file;
}

function changedFilesOnly(
  before: Map<string, string>,
  after: Map<string, string>
): Map<string, string> {
  return new Map(
    [...after.entries()].filter(
      ([path, content]) => before.get(path) !== content
    )
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function hasAllReviewCommandDeps(
  deps: Partial<ReviewCommandDeps>
): deps is ReviewCommandDeps {
  return [
    deps.getContext,
    deps.fetchPullRequest,
    deps.listArtifactComments,
    deps.readFiles,
    deps.commitFiles,
    deps.startHandsOnFix,
    deps.comment,
  ].every(Boolean);
}

function defaultReviewCommandDeps(): ReviewCommandDeps {
  const token = core.getInput("github_token", { required: true });
  const octokit = github.getOctokit(token);
  return {
    getContext: () => {
      const ctx = github.context;
      return {
        body: String(ctx.payload.comment?.body || ""),
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        issueNumber: Number(ctx.payload.issue?.number || 0),
      };
    },
    fetchPullRequest: async (owner, repo, issueNumber) => {
      const issue = github.context.payload.issue;
      if (!issue?.pull_request) return null;
      const response = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: issueNumber,
      });
      const pr = response.data;
      return {
        number: pr.number,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        headRepository: pr.head.repo?.full_name || "",
        repository: `${owner}/${repo}`,
        tokenPermissions: {
          contents: "write",
          pullRequests: "write",
        },
      };
    },
    listArtifactComments: async (owner, repo, issueNumber) => {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
        }
      );
      return comments
        .map((comment) => comment.body || "")
        .filter((body) => body.includes("<!-- maxi-review artifact -->"));
    },
    readFiles: async ({ owner, repo, ref, paths }) => {
      const files = new Map<string, string>();
      for (const path of paths) {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
        });
        if (!("content" in response.data)) continue;
        files.set(
          path,
          Buffer.from(response.data.content, "base64").toString("utf8")
        );
      }
      return files;
    },
    commitFiles: async ({
      owner,
      repo,
      branch,
      expectedHeadSha,
      message,
      files,
    }) => {
      if (files.size === 0) return;
      const ref = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      const latestCommitSha = ref.data.object.sha;
      if (latestCommitSha !== expectedHeadSha) {
        throw new Error(
          `stale head SHA: expected ${expectedHeadSha}, got ${latestCommitSha}`
        );
      }
      const latestCommit = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: latestCommitSha,
      });
      const tree = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: latestCommit.data.tree.sha,
        tree: await Promise.all(
          [...files.entries()].map(async ([path, content]) => {
            const blob = await octokit.rest.git.createBlob({
              owner,
              repo,
              content,
              encoding: "utf-8",
            });
            return {
              path,
              mode: "100644" as const,
              type: "blob" as const,
              sha: blob.data.sha,
            };
          })
        ),
      });
      const commit = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.data.sha,
        parents: [latestCommitSha],
      });
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      });
    },
    startHandsOnFix: async ({ owner, repo, branch, prompt }) => {
      const apiKey = core.getInput("jules_api_key", { required: true });
      core.setSecret(apiKey);
      await startJulesHandsOnFix(apiKey, prompt, {
        github: `${owner}/${repo}`,
        baseBranch: branch,
      });
    },
    comment: async (body) => {
      const context = github.context;
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: Number(context.payload.issue?.number || 0),
        body,
      });
    },
  };
}
