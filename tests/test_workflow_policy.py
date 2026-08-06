from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
ACTIONLINT_CONFIG = ROOT / ".github" / "actionlint.yaml"
PINNED_ACTION = re.compile(r"uses:\s*[^\s@]+/[^\s@]+@[0-9a-f]{40}(?:\s|$)")
USES_ACTION = re.compile(r"uses:\s*[^\s@]+/[^\s@]+@[^\s]+")


class WorkflowPolicyTests(unittest.TestCase):
    def test_trusted_ci_uses_self_hosted_and_forks_use_isolation(self) -> None:
        text = CI_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("ci:", text)
        self.assertIn("ci-fork:", text)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", text)
        self.assertIn("github.event.pull_request.head.repo.full_name != github.repository", text)
        self.assertIn("runs-on: [self-hosted, Linux, ARM64]", text)
        self.assertIn("runs-on: ubuntu-latest", text)

    def test_sonar_scan_is_trusted_and_secret_guarded(self) -> None:
        text = CI_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository", text)
        # The guard reads a step output, not `secrets`: the `secrets` context is
        # not available in an `if:`, and referencing it there makes GitHub
        # reject the whole file at parse time — zero jobs, no check run,
        # invisible. This assertion used to require that broken form, which is
        # part of why it survived: the only test that would have caught it lived
        # in a workflow that could never run.
        self.assertIn("steps.sonar.outputs.present == 'true'", text)
        self.assertNotIn("if: ${{ secrets.", text)
        self.assertIn("SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}", text)

        # And the credential stays scoped to the two steps that need it. A
        # job-level env block (4-space `env:` with a 6-space key) would expose it
        # to `npm install` lifecycle scripts and every build/test command in the
        # job; step-level env is indented deeper.
        job_level_env_lines = [
            line for line in text.splitlines()
            if line.startswith("      SONAR_TOKEN:")
        ]
        self.assertEqual([], job_level_env_lines)

    def test_third_party_actions_are_pinned_to_shas(self) -> None:
        text = CI_WORKFLOW.read_text(encoding="utf-8")
        unpinned = [line.strip() for line in text.splitlines() if USES_ACTION.search(line) and not PINNED_ACTION.search(line)]

        self.assertEqual([], unpinned)

    def test_actionlint_knows_custom_self_hosted_labels(self) -> None:
        text = ACTIONLINT_CONFIG.read_text(encoding="utf-8")

        self.assertIn("Linux", text)
        self.assertIn("ARM64", text)


if __name__ == "__main__":
    unittest.main()
