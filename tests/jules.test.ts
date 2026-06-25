/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runJulesReview,
  isAuthError,
  wrapPermissionError,
} from "../src/jules.js";
import { jules } from "@google/jules-sdk";
import * as core from "@actions/core";

vi.mock("@actions/core");

const mockSessionWithHistory = (historyEvents: any[]) => {
  return {
    id: "test-session-id",
    info: vi.fn().mockResolvedValue({}),
    hydrate: vi.fn().mockResolvedValue(1),
    prompt: vi.fn().mockResolvedValue({}),
    history: async function* () {
      for (const event of historyEvents) {
        yield event;
      }
    },
  };
};

describe("jules.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("runJulesReview", () => {
    it("returns null if no reviewMessage is collected", async () => {
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSessionWithHistory([])),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);

      // Fast-forward to timeout
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);

      const result = await promise;
      expect(result).toEqual({
        reviewResult: null,
        sessionId: "test-session-id",
      });
    });

    it("returns parsed review result", async () => {
      const reviewText =
        '```json\n{"summary": "test", "verdict": "approve"}\n```';
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi
          .fn()
          .mockResolvedValue(
            mockSessionWithHistory([
              { type: "agentMessaged", message: reviewText },
            ])
          ),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1);
      expect(result).toEqual({
        reviewResult: { summary: "test", verdict: "approve" },
        sessionId: "test-session-id",
      });
    });

    it("returns structured maxi review output in the legacy result shape", async () => {
      const reviewText =
        '```json\n{"schema":"maxi.review.v1.jules-review","summary":"structured","verdict":"comment","resolvedCommentIds":[2],"comments":[{"id":"c1","path":"src/a.ts","line":4,"severity":"Warning","confidence":"High","message":"Use this.","promptForAgents":"Fix it.","suggestion":{"path":"src/a.ts","startLine":4,"endLine":4,"replacement":"const ok = true;"}}]}\n```';
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi
          .fn()
          .mockResolvedValue(
            mockSessionWithHistory([
              { type: "agentMessaged", message: reviewText },
            ])
          ),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1);

      expect(result.reviewResult).toEqual({
        summary: "structured",
        verdict: "comment",
        resolvedCommentIds: [2],
        newComments: [
          {
            file: "src/a.ts",
            line: 4,
            startLine: undefined,
            endLine: undefined,
            severity: "Warning",
            confidence: "High",
            message: "Use this.",
            promptForAgents: "Fix it.",
            suggestedReplacement: "const ok = true;",
          },
        ],
      });
    });

    it("asks the same Jules session to revise malformed JSON", async () => {
      const badReview = '```json\n{"summary":"bad", "verdict":"comment",\n```';
      const fixedReview =
        '```json\n{"summary":"fixed","verdict":"comment","resolvedCommentIds":[],"newComments":[]}\n```';
      let prompted = false;
      const session = {
        id: "test-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        prompt: vi.fn().mockImplementation(async () => {
          prompted = true;
        }),
        history: async function* () {
          yield {
            type: "agentMessaged",
            message: prompted ? fixedReview : badReview,
          };
        },
      };
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1);

      expect(session.prompt).toHaveBeenCalledWith(
        expect.stringContaining("Fix only the review response JSON")
      );
      expect(result).toEqual({
        reviewResult: {
          summary: "fixed",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "test-session-id",
      });
    });

    it("waits for a new Jules message after requesting JSON repair", async () => {
      const badReview = '```json\n{"summary":"bad", "verdict":"comment",\n```';
      const fixedReview =
        '```json\n{"summary":"fixed","verdict":"comment","resolvedCommentIds":[],"newComments":[]}\n```';
      let prompted = false;
      let historyCalls = 0;
      const session = {
        id: "test-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        prompt: vi.fn().mockImplementation(async () => {
          prompted = true;
        }),
        history: async function* () {
          historyCalls++;
          yield {
            type: "agentMessaged",
            message: prompted && historyCalls > 2 ? fixedReview : badReview,
          };
        },
      };
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);
      await vi.advanceTimersByTimeAsync(20_000);

      const result = await promise;

      expect(result.reviewResult?.summary).toBe("fixed");
      expect(session.hydrate).toHaveBeenCalledTimes(3);
    });

    it("asks the same Jules session to revise malformed suggestion formatting", async () => {
      const badReview =
        '```json\n{"summary":"test","verdict":"comment","resolvedCommentIds":[],"newComments":[{"file":"a.ts","line":3,"severity":"Warning","confidence":"High","message":"Use a suggestion.\\n```suggestion\\nconst ok = true;","promptForAgents":""}]}\n```';
      const fixedReview =
        '```json\n{"summary":"test","verdict":"comment","resolvedCommentIds":[],"newComments":[{"file":"a.ts","line":3,"severity":"Warning","confidence":"High","message":"Use a suggestion.\\n```suggestion\\nconst ok = true;\\n```","promptForAgents":""}]}\n```';
      let prompted = false;
      const session = {
        id: "test-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        prompt: vi.fn().mockImplementation(async () => {
          prompted = true;
        }),
        history: async function* () {
          yield {
            type: "agentMessaged",
            message: prompted ? fixedReview : badReview,
          };
        },
      };
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1);

      expect(session.prompt).toHaveBeenCalledWith(
        expect.stringContaining("Fix only the review response formatting")
      );
      expect(result.reviewResult?.newComments[0].message).toContain(
        "```suggestion\nconst ok = true;\n```"
      );
    });

    it("asks the same Jules session to revise structured reviews that fail validation", async () => {
      const badReview =
        '```json\n{"schema":"maxi.review.v1.jules-review","summary":"test","verdict":"comment","resolvedCommentIds":[],"comments":[{"id":"c1","path":"src/a.ts","line":9,"severity":"Warning","confidence":"High","message":"Use this.\\n```suggestion\\nconst ok = true;\\n```","suggestion":{"path":"src/a.ts","startLine":9,"endLine":9,"replacement":"const ok = true;"}}]}\n```';
      const fixedReview =
        '```json\n{"schema":"maxi.review.v1.jules-review","summary":"test","verdict":"comment","resolvedCommentIds":[],"comments":[{"id":"c1","path":"src/a.ts","line":4,"severity":"Warning","confidence":"High","message":"Use this.\\n```suggestion\\nconst ok = true;\\n```","suggestion":{"path":"src/a.ts","startLine":4,"endLine":4,"replacement":"const ok = true;"}}]}\n```';
      let prompted = false;
      const session = {
        id: "test-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        prompt: vi.fn().mockImplementation(async () => {
          prompted = true;
        }),
        history: async function* () {
          yield {
            type: "agentMessaged",
            message: prompted ? fixedReview : badReview,
          };
        },
      };
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1, {
        verificationContext: {
          changedLines: new Map([["src/a.ts", new Set([4])]]),
          files: new Map([
            [
              "src/a.ts",
              "const old = false;\nconst x = 1;\n\nconst ok = false;\n",
            ],
          ]),
        },
      });

      expect(session.prompt).toHaveBeenCalledWith(
        expect.stringContaining("Fix only the Maxi review JSON")
      );
      expect(session.prompt).toHaveBeenCalledWith(
        expect.stringContaining(
          "targets a line that is not in the changed diff"
        )
      );
      expect(result.reviewResult?.newComments[0]).toMatchObject({
        file: "src/a.ts",
        line: 4,
        suggestedReplacement: "const ok = true;",
      });
    });

    it("keeps the parsed review when a formatting revision returns invalid JSON", async () => {
      const badFormatReview =
        '```json\n{"summary":"test","verdict":"comment","resolvedCommentIds":[],"newComments":[{"file":"a.ts","line":3,"severity":"Warning","confidence":"High","message":"Use a suggestion.\\n```suggestion\\nconst ok = true;","promptForAgents":""}]}\n```';
      let prompted = false;
      let historyCalls = 0;
      const session = {
        id: "test-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        prompt: vi.fn().mockImplementation(async () => {
          prompted = true;
        }),
        history: async function* () {
          historyCalls++;
          yield {
            type: "agentMessaged",
            message:
              prompted && historyCalls > 1 ? "not json" : badFormatReview,
          };
        },
      };
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1);

      expect(result.reviewResult?.summary).toBe("test");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse Jules formatting revision")
      );
    });

    it("returns parsed review result without markdown blocks", async () => {
      const reviewText = '{"summary": "test2", "verdict": "approve"}';
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi
          .fn()
          .mockResolvedValue(
            mockSessionWithHistory([
              { type: "agentMessaged", message: reviewText },
            ])
          ),
      });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1);
      expect(result).toEqual({
        reviewResult: { summary: "test2", verdict: "approve" },
        sessionId: "test-session-id",
      });
    });

    it("handles parsing failure", async () => {
      const reviewText = "invalid json";
      const session = mockSessionWithHistory([
        { type: "agentMessaged", message: reviewText },
      ]);
      session.prompt = vi.fn().mockResolvedValue({});
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);

      const result = await promise;
      expect(result).toEqual({
        reviewResult: {
          summary:
            "Jules returned an invalid response that could not be parsed after a same-session repair attempt. No valid code review comments are present.",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "test-session-id",
      });
      expect(session.prompt).toHaveBeenCalledWith(
        expect.stringContaining("Fix only the review response JSON")
      );
      expect(core.error).toHaveBeenCalled();
    });

    it("handles JSON parse error when block format is invalid fallback", async () => {
      const reviewText = "```json\ninvalid\n```";
      const session = mockSessionWithHistory([
        { type: "agentMessaged", message: reviewText },
      ]);
      session.prompt = vi.fn().mockResolvedValue({});
      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(session),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);

      const result = await promise;
      expect(result).toEqual({
        reviewResult: {
          summary:
            "Jules returned an invalid response that could not be parsed after a same-session repair attempt. No valid code review comments are present.",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "test-session-id",
      });
      expect(session.prompt).toHaveBeenCalledWith(
        expect.stringContaining("Fix only the review response JSON")
      );
      expect(core.error).toHaveBeenCalled();
    });

    it("fails immediately when session.info() fails with non-auth, non-404 error", async () => {
      const sessionInfoMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("500 server error"));

      const mockSession = mockSessionWithHistory([
        {
          type: "agentMessaged",
          message: '{"summary":"test","verdict":"approve"}',
        },
      ]);
      mockSession.info = sessionInfoMock;

      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSession),
      });
      (jules as any).with = mockJulesWith;

      await expect(runJulesReview("api-key", "prompt", {}, 1)).rejects.toThrow(
        "Jules session.info() failed: 500 server error"
      );
    });

    it("retries when session.info() fails with 404 string error", async () => {
      const sessionInfoMock = vi
        .fn()
        .mockRejectedValueOnce("404 Not found")
        .mockResolvedValueOnce({});

      const mockSession = mockSessionWithHistory([
        {
          type: "agentMessaged",
          message: '{"summary":"test","verdict":"approve"}',
        },
      ]);
      mockSession.info = sessionInfoMock;

      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSession),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);
      await vi.advanceTimersByTimeAsync(2000);

      await promise;
      expect(sessionInfoMock).toHaveBeenCalledTimes(2);
    });

    it("fails when session.info() throws auth error", async () => {
      const mockSession = mockSessionWithHistory([]);
      mockSession.info = vi
        .fn()
        .mockRejectedValue(new Error("401 Unauthorized"));

      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSession),
      });
      (jules as any).with = mockJulesWith;

      await expect(runJulesReview("api-key", "prompt", {}, 1)).rejects.toThrow(
        "Jules API rejected request (401 Unauthorized). Check JULES_API_KEY is valid."
      );
    });

    it("fails when session.info() fails max attempts", async () => {
      const mockSession = mockSessionWithHistory([]);
      mockSession.info = vi.fn().mockRejectedValue(new Error("404 not found"));

      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSession),
      });
      (jules as any).with = mockJulesWith;

      const promise = expect(
        runJulesReview("api-key", "prompt", {}, 1)
      ).rejects.toThrow("Session did not become ready within timeout.");

      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      await promise;
    });

    it("handles hydrate failure with string error and non-agentMessaged event", async () => {
      const hydrateMock = vi
        .fn()
        .mockRejectedValueOnce("Timeout")
        .mockResolvedValueOnce(1);

      const mockSession = mockSessionWithHistory([
        { type: "thought", message: "thinking" },
        {
          type: "agentMessaged",
          message: '{"summary":"test","verdict":"approve"}',
        },
      ]);
      mockSession.hydrate = hydrateMock;

      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSession),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);
      await vi.advanceTimersByTimeAsync(20000); // Poll delay

      const result = await promise;
      expect(result.reviewResult?.verdict).toBe("approve");
      expect(hydrateMock).toHaveBeenCalledTimes(2);
    });

    it("fails when hydrate throws auth error", async () => {
      const mockSession = mockSessionWithHistory([]);
      mockSession.hydrate = vi
        .fn()
        .mockRejectedValue(new Error("403 Forbidden"));

      const mockJulesWith = vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(mockSession),
      });
      (jules as any).with = mockJulesWith;

      const promise = runJulesReview("api-key", "prompt", {}, 1);
      await expect(promise).rejects.toThrow(
        "Jules API rejected request (403 Forbidden). Check JULES_API_KEY is valid."
      );
    });
  });

  describe("isAuthError & wrapPermissionError", () => {
    it("returns true for 401", () => {
      expect(isAuthError("status code 401")).toBe(true);
    });
    it("returns true for 403", () => {
      expect(isAuthError("status 403 forbidden")).toBe(true);
    });
    it("returns false for other status codes", () => {
      expect(isAuthError("status 404 not found")).toBe(false);
      expect(isAuthError("status 500 server error")).toBe(false);
    });

    it("wraps 403 error with helpful instructions", () => {
      const err = new Error("Request failed with status 403");
      const result = wrapPermissionError(
        err,
        "statuses:write",
        "createCommitStatus"
      );
      expect(result.message).toContain("createCommitStatus failed with 403");
      expect(result.message).toContain("permissions:");
    });

    it("wraps Resource not accessible error with helpful instructions", () => {
      const err = new Error("Resource not accessible by integration");
      const result = wrapPermissionError(
        err,
        "statuses:write",
        "createCommitStatus"
      );
      expect(result.message).toContain("createCommitStatus failed with 403");
      expect(result.message).toContain("permissions:");
    });

    it("passes through other Error instances unchanged", () => {
      const err = new Error("Some other error");
      const result = wrapPermissionError(
        err,
        "statuses:write",
        "createCommitStatus"
      );
      expect(result).toBe(err);
    });

    it("wraps non-Error objects into an Error", () => {
      const err = "Just a string error";
      const result = wrapPermissionError(
        err,
        "statuses:write",
        "createCommitStatus"
      );
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Just a string error");
    });
  });
});
