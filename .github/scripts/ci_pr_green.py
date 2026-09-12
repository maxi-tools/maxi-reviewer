#!/usr/bin/env python3
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
"""

# maxi-config-owned PR greenness judge.

import argparse
import json
import os
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
    """The newest item per group, by `created_at`/`started_at` then id.

    The timestamp alone is not a total order -- runs started in the same second
    are common -- so id breaks ties. Ids are monotonic per repository.
    """
    best = {}
    for item in items:
        group = key(item)
        stamp = (
            item.get("created_at") or item.get("started_at") or "",
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
    # Keyed by app as well as name: two apps can post a check with the same
    # name, and collapsing them by name alone would let one app's pass hide the
    # other's failure.
    keep_checks = newest(
        [c for c in checks if (c.get("check_suite") or {}).get("id") not in superseded],
        lambda c: ((c.get("app") or {}).get("id"), c.get("name")),
    )
    return keep_runs, keep_checks


def judge(runs, checks, statuses):
    """Return (failures, pending, stale, considered) after discarding superseded rows."""
    keep_runs, keep_checks = live_rows(runs, checks)
    failures, pending, stale = [], [], []

    buckets = {"failing": failures, "pending": pending, "stale": stale}
    rows = [(f"{r.get('name') or r.get('workflow_id')} (workflow)", r) for r in keep_runs]
    rows += [(f"{c.get('name')} (check)", c) for c in keep_checks]
    for label, row in rows:
        bucket, detail = _classify(row.get("status"), row.get("conclusion"))
        if bucket:
            buckets[bucket].append(f"{label}: {detail}")

    # `/statuses` returns every posting per context, newest first but not
    # deduplicated, so the current verdict is the newest per context.
    for status in newest(statuses, lambda s: s.get("context")):
        label = f"{status.get('context')} (status)"
        state = status.get("state")
        if state == "pending":
            pending.append(f"{label}: pending")
        elif state != "success":
            failures.append(f"{label}: {state}")

    considered = (
        len(keep_runs) + len(keep_checks) + len({s.get("context") for s in statuses})
    )
    return failures, pending, stale, considered

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
    for line in report["failures"]:
        print(f"  FAILING  {line}")
    for line in report["pending"]:
        print(f"  PENDING  {line}")
    for line in report["stale"]:
        print(f"  STALE    {line}")


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

    failures, pending, stale, considered = judge(runs, checks, statuses)
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
    verdict = "GREEN" if not (failures or pending or stale) else "NOT_GREEN"
    report = {
        "verdict": verdict,
        "sha": sha,
        "considered": considered,
        "failures": failures,
        "pending": pending,
        "stale": stale,
    }
    render(report, args.as_json)
    return 0 if verdict == "GREEN" else 1


if __name__ == "__main__":
    sys.exit(main())
