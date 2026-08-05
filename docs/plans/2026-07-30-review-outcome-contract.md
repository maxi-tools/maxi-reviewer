# Review Outcome Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every completed review attempt self-describing so calibration never infers acceptance from an empty or missing review payload.

**Architecture:** Extend the review artifact with an exhaustive producer outcome, output size, schema marker, and immutable Actions run identity. The producer derives these values from its completed result, the validator rejects partial or contradictory metadata, and calibration excludes legacy artifacts without guessing. Runner-level cancel/OOM/host death remains explicitly unobservable in Slice A because the action process cannot write after it dies.

**Tech Stack:** TypeScript, Vitest, GitHub Actions toolkit, checked-in `@vercel/ncc` bundle.

## Global Constraints

- Producer outcomes are exactly `TIMED_OUT_NO_CONTENT`, `REVIEWED_NO_FINDINGS`, and `REVIEWED_WITH_FINDINGS`.
- Legacy artifacts remain permanently ambiguous and are excluded from calibration; there is no guessed backfill.
- Assert the GitHub Actions job conclusion through `core.setFailed`, not only a commit status.
- Use strict types; add no `any` or `as unknown` escapes.
- RED precedes production code; CI is the authoritative verifier.
- Runner-level cancellation, OOM, and host death remain out of scope and unobservable in Slice A.

---

### Task 1: RED fixtures for the producer and consumer contract

**Files:**
- Modify: `tests/review-pr.test.ts`
- Modify: `tests/calibration.test.ts`
- Modify: `tests/schema.test.ts`

**Interfaces:**
- Consumes: current `runReviewPr`, `buildCalibrationReport`, and `validateReviewArtifact` behavior.
- Produces: six failing behavioral fixtures covering timeout, reviewed-empty, reviewed-with-findings, legacy exclusion, immutable retry identity, and invalid metadata.

- [ ] **Step 1: Add producer artifact assertions**

Assert literal outcome values, `reviewOutputChars`, `outcomeSchema`, and `{workflowRunId, workflowRunAttempt, job}` for timeout, zero-finding, and finding-bearing reviews.

- [ ] **Step 2: Assert the timeout job conclusion**

Expect `core.setFailed` to receive the timeout failure message. This must fail against current main where only the commit status is failed.

- [ ] **Step 3: Add legacy and identity fixtures**

Build a legacy artifact with a validated comment and assert calibration produces zero records. Run two attempts with a reused session ID but distinct Actions run/PR/head tuples and assert their run identities differ.

- [ ] **Step 4: Add validation fixture**

Pass an artifact with a mismatched outcome schema and assert validation fails with an `outcomeSchema` error.

- [ ] **Step 5: Push tests only and verify RED in CI**

Expected failures are the six predictions recorded on issue #17 before the push.

### Task 2: Producer metadata and strict validation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/late-feedback-harvest.ts`
- Modify: `src/review-pr.ts`
- Modify: `src/schema.ts`

**Interfaces:**
- Produces: `ReviewOutcome`, `ReviewRunIdentity`, required producer fields on `ReviewArtifactInput`, optional fields on legacy-readable `ReviewArtifact`, and strict all-or-none validation.
- Consumes: `github.context.runId`, `github.context.runAttempt`, `github.context.job`, review result comments, and raw response strings.

- [ ] **Step 1: Add exact types**

Define the three-value `ReviewOutcome`, `ReviewRunIdentity`, literal outcome schema, `reviewOutputChars`, and optional legacy-readable artifact fields.

- [ ] **Step 2: Require fields at the producer boundary**

Make `buildReviewArtifact` input require all new fields so new artifacts cannot omit them.

- [ ] **Step 3: Derive producer values**

Map null review to `TIMED_OUT_NO_CONTENT`, a completed review with zero comments to `REVIEWED_NO_FINDINGS`, and a completed review with comments to `REVIEWED_WITH_FINDINGS`. Sum raw response string lengths for `reviewOutputChars` and copy Actions run identity from the runtime context.

- [ ] **Step 4: Validate all-or-none metadata**

Accept artifacts with all producer fields absent as legacy. Otherwise require the exact schema, exact enum, a non-negative integer output size, positive run/attempt integers, and a non-empty job.

- [ ] **Step 5: Fail the timeout job**

Call `core.setFailed` after the timeout artifact and status are recorded so the job conclusion is failure.

### Task 3: Legacy exclusion and GREEN verification

**Files:**
- Modify: `src/calibration.ts`
- Regenerate: `dist/index.js`
- Regenerate: `dist/index.js.map`
- Regenerate: other ncc outputs only if the repository build changes them

**Interfaces:**
- Consumes: optional `ReviewArtifact.outcome`.
- Produces: calibration that processes only `REVIEWED_WITH_FINDINGS` artifacts and never classifies legacy payloads.

- [ ] **Step 1: Exclude legacy and non-finding outcomes**

Filter calibration inputs before extraction unless `artifact.outcome === "REVIEWED_WITH_FINDINGS"`.

- [ ] **Step 2: Run focused and full verification**

Run the repository lint, format check, build, test, and coverage commands. Confirm all six RED fixtures are GREEN and the timeout fixture asserts `core.setFailed`.

- [ ] **Step 3: Regenerate the checked-in action bundle**

Run the repository build command and confirm the bundle contains the new producer outcome symbols.

- [ ] **Step 4: Commit named paths only**

Use the typed Git Data API blob/tree/commit/ref CAS path. Never stage `.maxi-worktrees/` or use `git add -A`, `git add .`, or `git commit -a`.

- [ ] **Step 5: Open a draft PR**

State that runner-level cancellation/OOM/host death remains unobservable in Slice A, link #17 and the RED receipt, and report terminal checks without merging or closing.
