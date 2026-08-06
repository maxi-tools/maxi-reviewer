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


def permission_blocks(text: str) -> list:
    """Every `permissions:` block as (owner, [(scope, level), ...]), in order.

    Owner is `<workflow>` for the top-level block, otherwise the job key the
    block hangs under, so a test can assert that each job declares its own
    rather than that the word appears somewhere in the file.
    """
    lines = text.splitlines()
    blocks = []
    for index, line in enumerate(lines):
        if line.strip() != "permissions:":
            continue
        indent = indent_of(line)
        if indent == 0:
            owner = "<workflow>"
        else:
            parent = enclosing_line(lines, index, indent)
            owner = parent[1].strip().rstrip(":") if parent else "<unknown>"
        grants = []
        for candidate in lines[index + 1:]:
            if not candidate.strip():
                continue
            if indent_of(candidate) <= indent:
                break
            if candidate.lstrip().startswith("#"):
                continue
            scope, _, level = candidate.strip().partition(":")
            grants.append((scope, level.strip()))
        blocks.append((owner, grants))
    return blocks


def sonar_token_bindings(text: str) -> list:
    """Pair each `SONAR_TOKEN:` entry with the step that owns it, in file order.

    Both halves matter and only assert anything together: the owner alone would
    still pass if a correctly-named step had its value swapped for a non-secret,
    and the value alone would still pass if it were hoisted to job level.

    Yields a marker string in place of the owner for any entry that is not a
    step-scoped `env:` key, so a job-level (or otherwise misplaced) token fails
    loudly with the offending line rather than silently passing an absence check.
    """
    lines = text.splitlines()
    bindings = []
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped.startswith("SONAR_TOKEN:"):
            continue
        value = stripped.removeprefix("SONAR_TOKEN:").strip()
        env = enclosing_line(lines, index, indent_of(line))
        if env is None or env[1].strip() != "env:":
            bindings.append(("NOT UNDER env: -> " + stripped, value))
            continue
        step = enclosing_line(lines, env[0], indent_of(env[1]))
        if step is None or not step[1].lstrip().startswith("- "):
            bindings.append(("NOT STEP-SCOPED -> " + stripped, value))
            continue
        bindings.append(
            (step[1].lstrip()[2:].removeprefix("name:").strip(), value)
        )
    return bindings


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
        # would silently disable a prefix match while leaving it green. Pairing
        # each owning step with its value also asserts the positive case — the
        # token IS present, IS the secret, and IS scoped to exactly these two
        # steps — none of which "no job-level env" ever proved.
        self.assertEqual(
            [
                ("Check for a SonarCloud token", "${{ secrets.SONAR_TOKEN }}"),
                ("SonarCloud Scan", "${{ secrets.SONAR_TOKEN }}"),
            ],
            sonar_token_bindings(text),
        )

    def test_ci_token_is_read_only_and_declared_per_job(self) -> None:
        text = CI_WORKFLOW.read_text(encoding="utf-8")

        # This file declared no `permissions:` at all, so its token inherited
        # the repository default — read/write on this org — and every
        # dependency lifecycle script in both jobs ran beside a token that
        # could push. zizmor flagged all three sites as excessive.
        #
        # Asserted per owner rather than "the word appears somewhere": a single
        # workflow-level block would leave a later job free to widen itself,
        # and that is exactly the drift this exists to catch.
        blocks = permission_blocks(text)
        self.assertEqual(
            ["<workflow>", "ci", "ci-fork"], [owner for owner, _ in blocks]
        )

        granted = [
            (owner, scope, level)
            for owner, grants in blocks
            for scope, level in grants
        ]
        self.assertNotEqual([], granted)
        self.assertEqual([], [g for g in granted if g[2] != "read"])

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
