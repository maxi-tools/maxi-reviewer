"""Tests for ci_pr_green.py.

The fixtures are shaped after the real case that motivated the script:
maxi-core #3958, whose rollup read FAILURE with ten non-green rows and zero
real failures -- every one a CANCELLED check run left behind by a superseded
workflow run.
"""

# maxi-config-owned PR greenness judge tests.

import contextlib
import importlib.util
import io
import json
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).with_name("ci_pr_green.py")

# Named rather than repeated: these appear in most fixtures below, and a typo in
# one copy would quietly change which group a row lands in.
GATE = "Review Gate"
CI = "CI"
# The fake resolved paths the gate-stamp test asserts on. Named because the
# whole point of that test is that the binary EXECUTED and the path REPORTED
# are the same string; spelling it three times invites them to drift apart,
# which is the very defect being guarded.
FAKE_MAXI = "/opt/fake/maxi"
FAKE_GH = "/opt/fake/gh"
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
        failures, pending, _stale, _hollow, _ = mod.judge(runs, checks, [])
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
        failures, pending, _stale, _hollow, _ = mod.judge(runs, checks, [])
        self.assertEqual(failures, [])
        self.assertEqual(pending, [])

    def test_a_real_failure_on_the_newest_run_is_reported(self):
        runs = [
            run(CI, workflow_id=2, suite=300, created=T0,
                conclusion="success"),
            run(CI, workflow_id=2, suite=301, created="2026-09-11T17:20:00Z",
                conclusion="failure"),
        ]
        failures, pending, _stale, _hollow, _ = mod.judge(runs, [], [])
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
        failures, _p, _stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual(len(failures), 1)

    def test_in_flight_run_is_pending_not_failing(self):
        runs = [run(CI, workflow_id=2, suite=500, created=T0,
                    conclusion=None, status="in_progress")]
        failures, pending, _stale, _hollow, _ = mod.judge(runs, [], [])
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
        failures, _p, _stale, _hollow, _ = mod.judge(runs, checks, [])
        self.assertEqual(len(failures), 1)
        self.assertIn("CodeFactor", failures[0])

    def test_skipped_and_neutral_are_passes(self):
        runs = [
            run("Coverage", workflow_id=3, suite=700, created=T0,
                conclusion="skipped"),
            run("Docs", workflow_id=4, suite=701, created=T0,
                conclusion="neutral"),
        ]
        failures, pending, _stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual((failures, pending), ([], []))

    def test_a_rate_limited_success_is_noticed_but_still_green(self):
        """CodeRabbit posts success with "Review rate limited" and no review.

        Observed five times on 2026-09-19 across maxi-config PRs, including on
        two this session merged without seeing it. Checked on #753: the status
        was its ONLY trace -- no review was posted -- so the rollup, `gh pr
        checks` and this script all counted a reviewer that did nothing as a
        pass, and a reader seeing the tick believes otherwise.

        GREEN is still correct. The bot's rate limit is not the author's doing
        and failing the PR would wedge every merge until it recovers. The
        defect is that the claim is invisible, so it gets a line and not a
        verdict.
        """
        statuses = [{"context": "CodeRabbit", "state": "success",
                     "description": "Review rate limited"}]
        failures, pending, stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual((failures, pending, stale), ([], [], []),
                         "a rate-limited success must not withhold GREEN")
        self.assertEqual(len(hollow), 1)
        self.assertIn("CodeRabbit", hollow[0])
        self.assertIn("Review rate limited", hollow[0])

    def test_a_hollow_notice_alone_is_still_GREEN(self):
        """The verdict, not the buckets. This is the property M3 exposed.

        An earlier version of this suite asserted only that `judge` put
        nothing in failures/pending/stale. That is true however the verdict is
        computed, so a mutation adding `or hollow` to the verdict expression
        passed the entire suite -- the exclusion was incidental, not pinned.
        """
        statuses = [{"context": "CodeRabbit", "state": "success",
                     "description": "Review rate limited"}]
        failures, pending, stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(hollow), 1, "precondition: this row IS hollow")
        self.assertEqual(
            mod.verdict_of(failures, pending, stale), "GREEN",
            "a rate-limited reviewer must not block the merge; the bot's "
            "quota is not the author's doing")

    def test_a_real_failure_beside_a_hollow_notice_is_NOT_GREEN(self):
        # The notice must not become a way to launder a failure either.
        statuses = [
            {"context": "CodeRabbit", "state": "success",
             "description": "Review rate limited"},
            {"context": "review-gate/threads", "state": "failure"},
        ]
        failures, pending, stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(hollow), 1)
        self.assertEqual(mod.verdict_of(failures, pending, stale), "NOT_GREEN")

    def test_an_ordinary_success_is_not_noticed(self):
        # The notice must be rare enough to mean something. A passing status
        # with an ordinary description is not a hollow one.
        statuses = [{"context": "CodeRabbit", "state": "success",
                     "description": "Review completed"}]
        _f, _p, _s, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(hollow, [])

    def test_a_check_run_saying_it_was_rate_limited_is_noticed_too(self):
        # Same claim, different channel: check runs carry their prose in
        # output.title rather than in a status description.
        row = check("some-bot", suite=1, started=T0, conclusion="success")
        row["output"] = {"title": "Skipped: API quota exceeded"}
        _f, _p, _s, hollow, _ = mod.judge([], [row], [])
        self.assertEqual(len(hollow), 1)
        self.assertIn("some-bot", hollow[0])

    def test_a_qlty_out_of_minutes_error_is_noticed_but_still_green(self):
        """The qlty wedge: state=error + 'did not run' is a quota outage, not a finding.

        On maxi-sandbox#140 (2026-09-22) the org's qlty minutes ran out, so
        qlty posted `state: error` with `description: "Qlty did not run
        because you are out of minutes."` on every PR in the org. The merge
        gate treated the quota outage as a code defect and every PR was
        unmergeable until the minutes topped up. The fix: this is a
        did-not-run claim on a non-success state, which gets the same
        NOTICE-bucket, GREEN-passing treatment as the rate-limited success
        above.

        Deliberately narrow: a real qlty finding has a real summary attached
        and the regex must not match it, otherwise the gate ignores qlty
        errors wholesale. Pinned by the next two tests.
        """
        statuses = [{"context": "qlty check", "state": "error",
                     "description": "Qlty did not run because you are out of minutes."}]
        failures, pending, stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual((failures, pending, stale), ([], [], []),
                         "an out-of-minutes error must not withhold GREEN")
        self.assertEqual(len(hollow), 1)
        self.assertIn("qlty check", hollow[0])
        self.assertIn("did not run", hollow[0])
        self.assertEqual(
            mod.verdict_of(failures, pending, stale), "GREEN",
            "a quota exhaustion is not the author's doing; failing the PR "
            "would wedge every merge until the minutes top up")

    def test_a_qlty_check_run_out_of_minutes_is_noticed_but_still_green(self):
        """Same shape, different channel: a qlty CHECK-RUN with conclusion=error.

        qlty Cloud posts both -- a commit STATUS and a check RUN -- and the
        same description ("did not run because ... minutes") can land on
        either. The check-run path carries prose in `output.title` rather
        than in `state.description`, so it is the symmetric case: same
        exclusion, same NOTICE bucket.
        """
        row = check("qlty check", suite=1, started=T0, conclusion="error")
        row["output"] = {"title": "Qlty did not run because you are out of minutes.",
                         "summary": ""}
        failures, pending, stale, hollow, _ = mod.judge([], [row], [])
        self.assertEqual((failures, pending, stale), ([], [], []),
                         "the did-not-run conclusion=error must not withhold GREEN")
        self.assertEqual(len(hollow), 1)
        self.assertIn("qlty check", hollow[0])
        self.assertIn("did not run", hollow[0])
        self.assertEqual(mod.verdict_of(failures, pending, stale), "GREEN")

    def test_a_qlty_finding_with_no_did_not_run_phrasing_still_fails(self):
        """The narrow pattern must not launder real findings.

        Acceptance criterion 3 of t_409d42df: a qlty that ran and objected is
        not the same as one that never started, and collapsing those is how
        this class of bug gets made in the first place. A real qlty finding
        has a real summary (issues, smells, complexity), not "did not run".
        The regex must not match it.
        """
        statuses = [{"context": "qlty check", "state": "error",
                     "description": "Found 3 issues: complex function on line 42; "
                                    "duplicated block in src/foo.rs."}]
        failures, _p, _stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(failures), 1,
                         "a real qlty finding must still be a failure")
        self.assertEqual(hollow, [], "the description has no did-not-run phrase")
        self.assertEqual(mod.verdict_of(failures, _p, _stale), "NOT_GREEN")

    def test_a_codacy_internal_error_with_no_did_not_run_phrasing_still_fails(self):
        """A non-success description that is NOT a did-not-run claim still fails.

        HOLLOW_NOT_RUN is deliberately narrow. A bot that posts state=error
        for any other reason -- network, auth, internal -- stays a failure.
        The pattern matches what the bot SAYS, not just the fact that the
        state is non-success.
        """
        statuses = [{"context": "Codacy Static Code Analysis", "state": "error",
                     "description": "Internal server error"}]
        failures, _p, _stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(failures), 1)
        self.assertEqual(hollow, [])
        self.assertEqual(mod.verdict_of(failures, _p, _stale), "NOT_GREEN")

    def test_a_hollow_not_run_alone_is_GREEN(self):
        """The verdict, not the buckets. Verifies hollow-not-run does not
        withhold GREEN, by way of `verdict_of` -- the same property M3
        exposed for the success-side hollow.
        """
        statuses = [{"context": "qlty check", "state": "error",
                     "description": "Qlty did not run because you are out of minutes."}]
        failures, pending, stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(hollow), 1, "precondition: this row IS hollow")
        self.assertEqual(
            mod.verdict_of(failures, pending, stale), "GREEN",
            "a quota outage must not block the merge; the bot's quota is "
            "not the author's doing")

    def test_a_real_failure_beside_a_hollow_not_run_is_NOT_GREEN(self):
        """The hollow must not become a way to launder a failure either.

        Same shape as the success-side hollow test: a real red beside the
        hollow keeps the verdict NOT_GREEN. Otherwise a hollow exclusion
        would let any PR with a quota outage slip a real failure past the
        gate.
        """
        statuses = [
            {"context": "qlty check", "state": "error",
             "description": "Qlty did not run because you are out of minutes."},
            {"context": "review-gate/threads", "state": "failure"},
        ]
        failures, pending, stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(hollow), 1)
        self.assertEqual(len(failures), 1)
        self.assertEqual(mod.verdict_of(failures, pending, stale), "NOT_GREEN")

    def test_a_qlty_analysis_timeout_is_hollow_not_run(self):
        """The qlty Cloud race the troubleshooting docs name.

        "Pull request analysis starts, but Qlty hasn't posted a conclusive
        status back to GitHub within 15 minutes. At that point, Qlty will
        mark ... as `error`." That is still a did-not-run claim delivered via
        state=error -- an analysis that began and never completed -- and
        belongs in `hollow` for the same reason an explicit
        out-of-minutes error does.
        """
        statuses = [{"context": "qlty check", "state": "error",
                     "description": "Analysis timeout: 15-minute window expired."}]
        failures, _p, _stale, hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(failures, [])
        self.assertEqual(len(hollow), 1)
        self.assertIn("Analysis timeout", hollow[0])

    def test_a_hollow_not_run_does_not_also_appear_in_failures(self):
        """The pre-pass guarantees a row lands in exactly one bucket.

        The did-not-run check-run above would otherwise be added to BOTH
        `failures` (by the bucketing loop) and `hollow` (by the pre-pass),
        which still withholds GREEN. The pre-pass's `skip_check_ids` is what
        makes the bucketing loop skip it. If this test starts failing the
        pre-pass's skip set has drifted.
        """
        row = check("qlty check", suite=1, started=T0, conclusion="error")
        row["output"] = {"title": "Qlty did not run because you are out of minutes.",
                         "summary": ""}
        failures, _p, _stale, hollow, _ = mod.judge([], [row], [])
        self.assertEqual(failures, [],
                         "the pre-pass must skip the row in the bucketing loop")
        self.assertEqual(len(hollow), 1)
        self.assertEqual(mod.verdict_of(failures, _p, _stale), "GREEN")

    def test_commit_status_failure_is_reported(self):
        statuses = [{"context": "review-gate/threads", "state": "failure"}]
        failures, _p, _stale, _hollow, _ = mod.judge([], [], statuses)
        self.assertEqual(len(failures), 1)
        self.assertIn("review-gate/threads", failures[0])

    def test_same_second_runs_break_the_tie_by_id(self):
        runs = [
            run(CI, workflow_id=2, suite=800, created=T0,
                conclusion="failure", rid=1),
            run(CI, workflow_id=2, suite=801, created=T0,
                conclusion="success", rid=2),
        ]
        failures, _p, _stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual(failures, [], "the higher id is the later run")

    def test_two_workflows_are_judged_independently(self):
        runs = [
            run(CI, workflow_id=2, suite=900, created=T0,
                conclusion="success"),
            run("CodeQL", workflow_id=5, suite=901, created=T0,
                conclusion="failure"),
        ]
        failures, _p, _stale, _hollow, considered = mod.judge(runs, [], [])
        self.assertEqual(len(failures), 1)
        self.assertEqual(considered, 2)


class StaleTest(unittest.TestCase):
    def test_cancelled_newest_run_is_stale_not_failing(self):
        # Cancelled means the workflow reached no verdict. Reported as failing,
        # it sends someone to read a log that says only "cancelled"; reported as
        # passing, it is worse. It is its own bucket, and it still blocks GREEN.
        runs = [run(GATE, workflow_id=1, suite=100,
                    created=T1, conclusion="cancelled")]
        failures, pending, stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual(failures, [])
        self.assertEqual(pending, [])
        self.assertEqual(len(stale), 1)
        self.assertIn("no verdict", stale[0])

    def test_stale_still_withholds_green(self):
        runs = [run(CI, workflow_id=2, suite=110,
                    created=T1, conclusion="cancelled")]
        failures, pending, stale, _hollow, _ = mod.judge(runs, [], [])
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
        failures, pending, stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual((failures, pending, stale), ([], [], []))


class LiveRunWinsTest(unittest.TestCase):
    def test_a_succeeded_run_beats_a_cancelled_sibling_at_the_same_second(self):
        # The shape actually seen on maxi-config#677 once both runs finished:
        # ...112 cancelled by concurrency, ...083 succeeded, same second. The id
        # tie-break picked the cancelled one and reported a passing workflow as
        # STALE.
        runs = [
            run(GATE, workflow_id=1, suite=1, created=T0,
                conclusion="cancelled", rid=112),
            run(GATE, workflow_id=1, suite=2, created=T0,
                conclusion="success", rid=83),
        ]
        failures, pending, stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual((failures, pending, stale), ([], [], []))

    def test_an_in_flight_run_beats_a_cancelled_sibling_at_the_same_second(self):
        # Observed on maxi-config#677: two runs of one workflow created in the
        # same second, one cancelled and one still going. Ordering by id alone
        # picked the cancelled one, so the judge said STALE -- "no verdict,
        # re-run it" -- while a run was in flight and about to produce one.
        runs = [
            run(GATE, workflow_id=1, suite=1, created=T0,
                conclusion="cancelled", rid=112),
            run(GATE, workflow_id=1, suite=2, created=T0,
                conclusion=None, status="in_progress", rid=83),
        ]
        failures, pending, stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual(failures, [])
        self.assertEqual(stale, [], "a live run means the workflow is not stale")
        self.assertEqual(len(pending), 1)
        self.assertIn("in_progress", pending[0])

    def test_a_genuinely_cancelled_workflow_is_still_stale(self):
        # The fix must not make every cancelled run disappear: with no live
        # sibling, cancelled is still no verdict.
        runs = [run(GATE, workflow_id=1, suite=1, created=T0,
                    conclusion="cancelled", rid=112)]
        _f, _p, stale, _hollow, _ = mod.judge(runs, [], [])
        self.assertEqual(len(stale), 1)

    def test_a_newer_finished_run_beats_an_older_stuck_one(self):
        # Liveness breaks ties only within the same instant. Ordering by it
        # first would let one wedged job hold the verdict at PENDING forever,
        # which trades a wrong answer for one that never arrives.
        runs = [
            run(CI, workflow_id=2, suite=1, created=T0,
                conclusion=None, status="in_progress", rid=1),
            run(CI, workflow_id=2, suite=2, created=T1,
                conclusion="failure", rid=2),
        ]
        failures, pending, _s, _hollow, _c = mod.judge(runs, [], [])
        self.assertEqual(pending, [], "the newer finished run is the answer")
        self.assertEqual(len(failures), 1)


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
        failures, _p, _s, _hollow, _c = mod.judge(runs, checks, [])
        self.assertEqual(len(failures), 1, "the other app's failure must survive")
    def test_same_app_same_name_in_two_live_suites_keeps_both(self):
        # The defect: every GitHub Actions check-run is posted under the SAME
        # app id. Two check-runs from two DIFFERENT workflows, same job name,
        # both live -- neither suite is superseded -- used to collapse on
        # (app_id, name) and keep whichever was newer, discarding the other's
        # conclusion. With the suite in the key, both survive. SUCCESS is
        # newer; if the timestamp-newest rule on the collapsed key wins, the
        # failure is silently dropped and the judge answers GREEN.
        checks = [
            # newer, success
            {"name": "lint", "app": {"id": 15368},
             "check_suite": {"id": 7001}, "started_at": "2026-09-21T11:00:00Z",
             "status": "completed", "conclusion": "success", "id": 2001},
            # older, failure -- must survive
            {"name": "lint", "app": {"id": 15368},
             "check_suite": {"id": 7002}, "started_at": "2026-09-21T10:00:00Z",
             "status": "completed", "conclusion": "failure", "id": 2002},
        ]
        failures, _p, _s, _hollow, considered = mod.judge([], checks, [])
        self.assertEqual(
            failures, ["lint (check): failure"],
            "failing row in a different live suite must not be collapsed away",
        )
        self.assertEqual(considered, 2,
                         "both live rows are part of what was judged")

    def test_supersession_still_drops_rows_after_widening_the_key(self):
        # Widening the group key must NOT resurrect rows the superseded filter
        # already dropped. A cancelled run replaced by a newer run of the same
        # workflow -- the suite IS superseded -- must stay out of the verdict.
        runs = [
            run(CI, workflow_id=2, suite=800, created=T0,
                conclusion="cancelled"),
            run(CI, workflow_id=2, suite=801, created=T1,
                conclusion="success"),
        ]
        # A check run from the superseded suite would, without the filter,
        # now find its own key and survive. The filter has to remove it first.
        checks = [
            check("lint", suite=800, started=T0, conclusion="failure"),
            check("lint", suite=801, started=T1, conclusion="success"),
        ]
        failures, pending, stale, _hollow, _ = mod.judge(runs, checks, [])
        self.assertEqual((failures, pending, stale), ([], [], []),
                         "supersession still drops the older suite's rows")


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
        failures, _p, _s, _hollow, _c = mod.judge([], [], statuses)
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




class GateBinaryTest(unittest.TestCase):
    def test_discover_gate_stamp_returns_none_when_no_maxi(self):
        # When maxi is not on PATH (the common case on CI hosts that only
        # have gh + python), discover_gate_stamp must return None, not crash.
        orig_which = mod.shutil.which
        mod.shutil.which = lambda name: None
        try:
            self.assertIsNone(mod.discover_gate_stamp())
        finally:
            mod.shutil.which = orig_which

    def test_gate_binary_appears_in_json_report(self):
        # The point of the change: a caller (or a later Rust port) can see
        # exactly which binary produced the verdict. So this asserts on the
        # JSON REPORT, which is the thing the name promises.
        #
        # It did not, until now. The old body called mod.main(...) and
        # asserted NOTHING about it, then asserted on discover_gate_stamp()
        # directly. That main() call could never have reached the stamp:
        # fake_which returned None for "gh", so GhTransport.__init__ raised
        # "gh is not on PATH", main caught it and returned 2, and the only
        # thing printed was {"verdict": "UNKNOWN", ...} -- no gate_binary key
        # in it at all. Measured: main() returned 2 and the sole PATH lookup
        # made was "gh". A test named for the JSON report never once looked
        # at the JSON report, which is exactly the "absence reads as success"
        # shape this whole script exists to catch, turned on the script.
        orig_which = mod.shutil.which
        orig_run = mod.subprocess.run
        orig_transport = mod.GhTransport

        class FakeTransport:
            """Enough of the API for main() to reach a real verdict.

            One successful status and no runs/checks: `considered` must be
            non-zero or main short-circuits to UNKNOWN via report_unknown,
            which does not carry gate_binary either.
            """

            def __init__(self, binary=None):
                # Intentionally empty: the real __init__ resolves `gh` on
                # PATH and raises when it is absent, which is the exact
                # behaviour this double exists to avoid.
                pass

            # `key`, `params` and `path` are unused in places below, and stay
            # in the signatures on purpose: a double that does not mirror the
            # real call shape stops catching the caller passing the wrong
            # thing, which is most of what a double is for here.
            def items(self, path, key, params=None):
                if path.endswith("/statuses"):
                    return [{"context": CI, "state": "success",
                             "description": ""}]
                return []

            def one(self, path, params=None):
                return {}

        class FakeProc:
            returncode = 0
            stdout = "2.0.0 (build 42, deadbeef1234567, 2026-09-21)\n"
            stderr = ""

        argvs = []

        def fake_run(*a, **k):
            argvs.append(a[0] if a else k.get("args"))
            return FakeProc()

        mod.shutil.which = lambda name: (
            FAKE_MAXI if name == "maxi" else FAKE_GH
        )
        mod.subprocess.run = fake_run
        mod.GhTransport = FakeTransport
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = mod.main(["--repo", "o/n", "--sha", "abc", "--json"])
        finally:
            mod.shutil.which = orig_which
            mod.subprocess.run = orig_run
            mod.GhTransport = orig_transport

        # Assert the exit code. The old test discarded it, which is what let
        # a silent return of 2 sit here unnoticed.
        self.assertEqual(code, 0)
        report = json.loads(buf.getvalue())
        self.assertEqual(report["verdict"], "GREEN")
        stamp = report["gate_binary"]
        self.assertEqual(stamp["path"], FAKE_MAXI)
        self.assertEqual(stamp["sha"], "deadbeef1234567")
        self.assertEqual(stamp["date"], "2026-09-21")
        self.assertEqual(
            stamp["version_long"],
            "2.0.0 (build 42, deadbeef1234567, 2026-09-21)",
        )
        # The version must be read from the SAME binary whose path is
        # reported. Going back through PATH -- ["/usr/bin/env", "maxi", ...]
        # -- would let stamp["path"] and stamp["version_long"] describe two
        # different files, so the argv is asserted rather than assumed.
        # Without this the whole test still passes with the env form, because
        # a stubbed subprocess.run accepts any argv at all.
        self.assertEqual(argvs, [[FAKE_MAXI, "--version"]])



if __name__ == "__main__":
    unittest.main()
