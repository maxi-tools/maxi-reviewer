"""Answer "is this PR actually green?" without being fooled by superseded runs.

GitHub's PR rollup aggregates check runs across *all* check suites for a SHA
rather than taking the newest. Re-running a workflow replaces its own check
runs; a *new* run does not replace a previous run's. So a PR that re-runs a
workflow -- every `concurrency: cancel-in-progress` workflow does, on every
push and every review event -- accumulates rows, and the cancelled ones from
superseded runs sit in the rollup next to the live ones, same name, same SHA.

`gh pr checks` then shows the same check twice, once `fail` and once `pass`,
and "is this PR green?" has no answer. Observed on maxi-core #3958: ten
non-green rows, zero real failures, every one a `CANCELLED` superseded run.
That is not a display quirk -- it is read as a live failure and re-investigated
as one, by people and by agents.

review-gate-reusable.yml already documents this for its own verdicts and
answers it by publishing a COMMIT STATUS, which is last-write-wins per context.
This script generalises that answer to every workflow:

  * group workflow runs by workflow, keep only the newest run of each;
  * drop check runs belonging to a superseded run's check suite;
  * keep app check runs (Codacy, CodeFactor, review bots) -- they have no
    workflow run behind them -- newest per name;
  * read commit statuses as-is, since they are already last-write-wins.

Three outcomes, three exit codes, deliberately never collapsed:

  0  GREEN    -- everything that ran finished and passed.
  1  NOT      -- something failed, or something is still running. Both mean
                 "do not merge", but the reasons are printed separately
                 because only one of them is worth investigating.
  2  UNKNOWN  -- the API could not be read. NOT the same as "not green", and
                 emphatically not the same as green: a judge that reports a
                 failed query as a clean bill of health is the bug this file
                 exists to avoid.

Deliberately self-contained: it shells out to `gh` and imports nothing from
this repository, because it is distributed to the whole fleet from maxi-config
and most repos have no shared Python helpers to import.

No shebang, on purpose. This file reaches every repo through the fan-out, which
writes with the GitHub Contents API -- and that API has no mode, so every copy
lands as 100644. A shebang on a file that is not executable is exactly what
Codacy's EXE001 flags, and it did, on every recipient that runs Codacy. The
script is invoked as `python3 <path>` everywhere it is used, so the shebang was
documentation that cost a red check; the usage line above is the documentation.
"""

# maxi-config-owned PR greenness judge.

import argparse
import json
import os
import re
import shutil
import subprocess  # nosec B404 -- the optional `gh` transport, never a shell
import sys
import urllib.parse

# Conclusions that do not stand in the way of a merge. `neutral` and `skipped`
# are explicit passes in GitHub's model; `None` means still running and is
# handled separately so it can be reported as pending rather than as failure.
OK_CONCLUSIONS = frozenset({"success", "skipped", "neutral"})

# A cancelled run reached no verdict. Once superseded runs are discarded, a
# cancelled run that is still the newest of its workflow means that workflow
# has no current answer for this SHA -- which is neither a pass nor a failure.
# Calling it a failure sends someone to read a log that says only "cancelled";
# calling it a pass is worse. It gets its own bucket, and it still withholds
# GREEN.
NO_VERDICT_CONCLUSIONS = frozenset({"cancelled", "stale"})

# A success whose OWN DESCRIPTION says it did not do the work.
#
# CodeRabbit posts `state: success` with `description: "Review rate limited"`.
# Seen four times on 2026-09-19 across maxi-config PRs. It did not review, and
# it reported green. Checked on #753: it posted no review at all -- the status
# was its only trace, and the rollup, `gh pr checks` and this script all
# counted it as a pass. A reader seeing that tick believes a review happened.
#
# This does NOT withhold GREEN, and the distinction matters. A reviewer's rate
# limit is not the author's doing, and failing the PR would wedge every merge
# until the bot recovers -- trading a silent problem for a stuck one. The
# defect here is that the claim is INVISIBLE, not that it is green. So it gets
# a bucket and a line, on the same principle as everything else in this file:
# say what you actually judged.
#
# Deliberately narrow. Only phrases that mean "I could not do the work" belong
# here; "skipped by configuration" and friends are real, deliberate passes and
# are not listed. Add a pattern when a bot is OBSERVED doing this, not when one
# might.
HOLLOW_SUCCESS = re.compile(r"rate.?limit|quota exceeded", re.I)

# A non-success whose OWN DESCRIPTION says it did not do the work.
#
# On maxi-sandbox#140 (2026-09-22) `qlty check` posted `state: error` with
# `description: "Qlty did not run because you are out of minutes."`. The qlty
# account was out of minutes, the analysis never started, and qlty reported the
# outage through the same channel it normally reports a finding -- so the merge
# gate treated a quota exhaustion as a code defect and wedged every PR in the
# org until the minutes topped up.
#
# Same exclusion as HOLLOW_SUCCESS, different shape: a bot that says "I could
# not do the work" via a non-success state is making the same invisible claim,
# and blocking on it produces the same wedge. So it is filed under `hollow`,
# NOT GREEN-blocking, and printed in the same NOTICE band as HOLLOW_SUCCESS.
#
# Deliberately narrow. The phrase must say the tool did not run -- "did not
# run", "out of minutes", "could not start" -- not merely that it failed. A
# qlty finding that ran and objected has a real summary attached and the regex
# will not match it, so the gate still fails that PR. Add a pattern when a bot
# is OBSERVED posting this, not when one might.
#
# `analysis.?timeout` covers the qlty Cloud race the troubleshooting docs name:
# "pull request analysis starts, but Qlty hasn't posted a conclusive status
# back to GitHub within 15 minutes. At that point Qlty will mark ... `error`"
# -- an error-state posting that still means "I did not run", and still
# belongs in `hollow` rather than `failures`.
HOLLOW_NOT_RUN = re.compile(
    r"did.?not.?run|out.?of.?minutes|quota.?exceeded|"
    r"could.?not.?start|analysis.?timeout",
    re.I,
)


def discover_gate_stamp():
    """Return the build stamp of the `maxi` binary on PATH, if any.

    The stamp is the same format the release pipeline embeds (see
    release/verify_provenance.py STAMP and the version_long that the build
    injects as MAXI_VERSION_LONG) and that `maxi --version` / `maxi provenance`
    print. By surfacing it here, a stale gate binary becomes a readable fact
    in the judge output (especially --json) instead of an invisible cause of
    mysterious refusals or overrides.

    This reuses the existing stamp mechanism rather than adding a second one.
    """
    maxi = shutil.which("maxi")
    if not maxi:
        return None
    try:
        proc = subprocess.run(  # nosec B603 -- subprocess invocation uses a literal argv, no shell
            ["/usr/bin/env", "maxi", "--version"],
            capture_output=True, text=True, timeout=4
        )
        if proc.returncode != 0:
            return None
        text = (proc.stdout or "") + (proc.stderr or "")
        m = re.search(
            r"(\d+\.\d+\.\d+ \(build \d+, ([0-9a-f]{7,40}), (\d{4}-\d{2}-\d{2})\))",
            text,
        )
        if m:
            return {
                "path": maxi,
                "version_long": m.group(1),
                "sha": m.group(2),
                "date": m.group(3),
            }
    except (OSError, subprocess.SubprocessError):
        pass
    return None


class GhTransport:
    """Fetch through `gh api`.

    `gh` rather than a direct HTTP client for two reasons. It is the only
    transport that works in every place this runs -- CI, a developer's shell,
    and an agent's sandbox, where the network reachable from Python is not
    always the one `gh` is configured for. And it keeps this file dependency
    free, which is what lets the same bytes be distributed to every repo in the
    fleet rather than only the one with shared Python helpers.
    """

    def __init__(self, binary=None):
        self.binary = binary or shutil.which("gh")
        if not self.binary:
            raise RuntimeError("gh is not on PATH")

    def get(self, path, params=None, paginate=True):
        # urlencode rather than hand-joining: a value with a special character
        # would otherwise change the meaning of the request rather than be sent.
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        # The argv list is spelled INLINE at the call, not built into a
        # variable first. A scanner looking for a literal command has nothing to
        # inspect when it is handed a name, which is a fair complaint rather
        # than a false positive: `/usr/bin/env` is what makes this safe, and
        # that fact should be visible at the call site.
        #
        # `/usr/bin/env` is an absolute literal -- neither a partial path nor
        # one computed at runtime -- and it resolves `gh` from PATH wherever it
        # lives, which differs across the fleet's Ubuntu, NixOS and macOS boxes.
        # `self.binary` is still resolved in __init__, but only to fail with a
        # useful message when gh is absent.
        proc = subprocess.run(  # nosec B603
            [
                "/usr/bin/env",
                "gh",
                "api",
                *(["--paginate"] if paginate else []),
                f"{path}{query}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"gh api failed for {path}: {proc.stderr.strip() or proc.returncode}"
            )
        # --paginate concatenates one JSON document per page.
        docs = []
        decoder = json.JSONDecoder()
        text = proc.stdout.strip()
        index = 0
        while index < len(text):
            doc, end = decoder.raw_decode(text, index)
            docs.append(doc)
            index = end
            while index < len(text) and text[index].isspace():
                index += 1
        return docs

    def items(self, path, key, params=None):
        """Every element across every page.

        `gh api --paginate` emits one document per page, and the shape differs
        by endpoint: list endpoints page as bare arrays, keyed endpoints as
        objects carrying the array. Consuming only objects silently dropped
        every page of the array-shaped ones -- and a judge that sees no checks
        answers GREEN, so the failure mode of missing this was the worst
        available one.
        """
        out = []
        for doc in self.get(path, params):
            if isinstance(doc, list):
                out.extend(doc)
            elif isinstance(doc, dict) and key is not None:
                out.extend(doc.get(key, []))
        return out

    def one(self, path, params=None):
        """A single object endpoint, fetched without pagination."""
        docs = self.get(path, params, paginate=False)
        if not docs:
            raise RuntimeError(f"gh api returned nothing for {path}")
        return docs[0]


def newest(items, key):
    """The newest item per group, by `created_at`/`started_at`, then whether it speaks, then id.

    The timestamp alone is not a total order -- runs created in the same second
    are common -- so ties need breaking, and ids are monotonic per repository.

    Within one instant the tie goes to the run that SPEAKS -- one still going,
    or one that reached a real conclusion -- over one that was cancelled and so
    never said anything. Observed on maxi-config#677: runs ...083 and ...112
    were created in the same second, ...112 was cancelled by concurrency and
    ...083 succeeded, and the id tie-break picked the cancelled one. The judge
    reported

        STALE  Review Gate (workflow): cancelled - no verdict, re-run it

    for a workflow that had already passed, and the advice would have cancelled
    nothing useful. A cancelled run is not evidence about the SHA; its sibling
    at the same instant is.

    Deliberately NOT the primary key. Ordering by this before the timestamp
    would let a run stuck in_progress outrank a newer run that actually
    finished, so one wedged job would hold the verdict at PENDING indefinitely
    -- trading a wrong answer for one that never arrives.
    """
    best = {}
    for item in items:
        group = key(item)
        speaks = (
            item.get("status") != "completed"
            or item.get("conclusion") not in NO_VERDICT_CONCLUSIONS
        )
        stamp = (
            item.get("created_at") or item.get("started_at") or "",
            speaks,
            item.get("id") or 0,
        )
        if group not in best or stamp > best[group][0]:
            best[group] = (stamp, item)
    return [entry for _, entry in best.values()]


def _classify(status, conclusion):
    """Which bucket a row belongs in, and why.

    Returns `(bucket, detail)` rather than appending into three lists passed as
    arguments: the buckets are the caller's business, and one return value
    reads better at both call sites than six parameters.
    """
    if status != "completed":
        return "pending", status
    if conclusion in NO_VERDICT_CONCLUSIONS:
        return "stale", f"{conclusion} - no verdict, re-run it"
    if conclusion not in OK_CONCLUSIONS:
        return "failing", str(conclusion)
    return None, ""


def live_rows(runs, checks):
    """The rows that still speak for this SHA, and nothing else.

    A workflow is identified by workflow_id where present. Falling back to the
    display name would merge two workflows that share a name, which is still
    better than treating every run as its own workflow -- that is what makes
    superseded runs look live.

    Check runs are discarded by check SUITE rather than by name, because app
    checks (Codacy, CodeFactor, review bots) have no workflow run behind them
    and so no superseded suite; dropping by name would take them with it.
    """
    keep_runs = newest(runs, lambda r: r.get("workflow_id") or r.get("name"))
    live_suites = {r.get("check_suite_id") for r in keep_runs}
    superseded = {
        s for s in ({r.get("check_suite_id") for r in runs} - live_suites) if s is not None
    }
    # Keyed by app, suite AND name: two apps can post a check with the same
    # name (Codacy vs review-gate, say), and every GitHub Actions check-run is
    # posted under the SAME app id, so two check-runs from two DIFFERENT
    # workflows sharing a job name would otherwise collapse to one. The
    # superseded filter above already drops rows whose suite a newer run
    # replaced; widening the key here is for the case neither suite is
    # superseded -- two live workflows, same name, different conclusions --
    # where timestamp-newest on the collapsed row could drop a live failure.
    keep_checks = newest(
        [c for c in checks if (c.get("check_suite") or {}).get("id") not in superseded],
        lambda c: ((c.get("app") or {}).get("id"),
                   (c.get("check_suite") or {}).get("id"),
                   c.get("name")),
    )
    return keep_runs, keep_checks


def judge(runs, checks, statuses):
    """Return (failures, pending, stale, hollow, considered) after discarding superseded rows.

    `hollow` is advisory: rows whose OWN DESCRIPTION says the tool did not do
    the work, even when the conclusion looks like a real one. A row that
    PASSED while saying it did not run (HOLLOW_SUCCESS) and a row that FAILED
    while saying it did not run (HOLLOW_NOT_RUN) both belong here. `hollow`
    never changes the verdict, only what gets printed -- the bot's quota is
    not the author's doing, and blocking on it wedges every merge until the
    bot recovers, trading a silent problem for a stuck one.
    """
    keep_runs, keep_checks = live_rows(runs, checks)

    # Pre-pass: rows the next loop would put in `failures`, but whose own
    # description says the tool did not run, belong in `hollow` instead. Doing
    # this before the bucketing loop means each row lands in exactly one
    # bucket, and a reader of `failures` sees only the rows whose conclusion
    # is actually evidence about the SHA.
    hollow = []
    skip_check_ids = set()
    for check in keep_checks:
        conclusion = check.get("conclusion")
        if conclusion == "success" or conclusion in OK_CONCLUSIONS \
                or conclusion in NO_VERDICT_CONCLUSIONS:
            continue  # HOLLOW_SUCCESS is handled below in its own loop.
        title = ((check.get("output") or {}).get("title")) or ""
        if HOLLOW_NOT_RUN.search(title):
            hollow.append(
                f'{check.get("name")} (check): {conclusion}, '
                f'but says "{title}"'
            )
            # `check.get("id")` is the GitHub check-run id, which is
            # stable across the same payload; `id(check)` would be the
            # Python object id and would break the moment the dict
            # gets re-instantiated (e.g. from a test fixture rebuild).
            # The check run id is also what `gh pr checks --json` keys
            # by, so any future cross-reference can use the same id.
            skip_check_ids.add(check.get("id"))

    failures, pending, stale = [], [], []
    buckets = {"failing": failures, "pending": pending, "stale": stale}
    rows = [(f"{r.get('name') or r.get('workflow_id')} (workflow)", r)
            for r in keep_runs]
    rows += [(f"{c.get('name')} (check)", c) for c in keep_checks
             if c.get("id") not in skip_check_ids]
    for label, row in rows:
        bucket, detail = _classify(row.get("status"), row.get("conclusion"))
        if bucket:
            buckets[bucket].append(f"{label}: {detail}")

    # `/statuses` returns every posting per context, newest first but not
    # deduplicated, so the current verdict is the newest per context.
    for status in newest(statuses, lambda s: s.get("context")):
        label = f"{status.get('context')} (status)"
        state = status.get("state")
        description = status.get("description") or ""
        if state == "pending":
            pending.append(f"{label}: pending")
        elif state != "success":
            # A non-success whose own description says the tool did not run is
            # not a code finding -- it is the bot telling us it never started,
            # via the same channel it normally uses for findings. Same
            # exclusion as HOLLOW_SUCCESS: classify as hollow (NOTICE, not
            # FAILING), so the bot's quota / outage does not wedge the merge.
            if HOLLOW_NOT_RUN.search(description):
                hollow.append(
                    f'{label}: {state}, but says "{description}"'
                )
            else:
                failures.append(f"{label}: {state}")
        elif HOLLOW_SUCCESS.search(description):
            hollow.append(f'{label}: success, but says "{description}"')

    # Check runs carry their own prose in `output.title`. Same rule, same
    # reason -- a bot that reports success while its title says it was rate
    # limited is making the same claim through a different channel. The
    # `error`/`failure` half of this lives in the pre-pass above so the row
    # lands in exactly one bucket.
    for check in keep_checks:
        if check.get("conclusion") != "success":
            continue
        title = ((check.get("output") or {}).get("title")) or ""
        if HOLLOW_SUCCESS.search(title):
            hollow.append(f'{check.get("name")} (check): success, but says "{title}"')

    considered = (
        len(keep_runs) + len(keep_checks) + len({s.get("context") for s in statuses})
    )
    return failures, pending, stale, hollow, considered

def verdict_of(failures, pending, stale):
    """GREEN only when nothing failed, nothing is running, nothing is stale.

    `hollow` is deliberately NOT a parameter. A reviewer that reported success
    while saying it was rate limited is still a pass as far as merging goes --
    the bot's quota is not the author's doing, and blocking on it would wedge
    every merge until it recovers, trading a silent problem for a stuck one.

    Extracted as a function so that exclusion is a testable property rather
    than an incidental one. It was incidental: a mutation adding `or hollow`
    to the old inline expression passed the whole suite, because the tests
    asserted on the judge() buckets and nothing asserted on the verdict.
    """
    return "GREEN" if not (failures or pending or stale) else "NOT_GREEN"


def collect(repo, sha, gh):
    return (
        gh.items(f"repos/{repo}/actions/runs", "workflow_runs",
                 {"head_sha": sha, "per_page": "100"}),
        gh.items(f"repos/{repo}/commits/{sha}/check-runs", "check_runs",
                 {"per_page": "100"}),
        # `/statuses`, not `/status`. The combined endpoint returns a summary
        # object whose embedded array is capped, and a commit with many contexts
        # would silently lose the tail -- which for this script means losing a
        # failure. The list endpoint is properly paginated, at the cost of
        # returning the full HISTORY per context rather than the latest, so
        # `newest` picks the current verdict per context below.
        gh.items(f"repos/{repo}/commits/{sha}/statuses", None,
                 {"per_page": "100"}),
    )

def head_sha(repo, pr, gh):
    sha = ((gh.one(f"repos/{repo}/pulls/{pr}") or {}).get("head") or {}).get("sha")
    if not sha:
        raise RuntimeError(f"PR #{pr} returned no head SHA")
    return sha

def report_unknown(args, message, sha):
    """UNKNOWN, on both output paths, with exit code 2."""
    if args.as_json:
        print(json.dumps({"verdict": "UNKNOWN", "error": message, "sha": sha}))
    else:
        print(f"UNKNOWN: {message}", file=sys.stderr)
    return 2


def render(report, as_json):
    if as_json:
        print(json.dumps(report, indent=2))
        return
    print(f"{report['verdict']}  {report['sha'][:9]}  "
          f"({report['considered']} live checks judged)")
    if report.get("gate_binary"):
        gb = report["gate_binary"]
        print(f"gate binary: {gb['version_long']}  ({gb['path']})")
    for line in report["failures"]:
        print(f"  FAILING  {line}")
    for line in report["pending"]:
        print(f"  PENDING  {line}")
    for line in report["stale"]:
        print(f"  STALE    {line}")
    for line in report["hollow"]:
        # NOTICE, not FAILING: the verdict above already accounts for this row
        # as a pass. The line exists so a green verdict cannot quietly include
        # a reviewer that said it did nothing.
        print(f"  NOTICE   {line}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    ap.add_argument("--pr", type=int)
    ap.add_argument("--sha")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args(argv)

    if not args.repo or "/" not in args.repo:
        ap.error("--repo owner/name is required (or set GITHUB_REPOSITORY)")
    if not args.pr and not args.sha:
        ap.error("one of --pr or --sha is required")

    try:
        gh = GhTransport()
        sha = args.sha or head_sha(args.repo, args.pr, gh)
        runs, checks, statuses = collect(args.repo, sha, gh)
    except (RuntimeError, OSError, ValueError) as exc:
        # Deliberately not a bare `except`: a NameError or AttributeError here
        # is a bug in this file, and reporting it as "the API could not be read"
        # would hide it behind a plausible-looking UNKNOWN. The transport raises
        # RuntimeError, the subprocess layer OSError, and a malformed page
        # ValueError (JSONDecodeError subclasses it).
        return report_unknown(args, f"could not read check state: {exc}", args.sha)

    failures, pending, stale, hollow, considered = judge(runs, checks, statuses)
    if considered == 0:
        # Nothing was read: an empty response, a shape this does not recognise,
        # or a SHA with no CI at all. None of those are evidence of health, and
        # answering GREEN on them is the same "absence reads as success" bug
        # this script exists to catch -- so it reports UNKNOWN, which is what
        # "I could not tell" is for.
        return report_unknown(
            args,
            f"no checks, runs or statuses found for {sha} -- "
            "nothing was read, which is not the same as nothing being wrong",
            sha,
        )
    verdict = verdict_of(failures, pending, stale)
    gate_bin = discover_gate_stamp()
    report = {
        "verdict": verdict,
        "sha": sha,
        "considered": considered,
        "failures": failures,
        "pending": pending,
        "stale": stale,
        # Advisory. Deliberately not part of the verdict -- see HOLLOW_SUCCESS.
        "hollow": hollow,
        # Build stamp of the maxi binary discoverable on PATH (if any).
        # This is how "the merge gate runs an 8-hour-old binary" becomes
        # visible to callers and to automation. The format is the one
        # produced by the apps-latest pipeline (MAXI_VERSION / MAXI_BUILD_SHA
        # injected at build, scanned at publish by verify_provenance.py).
        "gate_binary": gate_bin,
    }
    render(report, args.as_json)
    return 0 if verdict == "GREEN" else 1


if __name__ == "__main__":
    sys.exit(main())
