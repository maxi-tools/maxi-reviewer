import { describe, expect, it, vi } from "vitest";
import {
  buildApplyAllPlan,
  extractReviewArtifact,
  parseReviewCommand,
  runReviewCommand,
} from "../src/review-command.js";

describe("review command handling", () => {
  it("parses apply-all and hands-on fix commands", () => {
    expect(parseReviewCommand("/maxi apply-all")).toEqual({
      kind: "apply-all",
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
    };

    await expect(runReviewCommand(deps)).resolves.toBeUndefined();

    expect(deps.comment).toHaveBeenCalledWith(
      "Could not apply Maxi suggestions: stale head SHA: expected head-a, got head-b"
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
