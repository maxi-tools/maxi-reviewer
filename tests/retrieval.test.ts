import { describe, it, expect, vi } from "vitest";
import {
  parseRetrievalRequest,
  formatRetrievalResults,
  formatInvalidRetrievalRequest,
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
    expect(req.kind).toBe("request");
    if (req.kind === "request") {
      expect(req.request.requests[0].tool).toBe("read_file");
    }
  });

  it("parses a bare retrieval request object", () => {
    const req = parseRetrievalRequest(
      JSON.stringify({
        schema: "maxi.review.v1.retrieval-request",
        requests: [{ tool: "grep", pattern: "foo" }],
      })
    );
    expect(req.kind).toBe("request");
    if (req.kind === "request") {
      expect(req.request.requests).toHaveLength(1);
    }
  });

  it("returns null for a review object, not a retrieval request", () => {
    const msg = JSON.stringify({
      schema: "maxi.review.v1.jules-review",
      summary: "x",
      verdict: "comment",
      resolvedCommentIds: [],
      comments: [],
    });
    expect(parseRetrievalRequest(msg).kind).toBe("none");
  });

  it("returns null for prose", () => {
    expect(parseRetrievalRequest("Sure, here is my review!").kind).toBe("none");
  });

  it("rejects an unknown tool", () => {
    const res = parseRetrievalRequest(
      JSON.stringify({
        schema: "maxi.review.v1.retrieval-request",
        requests: [{ tool: "delete_file", path: "x" }],
      })
    );
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.errors.join(" ")).toContain("tool must be one of");
    }
  });

  it("clamps an oversized request list to 8", () => {
    const requests = Array.from({ length: 20 }, () => ({
      tool: "grep",
      pattern: "x",
    }));
    const req = parseRetrievalRequest(
      JSON.stringify({ schema: "maxi.review.v1.retrieval-request", requests })
    );
    expect(req.kind).toBe("request");
    if (req.kind === "request") {
      expect(req.request.requests).toHaveLength(8);
    }
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

  it("grep rejects a catastrophic-backtracking pattern", async () => {
    const octokit = makeOctokit({ "src/a.ts": "x" });
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "grep", pattern: "(a+)+" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("backtracking");
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

describe("formatInvalidRetrievalRequest", () => {
  it("nonce-fences the schema errors and shows remaining rounds", () => {
    const out = formatInvalidRetrievalRequest(
      "NONCEABC",
      ["requests[0].tool must be one of read_file, grep, list_references"],
      1
    );
    expect(out).toContain("<<<BEGIN RETRIEVAL_REQUEST_ERRORS NONCEABC>>>");
    expect(out).toContain("<<<END RETRIEVAL_REQUEST_ERRORS NONCEABC>>>");
    expect(out).toContain("tool must be one of");
    expect(out).toContain("1 retrieval round(s) left");
  });

  it("tells the model to finalize when no rounds remain", () => {
    const out = formatInvalidRetrievalRequest("N", ["bad"], 0);
    expect(out).toContain("No retrieval rounds remain");
    expect(out).toContain("maxi.review.v1.jules-review");
  });
});

describe("grep truncation signaling", () => {
  const makeOctokit = (files: Record<string, string>) => ({
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
            tree: Object.keys(files).map((p) => ({ type: "blob", path: p })),
          },
        })),
      },
    },
  });

  it("reports candidateCount and truncates when the file cap is hit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 65; i++) files["src/f" + i + ".ts"] = "needle";
    const provider = createGithubRetrievalProvider({
      octokit: makeOctokit(files) as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "grep", pattern: "needle" });
    expect(res.ok).toBe(true);
    expect(res.candidateCount).toBe(65);
    expect(res.filesSearched).toBe(60);
    expect(res.truncated).toBe(true);
  });

  it("does not mark an exhaustive small scan as truncated", async () => {
    const provider = createGithubRetrievalProvider({
      octokit: makeOctokit({ "src/a.ts": "needle", "src/b.ts": "x" }) as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const res = await provider.fulfill({ tool: "grep", pattern: "needle" });
    expect(res.truncated).toBe(false);
    expect(res.candidateCount).toBe(2);
  });
});

describe("grep tree-listing errors", () => {
  it("returns ok:false on a tree error and retries (no empty-corpus cache)", async () => {
    let calls = 0;
    const octokit = {
      rest: {
        repos: {
          getContent: vi.fn(async () => ({
            data: {
              content: Buffer.from("needle", "utf8").toString("base64"),
            },
          })),
        },
        git: {
          getTree: vi.fn(async () => {
            calls++;
            if (calls === 1) throw new Error("503 upstream");
            return {
              data: {
                truncated: false,
                tree: [{ type: "blob", path: "src/a.ts" }],
              },
            };
          }),
        },
      },
    };
    const provider = createGithubRetrievalProvider({
      octokit: octokit as never,
      owner: "o",
      repo: "r",
      headSha: "HEAD",
    });
    const first = await provider.fulfill({ tool: "grep", pattern: "needle" });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("could not list repository tree");
    const second = await provider.fulfill({ tool: "grep", pattern: "needle" });
    expect(second.ok).toBe(true);
    expect(second.matchCount).toBe(1);
  });
});
