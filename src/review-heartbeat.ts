/**
 * Keeps the pending `jules/review` commit status current while a review runs.
 *
 * The status used to be written once when the review started and then left
 * untouched until a terminal verdict. From outside the job "started twenty
 * seconds ago" and "hung for twenty-five minutes" therefore looked identical,
 * and readers repeatedly diagnosed a healthy in-flight review as a stalled one
 * — including merging PRs a minute or two before Jules posted its approval.
 *
 * Refreshing the description with elapsed time makes the difference legible
 * without opening the run log, and surfaces the genuine failure mode (a session
 * that is accepted but whose agent never runs) minutes in rather than at the
 * timeout.
 */

const MINUTE_MS = 60_000;

/** GitHub truncates commit status descriptions; stay well inside the limit. */
export const MAX_DESCRIPTION_LENGTH = 140;

/** Default gap between status writes. */
const DEFAULT_INTERVAL_MS = 2 * MINUTE_MS;

export interface ReviewProgress {
  /** Whether Jules has produced any agent message so far. */
  sawAgentOutput: boolean;
}

/** What {@link formatHeartbeat} renders. */
export interface HeartbeatState extends ReviewProgress {
  /** Milliseconds since the review began, across every polling phase. */
  elapsedMs: number;
}

/**
 * Cap a description at the length GitHub accepts for a commit status.
 *
 * Exported so it can be tested against an over-long input directly. The live
 * format never approaches the limit, so a test that only fed it real values
 * would assert the cap vacuously without ever entering this branch.
 */
export function capDescription(description: string): string {
  return description.length > MAX_DESCRIPTION_LENGTH
    ? `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : description;
}

export interface HeartbeatOptions {
  /** Publishes one refreshed description. */
  publish: (description: string) => Promise<void>;
  /**
   * Minimum gap between writes. Commit statuses accumulate on the commit and
   * count against the API budget, so this is deliberately coarse relative to
   * the 20s poll tick.
   */
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export function formatHeartbeat(progress: HeartbeatState): string {
  const elapsed = Math.floor(progress.elapsedMs / MINUTE_MS);
  const state = progress.sawAgentOutput
    ? "agent replied, finishing up"
    : "no agent output yet";
  // Elapsed only, with no "of Nm" limit. Elapsed is cumulative across the whole
  // review while each polling phase carries its OWN deadline, so pairing them
  // produced impossible readings like "31m of 30m" while a repair phase was
  // still legitimately inside its own budget. There is no single review-wide
  // deadline to quote, so quoting one was a lie; elapsed alone is what
  // distinguishes "just started" from "stalled", which is the whole point.
  return capDescription(
    `Jules is reviewing this PR… (${elapsed}m elapsed, ${state})`
  );
}

/**
 * Builds a throttled progress sink for {@link ReviewProgress} updates.
 *
 * The returned function is safe to call on every poll tick: it publishes at
 * most once per interval, skips writes that would repeat the previous
 * description, and never rejects — a heartbeat is diagnostic, so failing to
 * refresh it must not fail the review it is describing.
 */
export function createHeartbeat(
  options: HeartbeatOptions
): (progress: ReviewProgress) => Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  // Elapsed is measured from here rather than from the current poll, because a
  // review is polled in several phases (initial wait, JSON/format repair, and
  // every round of the retrieval loop). Reporting per-phase elapsed would reset
  // the clock mid-review and hide exactly the long waits this exists to show.
  const startedAt = now();
  // Seed with creation time so the first beat lands one interval in: the caller
  // has already posted the opening "Jules is reviewing this PR…" status, and
  // immediately restating it at 0m would just be noise.
  let lastPublishedAt = startedAt;
  let lastDescription: string | undefined;

  return async (progress: ReviewProgress): Promise<void> => {
    const at = now();
    if (at - lastPublishedAt < intervalMs) return;

    const description = formatHeartbeat({
      ...progress,
      elapsedMs: at - startedAt,
    });
    if (description === lastDescription) return;

    // Advance the window before awaiting so a slow or failing write cannot let
    // concurrent ticks pile up behind it.
    lastPublishedAt = at;
    lastDescription = description;
    try {
      await options.publish(description);
    } catch (err) {
      options.onError?.(err);
    }
  };
}
