/**
 * Process-level hard deadline for the maxi-reviewer action.
 *
 * Jules poll already has timeout_minutes, but hangs observed in #53 produce
 * zero step output and never reach that poll — holding the job until the
 * 40-minute job timeout. Arming a hard wall-clock deadline at process entry
 * releases the self-hosted runner even when the SDK/event loop stalls before
 * the first log line.
 */

export type HardDeadlineOptions = {
  timeoutMs: number;
  onFire: () => void;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Optional heartbeat while armed. */
  onHeartbeat?: (remainingMs: number) => void;
  heartbeatMs?: number;
  now?: () => number;
};

export type HardDeadlineHandle = {
  clear: () => void;
};

export function armHardDeadline(opts: HardDeadlineOptions): HardDeadlineHandle {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(
      `hard deadline timeoutMs must be a positive finite number, got ${opts.timeoutMs}`
    );
  }
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as NodeJS.Timeout);
    });
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + opts.timeoutMs;

  const fireHandle = setTimer(() => {
    if (heartbeatHandle !== undefined) {
      clearTimer(heartbeatHandle);
      heartbeatHandle = undefined;
    }
    opts.onFire();
  }, opts.timeoutMs);

  let heartbeatHandle: unknown | undefined;
  const heartbeatMs = opts.heartbeatMs ?? 60_000;
  if (opts.onHeartbeat && heartbeatMs > 0) {
    const tick = () => {
      const remaining = Math.max(0, deadline - now());
      opts.onHeartbeat?.(remaining);
      if (remaining > 0) {
        heartbeatHandle = setTimer(tick, heartbeatMs);
      }
    };
    heartbeatHandle = setTimer(tick, heartbeatMs);
  }

  return {
    clear() {
      clearTimer(fireHandle);
      if (heartbeatHandle !== undefined) {
        clearTimer(heartbeatHandle);
        heartbeatHandle = undefined;
      }
    },
  };
}

/** Resolve overall hard-deadline minutes from inputs. */
export function resolveHardTimeoutMinutes(
  timeoutMinutes: number,
  hardTimeoutMinutesRaw: string | undefined
): number {
  const base = Math.max(1, timeoutMinutes | 0);
  if (
    hardTimeoutMinutesRaw !== undefined &&
    hardTimeoutMinutesRaw.trim() !== ""
  ) {
    const trimmed = hardTimeoutMinutesRaw.trim();
    // Require the entire string to be a positive integer (reject "1e2", "12oops").
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new Error(
        `Invalid hard_timeout_minutes: "${hardTimeoutMinutesRaw}". Must be a positive integer.`
      );
    }
    return Number(trimmed);
  }
  // Default: Jules budget + 5 minutes for setup/post + silent pre-Jules hang cover.
  return base + 5;
}
