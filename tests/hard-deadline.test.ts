import { describe, expect, it, vi } from "vitest";
import {
  armHardDeadline,
  NODE_MAX_TIMEOUT_MINUTES,
  NODE_MAX_TIMEOUT_MS,
  resolveHardTimeoutMinutes,
} from "../src/hard-deadline.js";

describe("resolveHardTimeoutMinutes", () => {
  it("defaults to timeout_minutes + 5", () => {
    expect(resolveHardTimeoutMinutes(30, undefined)).toBe(35);
    expect(resolveHardTimeoutMinutes(30, "")).toBe(35);
    expect(resolveHardTimeoutMinutes(30, "   ")).toBe(35);
  });

  it("honors an explicit hard_timeout_minutes", () => {
    expect(resolveHardTimeoutMinutes(30, "12")).toBe(12);
  });

  it("rejects non-positive hard_timeout_minutes", () => {
    expect(() => resolveHardTimeoutMinutes(30, "0")).toThrow(
      /Invalid hard_timeout_minutes/
    );
    expect(() => resolveHardTimeoutMinutes(30, "nope")).toThrow(
      /Invalid hard_timeout_minutes/
    );
  });

  it("rejects partially parsed numeric prefixes", () => {
    expect(() => resolveHardTimeoutMinutes(30, "1e2")).toThrow(
      /Invalid hard_timeout_minutes/
    );
    expect(() => resolveHardTimeoutMinutes(30, "12oops")).toThrow(
      /Invalid hard_timeout_minutes/
    );
  });

  it("rejects digit-only values outside Number.isSafeInteger range", () => {
    // Beyond MAX_SAFE_INTEGER as a pure digit string (regex-ok, non-safe Number).
    expect(() =>
      resolveHardTimeoutMinutes(30, "9007199254740993")
    ).toThrow(/Invalid hard_timeout_minutes/);
    // Far past finite Number range → Infinity.
    expect(() =>
      resolveHardTimeoutMinutes(30, "9".repeat(400))
    ).toThrow(/Invalid hard_timeout_minutes/);
  });

  it("rejects hard_timeout_minutes above Node setTimeout limit", () => {
    // 35792 min * 60000 ms > 2^31-1 → Node would clamp setTimeout to 1ms.
    expect(NODE_MAX_TIMEOUT_MINUTES).toBe(35791);
    expect(NODE_MAX_TIMEOUT_MINUTES * 60_000).toBeLessThanOrEqual(
      NODE_MAX_TIMEOUT_MS
    );
    expect((NODE_MAX_TIMEOUT_MINUTES + 1) * 60_000).toBeGreaterThan(
      NODE_MAX_TIMEOUT_MS
    );
    expect(() =>
      resolveHardTimeoutMinutes(30, String(NODE_MAX_TIMEOUT_MINUTES + 1))
    ).toThrow(/Node setTimeout limit/);
    // Boundary: max minutes still accepted.
    expect(
      resolveHardTimeoutMinutes(30, String(NODE_MAX_TIMEOUT_MINUTES))
    ).toBe(NODE_MAX_TIMEOUT_MINUTES);
  });
});

describe("armHardDeadline", () => {
  it("fires onFire once the wall-clock deadline elapses", () => {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextId = 1;
    const setTimer = (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id;
    };
    const clearTimer = (handle: unknown) => {
      const id = typeof handle === "number" ? handle : NaN;
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    };
    const onFire = vi.fn();

    const handle = armHardDeadline({
      timeoutMs: 5_000,
      onFire,
      setTimer,
      clearTimer,
    });

    expect(onFire).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(5_000);

    // Elapse the deadline.
    timers[0]?.fn();
    expect(onFire).toHaveBeenCalledTimes(1);

    handle.clear();
  });

  it("does not fire after clear()", () => {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextId = 1;
    const setTimer = (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id;
    };
    const clearTimer = (handle: unknown) => {
      const id = typeof handle === "number" ? handle : NaN;
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    };
    const onFire = vi.fn();
    const handle = armHardDeadline({
      timeoutMs: 5_000,
      onFire,
      setTimer,
      clearTimer,
    });
    handle.clear();
    // Nothing left to fire.
    expect(timers).toHaveLength(0);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("rejects non-positive timeoutMs", () => {
    expect(() =>
      armHardDeadline({ timeoutMs: 0, onFire: () => undefined })
    ).toThrow(/positive finite number/);
  });

  it("rejects timeoutMs above Node setTimeout limit", () => {
    expect(() =>
      armHardDeadline({
        timeoutMs: NODE_MAX_TIMEOUT_MS + 1,
        onFire: () => undefined,
      })
    ).toThrow(/Node setTimeout limit/);
  });
});
