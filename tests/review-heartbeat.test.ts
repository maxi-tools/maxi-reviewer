import { describe, it, expect, vi } from "vitest";
import {
  capDescription,
  createHeartbeat,
  formatHeartbeat,
  MAX_DESCRIPTION_LENGTH,
} from "../src/review-heartbeat.js";

describe("formatHeartbeat", () => {
  it("reports elapsed minutes and that no agent output has arrived", () => {
    expect(
      formatHeartbeat({
        elapsedMs: 6 * 60_000,
        sawAgentOutput: false,
      })
    ).toBe("Jules is reviewing this PR… (6m elapsed, no agent output yet)");
  });

  it("distinguishes a session that has replied from one that has not", () => {
    expect(
      formatHeartbeat({
        elapsedMs: 90_000,
        sawAgentOutput: true,
      })
    ).toBe(
      "Jules is reviewing this PR… (1m elapsed, agent replied, finishing up)"
    );
  });

  it("quotes no total budget, because each polling phase carries its own", () => {
    // Guards the regression this replaced: cumulative elapsed paired with a
    // per-phase timeout could render "31m of 30m" while a repair phase was
    // still inside its own deadline.
    expect(
      formatHeartbeat({ elapsedMs: 31 * 60_000, sawAgentOutput: true })
    ).not.toContain(" of ");
  });

  it("floors elapsed minutes so 1m59s reads 1m rather than rounding up to 2m", () => {
    expect(
      formatHeartbeat({
        elapsedMs: 119_000,
        sawAgentOutput: false,
      })
    ).toContain("(1m elapsed");
  });

  it("stays inside the GitHub status description limit", () => {
    const description = formatHeartbeat({
      elapsedMs: 999 * 60_000,
      sawAgentOutput: true,
    });
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });
});

describe("capDescription", () => {
  it("leaves a description that already fits untouched", () => {
    const short = "Jules is reviewing this PR…";
    expect(capDescription(short)).toBe(short);
  });

  it("truncates an over-long description to the limit, ending in an ellipsis", () => {
    // formatHeartbeat's own output can never reach the limit, so the
    // truncation branch is only reachable — and therefore only testable —
    // through capDescription directly.
    const long = "x".repeat(MAX_DESCRIPTION_LENGTH + 50);
    const capped = capDescription(long);
    expect(capped).toHaveLength(MAX_DESCRIPTION_LENGTH);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("keeps a description of exactly the limit intact", () => {
    const exact = "x".repeat(MAX_DESCRIPTION_LENGTH);
    expect(capDescription(exact)).toBe(exact);
  });
});

describe("createHeartbeat", () => {
  // Callers no longer report elapsed: a review is polled in several phases
  // (initial wait, JSON/format repair, each retrieval round) and per-phase
  // elapsed would reset the clock mid-review. The heartbeat owns the clock.
  const progress = (sawAgentOutput = false) => ({ sawAgentOutput });

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
      "Jules is reviewing this PR… (2m elapsed, no agent output yet)"
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
      "Jules is reviewing this PR… (0m elapsed, no agent output yet)"
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
      "Jules is reviewing this PR… (10m elapsed, agent replied, finishing up)"
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
