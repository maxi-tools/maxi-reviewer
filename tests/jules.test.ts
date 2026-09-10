/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runJulesReview,
  isAuthError,
  wrapPermissionError,
  startJulesHandsOnFix,
  SessionStuckInSetupError,
  readSessionState,
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

/**
 * A session that never produces agent output, reporting `state` every poll.
 * `states` is consumed one entry per `info()` call; the last entry sticks.
 */
const mockSessionInState = (states: string[]) => {
  let i = 0;
  return {
    id: "test-session-id",
    info: vi.fn().mockImplementation(async () => {
      const state = states[Math.min(i, states.length - 1)];
      i++;
      return { state };
    }),
    hydrate: vi.fn().mockResolvedValue(1),
    prompt: vi.fn().mockResolvedValue({}),
    history: async function* () {},
  };
};

const withSession = (session: unknown) => {
  (jules as any).with = vi.fn().mockReturnValue({
    session: vi.fn().mockResolvedValue(session),
  });
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

    it("continues a previous Jules session before polling for a new review", async () => {
      const oldReview =
        '```json\n{"summary": "old", "verdict": "approve"}\n```';
      const newReview =
        '```json\n{"summary": "continued", "verdict": "comment", "resolvedCommentIds": [], "newComments": []}\n```';
      let sent = false;
      const continuedSession = {
        id: "previous-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        send: vi.fn().mockImplementation(async () => {
          sent = true;
        }),
        history: async function* () {
          yield {
            type: "agentMessaged",
            message: sent ? newReview : oldReview,
          };
        },
      };
      const session = vi.fn().mockReturnValue(continuedSession);
      const mockJulesWith = vi.fn().mockReturnValue({ session });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1, {
        previousSessionId: "previous-session-id",
      });

      expect(session).toHaveBeenCalledWith("previous-session-id");
      expect(session).not.toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "prompt" })
      );
      expect(continuedSession.send).toHaveBeenCalledWith("prompt");
      expect(result).toEqual({
        reviewResult: {
          summary: "continued",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "previous-session-id",
      });
    });

    it("falls back to a new Jules session when previous session continuation fails", async () => {
      const reviewText =
        '```json\n{"summary": "fresh", "verdict": "approve"}\n```';
      const previousSession = {
        id: "previous-session-id",
        info: vi.fn().mockResolvedValue({}),
        hydrate: vi.fn().mockResolvedValue(1),
        send: vi.fn().mockRejectedValue(new Error("session is closed")),
        history: async function* () {
          yield {
            type: "agentMessaged",
            message: '```json\n{"summary": "old", "verdict": "approve"}\n```',
          };
        },
      };
      const freshSession = mockSessionWithHistory([
        { type: "agentMessaged", message: reviewText },
      ]);
      freshSession.id = "fresh-session-id";
      const session = vi.fn((input: unknown) =>
        typeof input === "string"
          ? previousSession
          : Promise.resolve(freshSession)
      );
      const mockJulesWith = vi.fn().mockReturnValue({ session });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview("api-key", "prompt", {}, 1, {
        previousSessionId: "previous-session-id",
      });

      expect(session).toHaveBeenCalledWith("previous-session-id");
      expect(session).toHaveBeenCalledWith({
        prompt: "prompt",
        source: {},
        requireApproval: false,
        autoPr: false,
      });
      expect(core.warning).toHaveBeenCalledWith(
        "Could not continue Jules session previous-session-id; starting a new review session: Error: session is closed"
      );
      expect(result.reviewResult?.summary).toBe("fresh");
      expect(result.sessionId).toBe("fresh-session-id");
    });

    it("retries without source context when Jules cannot access the repo source", async () => {
      const reviewText =
        '```json\n{"summary": "fallback", "verdict": "approve"}\n```';
      const session = vi
        .fn()
        .mockRejectedValueOnce(new Error("Could not get source 'maxi/example'"))
        .mockResolvedValueOnce(
          mockSessionWithHistory([
            { type: "agentMessaged", message: reviewText },
          ])
        );
      const mockJulesWith = vi.fn().mockReturnValue({ session });
      (jules as any).with = mockJulesWith;

      const result = await runJulesReview(
        "api-key",
        "prompt",
        { github: "maxi/example", baseBranch: "main" },
        1
      );

      expect(session).toHaveBeenCalledTimes(2);
      expect(session).toHaveBeenNthCalledWith(1, {
        prompt: "prompt",
        source: { github: "maxi/example", baseBranch: "main" },
        requireApproval: false,
        autoPr: false,
      });
      expect(session).toHaveBeenNthCalledWith(2, {
        prompt: "prompt",
        requireApproval: false,
        autoPr: false,
      });
      expect(core.warning).toHaveBeenCalledWith(
        "Jules could not access source maxi/example; retrying review without source context."
      );
      expect(result.reviewResult?.summary).toBe("fallback");
    });

    it("returns structured maxi review output in the legacy result shape", async () => {
      const reviewText =
        '```json\n{"schema":"maxi.review.v1.jules-review","summary":"structured","verdict":"comment","resolvedCommentIds":[2],"comments":[{"id":"c1","path":"src/a.ts","line":5,"severity":"Warning","confidence":"High","message":"Use this.","promptForAgents":"Fix it.","suggestion":{"path":"src/a.ts","startLine":4,"endLine":5,"replacement":"const ok = true;\\nconst more = true;"}}]}\n```';
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
            line: 5,
            startLine: 4,
            endLine: 5,
            severity: "Warning",
            confidence: "High",
            message: "Use this.",
            promptForAgents: "Fix it.",
            suggestedReplacement: "const ok = true;\nconst more = true;",
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
      expect(result).toMatchObject({
        reviewResult: {
          summary: "fixed",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "test-session-id",
        rawResponses: [badReview, fixedReview],
      });
      expect(result.validationErrors?.[0]).toContain(
        "Failed to parse Jules response"
      );
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
      expect(result).toMatchObject({
        reviewResult: {
          summary:
            "Jules returned an invalid response that could not be parsed after a same-session repair attempt. No valid code review comments are present.",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "test-session-id",
        rawResponses: [reviewText, ""],
      });
      expect(result.validationErrors?.join("\n")).toContain(
        "Failed to parse repaired Jules response"
      );
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
      expect(result).toMatchObject({
        reviewResult: {
          summary:
            "Jules returned an invalid response that could not be parsed after a same-session repair attempt. No valid code review comments are present.",
          verdict: "comment",
          resolvedCommentIds: [],
          newComments: [],
        },
        sessionId: "test-session-id",
        rawResponses: [reviewText, ""],
      });
      expect(result.validationErrors?.join("\n")).toContain(
        "Failed to parse repaired Jules response"
      );
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
      // Three, broken down: waitUntilSessionReady's 404 and its retry, then
      // one read of the session state on the first poll attempt. Only the
      // first two are this test's subject -- drop the 404 retry and the
      // rejection escapes runJulesReview instead of being counted here.
      expect(sessionInfoMock).toHaveBeenCalledTimes(3);
    });

    it("abandons a session still QUEUED past the setup budget", async () => {
      withSession(mockSessionInState(["QUEUED"]));

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      const assertion = expect(promise).rejects.toThrow(
        SessionStuckInSetupError
      );
      await vi.advanceTimersByTimeAsync(90_000);
      await assertion;
    });

    it("keeps waiting past the setup budget once work has started", async () => {
      // Same clock, same budget as the test above -- the ONLY difference is
      // that this session reached IN_PROGRESS, so elapsed time alone must not
      // be what abandons a session.
      withSession(mockSessionInState(["QUEUED", "IN_PROGRESS"]));

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(90_000);

      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true)
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      // Let it run out its real review budget so the test does not leak a
      // pending timer.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await expect(promise).resolves.toMatchObject({ reviewResult: null });
    });

    it("keeps waiting after a state flap back to QUEUED", async () => {
      // Having started work is a fact about the session, not about this poll.
      // A session that reports QUEUED again after IN_PROGRESS is flapping, not
      // stuck in setup.
      withSession(mockSessionInState(["QUEUED", "IN_PROGRESS", "QUEUED"]));

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(120_000);

      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true)
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await expect(promise).resolves.toMatchObject({ reviewResult: null });
    });

    it("keeps waiting when the state cannot be read at all", async () => {
      // The pre-existing mock resolves info() to `{}` -- no state field. An
      // unreadable state must never abandon a session, or an API blip costs a
      // review that was on its way.
      withSession(mockSessionWithHistory([]));

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(90_000);

      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true)
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await expect(promise).resolves.toMatchObject({ reviewResult: null });
    });

    it("does not abandon a session whose info() keeps throwing", async () => {
      const session = mockSessionWithHistory([]);
      session.info = vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValue(new Error("503 upstream"));
      withSession(session);

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(90_000);

      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true)
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await expect(promise).resolves.toMatchObject({ reviewResult: null });
    });

    it("still collects a review when info() throws every poll", async () => {
      // The state read must not be able to cancel the hydrate/history poll
      // that actually collects the review.
      const session = mockSessionWithHistory([
        {
          type: "agentMessaged",
          message: '{"summary":"test","verdict":"approve"}',
        },
      ]);
      session.info = vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValue(new Error("503 upstream"));
      withSession(session);

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(promise).resolves.toMatchObject({
        reviewResult: { verdict: "approve" },
      });
    });

    it("leaves the setup budget off for follow-up polls", async () => {
      // A repair prompt puts the session back through QUEUED, and picking that
      // prompt up can take longer than the first poll's setup budget. That is
      // normal, and must not be read as a setup that never finished -- so the
      // follow-up poll stays QUEUED here for longer than the DEFAULT budget,
      // not just longer than the one this test passes in.
      const REPAIR_DELAY_MS = 400_000;
      let sentRepairAt: number | null = null;
      const session = {
        id: "test-session-id",
        info: vi.fn().mockResolvedValue({ state: "QUEUED" }),
        hydrate: vi.fn().mockResolvedValue(1),
        prompt: vi.fn().mockImplementation(async () => {
          sentRepairAt = Date.now();
          return {};
        }),
        history: async function* () {
          if (sentRepairAt === null) {
            yield { type: "agentMessaged", message: "not json at all" };
            return;
          }
          const ready = Date.now() - sentRepairAt >= REPAIR_DELAY_MS;
          yield {
            type: "agentMessaged",
            message: ready
              ? '{"summary":"repaired","verdict":"approve"}'
              : "not json at all",
          };
        },
      };
      withSession(session);

      const promise = runJulesReview("api-key", "prompt", {}, 30, {
        setupBudgetMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(REPAIR_DELAY_MS + 60_000);
      await expect(promise).resolves.toMatchObject({
        reviewResult: { summary: "repaired" },
      });
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

  describe("startJulesHandsOnFix", () => {
    it("starts a Jules session that can commit to the PR branch", async () => {
      const session = vi.fn().mockResolvedValue({ id: "fix-session-id" });
      const mockJulesWith = vi.fn().mockReturnValue({ session });
      (jules as any).with = mockJulesWith;

      const sessionId = await startJulesHandsOnFix("api-key", "fix prompt", {
        github: "maxi/example",
        baseBranch: "feature",
      });

      expect(sessionId).toBe("fix-session-id");
      expect(session).toHaveBeenCalledWith({
        prompt: "fix prompt",
        source: { github: "maxi/example", baseBranch: "feature" },
        requireApproval: false,
        autoPr: true,
      });
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

  describe("readSessionState", () => {
    it("reads a string state", () => {
      expect(readSessionState({ state: "IN_PROGRESS" })).toBe("IN_PROGRESS");
    });

    it('returns "" for shapes that carry no readable state', () => {
      for (const info of [
        undefined,
        null,
        {},
        { state: 7 },
        { state: null },
        "IN_PROGRESS",
      ]) {
        expect(readSessionState(info)).toBe("");
      }
    });
  });
});
