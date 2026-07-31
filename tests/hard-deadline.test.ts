import { describe, expect, it, vi } from "vitest";
import {
  armHardDeadline,
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
});

describe("armHardDeadline", () => {
  it("fires onFire once the wall-clock deadline elapses", () => {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextId = 1;
    const setTimer = (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
      const id = handle as unknown as number;
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
    const setTimer = (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
      const id = handle as unknown as number;
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
});
