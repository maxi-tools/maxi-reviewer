# Martian's Code Review Bench: what it tells us, and what to borrow

**Status:** analysis and proposal, 2026-10-26. Companion to
[`2026-10-26-claude-code-review-gap-analysis.md`](2026-10-26-claude-code-review-gap-analysis.md),
whose recommendation 3 (an eval set for the reviewer) this document largely
answers.

**Source:** `https://codereview.withmartian.com/` (leaderboard; the host is
not reachable from the cloud sandbox) and the MIT-licensed repository behind
it, `withmartian/code-review-benchmark`, cloned at commit `e616e84` and
read directly. Leaderboard numbers below come from the repository's own
`offline/analysis/benchmark_dashboard.json`, not from vendor blog posts.

## What it is

Two benchmarks that check each other, with everything public: the PRs, the
golden comments, the judge prompts, the pipeline, and the per-judge results.

- **Offline.** 50 PRs from Sentry, Grafana, Cal.com, Discourse and Keycloak
  (Python, Go, TypeScript, Ruby, Java) with 173 human-curated golden
  comments, each tagged with a severity and a category. Every tool reviews
  forked copies of the same PRs. An LLM judge asks, per candidate finding
  and golden comment, "do these describe the same underlying issue?". Three
  judges are stored (Claude Opus 4.5 is the default, plus Sonnet 4.5 and
  GPT-5.2); the top five tools are the same under all three. Scoring
  profiles decide which categories count: **Strict** (bug, security,
  concurrency, data, api: 139 golden), **Core** (plus perf, test_gap,
  doc_defect: 158, the default), **All** (plus style, speculative: 173). A
  match on an excluded category is neither rewarded nor penalised. The
  leaderboard default is **F2**, which weights recall four times precision,
  on the argument that a missed bug costs more than a false alarm.
- **Online.** Continuously samples merged public PRs where a tracked bot
  reviewed, reconstructs the timeline, extracts the bot's suggestions and the
  developer's post-review fixes with an LLM, and matches them. Precision is
  "what share of the bot's suggestions did the developer act on", recall is
  "what share of the developer's fixes had the bot already flagged". This is
  Martian's headline metric because it is anchored to behaviour nobody
  controls. Bots are tracked by GitHub login
  (`online/etl/config.py:DEFAULT_CHATBOT_USERNAMES`).
- **Inclusion criteria for the public leaderboard:** roughly 600 to 1,000
  reviewed public PRs across a spread of orgs, and reviews attributable to a
  bot account or a consistent marker. Martian runs the pipeline itself for
  any tool it publishes. Anyone can run the harness privately without
  meeting those criteria.

The methodology document is unusually candid about Goodhart's law, judge
calibration (the judge "has not been formally calibrated against human
annotations"), golden-set incompleteness, and training leakage on the
offline set. It also describes two ideas we had independently reached in the
gap analysis: tracing production bugs back to the PR that introduced them as
a held-out recall set, and conditioning precision on a repo's `agents.md` /
`claude.md` so that "what the user asked to be flagged" is the standard for
both the tool and the grader.

## Offline leaderboard, Opus judge, Core profile

Micro-averaged over 50 PRs. Tools we run today are marked.

| Tool | Precision | Recall | F1 | F2 | Ours? |
|---|---|---|---|---|---|
| Qodo Extended (research preview) | 67.1 | 64.6 | 65.8 | 65.1 | |
| Cubic v2 | 61.5 | 65.8 | 63.6 | 64.9 | yes, local and PR |
| Augment | 59.5 | 65.2 | 62.2 | 64.0 | |
| Qodo v2 | 55.4 | 62.0 | 58.5 | 60.6 | |
| GitHub Copilot | 38.5 | 66.5 | 48.8 | 58.1 | |
| Gemini | 45.3 | 55.1 | 49.7 | 52.8 | yes, on demand |
| GitLab Duo | 53.5 | 52.5 | 53.0 | 52.7 | |
| Sourcery | 41.0 | 55.1 | 47.0 | 51.6 | |
| Greptile v4 | 50.9 | 51.3 | 51.1 | 51.2 | |
| CodeRabbit | 32.6 | 59.5 | 42.1 | 51.1 | yes, on demand |
| Macroscope | 61.1 | 48.7 | 54.2 | 50.8 | |
| Cursor Bugbot | 56.9 | 46.8 | 51.4 | 48.5 | |
| Claude Code (CLI) | 46.3 | 48.1 | 47.2 | 47.7 | nearest to our Claude workflow |
| Devin | 69.1 | 41.1 | 51.5 | 44.7 | |
| Kodus, CodeAnt, Baz, Claude Code (app), KG, Graphite | | | | 41.5 to 9.3 | |

Not measured anywhere on the board: **Jules** (maxi-reviewer's default
backend), **Qwen3-Coder** (the OpenAI-compatible backend), **Codacy** and
**qlty** (static analysers, out of scope for Martian). The managed Claude
Code Review service (find, verify, rank, post) is not listed under that name
either; the "Claude" rows are the CLI and the older GitHub app.

Online, the picture is tighter and shifts monthly. The snapshot cited by The
New Stack on 6 October 2026 had Cubic first at 64.9 F1, then Greptile and
CodeRabbit, with Copilot fourth at 60.9; a late-September tracking post had
Greptile second with the highest precision on the board at 80.5. Vendor
"#1" posts each cite a different week. The repository's data does not
include the online table, so none of those numbers is reproducible here.

## What it says about our current roster

- **Cubic earns its place.** Second offline, first online in the most recent
  snapshots, and the one reviewer with a per-commit local mode. The
  `local_review` and pre-cloud receipt gates that treat it as a substantive
  reviewer are justified by independent data.
- **CodeRabbit is a recall tool, not a precision tool.** 59.5 recall at 32.6
  precision: two of every three findings do not match a golden comment.
  That matches our experience and our config (`auto_review: false`, profile
  `chill`, review only on `@coderabbitai review`). Keep it on demand. It
  should not be the reviewer whose COMMENTED review satisfies the Review
  Gate's "non-author review" leg on its own.
- **Gemini is mid-table.** 52.8 F2 with 45 precision. On demand is the right
  setting.
- **Our primary reviewer has no public number.** Jules is not on either
  board. Everything we believe about maxi-reviewer's precision comes from
  the weekly accept-rate harvest, which measures what authors dismissed, not
  what the reviewer missed. The offline harness is the first instrument we
  have that can measure recall.
- **A generic Claude pass scores low offline.** Claude Code (CLI) at 47.7 F2
  and the GitHub app at 38.9 are bottom-half. Our `claude-code-review.yml`
  is a single generic prompt on `claude-code-action`, so it is closer to
  those rows than to the managed service's find-verify-rank pipeline.
  Another reason the verify stage in the gap analysis matters more than
  which model runs the find stage.

## Worth adding

Ranked by what each would add, not by leaderboard position alone.

1. **The offline harness itself, as our reviewer eval.** This is the big
   one and it replaces the "build a corpus from scratch" first step in the
   gap analysis. Concretely:
   - `step0_fork_prs` forks the 50 PRs into an org where the tool is
     installed. Make a `maxi-tools-bench` org with the Maxi Review workflow
     and let maxi-reviewer review them once per backend, so **Jules** and
     **Qwen3-Coder** score as two separate tools.
   - Alternatively, skip GitHub the way the Fletcher write-up did: a thin
     harness that calls maxi-reviewer's review path directly and writes the
     result into `results/benchmark_data.json` as one more tool. That needs
     the CLI entry point the gap analysis already asks for (maxi-reviewer is
     GitHub-context-only today, `src/index.ts`), so the two items pay for
     each other.
   - Run steps 1 to 3 with the Opus judge for comparability. Fletcher's
     report puts judging two full runs at under a dollar; the review side
     costs whatever 50 Jules sessions cost.
   - Report Core precision, recall, F1 and F2 before and after every change
     to `src/prompt.ts`, the rules, the backend or the verify stage. A
     prompt change is kept only if the number does not drop. The bar for
     flipping `advisory:` to blocking on Important findings is written
     down in advance: precision at or above Cubic's 61 on this set, and no
     recall regression.
   - Treat 50 public PRs as a calibration instrument, not a target. Jules
     may have seen them (Martian names this leakage risk itself), the golden
     set is incomplete (Fletcher found real bugs scored as false
     positives), and judges disagree by about five points. The private
     incident corpus from the gap analysis stays as the second, held-out
     set. That pairing is exactly Martian's own offline-plus-online design,
     and it is what the Claude Code team does with their incident set.
2. **Martian's online pipeline, run over our own repositories.** The ETL
   takes a bot login and a date range and produces acted-on precision and
   recall per bot from real PR timelines. Pointed at maxi-tools PRs with
   `maxi-reviewer[bot]`, `cubic-dev-ai[bot]`, `coderabbitai[bot]`,
   `claude[bot]` and `gemini-code-assist[bot]`, it scores every reviewer in
   our roster on the same PRs, monthly, with a judge we do not have to
   write. That is a stronger signal than `calibration-harvest.yml`'s
   accept-rate, because it also sees what the author fixed that no bot
   flagged. It would also give the roster selector in `maxi-review.yml` a
   measured basis for which bots to summon per band.
3. **The judge prompt and the dedup step, reused inside maxi-reviewer.**
   `JUDGE_PROMPT` in `step3_judge_comments.py` is a tested "same underlying
   issue?" matcher. It is the missing piece for fingerprint dedupe across
   review rounds and for cross-bot dedupe, both of which are prompt-only
   hints today. `step2_5_dedup_candidates` is the same idea applied within
   one review (inline plus summary duplicates).
4. **Greptile, as a trial on the online side.** Consistently top three
   online with the highest precision on the board, which is the shape of
   tool that suits a blocking lane. Offline it is mid-table, so run it
   through the harness first. Cost and seat model are not covered here and
   need checking before any commitment.
5. **Augment or Qodo, only if the harness shows a gap cubic does not fill.**
   Both are top-four offline. Qodo Extended is a research preview and its
   standard product is mid-table; Augment's bundled pricing is the open
   question. Neither should be added until we have maxi-reviewer's own
   offline number to compare against, or the roster grows without a reason.
6. **Not worth adding now:** GitHub Copilot (highest recall, 38.5 precision,
   the CodeRabbit shape), Devin and Macroscope (high precision, 41 to 49
   recall, and the precision-only lane is better served by the verify
   stage), Sourcery and the long tail.

## Getting maxi-reviewer onto the public online board

The inclusion criteria are 600 to 1,000 reviewed public PRs across orgs and
an attributable bot login. `maxi-reviewer[bot]` satisfies the second. The
first depends on how much of the fleet's review activity is on public
repositories; if it clears the bar, the step is a pull request to
`withmartian/code-review-benchmark` adding the login to
`DEFAULT_CHATBOT_USERNAMES`, and Martian runs the rest. Worth doing only
after the offline number is one we would be happy to see published.

## Suggested order

| Step | Change | Size |
|---|---|---|
| 1 | Fork the 50 PRs into a bench org, run maxi-reviewer (Jules, then Qwen) through steps 1 to 3 with the Opus judge, record the baseline | one afternoon, per the README, plus Jules quota |
| 2 | Land the CLI entry point so the harness can run without GitHub, and wire the before/after report into the eval-gated change policy from the gap analysis | days |
| 3 | Run the online ETL over maxi-tools PRs for every roster bot, monthly, alongside `calibration-harvest.yml` | days to set up, then scheduled |
| 4 | Port `JUDGE_PROMPT` into maxi-reviewer for round-to-round and cross-bot dedupe | days |
| 5 | Trial Greptile on one repo after checking cost; compare on the harness | after step 1 |

## Sources

- `https://codereview.withmartian.com/` (leaderboard, not fetchable from the sandbox).
- `withmartian/code-review-benchmark` at `e616e84`: `README.md`, `offline/README.md`, `online/README.md`, `methodology/summary.md`, `methodology/full.md`, `offline/analysis/benchmark_dashboard.json`, `offline/code_review_benchmark/step3_judge_comments.py`, `online/etl/config.py`.
- `shahparshva72/fletcher-code-review-benchmark` README: an independent run of a new tool through the offline harness, with judge-calibration and cost notes.
- The New Stack, "Copilot tops GitHub's own AI code review benchmark. An independent one tells a different story", for the 6 October 2026 online snapshot.
- Vendor posts from Greptile, cubic and Qodo were read for context only; their numbers are not used above.
