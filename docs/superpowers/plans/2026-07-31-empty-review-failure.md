# Empty Review Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a zero-character Jules review produce a nonpassing GitHub Actions job while preserving its harvestable artifact and explicit legacy failure status.

**Architecture:** Add an injected job-summary writer to `ReviewPrDeps`, backed by `core.summary` in production. In the existing null-review branch, publish the zero-character count, call `core.setFailed`, and return normally so the outer catch cannot replace the specific legacy failure status with generic error.

**Tech Stack:** TypeScript, `@actions/core`, Vitest, pnpm, GitHub Actions.

## Global Constraints

- Preserve the harvestable artifact and PR artifact comment.
- Keep the legacy commit status state `failure` with description `Review timed out; see harvested artifact`. **(Superseded: the `failure` state stands, but the description is now built by `reviewTimeoutStatus()` in `src/review-pr.ts` so it names the configured budget and says the outcome is infrastructure, not a code finding. Do not restore the literal.)**
- The Actions step/job must be nonpassing through `core.setFailed`.
- The job summary must contain exactly `Collected characters: 0`.
- Do not submit an empty PR review.
- Do not change dependency pins.
- Use GitHub Git Data API blob/tree/commit/ref CAS writes because local worktree binding is quarantined.
- CI, not local execution, verifies the Node checks and checked-in `dist`.

---

### Task 1: Add the RED regression contract

**Files:**
- Modify: `tests/review-pr.test.ts`
- Modify: `tests/index.test.ts`

**Interfaces:**
- Consumes: `runReviewPr(overrides: Partial<ReviewPrDeps>): Promise<void>`.
- Produces: an executable contract that the empty-review path invokes `writeJobSummary(0)` and calls `core.setFailed` with the exact timeout message.

- [ ] **Step 1: Change the orchestration test to fail on current behavior**

Add `writeJobSummary: vi.fn().mockResolvedValue(undefined)` to the dependency fixture. Replace the old `expect(core.setFailed).not.toHaveBeenCalled()` assertion with:

```ts
expect(deps.writeJobSummary).toHaveBeenCalledWith(0);
expect(core.setFailed).toHaveBeenCalledWith(
  "Jules returned no review message within 30 minutes; recorded a harvestable review artifact."
);
```

Keep every existing artifact, PR-comment, legacy-status, warning, and no-submit assertion.

- [ ] **Step 2: Change the action-level test to require a nonpassing conclusion**

Replace its old `expect(mockSetFailed).not.toHaveBeenCalled()` with the same exact `toHaveBeenCalledWith(...)` assertion. This proves the entrypoint exposes the failure to GitHub Actions rather than only to a legacy status.

- [ ] **Step 3: Create a test-only commit through Git Data API and open a draft PR**

Expected CI result: the focused/unit test job fails because `writeJobSummary` is absent and `core.setFailed` is not called. Preserve the failing run URL as the RED receipt before production code is added.

### Task 2: Implement the minimal failure and summary behavior

**Files:**
- Modify: `src/review-pr.ts`

**Interfaces:**
- Consumes: `core.summary` and the null `reviewResult` branch.
- Produces: `ReviewPrDeps.writeJobSummary(collectedCharacters: number): Promise<void>`.

- [ ] **Step 1: Add the injected dependency**

Add this member to `ReviewPrDeps`:

```ts
writeJobSummary: (collectedCharacters: number) => Promise<void>;
```

Add this default implementation:

```ts
writeJobSummary: async (collectedCharacters: number) => {
  await core.summary
    .addHeading("Maxi Review")
    .addRaw(`Collected characters: ${collectedCharacters}`)
    .write();
},
```

- [ ] **Step 2: Mark the empty-review path failed without throwing**

After the existing legacy failure status and warning, add:

```ts
await deps.writeJobSummary(0);
core.setFailed(
  `Jules returned no review message within ${timeoutMinutes} minutes; recorded a harvestable review artifact.`
);
return;
```

Do not throw: the outer catch would replace the specific legacy `failure` status with generic `error`.

- [ ] **Step 3: Audit all failing early returns**

Search `src/review-pr.ts` for `setStatus` and `return`. Verify the null-review branch is the only early return that publishes a failing legacy status. Verify invalid input/event branches already call `core.setFailed`, while draft/fork/bypass branches are intentional skips.

- [ ] **Step 4: Create the GREEN commit by expected-head CAS**

Expected CI result: tests, lint, format check, build, coverage, and checked-in `dist` verification are terminal-green over the changed TypeScript and action bundle. If CI reports generated `dist` drift, generate the exact repository build output in an isolated CI-capable lane and commit it by a separate expected-head CAS.

### Task 3: Close the evidence loop

**Files:**
- Modify: `dist/index.js` only if the repository build requires it.
- Durable receipts: draft PR and `maxi-reviewer#58`.

**Interfaces:**
- Consumes: RED and GREEN CI run/job URLs bound to exact commit SHAs.
- Produces: reviewable draft PR with byte-matched Git Data API commits and a durable issue receipt.

- [ ] **Step 1: Verify every Git Data write**

Read each written blob back by SHA, decode it, and byte-compare it with the intended content. Confirm ref CAS uses the expected old head and `force=false`.

- [ ] **Step 2: Record the exact evidence**

On the PR and issue, enumerate changed paths, RED run/job and failure, GREEN run/jobs and denominator, the early-return audit result, artifact preservation, summary text, and any check that could not be established. Do not merge or close.
