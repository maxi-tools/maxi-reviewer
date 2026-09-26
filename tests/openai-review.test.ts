import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeOpenAiChat,
  OpenAiTimeoutError,
  parseOpenAiReview,
  parseReviewerBackend,
  resolveOpenAiReviewConfig,
  runOpenAiReview,
} from "../src/openai-review.js";

const REVIEW = {
  schema: "maxi.review.v1.jules-review",
  summary: "Adds a helper that panics on bad input.",
  verdict: "comment",
  resolvedCommentIds: [2],
  comments: [
    {
      id: "panic-on-invalid-port",
      path: "src/net.rs",
      line: 2,
      startLine: 2,
      endLine: 2,
      severity: "High",
      confidence: "High",
      evidenceSource: "diff",
      message:
        "`unwrap()` panics on non-numeric input.\n```suggestion\nfn port(raw: &str) -> Result<u16, _> { raw.trim().parse() }\n```",
      promptForAgents: "Return a Result from src/net.rs:2 instead of unwrap.",
      suggestion: {
        path: "src/net.rs",
        startLine: 2,
        endLine: 2,
        replacement:
          "fn port(raw: &str) -> Result<u16, _> { raw.trim().parse() }",
      },
    },
  ],
};

function chatResponse(content: string, id = "chatcmpl-test") {
  return {
    id,
    choices: [{ message: { role: "assistant", content } }],
  };
}

const config = {
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: "spark-key",
  model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  timeoutMinutes: 8,
};

describe("parseReviewerBackend", () => {
  it.each([
    ["", "jules"],
    ["jules", "jules"],
    ["JULES", "jules"],
    ["openai", "openai"],
    ["openai-compatible", "openai"],
    ["qwen", "openai"],
  ])("maps %j to %s", (raw, expected) => {
    expect(parseReviewerBackend(raw)).toBe(expected);
  });

  it("rejects an unknown backend instead of silently using Jules", () => {
    expect(() => parseReviewerBackend("anthropic")).toThrow(/reviewer_backend/);
  });
});

describe("resolveOpenAiReviewConfig", () => {
  it("reads the OpenAI-compatible endpoint, key, and model", () => {
    const get = (name: string) =>
      (
        ({
          openai_base_url: "http://jasper.local:8000/v1/",
          openai_api_key: "secret",
          openai_model: "Qwen/Qwen3-Coder",
          openai_timeout_minutes: "6",
        }) as Record<string, string>
      )[name] ?? "";
    expect(resolveOpenAiReviewConfig(get, 30)).toEqual({
      baseUrl: "http://jasper.local:8000/v1",
      apiKey: "secret",
      model: "Qwen/Qwen3-Coder",
      timeoutMinutes: 6,
    });
  });

  it("names the missing input rather than calling a half-configured endpoint", () => {
    expect(() => resolveOpenAiReviewConfig(() => "", 30)).toThrow(
      /openai_base_url/
    );
  });

  it("defaults the model and caps the fallback budget at the Jules budget", () => {
    const get = (name: string) =>
      name === "openai_base_url" ? "http://pearl:8000/v1" : "";
    expect(resolveOpenAiReviewConfig(get, 4).timeoutMinutes).toBe(4);
    expect(resolveOpenAiReviewConfig(get, 30).model).toContain("Qwen3-Coder");
  });

  it("ignores a non-positive timeout override", () => {
    const get = (name: string) =>
      name === "openai_base_url"
        ? "http://pearl:8000/v1"
        : name === "openai_timeout_minutes"
          ? "0"
          : "";
    expect(resolveOpenAiReviewConfig(get, 30).timeoutMinutes).toBe(8);
  });
});

describe("completeOpenAiChat", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the prompt as a user message and returns the assistant text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(chatResponse("```json\n{}\n```")), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await completeOpenAiChat({
      ...config,
      messages: [{ role: "user", content: "review this" }],
    });

    expect(text).toContain("{}");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer spark-key"
    );
    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe(config.model);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: "user", content: "review this" }]);
  });

  it("omits Authorization when no key is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(chatResponse("ok")), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    await completeOpenAiChat({
      ...config,
      apiKey: undefined,
      messages: [{ role: "user", content: "review" }],
    });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws a timeout the caller can treat as 'no review', not a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"))
    );
    await expect(
      completeOpenAiChat({
        ...config,
        messages: [{ role: "user", content: "review" }],
      })
    ).rejects.toBeInstanceOf(OpenAiTimeoutError);
  });

  it("surfaces a non-2xx body without claiming a review was produced", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("model not loaded", { status: 503 }))
    );
    await expect(
      completeOpenAiChat({
        ...config,
        messages: [{ role: "user", content: "review" }],
      })
    ).rejects.toThrow(/503/);
  });

  it("still names the status when the error body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error("body gone")),
      })
    );
    await expect(
      completeOpenAiChat({
        ...config,
        messages: [{ role: "user", content: "review" }],
      })
    ).rejects.toThrow(/502\./);
  });

  it("rejects a transport failure that is not a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    await expect(
      completeOpenAiChat({
        ...config,
        messages: [{ role: "user", content: "review" }],
      })
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("rejects an empty assistant message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "  " } }] }),
            { status: 200 }
          )
        )
    );
    await expect(
      completeOpenAiChat({
        ...config,
        messages: [{ role: "user", content: "review" }],
      })
    ).rejects.toThrow(/no assistant message/);
  });
});

describe("runOpenAiReview", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the review prompt and returns parsed comments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            chatResponse("```json\n" + JSON.stringify(REVIEW) + "\n```")
          ),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenAiReview("review this diff", config);

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body)
    ) as { messages: { content: string }[] };
    expect(body.messages[0].content).toBe("review this diff");
    expect(result.reviewResult).toMatchObject({
      verdict: "comment",
      summary: REVIEW.summary,
      resolvedCommentIds: [2],
    });
    expect(result.reviewResult?.newComments).toEqual([
      expect.objectContaining({
        file: "src/net.rs",
        line: 2,
        severity: "High",
        confidence: "High",
        evidenceSource: "diff",
        message: expect.stringContaining("unwrap()"),
        promptForAgents: expect.stringContaining("src/net.rs"),
        suggestedReplacement: expect.stringContaining("Result"),
      }),
    ]);
    expect(result.sessionId).toMatch(/^openai:/);
    expect(result.rawResponses?.[0]).toContain("panic-on-invalid-port");
  });

  it("repairs an unparseable reply in the same conversation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(chatResponse("Sure, here is my take.")), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(chatResponse(JSON.stringify(REVIEW))), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenAiReview("prompt", config);

    expect(result.reviewResult?.verdict).toBe("comment");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repair = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body)
    ) as { messages: { role: string; content: string }[] };
    expect(repair.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(repair.messages[2].content).toContain("could not be parsed");
    expect(result.validationErrors?.[0]).toMatch(/parse/i);
  });

  it("returns no review when the endpoint never replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"))
    );
    const result = await runOpenAiReview("prompt", config);
    expect(result.reviewResult).toBeNull();
    expect(result.sessionId).toMatch(/^openai:timeout:/);
  });

  it("fulfils a retrieval request and feeds the result back before the verdict", async () => {
    const request = {
      schema: "maxi.review.v1.retrieval-request",
      requests: [{ tool: "read_file", path: "src/net.rs" }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(chatResponse(JSON.stringify(request))), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(chatResponse(JSON.stringify(REVIEW))), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const fulfill = vi.fn().mockResolvedValue({
      tool: "read_file",
      ok: true,
      path: "src/net.rs",
      content: "fn port() {}",
    });

    const result = await runOpenAiReview("prompt", config, {
      retrieval: {
        provider: { fulfill },
        maxSteps: 2,
        nonce: "nonce-1",
      },
    });

    expect(fulfill).toHaveBeenCalledWith(request.requests[0]);
    const followUp = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body)
    ) as { messages: { content: string }[] };
    expect(followUp.messages.at(-1)?.content).toContain("fn port() {}");
    expect(followUp.messages.at(-1)?.content).toContain("nonce-1");
    expect(result.reviewResult?.newComments).toHaveLength(1);
  });

  it("returns no review when the repair turn also times out", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce("not json")
      .mockRejectedValueOnce(new OpenAiTimeoutError(8));
    const result = await runOpenAiReview("prompt", config, { complete });
    expect(result.reviewResult).toBeNull();
    expect(result.validationErrors?.[0]).toMatch(/parse/i);
  });

  it("returns an empty comment review when the repair is still not JSON", async () => {
    const complete = vi.fn().mockResolvedValue("still not json");
    const result = await runOpenAiReview("prompt", config, { complete });
    expect(result.reviewResult).toMatchObject({
      verdict: "comment",
      newComments: [],
    });
    expect(result.reviewResult?.summary).toContain("could not be parsed");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps a finding whose suggestion fence was repaired", async () => {
    const broken = {
      ...REVIEW,
      comments: [
        {
          ...REVIEW.comments[0],
          message: "bad fence ```suggestion replacement",
        },
      ],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(broken))
      .mockResolvedValueOnce(JSON.stringify(REVIEW));
    const result = await runOpenAiReview("prompt", config, { complete });
    expect(result.reviewResult?.newComments[0].message).toContain(
      "```suggestion\n"
    );
  });

  it("records a formatting revision that is itself unparseable", async () => {
    const broken = {
      ...REVIEW,
      comments: [
        {
          ...REVIEW.comments[0],
          message: "bad fence ```suggestion replacement",
        },
      ],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(broken))
      .mockResolvedValueOnce("nope");
    const result = await runOpenAiReview("prompt", config, { complete });
    expect(result.reviewResult?.newComments[0].message).toContain(
      "```suggestion replacement"
    );
    expect(result.validationErrors?.join("\n")).toMatch(/formatting revision/);
  });

  it("asks for a corrected review when a comment targets an unchanged line", async () => {
    const offDiff = {
      ...REVIEW,
      comments: [{ ...REVIEW.comments[0], line: 99 }],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(offDiff))
      .mockResolvedValueOnce(JSON.stringify(REVIEW));
    const result = await runOpenAiReview("prompt", config, {
      complete,
      verificationContext: {
        files: new Map([["src/net.rs", "fn port() {}\n"]]),
        changedLines: new Map([["src/net.rs", new Set([2])]]),
      },
    });
    expect(result.reviewResult?.newComments[0].line).toBe(2);
    expect(result.validationErrors?.join("\n")).toContain("unchanged-line");
    const repair = complete.mock.calls[1][0] as {
      messages: { content: string }[];
    };
    expect(repair.messages.at(-2)?.content).toContain("unchanged");
  });

  it("feeds a malformed retrieval request back and stops if that turn times out", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          schema: "maxi.review.v1.retrieval-request",
          requests: [],
        })
      )
      .mockRejectedValueOnce(new OpenAiTimeoutError(8));
    const result = await runOpenAiReview("prompt", config, {
      complete,
      retrieval: {
        provider: { fulfill: vi.fn() },
        maxSteps: 1,
        nonce: "n",
      },
    });
    expect(result.reviewResult).toBeNull();
    expect(JSON.stringify(complete.mock.calls[1][0])).toContain(
      "retrieval request was invalid"
    );
  });

  it("records a retrieval failure instead of dropping the round", async () => {
    const request = {
      schema: "maxi.review.v1.retrieval-request",
      requests: [{ tool: "read_file", path: "missing.rs" }],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(request))
      .mockResolvedValueOnce(JSON.stringify(REVIEW));
    const result = await runOpenAiReview("prompt", config, {
      complete,
      retrieval: {
        provider: {
          fulfill: vi.fn().mockRejectedValue(new Error("404")),
        },
        maxSteps: 1,
        nonce: "n",
      },
    });
    expect(result.reviewResult?.verdict).toBe("comment");
    const followUp = complete.mock.calls[1][0] as {
      messages: { content: string }[];
    };
    expect(followUp.messages[2]?.content).toContain("404");
  });

  it("nudges for the verdict when the retrieval budget is spent still asking", async () => {
    const request = {
      schema: "maxi.review.v1.retrieval-request",
      requests: [{ tool: "grep", pattern: "port" }],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(request))
      .mockResolvedValueOnce(JSON.stringify(REVIEW));
    await runOpenAiReview("prompt", config, {
      complete,
      retrieval: {
        provider: {
          fulfill: vi
            .fn()
            .mockResolvedValue({ tool: "grep", ok: true, matches: [] }),
        },
        maxSteps: 1,
        nonce: "n",
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("publishes progress and swallows a heartbeat failure", async () => {
    const onProgress = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status api down"));
    const complete = vi.fn().mockResolvedValue(JSON.stringify(REVIEW));
    await runOpenAiReview("prompt", config, { complete, onProgress });
    expect(onProgress).toHaveBeenCalledWith({ sawAgentOutput: false });
    expect(onProgress).toHaveBeenCalledWith({ sawAgentOutput: true });
  });

  it("keeps the review when the validation revision is not JSON", async () => {
    const offDiff = {
      ...REVIEW,
      comments: [{ ...REVIEW.comments[0], line: 99 }],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(offDiff))
      .mockResolvedValueOnce("not a revision");
    const result = await runOpenAiReview("prompt", config, {
      complete,
      verificationContext: {
        files: new Map([["src/net.rs", "fn port() {}\n"]]),
        changedLines: new Map([["src/net.rs", new Set([2])]]),
      },
    });
    expect(result.reviewResult?.newComments[0].line).toBe(99);
    expect(result.validationErrors?.join("\n")).toContain("unchanged-line");
  });

  it("stops the retrieval loop when the final nudge times out", async () => {
    const request = {
      schema: "maxi.review.v1.retrieval-request",
      requests: [{ tool: "grep", pattern: "port" }],
    };
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(request))
      .mockRejectedValueOnce(new OpenAiTimeoutError(8));
    const result = await runOpenAiReview("prompt", config, {
      complete,
      retrieval: {
        provider: {
          fulfill: vi.fn().mockResolvedValue({
            tool: "grep",
            ok: true,
            matches: [],
          }),
        },
        maxSteps: 1,
        nonce: "n",
      },
    });
    expect(result.reviewResult).toBeNull();
  });

  it("propagates a non-timeout failure instead of recording an empty review", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("model not loaded"));
    await expect(
      runOpenAiReview("prompt", config, { complete })
    ).rejects.toThrow(/model not loaded/);
  });
});

describe("parseOpenAiReview", () => {
  it("accepts the legacy newComments shape when schema is absent", () => {
    const parsed = parseOpenAiReview(
      JSON.stringify({
        summary: "Legacy.",
        verdict: "approve",
        newComments: [
          {
            file: "src/a.ts",
            line: 1,
            severity: "Info",
            confidence: "Low",
            message: "nit",
            promptForAgents: "",
          },
        ],
      })
    );
    expect(parsed.newComments[0].file).toBe("src/a.ts");
  });

  it("accepts a comments array inside a fence", () => {
    const parsed = parseOpenAiReview(
      "```json\n" +
        JSON.stringify({
          summary: "Fenced.",
          verdict: "comment",
          comments: [{ file: "a.ts", line: 3, message: "x" }],
        }) +
        "\n```"
    );
    expect(parsed.newComments[0]).toMatchObject({ file: "a.ts", line: 3 });
  });

  it("rejects a JSON object that is not a review", () => {
    expect(() => parseOpenAiReview('{"ok":true}')).toThrow(
      /missing summary, verdict, or comments/
    );
  });
});
