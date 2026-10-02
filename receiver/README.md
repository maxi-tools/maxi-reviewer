# maxi-reviewer re-trigger receiver

A Cloudflare Worker that subscribes to the GitHub webhook events the
`review-gate` workflow cannot, and posts the gate's verdict as the
maxi-reviewer App's own check run.

The fix it implements is described in
[maxi-tools/maxi-reviewer#72](https://github.com/maxi-tools/maxi-reviewer/issues/72).

## What it does

Resolving a review thread on a PR emits `pull_request_review_thread`
(`resolved` / `unresolved`) — a webhook delivered to GitHub Apps but not a
valid workflow trigger. This Worker subscribes to that webhook (and four
siblings) on behalf of the `maxi-reviewer` App, re-runs the gate logic on
the live PR state, and posts the verdict as the App's own check run. A
check run owned by the App is reachable through GitHub's manual re-run
button, which sends `check_run.rerequested` — that delivery is also
handled here.

Subscribed events:

| Event                                 | Action filter                                     |
| ------------------------------------- |   |
| `pull_request_review_thread`          | `resolved`, `unresolved`                          |
| `pull_request_review`                 | `submitted`, `dismissed`                          |
| `pull_request`                        | `opened`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, `labeled`, `unlabeled` |
| `pull_request_review_comment`         | `created`, `deleted`                              |
| `check_run`                           | `rerequested`, AND `name == maxi-reviewer/...`    |

## What is checked in

| Check name                                         | Verdict     |
| -------------------------------------------------- |   |
| `maxi-reviewer/review-gate (review threads)`       | failure if any thread is unresolved |
| `maxi-reviewer/review-gate (non-author review)`    | failure if no non-author review (with the fan-out and Dependabot bypasses preserved) |

Two checks, one per condition, so a reader can see which half of the
gate failed without negating a conjunction.

## What is NOT checked in

This is the App-owned verdict. The fanned-out `review-gate.yml`
workflow is **not** modified by this PR — until the App check has been
correct on real PRs for a while, both run. The plan is to retire the
workflow gate once the App check is trusted, per the issue's "Phase 6".
Two checks with the same verdict and different names is how people learn
to ignore both.

## Heartbeat

Every successful publish writes `last_success` to the bound KV
namespace. The Worker's `scheduled()` handler runs every 5 minutes and
writes `last_alert` when the heartbeat is older than
`HEARTBEAT_STALE_SECONDS` (default 1h). A scheduled workflow in
maxi-config reads `last_alert` and posts a `::error::` on its own run.

`GET /health` (and `/heartbeat`) returns 200 with the timestamp when
fresh, 503 when stale, so an external poller can also watch.

## Permissions (App)

| Permission          | Used for                                   |
| ------------------- |   |
| `checks: write`     | posting the App's own check run            |
| `pull_requests: read` | the GraphQL reviews + threads read       |
| `statuses: read`    | reading `review-roster` commit statuses         |

No `contents: write`, no `actions: write`, no `workflows: write`.

## Endpoints

```
POST /webhook        GitHub webhook delivery (HMAC-verified).
GET  /health         200 when heartbeat is fresh, 503 when stale.
GET  /heartbeat      Same shape as /health.
```

## Deploy

```bash
cd receiver
npm install
wrangler kv:namespace create "HEARTBEAT"      # paste id into wrangler.toml
wrangler secret put APP_ID
wrangler secret put APP_PRIVATE_KEY            # PEM, newline-stripped is fine
wrangler secret put APP_WEBHOOK_SECRET
wrangler deploy
```

In the App's settings page, set the webhook URL to
`https://<worker>/webhook` and subscribe to the five events above.

## Tests

```bash
npm test
```

The Python source of truth is
`maxi-config/maxi-review/.github/actions/pr-review-gate/pr_review_gate.py`
and its truth table lives in
`maxi-config/maxi-review/tests/test_pr_review_gate.py`. The JS port
mirrors that table case-for-case in `test/evaluate.test.ts`. Any
behaviour drift is a drift on the live gate.