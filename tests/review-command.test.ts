import { describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildApplyAllPlan,
  defaultReviewCommandDeps,
  extractReviewArtifact,
  parseReviewCommand,
  runReviewCommand,
} from "../src/review-command.js";

vi.mock("@actions/core");
vi.mock("@actions/github");

type MutableGithubModule = typeof github & { context: typeof github.context };

describe("review command handling", () => {
  it("parses apply-all and hands-on fix commands", () => {
    expect(parseReviewCommand("/maxi apply-all")).toEqual({
      kind: "apply-all",
    });
    expect(parseReviewCommand("/maxi harvest")).toEqual({
      kind: "harvest",
    });
    expect(parseReviewCommand("/maxi fix c1")).toEqual({
      kind: "fix",
      findingId: "c1",
    });
    expect(parseReviewCommand("LGTM")).toEqual({ kind: "unknown" });
  });

  it("extracts review artifacts from hidden PR comments", () => {
    const artifact = extractReviewArtifact(`<!-- maxi-review artifact -->
## Maxi review artifact

maxi-review-7-head.json

<details>
<summary>Artifact JSON</summary>

\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"head","validatedReview":{"comments":[]}}
\`\`\`
</details>`);

    expect(artifact).toMatchObject({
      schema: "maxi.review.v1.review-artifact",
      headSha: "head",
    });
  });

  it("extracts review artifacts from invisible base64 comments", () => {
    const artifact = extractReviewArtifact(`<!-- maxi-review artifact -->
<!-- maxi-review artifact-data
name: maxi-review-7-head.json
encoding: base64
eyJzY2hlbWEiOiJtYXhpLnJldmlldy52MS5yZXZpZXctYXJ0aWZhY3QiLCJoZWFkU2hhIjoiaGVhZCIsInZhbGlkYXRlZFJldmlldyI6eyJjb21tZW50cyI6W119fQ==
-->`);

    expect(artifact).toMatchObject({
      schema: "maxi.review.v1.review-artifact",
      headSha: "head",
    });
  });

  it("harvests all review artifacts from hidden PR comments", async () => {
    const artifactA = `<!-- maxi-review artifact -->
## Maxi review artifact

maxi-review-7-a.json

<details>
<summary>Artifact JSON</summary>

\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"a","validatedReview":{"comments":[]}}
\`\`\`
</details>`;
    const artifactB = `<!-- maxi-review artifact -->
## Maxi review artifact

maxi-review-7-b.json

<details>
<summary>Artifact JSON</summary>

\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"b","validatedReview":{"comments":[{"id":"c1"}]}}
\`\`\`
</details>`;
    const deps = {
      getContext: () => ({
        body: "/maxi harvest",
        owner: "maxi",
        repo: "example",
        issueNumber: 7,
      }),
      fetchPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        headSha: "head-a",
        headRef: "feature",
        headRepository: "maxi/example",
        repository: "maxi/example",
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }),
      listArtifactComments: vi
        .fn()
        .mockResolvedValue([artifactA, "ordinary comment", artifactB]),
      readFiles: vi.fn(),
      commitFiles: vi.fn(),
      startHandsOnFix: vi.fn(),
      comment: vi.fn().mockResolvedValue(undefined),
      setOutput: vi.fn(),
    };

    await runReviewCommand(deps);

    expect(deps.setOutput).toHaveBeenCalledWith(
      "review_artifacts",
      JSON.stringify([
        {
          schema: "maxi.review.v1.review-artifact",
          headSha: "a",
          validatedReview: { comments: [] },
        },
        {
          schema: "maxi.review.v1.review-artifact",
          headSha: "b",
          validatedReview: { comments: [{ id: "c1" }] },
        },
      ])
    );
    expect(deps.comment).toHaveBeenCalledWith(
      "Harvested 2 Maxi review artifacts."
    );
  });

  it("builds workflow dispatch command context from action inputs", () => {
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "command") return "/maxi apply-all";
      if (name === "pr_number") return "7";
      return "";
    });
    vi.mocked(github.getOctokit).mockReturnValue(
      {} as ReturnType<typeof github.getOctokit>
    );
    (github as MutableGithubModule).context = {
      eventName: "workflow_dispatch",
      repo: { owner: "maxi", repo: "example" },
      payload: { inputs: {} },
    } as typeof github.context;

    const deps = defaultReviewCommandDeps();

    expect(deps.getContext()).toEqual({
      body: "/maxi apply-all",
      owner: "maxi",
      repo: "example",
      issueNumber: 7,
    });
  });

  it("fetches workflow dispatch pull request by pr_number input", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        head: {
          sha: "head-a",
          ref: "feature",
          repo: { full_name: "maxi/example" },
        },
      },
    });
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      return "";
    });
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: { pulls: { get: pullsGet } },
    } as ReturnType<typeof github.getOctokit>);
    (github as MutableGithubModule).context = {
      eventName: "workflow_dispatch",
      repo: { owner: "maxi", repo: "example" },
      payload: { inputs: {} },
    } as typeof github.context;

    const deps = defaultReviewCommandDeps();
    const pr = await deps.fetchPullRequest("maxi", "example", 7);

    expect(pullsGet).toHaveBeenCalledWith({
      owner: "maxi",
      repo: "example",
      pull_number: 7,
    });
    expect(pr).toMatchObject({
      number: 7,
      headSha: "head-a",
      headRef: "feature",
      headRepository: "maxi/example",
      repository: "maxi/example",
    });
  });

  it("builds an apply-all plan from structured suggestions", () => {
    const plan = buildApplyAllPlan({
      artifact: {
        schema: "maxi.review.v1.review-artifact",
        headSha: "head-a",
        validatedReview: {
          schema: "maxi.review.v1.jules-review",
          summary: "s",
          verdict: "comment",
          resolvedCommentIds: [],
          comments: [
            {
              id: "c1",
              path: "src/a.ts",
              line: 2,
              severity: "Warning",
              confidence: "High",
              message: "Use this.",
              suggestion: {
                path: "src/a.ts",
                startLine: 2,
                endLine: 2,
                replacement: "const b = 3;",
              },
            },
          ],
        },
      },
      files: new Map([["src/a.ts", "const a = 1;\nconst b = 2;\n"]]),
      expectedHeadSha: "head-a",
      currentHeadSha: "head-a",
    });

    expect(plan.ok).toBe(true);
    expect(plan.result?.files.get("src/a.ts")).toBe(
      "const a = 1;\nconst b = 3;\n"
    );
    expect(plan.commitMessage).toBe("Apply 1 Maxi suggestion");
  });

  it("rejects apply-all plans for stale heads", () => {
    const plan = buildApplyAllPlan({
      artifact: { headSha: "head-a", validatedReview: { comments: [] } },
      files: new Map(),
      expectedHeadSha: "head-a",
      currentHeadSha: "head-b",
    });

    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain("stale head SHA");
  });

  it("commits all valid structured suggestions from the latest review artifact", async () => {
    const deps = {
      getContext: () => ({
        body: "/maxi apply-all",
        owner: "maxi",
        repo: "example",
        issueNumber: 7,
      }),
      fetchPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        headSha: "head-a",
        headRef: "feature",
        headRepository: "maxi/example",
        repository: "maxi/example",
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }),
      listArtifactComments: vi.fn().mockResolvedValue([
        `<!-- maxi-review artifact -->
\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"head-a","validatedReview":{"comments":[{"id":"c1","path":"src/a.ts","line":2,"severity":"Warning","confidence":"High","message":"Use this.","suggestion":{"path":"src/a.ts","startLine":2,"endLine":2,"replacement":"const b = 3;"}}]}}
\`\`\``,
      ]),
      readFiles: vi
        .fn()
        .mockResolvedValue(
          new Map([["src/a.ts", "const a = 1;\nconst b = 2;\n"]])
        ),
      commitFiles: vi.fn().mockResolvedValue(undefined),
      startHandsOnFix: vi.fn().mockResolvedValue("fix-session-1"),
      comment: vi.fn().mockResolvedValue(undefined),
      setOutput: vi.fn(),
    };

    await runReviewCommand(deps);

    expect(deps.readFiles).toHaveBeenCalledWith({
      owner: "maxi",
      repo: "example",
      ref: "head-a",
      paths: ["src/a.ts"],
    });
    expect(deps.commitFiles).toHaveBeenCalledWith({
      owner: "maxi",
      repo: "example",
      branch: "feature",
      expectedHeadSha: "head-a",
      message: "Apply 1 Maxi suggestion",
      files: new Map([["src/a.ts", "const a = 1;\nconst b = 3;\n"]]),
    });
    expect(deps.comment).toHaveBeenCalledWith(
      "Applied 1 Maxi suggestion. Skipped 0."
    );
  });

  it("comments instead of throwing when apply-all commit detects a stale branch", async () => {
    const deps = {
      getContext: () => ({
        body: "/maxi apply-all",
        owner: "maxi",
        repo: "example",
        issueNumber: 7,
      }),
      fetchPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        headSha: "head-a",
        headRef: "feature",
        headRepository: "maxi/example",
        repository: "maxi/example",
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }),
      listArtifactComments: vi.fn().mockResolvedValue([
        `<!-- maxi-review artifact -->
\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"head-a","validatedReview":{"comments":[{"id":"c1","path":"src/a.ts","line":2,"severity":"Warning","confidence":"High","message":"Use this.","suggestion":{"path":"src/a.ts","startLine":2,"endLine":2,"replacement":"const b = 3;"}}]}}
\`\`\``,
      ]),
      readFiles: vi
        .fn()
        .mockResolvedValue(
          new Map([["src/a.ts", "const a = 1;\nconst b = 2;\n"]])
        ),
      commitFiles: vi
        .fn()
        .mockRejectedValue(
          new Error("stale head SHA: expected head-a, got head-b")
        ),
      startHandsOnFix: vi.fn().mockResolvedValue("fix-session-1"),
      comment: vi.fn().mockResolvedValue(undefined),
      setOutput: vi.fn(),
    };

    await expect(runReviewCommand(deps)).resolves.toBeUndefined();

    expect(deps.comment).toHaveBeenCalledWith(
      "Could not apply Maxi suggestions: stale head SHA: expected head-a, got head-b"
    );
  });

  it("rejects apply-all on fork PR branches", async () => {
    const deps = {
      getContext: () => ({
        body: "/maxi apply-all",
        owner: "maxi",
        repo: "example",
        issueNumber: 7,
      }),
      fetchPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        headSha: "head-a",
        headRef: "feature",
        headRepository: "other/example",
        repository: "maxi/example",
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }),
      listArtifactComments: vi.fn().mockResolvedValue([
        `<!-- maxi-review artifact -->
\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"head-a","validatedReview":{"comments":[]}}
\`\`\``,
      ]),
      readFiles: vi.fn().mockResolvedValue(new Map()),
      commitFiles: vi.fn().mockResolvedValue(undefined),
      startHandsOnFix: vi.fn().mockResolvedValue("fix-session-1"),
      comment: vi.fn().mockResolvedValue(undefined),
      setOutput: vi.fn(),
    };

    await runReviewCommand(deps);

    expect(deps.readFiles).not.toHaveBeenCalled();
    expect(deps.commitFiles).not.toHaveBeenCalled();
    expect(deps.comment).toHaveBeenCalledWith(
      "Could not apply Maxi suggestions: apply-all requires a same-repository PR branch"
    );
  });

  it("starts a hands-on fix session for an authorized finding", async () => {
    const deps = {
      getContext: () => ({
        body: "/maxi fix c1",
        owner: "maxi",
        repo: "example",
        issueNumber: 7,
      }),
      fetchPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        headSha: "head-a",
        headRef: "feature",
        headRepository: "maxi/example",
        repository: "maxi/example",
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }),
      listArtifactComments: vi.fn().mockResolvedValue([
        `<!-- maxi-review artifact -->
\`\`\`json
{"schema":"maxi.review.v1.review-artifact","headSha":"head-a","validatedReview":{"comments":[{"id":"c1","path":"src/a.ts","line":2,"severity":"High","confidence":"High","message":"Fix this.","promptForAgents":"Patch src/a.ts."}]}}
\`\`\``,
      ]),
      readFiles: vi.fn().mockResolvedValue(new Map()),
      commitFiles: vi.fn().mockResolvedValue(undefined),
      startHandsOnFix: vi.fn().mockResolvedValue("fix-session-1"),
      comment: vi.fn().mockResolvedValue(undefined),
      setOutput: vi.fn(),
    };

    await runReviewCommand(deps);

    expect(deps.startHandsOnFix).toHaveBeenCalledWith({
      owner: "maxi",
      repo: "example",
      prNumber: 7,
      branch: "feature",
      findingId: "c1",
      prompt: expect.stringContaining("Patch src/a.ts."),
    });
    expect(deps.comment).toHaveBeenCalledWith(
      "Started hands-on Maxi fix session fix-session-1 for c1."
    );
  });
});
