import * as github from "@actions/github";
import * as core from "@actions/core";
import { OpenThread, ReviewComment } from "./types.js";

export async function fetchDiff(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pr: { number: number },
  baseShaForDiff: string,
  headSha: string
): Promise<string> {
  try {
    const compare = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseShaForDiff}...${headSha}`,
      mediaType: { format: "diff" },
    });
    const data = compare.data as unknown;
    if (typeof data === "string") return data;
  } catch (err) {
    core.warning(
      `compareCommitsWithBasehead failed, falling back to pulls.get: ${String(err)}`
    );
  }

  // fallback to full PR diff
  const res = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pr.number,
    mediaType: { format: "diff" },
  });
  const data = res.data as unknown;
  if (typeof data === "string") return data;

  throw new Error("GitHub returned no diff text.");
}

export async function loadRulesFromBase(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  path: string,
  baseSha: string
): Promise<string | undefined> {
  try {
    const file = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: baseSha,
    });
    if ("content" in file.data && typeof file.data.content === "string") {
      const content = Buffer.from(file.data.content, "base64").toString("utf8");
      core.info(`Loaded ${content.length} chars from ${path} at base SHA`);
      return content;
    }
    return undefined;
  } catch (err) {
    core.warning(`Failed to load rules from base: ${String(err)}`);
    return undefined;
  }
}

export async function fetchOpenThreads(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<OpenThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 20) {
                nodes {
                  body
                  path
                  line
                  author { login }
                  viewerDidAuthor
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response: any = await octokit.graphql(query, {
    owner,
    repo,
    pr: prNumber,
  });
  const threads = response.repository?.pullRequest?.reviewThreads?.nodes || [];

  let index = 1;
  const result: OpenThread[] = [];
  for (const thread of threads) {
    if (thread.isResolved) continue;
    const firstComment = thread.comments.nodes[0];
    if (!firstComment) continue;
    if (
      firstComment.viewerDidAuthor &&
      (firstComment.body.includes("<!-- maxi-review-inline-comment -->") ||
        firstComment.body.includes("<!-- jules-inline-comment -->"))
    ) {
      result.push({
        index: index++,
        threadId: thread.id,
        path: firstComment.path,
        line: firstComment.line || 0,
        body: firstComment.body,
        comments: thread.comments.nodes.map(
          (comment: {
            body: string;
            line?: number | null;
            author?: { login?: string } | null;
            viewerDidAuthor?: boolean;
            createdAt?: string;
          }) => ({
            author: comment.author?.login || "unknown",
            body: comment.body,
            line: comment.line || 0,
            viewerDidAuthor: !!comment.viewerDidAuthor,
            createdAt: comment.createdAt,
          })
        ),
      });
    }
  }
  return result;
}

export async function resolveThreads(
  octokit: ReturnType<typeof github.getOctokit>,
  threadIds: string[]
): Promise<void> {
  for (const id of threadIds) {
    try {
      await octokit.graphql(
        `
        mutation($id: ID!) {
          resolveReviewThread(input: {threadId: $id}) {
            thread { isResolved }
          }
        }
      `,
        { id }
      );
      core.info(`Resolved thread ${id}`);
    } catch (e) {
      core.warning(`Failed to resolve thread ${id}: ${e}`);
    }
  }
}

export async function submitReview(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  summary: string,
  comments: ReviewComment[]
): Promise<void> {
  const formattedComments = comments.map((c) => {
    const severityEmoji =
      c.severity === "High" ? "🚨" : c.severity === "Warning" ? "⚠️" : "ℹ️";
    const confidenceEmoji =
      c.confidence === "High" ? "🟢" : c.confidence === "Medium" ? "🟡" : "🔴";

    let body = `<!-- maxi-review-inline-comment -->
**Severity:** ${severityEmoji} ${c.severity} | **Confidence:** ${confidenceEmoji} ${c.confidence}

${messageWithSuggestion(c)}`;

    if (c.promptForAgents) {
      body += `

<details>
<summary>🤖 Prompt for Agents</summary>

${c.promptForAgents}
</details>`;
    }

    const startLine = c.startLine || c.line;
    const endLine = c.endLine || startLine;
    return {
      path: c.file,
      ...(endLine > startLine
        ? { start_line: startLine, start_side: "RIGHT" as const, line: endLine }
        : { line: c.line }),
      side: "RIGHT" as const,
      body,
    };
  });

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: summary,
      comments: formattedComments,
    });
  } catch (err) {
    core.warning(
      `Failed to submit PR review; recording late feedback as a PR comment instead: ${String(err)}`
    );
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: buildLateFeedbackComment(summary, comments),
    });
  }
}

function messageWithSuggestion(comment: ReviewComment): string {
  if (
    !comment.suggestedReplacement ||
    comment.message.includes("```suggestion")
  ) {
    return comment.message;
  }
  return `${comment.message}\n\n\`\`\`suggestion\n${comment.suggestedReplacement}\n\`\`\``;
}

function buildLateFeedbackComment(
  summary: string,
  comments: ReviewComment[]
): string {
  const findings = comments
    .map((comment, index) => {
      const promptForAgents = comment.promptForAgents
        ? `\n\n<details>\n<summary>Prompt for Agents</summary>\n\n${comment.promptForAgents}\n</details>`
        : "";
      return `### ${index + 1}. ${formatCommentLocation(comment)}

**Severity:** ${comment.severity} | **Confidence:** ${comment.confidence}

${comment.message}${promptForAgents}`;
    })
    .join("\n\n---\n\n");

  return `<!-- maxi-review late-feedback -->
## Late Maxi review feedback

${summary}

${findings}`;
}

function formatCommentLocation(comment: ReviewComment): string {
  const startLine = comment.startLine || comment.line;
  const endLine = comment.endLine || startLine;
  const lineSuffix =
    endLine > startLine ? `${startLine}-${endLine}` : `${startLine}`;
  return `${comment.file}:${lineSuffix}`;
}

export async function setStatus(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  sha: string,
  context: string,
  state: "pending" | "success" | "failure" | "error",
  description: string
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context,
    description,
  });
}

export async function recordReviewArtifactComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  name: string,
  content: string
): Promise<void> {
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `<!-- maxi-review artifact -->
<!-- maxi-review artifact-data
name: ${name}
encoding: base64
${encodedContent}
-->`,
  });
}

export async function listReviewArtifactComments(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  const trustedAuthors = await trustedArtifactCommentAuthors(octokit);
  const request = {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  };
  const comments =
    typeof octokit.paginate === "function"
      ? await octokit.paginate(octokit.rest.issues.listComments, request)
      : (await octokit.rest.issues.listComments(request)).data;
  return comments
    .filter(
      (comment: {
        body?: string;
        user?: { login?: string; type?: string } | null;
      }) =>
        comment.body?.includes("<!-- maxi-review artifact -->") &&
        comment.user?.type === "Bot" &&
        typeof comment.user.login === "string" &&
        trustedAuthors.has(comment.user.login)
    )
    .map((comment: { body?: string }) => comment.body || "");
}

async function trustedArtifactCommentAuthors(
  octokit: ReturnType<typeof github.getOctokit>
): Promise<Set<string>> {
  const trusted = new Set(["github-actions[bot]", "maxi-reviewer[bot]"]);
  const actor = process.env.GITHUB_ACTOR;
  if (actor?.endsWith("[bot]")) {
    trusted.add(actor);
  }
  try {
    const authenticated = await octokit.rest.users.getAuthenticated();
    if (authenticated.data.login) {
      trusted.add(authenticated.data.login);
    }
  } catch (err) {
    core.warning(
      `Failed to determine authenticated GitHub user for artifact filtering: ${String(err)}`
    );
  }
  return trusted;
}
