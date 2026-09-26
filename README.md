# Maxi Review

`maxi-review` is Maxi's PR review action. It combines fast analyzer context with a Jules review session, validates the structured response, posts GitHub review feedback, and records review artifacts for late harvesting.

This repository is a hard fork of the earlier Jules PR reviewer workflow, but the action identity and review schema are Maxi-owned:

- Action/package identity: `maxi-review`
- GitHub Action runtime: Node 24
- Review schema namespace: `maxi.review.v1`

## Usage

```yaml
name: Maxi Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: true
      command:
        description: Maxi command, for example /maxi apply-all
        required: true

concurrency:
  group: maxi-review-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    steps:
      - uses: actions/checkout@v4

      - name: Create Maxi Review app token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.MAXI_REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.MAXI_REVIEW_APP_PRIVATE_KEY }}
          permission-contents: read
          permission-issues: write
          permission-pull-requests: write
          permission-statuses: write

      - uses: maxi-tools/maxi-reviewer@v1
        with:
          jules_api_key: ${{ secrets.JULES_API_KEY }}
          github_token: ${{ steps.app-token.outputs.token }}
          fail_on: blocking

  command:
    if: (github.event_name == 'issue_comment' && github.event.issue.pull_request) || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - name: Create Maxi Review app token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.MAXI_REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.MAXI_REVIEW_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-issues: write
          permission-pull-requests: write

      - uses: maxi-tools/maxi-reviewer@v1
        with:
          jules_api_key: ${{ secrets.JULES_API_KEY }}
          github_token: ${{ steps.app-token.outputs.token }}
          command: ${{ inputs.command }}
          pr_number: ${{ inputs.pr_number }}
```

Add `JULES_API_KEY` and `MAXI_REVIEW_APP_PRIVATE_KEY` as organization or
repository Actions secrets. Add `MAXI_REVIEW_APP_CLIENT_ID` as an organization
or repository Actions variable. Using an app token makes review comments appear
as the GitHub App's bot user instead of `github-actions[bot]`.

## What It Does

- Rejects `pull_request_target` and skips fork PRs by default for write-capable review flows.
- Collects the PR diff, changed files, project rules, open Maxi/Jules review threads, analyzer findings, and per-language Maxi rule guidance.
- Passes trusted structured context to Jules before untrusted PR title/body/diff data.
- Asks Jules to return a `maxi.review.v1.jules-review` JSON object.
- Validates schema, locations, suggested-change fences, changed-line targets, and structured suggestions.
- Requests same-session repair when Jules returns malformed JSON or invalid review data.
- Posts actionable GitHub review comments and uses suggested-change format when a fix is mechanically applicable.
- Builds `maxi.review.v1.review-artifact` JSON so review feedback remains harvestable even if PR review submission is unavailable or late.
- Records review artifacts as hidden PR comments for later harvesting.
- Publishes each artifact over both channels — the Actions artifact store and the hidden PR comment — and tolerates the loss of either. The verdict is decided before publication, so an artifact-storage outage (the org-wide quota is shared) is warned about, not reported as a failed review. Losing **both** channels still fails the step: nothing was recorded and there is nothing left to harvest.
- Handles `/maxi apply-all` and `/maxi fix <finding-id>` on `issue_comment` events.

## Analyzer Posture

Maxi Review is designed to consume fast, open-source analyzer output in the PR-time path:

- Opengrep/Semgrep-compatible JSON and SARIF findings.
- PMD XML violations.
- CPD XML duplicate findings.

Analyzers are treated as external tools. In `auto` mode, Maxi Review runs `opengrep` and `pmd` from `PATH` when no analyzer output files are configured, consumes their machine-readable output, and preserves tool name, rule id, help URL, and license metadata where available. Missing analyzer binaries are non-fatal so review can still proceed with Jules-only context.

If your CI installs analyzers in an earlier step, leave `analyzer_mode` at `auto`. If another job or step already produced analyzer output, pass the output paths below; configured files take precedence over running tools.

Configured analyzer output inputs:

| Input            | Format                              |
| ---------------- | ----------------------------------- |
| `opengrep_json`  | Opengrep/Semgrep-compatible JSON    |
| `opengrep_sarif` | Opengrep/Semgrep-compatible SARIF   |
| `pmd_xml`        | PMD XML                             |
| `cpd_xml`        | CPD XML duplicate-detection results |

Set `analyzer_mode: off` to skip analyzer execution and ingestion.

Qodana is intentionally not run during PR-time review. It is more expensive and belongs in nightly or self-hosted checks. Later Maxi-authored Qodana-inspired guidance can live in Maxi-owned rule files, but this repository does not bulk-copy JetBrains Inspectopedia or Qodana documentation.

## Rule Guidance

The `rules/` directory contains concise Maxi-authored guidance for:

- JavaScript
- TypeScript
- Python
- Rust
- Go
- Shell
- Markdown
- GitHub Actions

Project-specific rules can still be supplied with `extra_instructions` or `rules_file`.

## Inputs

| Input                | Default                         | Description                                                   |
| -------------------- | ------------------------------- | ------------------------------------------------------------- |
| `jules_api_key`      |                                 | Required Jules API key.                                       |
| `jules_api_key_fallback` |                             | Optional Jules API key for a second account. Used only when a session never leaves repository setup — see [Stuck sessions](#stuck-sessions). |
| `reviewer_backend` | `jules` | `jules` (default) or `openai`. `openai` / `qwen` sends the review to an OpenAI-compatible server instead of Jules — the explicit roster entry. |
| `openai_base_url` | | OpenAI-compatible base URL, including `/v1` (for example `http://jasper:8000/v1`). Required when `reviewer_backend` is `openai`. When the backend is Jules, setting this turns a Jules timeout into a fallback review rather than an empty one — see [OpenAI-compatible fallback](#openai-compatible-fallback). |
| `openai_api_key` | | Bearer token for that server. Leave empty when vLLM is serving without `--api-key`. |
| `openai_model` | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | `model` field sent to the server. |
| `openai_timeout_minutes` | `8`, capped at `timeout_minutes` | Per-turn budget for the OpenAI-compatible reviewer. |
| `github_token`       |                                 | Required GitHub token (App installation token preferred). Reviews also read linked issues, so the token needs issues:read; /maxi commands additionally need contents:write and issues:write. Enabling `ci_signal: auto` also needs checks:read. |
| `fail_on`            | `blocking`                      | `never`, `blocking`, or `any`. Controls commit-status state.  |
| `skip_drafts`        | `true`                          | Skip draft PRs.                                               |
| `skip_forks`         | `true`                          | Skip PRs from forks.                                          |
| `bypass_label`       | `maxi-review-override`          | Label that skips the review.                                  |
| `status_context`     | `maxi/review`                   | Commit status context name.                                   |
| `extra_instructions` |                                 | Markdown appended to the review prompt.                       |
| `rules_file`         | `.github/maxi-review-rules.md`  | Repo file loaded from the base SHA. Set empty to disable.     |
| `timeout_minutes`    | `30`                            | How long to wait for Jules review output.                     |
| `hard_timeout_minutes` | `timeout_minutes + 20`        | Wall-clock process deadline (minutes). On expiry the action fails the commit status and exits so a silent hang cannot hold a self-hosted runner until the job timeout. Empty uses `timeout_minutes + 20` (setup/analyzer headroom). |
| `analyzer_mode`      | `auto`                          | `auto` or `off`.                                              |
| `opengrep_json`      |                                 | Path to Opengrep/Semgrep-compatible JSON output.              |
| `opengrep_sarif`     |                                 | Path to Opengrep/Semgrep-compatible SARIF output.             |
| `pmd_xml`            |                                 | Path to PMD XML output.                                       |
| `cpd_xml`            |                                 | Path to CPD XML output.                                       |
| `ci_signal` | `off` | `auto` fetches PR head check-runs (needs checks:read) as review evidence; `off` skips them. Supplied report files are ingested regardless. |
| `test_report` | | Path to a test report file (e.g. a JUnit or text summary) to ingest as CI evidence. |
| `coverage_summary` | | Path to a coverage summary file (e.g. a coverage delta) to ingest as CI evidence. |
| `dedupe_reviewers` | `off` | `auto` fetches other reviewers active inline comments and tells the model not to restate them. |
| `command`            |                                 | `/maxi ...` command for `workflow_dispatch`.                  |
| `pr_number`          |                                 | Pull request number for `workflow_dispatch` commands.         |


> **Hang release guarantee:** `hard_timeout_minutes` is enforced inside the action
> process (timers + status cleanup). A blocked Node event loop can prevent those
> timers from firing. Always set the GitHub Actions **step** `timeout-minutes`
> above `hard_timeout_minutes` (default `timeout_minutes + 20`) plus a few minutes
> of cleanup headroom — that outer timeout is the real runner-release watchdog.
> With the default Jules budget of 30 minutes the process deadline is 50 minutes;
> use a step `timeout-minutes` of at least 55 and a job timeout above that.

## Stuck Sessions

A Jules session can be created, accept the full prompt, and then never leave
repository setup — the session page sits on `🐙 Cloning <repo>` with a live
spinner and no agent turn ever begins. Observed on 2026-09-10: session
`9532304781847968824` was still cloning over two hours after creation, on an
account nowhere near its quota (11/300).

That is not the same failure as a review that ran and stayed silent, and
waiting it out buys nothing: measured across 26 reviews, a reply that is coming
arrives in 21–190s (slowest 546s), or never. So the review budget is spent
entirely on a session that cannot produce a review.

The action watches the session's own state rather than the clock. If the
session has not started work within five minutes — and only on positive
evidence of a pre-work state, never because the state could not be read — the
session is abandoned and the review is recreated: on `jules_api_key_fallback`
when a second account is configured, otherwise as a fresh session on the same
one. A session that reaches `IN_PROGRESS` is never abandoned, however slow it
is.

If every configured account fails to bring a session up, the job fails with an
`error` commit status naming the stuck session and state, rather than reporting
a review timeout. The two call for opposite responses — a timeout is worth
re-running, a stuck clone is worth recreating elsewhere — so they are reported
differently.

## OpenAI-compatible fallback

Jules is still the default reviewer. On 2026-09-26 it produced no review twice,
each time by sitting out a 15-minute budget, and the PR had no substantive
review. An OpenAI-compatible chat-completions server covers that gap in two
ways, selected by config:

- **Fallback.** Leave `reviewer_backend` at `jules` and set `openai_base_url`.
  If Jules returns no review before `timeout_minutes`, the same prompt is sent
  to that server. A Jules error that is not "no review" (auth, a stuck clone)
  is not retried there: those are answers, and a second model should not paper
  over them. If the fallback also returns nothing, the job still records the
  Jules timeout — the harvest must not claim a review that neither side wrote.
- **Roster reviewer.** Set `reviewer_backend: openai` (alias `qwen`) on a
  second workflow job. That job reviews with the local model and does not
  require `jules_api_key`. It posts through the same comment path, so the two
  reviews sit side by side rather than one replacing the other.

The intended server is Qwen3-Coder on vLLM, on the ARM64 DGX Sparks (jasper,
pearl, peridot). Standing the server up is a separate step; the recipe is in
[docs/qwen3-coder-vllm.md](docs/qwen3-coder-vllm.md). The action only needs the
base URL. It does not take an x86 Linux lane to do that: the review job keeps
the runner it already has, and the model runs on the Spark.

```yaml
- uses: maxi-tools/maxi-reviewer@v1
  with:
    jules_api_key: ${{ secrets.JULES_API_KEY }}
    github_token: ${{ steps.app-token.outputs.token }}
    openai_base_url: http://jasper:8000/v1
    openai_model: Qwen/Qwen3-Coder-30B-A3B-Instruct
```

## Outputs

| Output             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `review_artifacts` | JSON array emitted by `/maxi harvest` with recorded artifacts. |

## Apply-All And Hands-On Fixes

Structured suggestions can be applied as a batch only when the head SHA is still fresh. Broader findings can be routed to a hands-on Jules fix session only after an explicit `/maxi fix <finding-id>` command, on a same-repository PR branch, with write permissions available.

Supported PR comment or `workflow_dispatch` commands:

- `/maxi apply-all`
- `/maxi fix <finding-id>`
- `/maxi harvest`

Fork PRs and stale-head branches are rejected for branch-writing flows.

## Reviewer Calibration Profile

A weekly scheduled job (`.github/workflows/calibration-harvest.yml`) walks the
org's merged/closed PRs in a 30-day trailing window, classifies every inline
review thread from the seven bot reviewers the org runs
(`codacy-production`, `coderabbitai`, `qltysh`, `chatgpt-codex-connector`,
`cubic-dev-ai`, `github-advanced-security`, `maxi-reviewer`), and publishes
the result as a release asset on the rolling tag `reviewer-profiles-latest`:

- `reviewer-profiles.json` — per-reviewer overall + by-path-group accept-rate.
- `calibration.json` — the per-rule / per-severity / per-path report produced
  by the existing `calibration.ts` engine over the harvested
  `maxi.review.v1.review-artifact` payloads from `maxi-reviewer`.

The workflow is `workflow_dispatch`-triggerable; pass `dry_run=1` to write to
`/tmp` and skip the release publish.

### Schema

`reviewer-profiles.json` is the file downstream selectors read:

```jsonc
{
  "schema": "maxi.review.v1.reviewer-profiles",
  "generatedAt": "2026-09-18T06:00:00.000Z",
  "windowDays": 30,
  "reviewers": {
    "coderabbitai": {
      "overall":        { "n": 213, "acceptRate": 0.42 },
      "byPathGroup": {
        "rust-src":     { "n":  64, "acceptRate": 0.31 },
        "workflows":    { "n":  29, "acceptRate": 0.55 },
        "python":       { "n":  18, "acceptRate": 0.17 }
      }
    },
    // ... one entry per bot
  }
}
```

`calibration.json` follows the `byRule` / `bySeverity` / `byPath` shape the
existing `src/calibration.ts` engine already produces (see its docstring) and
exists so the per-rule low-precision signal isn't lost when only the
per-reviewer profile is published.

### How to read it

`acceptRate` is `accepted / (accepted + dismissed)`. A thread is classified
as:

- **accepted** — a commit after the thread's first comment touched the same
  file (or another file in the same `pathGroupFor()` group). This covers the
  most common "the author fixed it in a follow-up commit" case.
- **dismissed** — the thread was resolved with no subsequent commit on the
  same file (or another file in the same `pathGroupFor()` group).
  Resolved is treated as a deliberate close by either the thread author
  or the PR author; "no edit" is the evidence the finding was not
  actioned.
- **unaddressed** — the thread is still open and no commit has touched the
  same file (or another file in the same `pathGroupFor()` group).
  Open + no edit = the finding is sitting there unresolved.

Unaddressed findings are not counted in the accept-rate denominator: a
pending finding carries no signal yet, and we don't want to penalise a bot
for an in-flight review. The trade is that a thread that drifts without
resolution for a long window reads as 0% accepted. The harvest window
defaults to 30 days precisely so the denominator shifts as threads age.

### Path groups

A path group is a routing bucket, not a verdict on the bot. The named
buckets are `rust-src`, `rust-test`, `workflows`, `shell`, `python`, `docs`,
`lockfile`, `config`; anything else falls into its top-level directory
(`src`, `lib`, `crates`, ...). The exact `pathGroupFor()` rule lives in
`src/reviewer-profile.ts` and the fixtures in
`tests/reviewer-profile.test.ts` pin every named bucket.

### Caveat — read this before routing on it

A low accept-rate on a path group is a **routing signal**, not a verdict on
the bot. Reviewers score differently across path groups for reasons that
have nothing to do with quality: a reviewer that focuses on workflow YAML
will underperform on Rust source by construction, because its findings are
about a different surface. Use the profile to decide which reviewer to
*route* to on which surface, not whether to trust it.

A path group with `n < 20` in the window is too noisy to drive routing
either way — the noise floor for this schema is `n = 20`. The selector that
consumes this file should treat small-N groups as "no signal" rather than
as evidence.

The profile file is allowed to be absent. The selector MUST tolerate a
404 on the rolling tag (a fresh repo, an App outage, an org on a different
billing tier) and fall back to round-robin routing — the harvest job is
best-effort and is not on the merge-gate critical path.

### Triggering a backfill

`Actions → Calibration Harvest → Run workflow` runs the harvest with the
default 30-day window and publishes to the rolling tag. Pass `dry_run=1`
to write to `/tmp` (uploaded as the `calibration-harvest-dry-run` artifact
for inspection) without touching the release tag.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

The built action in `dist/` is committed for GitHub Action execution.

## License

MIT
