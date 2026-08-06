import { describe, it, expect, vi } from "vitest";
import {
  createHeartbeat,
  formatHeartbeat,
  MAX_DESCRIPTION_LENGTH,
} from "../src/review-heartbeat.js";

describe("formatHeartbeat", () => {
  it("reports elapsed minutes against the limit and that no agent output has arrived", () => {
    expect(
      formatHeartbeat({
        elapsedMs: 6 * 60_000,
        timeoutMs: 30 * 60_000,
        sawAgentOutput: false,
      })
    ).toBe("Jules is reviewing this PR… (6m of 30m, no agent output yet)");
  });

  it("distinguishes a session that has replied from one that has not", () => {
    expect(
      formatHeartbeat({
        elapsedMs: 90_000,
        timeoutMs: 30 * 60_000,
        sawAgentOutput: true,
      })
    ).toBe(
      "Jules is reviewing this PR… (1m of 30m, agent replied, finishing up)"
    );
  });

  it("floors elapsed minutes so the first interval reads 0m rather than rounding up", () => {
    expect(
      formatHeartbeat({
        elapsedMs: 119_000,
        timeoutMs: 30 * 60_000,
        sawAgentOutput: false,
      })
    ).toContain("(1m of 30m");
  });

  it("stays inside the GitHub status description limit", () => {
    const description = formatHeartbeat({
      elapsedMs: 999 * 60_000,
      timeoutMs: 999 * 60_000,
      sawAgentOutput: true,
    });
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });
});

describe("createHeartbeat", () => {
  // Callers no longer report elapsed: a review is polled in several phases
  // (initial wait, JSON/format repair, each retrieval round) and per-phase
  // elapsed would reset the clock mid-review. The heartbeat owns the clock.
  const progress = (sawAgentOutput = false) => ({
    timeoutMs: 30 * 60_000,
    sawAgentOutput,
  });

  it("does not publish immediately: the caller has already posted the initial status", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const clock = 1_000;
    const beat = createHeartbeat({ publish, now: () => clock });

    await beat(progress());

    expect(publish).not.toHaveBeenCalled();
  });

  it("fires exactly on the interval boundary, not one tick later", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 120_000,
    });

    clock = 120_000;
    await beat(progress());

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("publishes once an interval has passed", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 120_000,
    });

    clock = 119_000;
    await beat(progress());
    expect(publish).not.toHaveBeenCalled();

    clock = 121_000;
    await beat(progress());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "Jules is reviewing this PR… (2m of 30m, no agent output yet)"
    );
  });

  it("throttles: a burst of polls inside one interval yields a single status write", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 120_000,
    });

    // The poll loop ticks every 20s; five ticks stay strictly inside the 2m
    // interval (the sixth would land exactly on the boundary and should fire).
    for (let tick = 1; tick <= 5; tick++) {
      clock = tick * 20_000;
      await beat(progress());
    }

    expect(publish).not.toHaveBeenCalled();

    clock = 121_000;
    await beat(progress());
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("skips a write when the description has not changed since the last one", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    // Sub-minute interval, so two beats land inside the same rendered minute
    // and produce an identical description.
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 20_000,
    });

    clock = 21_000;
    await beat(progress());
    clock = 42_000;
    await beat(progress());

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "Jules is reviewing this PR… (0m of 30m, no agent output yet)"
    );
  });

  it("measures elapsed from review start, not from the current poll phase", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 120_000,
    });

    // A later retrieval round starts a fresh poll with its own clock, but the
    // reported elapsed must keep climbing across the whole review.
    clock = 121_000;
    await beat(progress());
    clock = 601_000;
    await beat(progress(true));

    expect(publish).toHaveBeenNthCalledWith(
      2,
      "Jules is reviewing this PR… (10m of 30m, agent replied, finishing up)"
    );
  });

  it("never lets a failed status write break the review", async () => {
    const publish = vi
      .fn()
      .mockRejectedValue(new Error("statuses:write denied"));
    const onError = vi.fn();
    let clock = 0;
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 60_000,
      onError,
    });

    clock = 61_000;
    await expect(beat(progress())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps beating after a failed write instead of wedging on the stale timestamp", async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    let clock = 0;
    const beat = createHeartbeat({
      publish,
      now: () => clock,
      intervalMs: 60_000,
    });

    clock = 61_000;
    await beat(progress());
    clock = 122_000;
    await beat(progress());

    expect(publish).toHaveBeenCalledTimes(2);
  });
});
