import * as core from "@actions/core";
import { SessionStuckInSetupError, RunJulesReviewOptions } from "./jules.js";

/** The subset of `runJulesReview` this module needs, so it can be injected. */
export type RunReview<T> = (
  apiKey: string,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any,
  timeoutMinutes: number,
  options?: RunJulesReviewOptions
) => Promise<T>;

/** One planned attempt: which credential to use, and what to call it in logs. */
export interface ReviewAttempt {
  apiKey: string;
  label: string;
}

/**
 * The order to try credentials in when a session never leaves repository setup.
 *
 * Always two attempts. A stuck clone is a property of the session, not of the
 * prompt, so the recovery is a *new* session -- on the other account when one
 * is configured, because the failure observed on 2026-09-10 sat in
 * `🐙 Cloning maxi-tools/maxi-core` for over two hours while the account's own
 * quota was untouched (11/300), which points at the account's setup path
 * rather than at load. With only one key there is still a second attempt: a
 * fresh session on the same account is the cheapest thing that has been seen
 * to work, and it is what the review would otherwise never get.
 */
export function planAttempts(
  primaryKey: string,
  fallbackKey?: string
): ReviewAttempt[] {
  const fallback = (fallbackKey ?? "").trim();
  return [
    { apiKey: primaryKey, label: "primary account" },
    fallback && fallback !== primaryKey
      ? { apiKey: fallback, label: "fallback account" }
      : { apiKey: primaryKey, label: "primary account, fresh session" },
  ];
}

/**
 * Run a review, recreating the session elsewhere if it never starts work.
 *
 * Only {@link SessionStuckInSetupError} is retried. Every other failure --
 * auth, a parse error, a review that ran and said nothing -- propagates
 * unchanged, because those are answers, and re-running them would just spend
 * another review budget arriving at the same one.
 */
export async function runReviewWithSetupEscalation<T>(args: {
  run: RunReview<T>;
  attempts: ReviewAttempt[];
  prompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any;
  timeoutMinutes: number;
  options?: RunJulesReviewOptions;
}): Promise<T> {
  const { run, attempts, prompt, source, timeoutMinutes, options } = args;
  let lastStuck: SessionStuckInSetupError | undefined;

  for (const [index, attempt] of attempts.entries()) {
    // Resuming is only correct on the first attempt. Every later attempt is
    // here *because* a session failed to come up, and `previousSessionId`
    // would hand it straight back to the session that failed.
    const attemptOptions: RunJulesReviewOptions | undefined =
      index === 0 || !options
        ? options
        : { ...options, previousSessionId: undefined };

    try {
      return await run(
        attempt.apiKey,
        prompt,
        source,
        timeoutMinutes,
        attemptOptions
      );
    } catch (err) {
      if (!(err instanceof SessionStuckInSetupError)) throw err;
      lastStuck = err;
      core.warning(
        `Jules session ${err.sessionId} never left ${err.state} on the ` +
          `${attempt.label}; ${
            index + 1 < attempts.length
              ? `recreating it on the ${attempts[index + 1].label}.`
              : "no attempts left."
          }`
      );
    }
  }

  // Every configured Jules account failed to bring a session up. This is the
  // seam for a non-Jules reviewer -- a maxi-sandbox VM run against the intra
  // build account, or a maxi-ml / agent-runner review -- which would slot in
  // here as a further attempt rather than as a change to the loop above. Until
  // one exists, the honest thing is to surface *why* no review happened: this
  // is not "the reviewer had nothing to say", and it must not be reported as a
  // timeout.
  throw lastStuck ?? new Error("No review attempts were configured.");
}
