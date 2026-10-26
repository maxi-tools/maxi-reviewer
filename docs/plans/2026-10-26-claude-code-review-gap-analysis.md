# Learning from "How the Claude Code team does code review"

**Status:** analysis and proposal, 2026-10-26. Nothing here is implemented yet.
**Scope:** maxi-reviewer (the action), the local pre-push path in maxi-core
(`🌿🩻`, hooks), the GitHub-side workflows (Maxi Review, Review Gate, Claude
Code Review), and the PR lifecycle in maxi-agent-runner (pre-cloud gate, merge
loop, verify/rework cards).

The question asked: what does the Claude Code team do that gets them a
reviewer engineers trust, and which of those things are we missing?

The one-paragraph answer: our pipeline already has several of their layers
(draft-first PRs, local reviewers that must run before a push, delta
re-review, an independent reviewer session, a merge gate on unresolved
threads). What it does not have is the part that makes their reviewer worth
gating on: **every candidate finding is independently verified before it is
posted, style and cleanup findings are dropped on purpose, and the reviewer is
scored daily against a corpus of real past incidents so a prompt or model
change cannot silently make it worse.** Our LLM reviewers are single-pass,
their confidence field is decorative, they are asked to comment on style and
performance, and nothing measures them except a post-hoc accept rate that
feeds back into nothing. That is why they are still marked `advisory:` and
why the Review Gate accepts any bot's COMMENTED review as "reviewed". The
recommendations below are ordered to close that gap first.

## Part 1 — What the Claude Code team actually does

Source: "How the Claude Code team does code review" (Addy Osmani, Morgan Westlee Lunt, Qing Wang;
claude.dev blog, 2026-10-15; mirrored as an X article). The cloud sandbox for this session cannot
reach x.com or claude.dev, so the article content below is reconstructed from search-engine
extracts of the post plus its secondary coverage, and cross-checked against the official Code
Review docs (code.claude.com/docs/en/code-review*) and the open-source `/code-review` plugin
prompt (anthropics/claude-code, plugins/code-review/commands/code-review.md), both of which were
reachable. Where only secondary sources carry a claim it is marked *(secondary)*.

### The framing

- ~90% of Claude Code is written by Claude. The bottleneck moved from writing to **proving the
  change is right**. Review is reframed as "the minimum human review time that does not raise
  reverts or incidents", measured, not assumed.
- Stated goal: most PRs merge with **at most one person in the loop, who may be the author**,
  with no rise in reverts or incidents.
- Reported outcome (June→September): merged PRs more than doubled, share of PRs reverted fell
  >40%; one-round pass rate 65%→78%; PRs needing 5+ review rounds 8.9%→1.5%; mean reviews-to-pass
  2.08→1.32 *(the round-count figures are secondary)*.

### The layers, in order

1. **Author-side verification before a PR exists.** The agent is given *runnable* checks
   (tests, build, lint, a screenshot compared to the design, a bash command, a browser or phone
   simulator) listed in a short CLAUDE.md, plus hooks that run formatters and linters. Then a
   **second agent reviews the diff in a fresh context** (`/code-review`, `/security-review`, or a
   subagent) before the PR opens. The point is that the author's own context is contaminated by
   having written the code; the reviewer must not share it.
2. **Required CI** on every PR.
3. **Automated AI review on every PR, before a human looks.** Reads the diff against the
   *whole repo* and the PR's *stated intent*: does it solve the stated problem, fit the system,
   and avoid breaking anything else. Mechanics (confirmed by the product docs): several agents
   **find** in parallel → a separate **verify** step checks each candidate against the code and
   drops false positives (the post describes this as a separate group *voting* on each finding;
   it is posted only if enough agree it is real) → **rank** by severity and dedupe → **post**
   inline, with a collapsed "Why this was flagged" section recording how it was verified.
   Style, diagnostics and cleanup-only findings are dropped; those filters were A/B tested on
   the team's own PRs. Engineers mark <1% of posted findings as wrong *(Osmani, Substack)*.
4. **Separate blocking security review.** A PR cannot merge while any finding from the bug review
   or the security review is still open; a later commit that fixes it clears it automatically.
5. **Human approval scaled by risk.** Low-risk (docs, flagged additive features) needs no human
   once the automated checks pass; medium needs one approval; high-risk / sensitive paths
   (billing, the auto-updater, CI workflow files, "dangerous code") always need people, and some
   need two *(tiers partly secondary; the sensitive-path list is in the post)*. They explicitly do
   **not yet** have circuit breakers that tighten approval when revert/incident rates rise.
6. **Merge queue** re-runs checks against latest main with the change applied, so two
   individually-green PRs cannot break main together.
7. **Flags and gradual rollout, then watch / fix forward / roll back.** New features start behind
   a feature flag, employees first; author and on-call watch; flags turn off without a deploy,
   broken builds get reverted automatically, a person decides the rest, scaled by risk. Every
   incident review asks *which layer should have caught this*.

### The parts that make the reviewer trustworthy (the bits most people skip)

- **An eval set built from incidents.** They collected past PRs that caused incidents, with their
  fix-forwards and reverts, and had engineers who know the code confirm each bug and where it
  lived. The reviewer runs against that set **daily**; any change to the prompt, tools or model is
  scored against the whole set and kept only if the score goes up.
- **Metrics with a guardrail.** Human time: median (and p95) human approvals per PR, number of
  human comments, how long a PR waits on a person. Guardrail: revert rate and incident rate. Plus
  rounds-to-pass, after one CLI PR went through 50+ review-and-fix rounds overnight; the fix was a
  three-round cap, diff-only re-review after the first pass, and never re-posting an already-posted
  finding *(secondary)*.
- **Review rules live outside the PR.** REVIEW.md is read from the base/default branch, never from
  the PR's own changes, and severity-lowering / path-excluding / nit-capping instructions are
  honoured only from a *protected* branch. A PR cannot weaken the review that judges it.
- **Severity vocabulary is tiny and means something.** 🔴 Important = fix before merge;
  🟡 Nit = worth fixing, not blocking; 🟣 Pre-existing = real bug, not this PR's. The check run
  never concludes as failure; a machine-readable severity line
  (`<!-- bughunter-severity: {"nit":1,"normal":2,"pre_existing":0} -->`) lets CI gate on it.
- **The false-positive list is explicit and the verifier is given it verbatim** (open-source
  plugin): pre-existing issues; looks-like-a-bug-but-isn't; pedantic nitpicks a senior engineer
  wouldn't make; anything a linter, typechecker or compiler catches; general quality concerns
  unless CLAUDE.md requires them; issues silenced by a lint-ignore; intentional behaviour changes;
  real issues on lines the PR didn't touch. Each candidate is scored 0–100 by an *independent*
  agent with a verbatim rubric; <80 is dropped; if nothing survives, nothing is posted.
- **Adoption advice, verbatim-ish:** give the agent runnable checks in a short CLAUDE.md; add
  REVIEW.md and move repeated review comments into it; add the AI reviewer on one repo, tune
  REVIEW.md for a few weeks, then widen.

## Part 2 — Where we stand, layer by layer

Pointers are to HEAD of each repo on 2026-10-26 (maxi-reviewer `f97628c`).
"maxi-config-owned" means the file in the repo carries that marker and the
change has to land in maxi-config, which is not in this session's scope.

| Layer | Claude Code team | Us today | Gap |
|---|---|---|---|
| Author-side runnable checks | Agent given tests/build/lint/screenshot checks in a short CLAUDE.md, plus formatter/linter hooks | maxi-core `hooks/pre-commit` + `pre-push` run rustfmt, qlty, and cargo fmt/clippy when `local_checks` is on; `🌿🩻` drives qlty/cubic/CodeRabbit/Codacy with a three-state verdict where `incomplete` is not a pass (`src/tools/local_review/mod.rs:282-293`); agent-runner's pre-cloud gate refuses a push unless the roster's reviewers `ran` at HEAD (`crates/maxi-kanban/src/pre_cloud/gate.rs:154-245`) | Small. This layer is in good shape and in one respect (honest `unavailable`/`failed` reporting) better than the article describes. |
| Fresh-context review before the PR opens | A second agent reviews the diff with none of the author's context (`/code-review`, `/security-review`, or a subagent) | None. `🩻` runs only external CLIs; the `requesting-code-review` skill dispatches a `🔱` review agent but nothing requires it, and the pre-cloud receipt only knows coderabbit/cubic/qlty (`crates/maxi-kanban/src/local_review.rs:46`) | **Missing layer.** |
| Required CI | Yes | Yes: `merge-gate`, `build-pr`, `security-pr`, maxi-lint ratchet, docs-only stubs | None. |
| AI review on every PR | Whole repo + stated intent; find → **verify** → rank → post; style/diagnostic/cleanup findings dropped; <1% of posted findings marked wrong | maxi-reviewer: one Jules (or OpenAI-compatible) pass over the diff ±25 lines, retrieval off by default (`action.yml` `retrieval_mode: off`), then only **structural** repair (`src/verify-format.ts`), out-of-diff scoping (`src/diff-filter.ts`), and the memory-evidence hold (`src/evidence.ts`). Confidence Low/Medium/High is rendered as an emoji and never filters (`src/github.ts:245-249`). The prompt asks for maintainability, naming, dead code and missing tests (`src/prompt.ts:246-250`); the Claude workflow prompt asks for "performance problems" and "code style and readability" (`claude-code-review.yml:415-420`, maxi-config-owned). Posted as COMMENT only; org runs it `fail_on: never` as `advisory: maxi reviewer` | **The central gap.** No semantic verification, no false-positive filter, severity vocabulary not aligned with "would I block on this", noise categories requested on purpose. |
| Separate blocking security review | Yes; a PR cannot merge with any open bug or security finding | Security is one bullet in the single prompt (`src/prompt.ts:247`); CodeQL runs separately; nothing blocks on a finding, only on *unresolved threads* (Review Gate) | Missing as a distinct pass; the thread gate is a weaker proxy because a thread can be resolved by anyone without a fix. |
| Reviewer eval set | PRs that caused incidents, with fix-forwards/reverts, bugs confirmed by engineers; run daily; changes kept only if score rises | None. `tests/` is plumbing; `calibration.ts` computes accept/dismiss rates from harvested artifacts weekly but "auto-suppression belongs to a separate job" (`src/calibration.ts:20-22`) and nothing imports it from the review path | **Missing.** This is what would let us justify flipping `advisory` to blocking; `maxi-review.yml` already says so in its own comments. |
| Rules outside the PR | REVIEW.md read from base/default branch, severity-lowering only honoured from a protected branch | `rules_file` is read at the **base SHA** (`src/github.ts:41-65`) — the right instinct, already done. But CLAUDE.md/REVIEW.md/AGENTS.md are not read at all; built-in `rules/` load from cwd so only work when the workflow stages them (`src/rules/select.ts:34-39`) | Partial. |
| Re-review rounds | Three-round cap; later rounds review only the delta; never re-post a posted finding; "not repeated — earlier Important findings still open" | Delta diff on `synchronize` (`src/review-pr.ts:777-789`), Jules session resume, own open threads passed back for `resolvedCommentIds`. No fingerprint dedupe, no round cap in the action; agent-runner's rework cards cap at 9 rounds (`verify_rework.rs:101`); the 50-round-overnight failure mode the article describes is possible here | Partial. Drift-tolerant anchors are already computed (`src/anchor.ts`) and unused for dedupe. |
| Human approval scaled by risk | Low-risk merges with zero humans once checks pass; sensitive paths (billing, auto-updater, CI workflows) always need people | Review Gate explicitly wants **no** human approval; a COMMENTED review from any asked bot satisfies it (`receiver/src/evaluate.ts:370,386`). No sensitive-path list, no CODEOWNERS, no ruleset files in-repo. Workers are correctly blocked from merging (`guard/shell/gh.rs:51-58,228-236`) | **Inverted.** We are more automated than the article's team on the approval side while having less verification on the reviewer side. |
| Merge queue + flags + watch/rollback | Yes | Merge queue is a pilot (`ci.yml:22-31`); merge loop pins the merge commit to the approved head (`src/merge_loop/pass/merge.rs`) | Fine for now. |
| Metrics with a guardrail | Median/p95 human approvals per PR, human comments, time waiting on a person, rounds-to-pass; revert and incident rate as guardrail | `calibration-harvest.yml` collects accept rates; `ci-metrics.yml` collects CI timings. Nobody computes rounds-to-pass or revert rate | Missing the guardrail half. |

Two side findings from the survey, unrelated to the article but worth a ticket:

- `PRODUCER_PR_RULE` tells producers to run `gh pr ready` as their last act,
  while the worker shell guard refuses `gh pr ready` (`guard/shell/gh.rs:53`),
  and the campaign preamble has the *reviewer* mark the PR ready. Three
  answers to one question.
- A bare consumer of maxi-reviewer following the README example will try to
  load `rules/<lang>.md` from its own checkout (`src/rules/select.ts:34`),
  which either ENOENTs or reads the PR's own `rules/` directory, the exact
  "a PR rewrites its own review" hole the article's REVIEW.md design closes.

## Part 3 — What to change, in order of leverage

### 1. Add a verify stage to maxi-reviewer (the biggest single lever)

Today one model call produces findings and they are posted. Make it two:

- **Find** stays as it is (Jules or the OpenAI-compatible backend).
- **Verify**: for each candidate finding, one independent call that receives
  the PR context, the single finding, the project rules, and the verbatim
  rubric and false-positive list from the open-source `/code-review` plugin
  (reproduced in Part 1). It returns a 0–100 score and a one-paragraph
  "why this was flagged / how it was verified". Drop anything under 80. If
  nothing survives, post the "no issues" note and nothing else.
- Verification should be **cross-model where possible**: Jules findings
  verified by Qwen3-Coder on the Sparks (`openai_base_url`), and vice versa.
  A verifier that shares the finder's weights shares its blind spots; the
  `distinct_from` rule agent-runner already enforces for verifier cards
  (`crates/maxi-kanban/src/route/filters.rs`) is the right principle here.
- Post the verifier's paragraph as a collapsed `<details>` on each inline
  comment, the way Code Review posts "Why this was flagged". That is what
  turns a bot comment from an opinion into an argument a human can check in
  ten seconds.
- Retire the decorative confidence emoji; the score is the confidence. Keep
  `evidenceSource` and let `memory` cap the score (it is already the reason
  the evidence hold exists).
- The retrieval loop (`retrieval_mode`) should be **on for the verifier**
  even if it stays off for the finder. Verification is where reading the
  callee or the test matters.

Cost: one extra small call per candidate finding, against a local vLLM
endpoint. This is the cheapest part of the pipeline.

### 2. Default to correctness, and shrink the severity vocabulary

The article's filter is blunt: style, diagnostics and cleanup-only findings
are dropped, A/B-tested on their own PRs, and the result is a <1% wrong-finding
rate. Ours asks for the opposite.

- In `src/prompt.ts` change the "What to review" block to correctness and
  security only by default: logic, nulls, races, off-by-one, injection,
  secrets, authz, data loss, broken error handling. Move maintainability,
  naming, dead code and missing tests behind an opt-in input
  (`review_scope: correctness|full`), with `correctness` the default.
- Same change for the Claude workflow prompt (maxi-config): drop
  "performance problems" and "code style and readability concerns".
  qlty, maxi-lint, Codacy and clippy already own that territory, and the
  article's rule "don't report what CI already enforces" applies.
- Map severities to the three the article uses and give each a merge
  meaning: `High` → 🔴 **Important** (fix before merge), `Warning` → 🟡
  **Nit** (worth fixing, not blocking), and add 🟣 **Pre-existing** for a
  real bug on an untouched line, which today is silently dropped by diff
  scoping. Cap Nits per review (five is their example).
- Require a `file:line` citation for any behaviour claim; a finding whose
  evidence is an inference from naming scores low in verify.

### 3. Build the incident eval set, then gate reviewer changes on it

This is the part nobody skips in the article and everybody skips in
practice. It is also the precondition `maxi-review.yml` itself names for
moving maxi-reviewer from advisory to blocking.

- **Corpus**: across maxi-tools, collect PRs that were reverted, PRs whose
  title or body says fix-forward, and the incidents already cited in
  CLAUDE.md and code comments (maxi-kvm#85 wrong block, maxi-libs#247
  the three defects cubic branch-mode missed, maxi-core#3460, #3932). For
  each, record the base SHA, head SHA, and the confirmed bug with file and
  line, confirmed by whoever knows the code. Start with 20–30 cases; the
  article's team did not start with hundreds either.
- **Harness**: a `workflow_dispatch` (or local script) that runs
  maxi-reviewer against each case's base/head pair and scores **recall**
  (did a posted Important finding land on the confirmed bug) and
  **precision** (how many posted findings are not in the confirmed set).
  The action already accepts `pr_number` and emits a structured artifact,
  so most of the plumbing exists.
- **Policy**: any change to `src/prompt.ts`, the rules files, the backend,
  or the model runs the harness; the change is kept only if recall does not
  drop and precision does not drop. Run it nightly as well so model-side
  drift (Jules updates itself) is caught.
- Feed `calibration.ts` output into the same report so accept rate on live
  PRs and recall on the incident set are read side by side.

### 4. Make the merge decision depend on verified findings, not threads

Once 1–3 are in place:

- Emit severity counts in machine-readable form, the way Code Review ends
  its check-run text with `<!-- bughunter-severity: {...} -->`. We already
  write a hidden artifact comment; add the counts to the commit status
  description or a check run so a script can gate on `important > 0`.
- Flip `fail_on` from `never` to `blocking` for Important findings only
  after the eval shows precision is high enough that a wrong block is rare.
  Keep Nits and Pre-existing non-blocking.
- Make the Review Gate require that no **Important** finding is open, in
  addition to no unresolved threads. "Resolved" is a click; "fixed and
  verified by the next review" is evidence. Code Review's "not repeated —
  earlier findings still open" rule is the model: a push that does not
  touch an open Important finding does not earn a fresh review.
- Add a distinct **security** find-agent in the find stage (injection,
  secrets, authz, unsafe deserialization, workflow permissions) and treat
  its Important findings as blocking from day one. Its output stays small
  and its cost of being wrong is asymmetric.

### 5. Put human approval where risk is, not nowhere

The article's team earns zero-human merges on low-risk changes by having a
verified reviewer, an eval set, and a guardrail metric, and still keeps
people on billing, the auto-updater and CI workflow files. We currently
have zero-human merges everywhere and none of the three preconditions.

- Define a sensitive-path list per repo and require one human approval
  there: `.github/workflows/**`, `hooks/**`, anything that signs, updates,
  installs or handles credentials, the daemon core, and the review tooling
  itself (a PR must not be able to weaken the gate that judges it, which is
  exactly the hole in `rules/` loading from cwd). CODEOWNERS plus a ruleset
  is the cheapest mechanism.
- Keep docs-only and byte-identical fan-out PRs on the zero-human path they
  already have. Use the roster's `band` (`maxi-review.yml:1531-1558`) as
  the medium/high tier signal; it already scores PRs, it just stops at
  choosing reviewers.
- Write down the circuit breaker now even if it is manual at first: if the
  monthly revert rate or mean rounds-to-pass rises past a threshold, the
  sensitive-path list widens until the number recovers.

### 6. Round discipline in the action

- Fingerprint findings (the anchors in `src/anchor.ts` are already drift
  tolerant) and never re-post a finding whose fingerprint is on an open
  or resolved thread of ours.
- Cap automatic re-reviews at three per PR; after that only `/maxi review`
  or a push that touches an open Important finding triggers one.
- Later rounds review the delta only and say so in the review body with a
  count of what was found and not posted, as Code Review does.

### 7. Read REVIEW.md and CLAUDE.md, from the base branch

- Add REVIEW.md (root plus the parent directories of changed files) to the
  inputs, read at the base SHA like `rules_file` is today, and pass it to
  both the finder and the verifier. Keep `rules_file` as an alias so no
  consumer breaks.
- Read CLAUDE.md the same way, as project context; a change that violates
  a CLAUDE.md rule is a finding only if the verifier can quote the rule
  (the plugin's "double check that CLAUDE.md actually calls out that
  issue").
- Honour severity-lowering, path-excluding and nit-capping instructions
  only when the base branch is protected. Our receiver already knows how to
  ask GitHub about branch state.
- Adopt the practice, not only the file: when the same human review comment
  appears twice, it goes into REVIEW.md. `detect-review-churn.py` already
  notices same-shaped findings across rounds; point its output at a
  REVIEW.md suggestion instead of an `extra_instructions` note.
- Fix `rules/` to load relative to the action's install directory
  (`GITHUB_ACTION_PATH`), never the workspace.

### 8. Fresh-context review before the PR, recorded in the receipt

- Add an LLM reviewer with no author context as a fifth reviewer in `🌿🩻`:
  Claude `/code-review` where a Claude credential exists, else a `🔱`
  review agent on a different model from the producer. It reviews the
  branch diff against `origin/main`, reports through the same
  `ok | failed | unavailable` contract, and its findings go into the
  `## Local review` block like the others.
- Add it to `SUBSTANTIVE_REVIEWERS` in agent-runner's completion gate so a
  producer card cannot complete without either it or CodeRabbit/cubic having
  run, and to the pre-cloud receipt so a push without it is refused unless
  the roster did not ask for it.
- Keep the article's framing in the skill text: the author's context is
  contaminated by having written the code, so the reviewer must not inherit
  the session. `🔱🚀` already spawns a fresh process; the rule is to not
  pass the producer's transcript in.

### 9. Measure what they measure

Extend `calibration-harvest.yml` (or a sibling) to compute per month, per
repo:

- rounds-to-pass per PR (distribution, mean, share at 5+)
- human comments per PR, human approvals per PR (median and p95)
- time a PR spends waiting on a person
- revert rate and incident-linked PR count (the guardrail)
- reviewer precision on the incident eval set

Publish it where the `review-roster` status is read today. The article's
numbers (65→78% one-round pass, 8.9→1.5% five-plus rounds, >40% fewer
reverts) are the targets to compare against, with the caveat that they are
Anthropic's internal figures and not reproducible from outside.

## Part 4 — What not to copy, and caveats

- **Their reviewer never approves or blocks.** The Code Review check run
  concludes neutral and the merge decision stays with the team. The
  *blocking* behaviour in the article is their repo's own rule ("a PR
  cannot merge with an open finding"), layered on top. Keep that split:
  the reviewer reports, the gate decides.
- **Zero-human merge is a compliance question too.** The HN thread raised
  SOC 2 auditors expecting a second human on production code. If any
  maxi-tools repo ever needs that, the sensitive-path list in §5 is where
  it goes.
- **Jules is not Claude.** The article's numbers come from a reviewer the
  team could tune and eval daily. Jules updates itself and we cannot pin
  its prompt internals; the eval harness in §3 is the only way to notice
  when it changes under us. That argues for keeping the OpenAI-compatible
  roster (Qwen on the Sparks) as a first-class finder, not only a fallback,
  because it is the one we can version.
- **The numbers are theirs.** Everything quantitative in Part 1 is
  Anthropic's internal measurement, reported in a blog post and relayed by
  secondary sources because the primary host was unreachable from this
  sandbox. Treat them as direction, not a benchmark.
- **Do not grow the prompt to fix precision.** The article's lesson is that
  precision came from an *independent* verify step and an eval set, not
  from a longer finder prompt. `src/prompt.ts` and the 2,183-line
  `maxi-review.yml` are already where instructions go to die.

## Suggested sequencing

| Phase | Change | Repo | Size |
|---|---|---|---|
| 0 | Correctness-only default, severity remap, Nit cap, evidence citation rule, `rules/` install-path fix, `ci_signal: auto` by default | maxi-reviewer; Claude prompt in maxi-config | days |
| 1 | Verify stage with cross-model scoring and "why flagged" details; drop <80 | maxi-reviewer | 1–2 weeks |
| 2 | Incident corpus (20–30 cases) and replay harness; nightly run; eval-gated prompt changes | maxi-reviewer | 1–2 weeks, plus engineer time to confirm bugs |
| 3 | Severity counts on the status/check run; `fail_on: blocking` for Important once eval precision supports it; Review Gate requires no open Important | maxi-reviewer, receiver, maxi-config | days after phase 2 |
| 4 | Fingerprint dedupe, three-round cap, delta-only wording | maxi-reviewer | days |
| 5 | REVIEW.md/CLAUDE.md inputs from base, protected-branch rule for weakening instructions | maxi-reviewer | days |
| 6 | Sensitive-path CODEOWNERS + ruleset; written circuit-breaker rule | each repo | days |
| 7 | Fresh-context LLM reviewer in `🩻` and in the pre-cloud receipt | maxi-core, maxi-agent-runner | 1 week |
| 8 | Metrics job: rounds-to-pass, human time, revert rate, eval precision | maxi-reviewer (harvest) | 1 week |

## Sources

- Addy Osmani, Morgan Westlee Lunt, Qing Wang, "How the Claude Code team does code review", claude.dev blog, 2026-10-15 (`https://claude.dev/blog/solving-code-review-at-anthropic/`; mirrored at `https://x.com/addyosmani/article/2114604912520921136`). Not fetchable from this sandbox; reconstructed from search extracts and the secondary coverage below.
- Simon Willison, quote and commentary, 2026-10-16 (`https://simonwillison.net/2026/Oct/16/code-review/`).
- Hacker News thread (`https://news.ycombinator.com/item?id=50122951`).
- Secondary summaries: dev.to (tokely; akaranjkar08), orcarouter.ai, leafw.net, explainx.ai, cellcog.ai, mnemehq.com, ai-tldr.dev, techbytes.app.
- Official docs, fetched directly: `https://code.claude.com/docs/en/code-review`, `/code-review-customize`, `/code-review-pull-requests`, `/code-review-local`.
- Open-source plugin prompt, fetched directly: `anthropics/claude-code` `plugins/code-review/commands/code-review.md` and `README.md`; `anthropics/claude-plugins-official` copy of the same.
- Codebase surveys of maxi-reviewer, maxi-core, maxi-agent-runner and maxi-cloud at their 2026-10-26 heads.
