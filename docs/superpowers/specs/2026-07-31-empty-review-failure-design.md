# Empty review failure handling

## Problem

When Jules returns zero review characters, `runReviewPr` publishes the review artifact and sets the legacy commit status to `failure`, but returns normally. The GitHub Actions step therefore concludes successfully. The two reporting surfaces disagree and a green job can hide a missing substantive review.

## Desired behavior

For an empty collected review:

- preserve the existing artifact publication and warning;
- keep the legacy commit status as `failure`;
- mark the Actions step/job nonpassing with `core.setFailed`;
- add `Collected characters: 0` to the Actions job summary;
- do not submit an empty PR review.

## Design

Keep the empty-result handling in `runReviewPr`. After the artifact is uploaded and the failure status is set, write a short job-summary section containing the collected character count, call `core.setFailed` with the empty-review reason, and return normally. Returning avoids the outer catch overwriting the specific legacy status with generic `error` while `setFailed` still determines the Actions conclusion.

Use the existing injected dependency pattern for summary writing so unit tests do not depend on global mutable state.

## Verification

Use RED-first tests. First change the empty-review regression test to require the exact failure signal and zero-character summary while preserving artifact/status assertions; observe that it fails because the current code never marks the step failed. Then implement the smallest production change and rerun the focused test. Audit every early return that publishes a failing legacy status and ensure no other path can return a successful Actions conclusion. Finally use CI for the repository-required Node checks and checked-in `dist` verification. No dependency pin changes are in scope.
