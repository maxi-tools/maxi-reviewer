"""Tests for ci_pr_green.py.

The fixtures are shaped after the real case that motivated the script:
maxi-core #3958, whose rollup read FAILURE with ten non-green rows and zero
real failures -- every one a CANCELLED check run left behind by a superseded
workflow run.
"""

# maxi-config-owned PR greenness judge tests.

import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).with_name("ci_pr_green.py")

# Named rather than repeated: these appear in most fixtures below, and a typo in
# one copy would quietly change which group a row lands in.
GATE = "Review Gate"
CI = "CI"
T0 = "2026-09-11T17:00:00Z"
T1 = "2026-09-11T18:00:00Z"


def load():
    spec = importlib.util.spec_from_file_location("ci_pr_green", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    if spec.loader is None:
        # Not an assert: a bare one is stripped under -O, which would let this
        # suite "pass" having loaded nothing. Same reasoning as ci_metrics_test.
        raise RuntimeError(f"no loader for {SCRIPT}")
    spec.loader.exec_module(module)
    return module


mod = load()


def run(name, *, workflow_id, suite, created, conclusion, status="completed", rid=None):
    return {
        "name": name, "workflow_id": workflow_id, "check_suite_id": suite,
        "created_at": created, "conclusion": conclusion, "status": status,
        "id": rid if rid is not None else suite,
    }


def check(name, *, suite, started, conclusion, status="completed", cid=None):
    return {
        "name": name, "check_suite": {"id": suite}, "started_at": started,
        "conclusion": conclusion, "status": status,
        "id": cid if cid is not None else suite,
    }


class JudgeTest(unittest.TestCase):
    def test_superseded_cancelled_run_does_not_make_a_green_pr_red(self):
        runs = [
            run(GATE, workflow_id=1, suite=100, created="2026-09-11T17:15:10Z",
                conclusion="cancelled"),
            run(GATE, workflow_id=1, suite=101, created="2026-09-11T17:18:59Z",
                conclusion="success"),
        ]
        checks = [
            check("review-gate / matrix.check", suite=100,
                  started="2026-09-11T17:15:12Z", conclusion="cancelled"),
            check("review-gate / per-run: resolve-review-threads", suite=101,
                  started="2026-09-11T17:19:01Z", conclusion="success"),
        ]
        failures, pending, _stale, _ = mod.judge(runs, checks, [])
        self.assertEqual(failures, [])
        self.assertEqual(pending, [])

    def test_ten_superseded_rows_and_one_live_success_is_green(self):
        # The #3958 shape: many cancelled runs of one workflow, newest green.
        runs = [
            run(GATE, workflow_id=1, suite=200 + i,
                created=f"2026-09-11T17:{10 + i:02d}:00Z", conclusion="cancelled")
            for i in range(10)
        ]
        runs.append(run(GATE, workflow_id=1, suite=299,
                        created="2026-09-11T17:30:00Z", conclusion="success"))
        checks = [
            check("review-gate / matrix.check", suite=200 + i,
                  started=f"2026-09-11T17:{10 + i:02d}:05Z", conclusion="cancelled")
            for i in range(10)
        ]
        failures, pending, _stale, _ = mod.judge(runs, checks, [])
        self.assertEqual(failures, [])
        self.assertEqual(pending, [])

    def test_a_real_failure_on_the_newest_run_is_reported(self):
        runs = [
            run(CI, workflow_id=2, suite=300, created=T0,
                conclusion="success"),
            run(CI, workflow_id=2, suite=301, created="2026-09-11T17:20:00Z",
                conclusion="failure"),
        ]
        failures, pending, _stale, _ = mod.judge(runs, [], [])
        self.assertEqual(pending, [])
        self.assertEqual(len(failures), 1)
        self.assertIn("CI (workflow): failure", failures[0])

    def test_an_older_success_does_not_mask_a_newer_failure(self):
        # The inverse of the motivating bug, and the reason newest-wins must be
        # by timestamp rather than by "any success for this name".
        runs = [
            run(CI, workflow_id=2, suite=400, created=T1,
                conclusion="failure"),
            run(CI, workflow_id=2, suite=401, created=T0,
                conclusion="success"),
        ]
        failures, _p, _stale, _ = mod.judge(runs, [], [])
        self.assertEqual(len(failures), 1)

    def test_in_flight_run_is_pending_not_failing(self):
        runs = [run(CI, workflow_id=2, suite=500, created=T0,
                    conclusion=None, status="in_progress")]
        failures, pending, _stale, _ = mod.judge(runs, [], [])
        self.assertEqual(failures, [])
        self.assertEqual(len(pending), 1)
        self.assertIn("in_progress", pending[0])

    def test_app_check_runs_survive_having_no_workflow_run(self):
        # Codacy/CodeFactor/cubic post check runs with no workflow behind them.
        # Their suites are in no run, so they must not be mistaken for
        # superseded rows and dropped.
        runs = [run(CI, workflow_id=2, suite=600, created=T0,
                    conclusion="success")]
        checks = [check("CodeFactor", suite=999, started="2026-09-11T17:05:00Z",
                        conclusion="failure")]
        failures, _p, _stale, _ = mod.judge(runs, checks, [])
        self.assertEqual(len(failures), 1)
        self.assertIn("CodeFactor", failures[0])

    def test_skipped_and_neutral_are_passes(self):
        runs = [
            run("Coverage", workflow_id=3, suite=700, created=T0,
                conclusion="skipped"),
            run("Docs", workflow_id=4, suite=701, created=T0,
                conclusion="neutral"),
        ]
        failures, pending, _stale, _ = mod.judge(runs, [], [])
        self.assertEqual((failures, pending), ([], []))

    def test_commit_status_failure_is_reported(self):
        statuses = [{"context": "review-gate/threads", "state": "failure"}]
        failures, _p, _stale, _ = mod.judge([], [], statuses)
        self.assertEqual(len(failures), 1)
        self.assertIn("review-gate/threads", failures[0])

    def test_same_second_runs_break_the_tie_by_id(self):
        runs = [
            run(CI, workflow_id=2, suite=800, created=T0,
                conclusion="failure", rid=1),
            run(CI, workflow_id=2, suite=801, created=T0,
                conclusion="success", rid=2),
        ]
        failures, _p, _stale, _ = mod.judge(runs, [], [])
        self.assertEqual(failures, [], "the higher id is the later run")

    def test_two_workflows_are_judged_independently(self):
        runs = [
            run(CI, workflow_id=2, suite=900, created=T0,
                conclusion="success"),
            run("CodeQL", workflow_id=5, suite=901, created=T0,
                conclusion="failure"),
        ]
        failures, _p, _stale, considered = mod.judge(runs, [], [])
        self.assertEqual(len(failures), 1)
        self.assertEqual(considered, 2)


class StaleTest(unittest.TestCase):
    def test_cancelled_newest_run_is_stale_not_failing(self):
        # Cancelled means the workflow reached no verdict. Reported as failing,
        # it sends someone to read a log that says only "cancelled"; reported as
        # passing, it is worse. It is its own bucket, and it still blocks GREEN.
        runs = [run(GATE, workflow_id=1, suite=100,
                    created=T1, conclusion="cancelled")]
        failures, pending, stale, _ = mod.judge(runs, [], [])
        self.assertEqual(failures, [])
        self.assertEqual(pending, [])
        self.assertEqual(len(stale), 1)
        self.assertIn("no verdict", stale[0])

    def test_stale_still_withholds_green(self):
        runs = [run(CI, workflow_id=2, suite=110,
                    created=T1, conclusion="cancelled")]
        failures, pending, stale, _ = mod.judge(runs, [], [])
        verdict = "GREEN" if not (failures or pending or stale) else "NOT_GREEN"
        self.assertEqual(verdict, "NOT_GREEN")

    def test_superseded_cancelled_is_dropped_before_staleness_applies(self):
        # The common case must not become a STALE row: a cancelled run that a
        # newer run replaced is discarded entirely, not reported as no-verdict.
        runs = [
            run(CI, workflow_id=2, suite=120, created=T0,
                conclusion="cancelled"),
            run(CI, workflow_id=2, suite=121, created=T1,
                conclusion="success"),
        ]
        failures, pending, stale, _ = mod.judge(runs, [], [])
        self.assertEqual((failures, pending, stale), ([], [], []))


class EmptyReadTest(unittest.TestCase):
    def test_nothing_read_is_unknown_not_green(self):
        # An empty or unrecognised response must not answer GREEN. Zero rows is
        # "I could not tell", which is what exit 2 is for.
        original_collect, original_head = mod.collect, mod.head_sha
        mod.collect = lambda *_a, **_k: ([], [], [])
        mod.head_sha = lambda *_a, **_k: "f" * 40
        try:
            code = mod.main(["--repo", "o/n", "--pr", "1", "--json"])
        finally:
            mod.collect, mod.head_sha = original_collect, original_head
        self.assertEqual(code, 2)

    def test_a_programming_error_is_not_reported_as_an_api_failure(self):
        # A NameError here is a bug in this file. Reporting it as UNKNOWN would
        # hide it behind a plausible-looking "could not read check state".
        original = mod.head_sha

        def boom(*_a, **_k):
            raise AttributeError("typo in this file")

        mod.head_sha = boom
        try:
            with self.assertRaises(AttributeError):
                mod.main(["--repo", "o/n", "--pr", "1", "--json"])
        finally:
            mod.head_sha = original


class AppScopedCheckTest(unittest.TestCase):
    def test_two_apps_may_post_the_same_check_name(self):
        # Collapsing by name alone let one app's pass hide another's failure.
        runs = [run(CI, workflow_id=1, suite=1, created=T0, conclusion="success")]
        checks = [
            {"name": "review", "app": {"id": 10}, "check_suite": {"id": 900},
             "started_at": T0, "status": "completed", "conclusion": "success", "id": 1},
            {"name": "review", "app": {"id": 20}, "check_suite": {"id": 901},
             "started_at": T0, "status": "completed", "conclusion": "failure", "id": 2},
        ]
        failures, _p, _s, _c = mod.judge(runs, checks, [])
        self.assertEqual(len(failures), 1, "the other app's failure must survive")


class GhTransportTest(unittest.TestCase):
    """`gh api --paginate` concatenates one JSON document per page.

    That is not valid JSON as a whole, so the stream is decoded document by
    document. A single-page response has to keep working through the same path.
    """

    def decode(self, text):
        gh = mod.GhTransport.__new__(mod.GhTransport)
        gh.binary = "/nonexistent"
        captured = {}

        class Proc:
            returncode = 0
            stdout = text
            stderr = ""

        original = mod.subprocess.run
        mod.subprocess.run = lambda *a, **k: (captured.setdefault("argv", a[0]), Proc())[1]
        try:
            return gh.get("repos/o/n/x")
        finally:
            mod.subprocess.run = original

    def test_single_document(self):
        self.assertEqual(self.decode('{"a": 1}'), [{"a": 1}])

    def test_concatenated_pages(self):
        docs = self.decode('{"check_runs": [1]}\n{"check_runs": [2]}')
        self.assertEqual(len(docs), 2)

    def test_items_flattens_array_shaped_pages(self):
        # Regression: list endpoints page as bare arrays. Consuming only dicts
        # dropped every page, and no checks judges as GREEN -- the worst
        # direction for this failure to go.
        gh = mod.GhTransport.__new__(mod.GhTransport)
        gh.get = lambda path, params=None: [[{"id": 1}], [{"id": 2}]]
        self.assertEqual(gh.items("p", "ignored"), [{"id": 1}, {"id": 2}])

    def test_items_handles_mixed_page_shapes(self):
        gh = mod.GhTransport.__new__(mod.GhTransport)
        gh.get = lambda path, params=None: [{"k": [1]}, [2], {"k": [3]}]
        self.assertEqual(gh.items("p", "k"), [1, 2, 3])

    def test_statuses_are_aggregated_across_pages(self):
        # Regression: reading only page one of /status hid a failing context on
        # a later page, which again judged GREEN.
        gh = mod.GhTransport.__new__(mod.GhTransport)
        gh.get = lambda path, params=None: [
            {"statuses": [{"context": "a", "state": "success"}]},
            {"statuses": [{"context": "b", "state": "failure"}]},
        ]
        statuses = gh.items("repos/o/n/commits/x/status", "statuses")
        self.assertEqual(len(statuses), 2)
        failures, _p, _s, _c = mod.judge([], [], statuses)
        self.assertEqual(len(failures), 1, "the second page's failure must be seen")

    def test_one_does_not_paginate(self):
        gh = mod.GhTransport.__new__(mod.GhTransport)
        seen = {}

        def fake_get(path, params=None, paginate=True):
            seen["paginate"] = paginate
            return [{"head": {"sha": "abc"}}]

        gh.get = fake_get
        gh.one("repos/o/n/pulls/1")
        self.assertFalse(seen["paginate"])

    def test_items_flattens_pages(self):
        gh = mod.GhTransport.__new__(mod.GhTransport)
        gh.get = lambda path, params=None: [{"k": [1, 2]}, {"k": [3]}]
        self.assertEqual(gh.items("p", "k"), [1, 2, 3])

    def test_nonzero_exit_raises_rather_than_returning_empty(self):
        # The failure mode this whole script guards: a failed query must not
        # read as "nothing found", which would judge as GREEN.
        gh = mod.GhTransport.__new__(mod.GhTransport)
        gh.binary = "/nonexistent"

        class Proc:
            returncode = 1
            stdout = ""
            stderr = "HTTP 403"

        original = mod.subprocess.run
        mod.subprocess.run = lambda *a, **k: Proc()
        try:
            with self.assertRaises(RuntimeError):
                gh.get("repos/o/n/x")
        finally:
            mod.subprocess.run = original


class UnknownTest(unittest.TestCase):
    def test_read_failure_is_unknown(self):
        # The defect this guards: a judge that reports a failed query as a
        # clean bill of health. UNKNOWN must be its own outcome.
        original = mod.head_sha

        def boom(*_a, **_k):
            raise RuntimeError("rate limited")

        mod.head_sha = boom
        try:
            code = mod.main(["--repo", "o/n", "--pr", "1", "--json"])
        finally:
            mod.head_sha = original
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
