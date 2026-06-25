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

concurrency:
  group: maxi-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  statuses: write
  actions: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Opengrep
        run: opengrep scan --json --output opengrep.json .
        continue-on-error: true

      - uses: maxi-tools/maxi-reviewer@v1
        with:
          jules_api_key: ${{ secrets.JULES_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on: blocking
          opengrep_json: opengrep.json
```

Add `JULES_API_KEY` as a repository Actions secret. The default `GITHUB_TOKEN` should be used with the permissions above.

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

## Analyzer Posture

Maxi Review is designed to consume fast, open-source analyzer output in the PR-time path:

- Opengrep/Semgrep-compatible JSON and SARIF findings.
- PMD XML violations.
- CPD XML duplicate findings.

Analyzers are treated as external tools. Maxi Review consumes their machine-readable output and preserves tool name, rule id, help URL, and license metadata where available.

Configured analyzer output inputs:

| Input            | Format                              |
| ---------------- | ----------------------------------- |
| `opengrep_json`  | Opengrep/Semgrep-compatible JSON    |
| `opengrep_sarif` | Opengrep/Semgrep-compatible SARIF   |
| `pmd_xml`        | PMD XML                             |
| `cpd_xml`        | CPD XML duplicate-detection results |

Set `analyzer_mode: off` to skip analyzer ingestion.

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
| `github_token`       |                                 | Required GitHub token, usually `${{ secrets.GITHUB_TOKEN }}`. |
| `fail_on`            | `blocking`                      | `never`, `blocking`, or `any`. Controls commit-status state.  |
| `skip_drafts`        | `true`                          | Skip draft PRs.                                               |
| `skip_forks`         | `true`                          | Skip PRs from forks.                                          |
| `bypass_label`       | `jules-override`                | Label that skips the review.                                  |
| `status_context`     | `jules/review`                  | Commit status context name.                                   |
| `extra_instructions` |                                 | Markdown appended to the review prompt.                       |
| `rules_file`         | `.github/jules-review-rules.md` | Repo file loaded from the base SHA. Set empty to disable.     |
| `timeout_minutes`    | `30`                            | How long to wait for Jules review output.                     |
| `analyzer_mode`      | `auto`                          | `auto` or `off`.                                              |
| `opengrep_json`      |                                 | Path to Opengrep/Semgrep-compatible JSON output.              |
| `opengrep_sarif`     |                                 | Path to Opengrep/Semgrep-compatible SARIF output.             |
| `pmd_xml`            |                                 | Path to PMD XML output.                                       |
| `cpd_xml`            |                                 | Path to CPD XML output.                                       |

## Apply-All And Hands-On Fixes

Structured suggestions can be applied as a batch only when the head SHA is still fresh. Broader findings can be routed to a hands-on Jules fix session only after an explicit `/maxi fix <finding-id>` command, on a same-repository PR branch, with write permissions available.

Fork PRs and stale heads are rejected for branch-writing flows.

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
