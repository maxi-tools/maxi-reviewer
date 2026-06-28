import { describe, it, expect, vi } from "vitest";
import {
  parseRetrievalRequest,
  formatRetrievalResults,
  createGithubRetrievalProvider,
} from "../src/retrieval.js";

describe("parseRetrievalRequest", () => {
  it("parses a fenced retrieval request", () => {
    const msg =
      "```json\n" +
      JSON.stringify({
        schema: "maxi.review.v1.retrieval-request",
        requests: [{ tool: "read_file", path: "src/a.ts" }],
      }) +
      "\n```";
    const req = parseRetrievalRequest(msg);
    expect(req).not.toBeNull();
    expect(req?.requests[0].tool).toBe("read_file");
  });

  it("parses a bare retrieval request object", () => {
    const req = parseRetrievalRequest(
      JSON.stringify({
        schema: "maxi.review.v1.retrieval-request",
        requests: [{ tool: "grep", pattern: "foo" }],
      })
    );
    expect(req?.requests).toHaveLength(1);
  });

  it("returns null for a review object, not a retrieval request", () => {
    const msg = JSON.stringify({
      schema: "maxi.review.v1.jules-review",
      summary: "x",
      verdict: "comment",
      resolvedCommentIds: [],
      comments: [],
    });
    expect(parseRetrievalRequest(msg)).toBeNull();
  });

  it("returns null for prose", () => {
    expect(parseRetrievalRequest("Sure, here is my review!")).toBeNull();
  });

  it("rejects an unknown tool", () => {
    expect(
      parseRetrievalRequest(
        JSON.stringify({
          schema: "maxi.review.v1.retrieval-request",
          requests: [{ tool: "delete_file", path: "x" }],
        })
      )
    ).toBeNull();
  });

  it("clamps an oversized request list to 8", () => {
    const requests = Array.from({ length: 20 }, () => ({
      tool: "grep",
      pattern: "x",
    }));
    const req = parseRetrievalRequest(
      JSON.stringify({ schema: "maxi.review.v1.retrieval-request", requests })
    );
    expect(req?.requests).toHaveLength(8);
  });
});

describe("formatRetrievalResults", () => {
  it("nonce-fences each result and shows remaining rounds", () => {
    const out = formatRetrievalResults(
      "NONCEXYZ",
      [{ tool: "read_file", ok: true, path: "a.ts", content: "1\tx" }],
      2
    );
    expect(out).toContain("<<<BEGIN RETRIEVAL_RESULT_1 NONCEXYZ>>>");
    expect(out).toContain("<<<END RETRIEVAL_RESULT_1 NONCEXYZ>>>");
    expect(out).toContain("2 retrieval round(s) left");
  });

  it("tells the model to finalize when no rounds remain", () => {
    const out = formatRetrievalResults("N", [], 0);
    expect(out).toContain("No retrieval rounds remain");
    expect(out).toContain("maxi.review.v1.jules-review");
  });
});

describe("createGithubRetrievalProvider", () => {
  const makeOctokit = (files: Record<string, string>, tree?: string[]) => ({
    rest: {
      repos: {
        getContent: vi.fn(async ({ path }: { path: string }) => {
          if (!(path in files)) throw new Error("404");
          return {
            data: {
              content: Buffer.from(files[path], "utf8").toString("base64"),
            },
          };
        }),
      },
      git: {
        getTree: vi.fn(async () => ({
          data: {
            truncated: false,
            tree: (tree ?? Object.keys(files)).map((p) => ({
              type: "blob",
              path: p,
            })),
          },
        })),
      },
    },
  });

  it("read_file returns line-numbered content at head", async () => {
    const octokit = makeOctokit({ "src/a.ts": "line1\nline2\nline3" });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "read_file", path: "src/a.ts" });
    expect(res.ok).toBe(true);
    expect(res.totalLines).toBe(3);
    expect(res.content).toContain("2\tline2");
  });

  it("read_file slices a line range", async () => {
    const octokit = makeOctokit({ "src/a.ts": "a\nb\nc\nd\ne" });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({
      tool: "read_file",
      path: "src/a.ts",
      startLine: 2,
      endLine: 3,
    });
    expect(res.content).toBe("2\tb\n3\tc");
    expect(res.truncated).toBe(true);
  });

  it("read_file reports a missing file", async () => {
    const octokit = makeOctokit({});
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "read_file", path: "nope.ts" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("grep finds regex matches across the head tree", async () => {
    const octokit = makeOctokit({
      "src/a.ts": "const foo = 1;\nconst bar = 2;",
      "src/b.ts": "foo();",
    });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "grep", pattern: "foo" });
    expect(res.ok).toBe(true);
    expect(res.matchCount).toBe(2);
    const paths = res.matches?.map((m) => m.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("grep honors a pathGlob", async () => {
    const octokit = makeOctokit({ "src/a.ts": "foo", "test/c.ts": "foo" });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({
      tool: "grep",
      pattern: "foo",
      pathGlob: "src/**",
    });
    expect(res.matches?.map((m) => m.path)).toEqual(["src/a.ts"]);
  });

  it("grep rejects an invalid regex", async () => {
    const octokit = makeOctokit({ "src/a.ts": "x" });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "grep", pattern: "(" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid regex");
  });

  it("list_references matches whole-word symbol usages", async () => {
    const octokit = makeOctokit({
      "src/a.ts": "fooBar();\n// fooBarBaz unrelated",
    });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({
      tool: "list_references",
      symbol: "fooBar",
    });
    expect(res.matchCount).toBe(1);
    expect(res.matches?.[0].line).toBe(1);
  });

  it("caches seeded files without an API call", async () => {
    const octokit = makeOctokit({});
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
      seedFiles: new Map([["src/a.ts", "seeded\ncontent"]]),
    });
    const res = await provider.fulfill({ tool: "read_file", path: "src/a.ts" });
    expect(res.content).toContain("seeded");
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });
});
