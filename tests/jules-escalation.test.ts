import { describe, it, expect, vi } from "vitest";
import {
  planAttempts,
  runReviewWithSetupEscalation,
} from "../src/jules-escalation.js";
import { SessionStuckInSetupError } from "../src/jules.js";

vi.mock("@actions/core");

const stuck = () => new SessionStuckInSetupError("sess-1", "QUEUED", 300_000);

const call = (run: ReturnType<typeof vi.fn>, attempts = planAttempts("k1")) =>
  runReviewWithSetupEscalation({
    run,
    attempts,
    prompt: "prompt",
    source: { github: "o/r" },
    timeoutMinutes: 15,
    options: { previousSessionId: "old-session" },
  });

describe("planAttempts", () => {
  it("sends the second attempt to the other account when there is one", () => {
    expect(planAttempts("k1", "k2")).toEqual([
      { apiKey: "k1", label: "primary account" },
      { apiKey: "k2", label: "fallback account" },
    ]);
  });

  it("still plans a second attempt with only one account", () => {
    // A fresh session on the same account is the cheapest thing that has been
    // seen to recover a clone that never finished. Planning one attempt would
    // mean the review simply never happens.
    const attempts = planAttempts("k1");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.apiKey)).toEqual(["k1", "k1"]);
    expect(attempts[1].label).toContain("fresh session");
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["the same key", "k1"],
  ])("treats a %s fallback as no second account", (_name, fallback) => {
    expect(planAttempts("k1", fallback)[1]).toEqual({
      apiKey: "k1",
      label: "primary account, fresh session",
    });
  });
});

describe("runReviewWithSetupEscalation", () => {
  it("does not retry a review that succeeded", async () => {
    const run = vi.fn().mockResolvedValue({ reviewResult: null });
    await expect(call(run)).resolves.toEqual({ reviewResult: null });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("resumes the previous session on the first attempt", async () => {
    const run = vi.fn().mockResolvedValue({});
    await call(run);
    expect(run.mock.calls[0][4]).toMatchObject({
      previousSessionId: "old-session",
    });
  });

  it("recreates on the next account when setup never finished", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(stuck())
      .mockResolvedValueOnce({ reviewResult: { verdict: "approve" } });

    await expect(call(run, planAttempts("k1", "k2"))).resolves.toMatchObject({
      reviewResult: { verdict: "approve" },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toBe("k1");
    expect(run.mock.calls[1][0]).toBe("k2");
  });

  it("does not hand the retry back to the session that failed", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(stuck())
      .mockResolvedValueOnce({});
    await call(run, planAttempts("k1", "k2"));
    expect(run.mock.calls[1][4]).toMatchObject({
      previousSessionId: undefined,
    });
  });

  it("carries the rest of the options into the retry", async () => {
    const onProgress = vi.fn();
    const run = vi
      .fn()
      .mockRejectedValueOnce(stuck())
      .mockResolvedValueOnce({});
    await runReviewWithSetupEscalation({
      run,
      attempts: planAttempts("k1", "k2"),
      prompt: "prompt",
      source: {},
      timeoutMinutes: 15,
      options: { previousSessionId: "old", onProgress },
    });
    expect(run.mock.calls[1][4]).toMatchObject({ onProgress });
  });

  it("reports the stuck session rather than a timeout when every account fails", async () => {
    const last = new SessionStuckInSetupError("sess-2", "QUEUED", 300_000);
    const run = vi
      .fn()
      .mockRejectedValueOnce(stuck())
      .mockRejectedValueOnce(last);

    await expect(call(run, planAttempts("k1", "k2"))).rejects.toBe(last);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("propagates any other failure without spending a second budget", async () => {
    // An auth failure, a parse failure, or a review that ran and said nothing
    // are answers. Re-running them just arrives at the same answer later.
    const err = new Error("Jules API rejected request (401)");
    const run = vi.fn().mockRejectedValue(err);

    await expect(call(run, planAttempts("k1", "k2"))).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when no attempt was planned", async () => {
    const run = vi.fn();
    await expect(call(run, [])).rejects.toThrow(
      "No review attempts were configured."
    );
    expect(run).not.toHaveBeenCalled();
  });
});
