from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
ACTIONLINT_CONFIG = ROOT / ".github" / "actionlint.yaml"
PINNED_ACTION = re.compile(r"uses:\s*[^\s@]+/[^\s@]+@[0-9a-f]{40}(?:\s|$)")
USES_ACTION = re.compile(r"uses:\s*[^\s@]+/[^\s@]+@[^\s]+")


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def enclosing_line(lines: list, index: int, indent: int):
    """The nearest preceding line that opens the scope containing `index`."""
    for candidate in range(index - 1, -1, -1):
        line = lines[candidate]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if indent_of(line) < indent:
            return candidate, line
    return None


def sonar_token_owners(text: str) -> list:
    """Name the step owning each `SONAR_TOKEN:` entry, in file order.

    Returns a marker string instead of a step name for any entry that is not
    a step-scoped `env:` key, so a job-level (or otherwise misplaced) token
    fails the assertion loudly with the offending line rather than silently
    passing an absence check.
    """
    lines = text.splitlines()
    owners = []
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("SONAR_TOKEN:"):
            continue
        env = enclosing_line(lines, index, indent_of(line))
        if env is None or env[1].strip() != "env:":
            owners.append("NOT UNDER env: -> " + line.strip())
            continue
        step = enclosing_line(lines, env[0], indent_of(env[1]))
        if step is None or not step[1].lstrip().startswith("- "):
            owners.append("NOT STEP-SCOPED -> " + line.strip())
            continue
        owners.append(step[1].lstrip()[2:].removeprefix("name:").strip())
    return owners


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
        # job-level env block would expose it to `npm install` lifecycle scripts
        # and every build/test command in the job.
        #
        # Asserted by walking enclosing scopes rather than by matching a literal
        # six-space prefix: re-indenting this file, or a YAML formatter pass,
        # would silently disable a prefix match while leaving it green. Naming
        # the owning steps also asserts the positive case — the token IS present
        # and IS scoped to these two — which "no job-level env" never proved.
        self.assertEqual(
            ["Check for a SonarCloud token", "SonarCloud Scan"],
            sonar_token_owners(text),
        )

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
