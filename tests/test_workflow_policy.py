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
        self.assertIn("secrets.SONAR_TOKEN != ''", text)
        self.assertIn("SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}", text)

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
