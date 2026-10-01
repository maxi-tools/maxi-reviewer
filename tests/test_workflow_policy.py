from pathlib import Path
import json
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
RELEASE_PLEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-please.yml"
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


def steps_of(text: str) -> list:
    """Every step in the file as a list of its own lines, in file order.

    Scope-walked rather than prefix-matched, for the reason the SONAR_TOKEN
    helper already documents: a re-indent or a YAML formatter pass must not be
    able to silently disable an assertion. A step is a `- ` item whose nearest
    enclosing key is `steps:`, which also keeps `- ` lines inside a `run: |`
    block out of the result -- their enclosing key is the `run:` scalar.

    Returning the step's lines rather than a parsed mapping is deliberate: an
    assertion can then require an exact key/value line, so a value swapped for
    a different one fails instead of passing a key-presence check.
    """
    lines = text.splitlines()
    steps = []
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped.startswith("- "):
            continue
        parent = enclosing_line(lines, index, indent_of(line))
        if parent is None or parent[1].strip() != "steps:":
            continue
        indent = indent_of(line)
        body = [stripped[2:].strip()]
        for candidate in lines[index + 1:]:
            if not candidate.strip():
                continue
            if indent_of(candidate) <= indent:
                break
            if candidate.lstrip().startswith("#"):
                continue
            body.append(candidate.strip())
        steps.append(body)
    return steps


def step_using(steps: list, action: str) -> list:
    """The one step invoking `action`, failing loudly on zero or many."""
    matches = [
        step
        for step in steps
        if any(line.startswith("uses: " + action + "@") for line in step)
    ]
    if len(matches) != 1:
        raise AssertionError(
            "expected exactly one step using " + action + ", found " + str(len(matches))
        )
    return matches[0]


def workflow_files(root: Path) -> list[Path]:
    """Every workflow file under `root/.github/workflows`, both extensions.

    GitHub runs `.yml` and `.yaml` alike. A scan that globs only one
    extension lets a workflow with the other slip past every install
    assertion in this file.
    """
    workflow_dir = root / ".github" / "workflows"
    return sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")])


def install_commands(step: list[str]) -> list[tuple[str, str]]:
    """Return each shell install invocation and its own arguments, not its step's.

    Options before the subcommand (`npm --package-lock=false install`) are
    part of the invocation: a validator that only sees `npm install` would
    miss a config flag that disables the lockfile. Both sides are joined
    into the returned args so the caller validates the whole command.
    """
    commands = []
    for line in step:
        for segment in re.split(r"\s*(?:&&|\|\||;)\s*", line):
            match = re.search(
                r"\b(npm|pnpm|yarn)((?:\s+--?\S+)*)\s+(install|i|ci)\b", segment
            )
            if match:
                pre = match.group(2).strip()
                post = segment[match.end():].strip()
                args = (pre + " " + post).strip()
                commands.append((match.group(1), args))
    return commands


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
        # Asserted as an exact (owner, scope, level) list rather than "every
        # level is read", because a levels-only check is also satisfied by an
        # empty grant. Dropping `pull-requests: read` from `ci` would silently
        # break SonarCloud's PR decoration — the analysis needs the base ref
        # and PR number to attach itself — while leaving a levels-only
        # assertion green. Widening a scope is a deliberate act and should
        # have to be written down twice.
        self.assertEqual(
            [
                ("<workflow>", "contents", "read"),
                ("ci", "contents", "read"),
                ("ci", "pull-requests", "read"),
                ("ci-fork", "contents", "read"),
            ],
            [
                (owner, scope, level)
                for owner, grants in permission_blocks(text)
                for scope, level in grants
            ],
        )


    def test_release_please_opens_its_pr_with_an_app_token(self) -> None:
        # GITHUB_TOKEN cannot open a pull request here: maxi-tools and this
        # repo both set `can_approve_pull_request_reviews: false`, and GitHub
        # applies that flag to PR creation by the Actions token. release-please
        # therefore ran to completion every time -- version computed, release
        # branch pushed -- and then failed on the create call, leaving main red
        # after every merge with no failing step that named a code defect.
        #
        # This is asserted here rather than left to review because the failure
        # is invisible until it reaches main: release-please has no
        # pull_request trigger, so dropping the token below would go green on
        # the PR that did it and only break once merged.
        text = RELEASE_PLEASE_WORKFLOW.read_text(encoding="utf-8")
        steps = steps_of(text)

        mint = step_using(steps, "actions/create-github-app-token")
        self.assertIn("id: app-token", mint)
        # Both halves of the grant, as exact lines. `permission-pull-requests`
        # is the one the create call needs and the one that was missing;
        # `permission-contents` covers the release branch, the bump commit and
        # the tag. A key-presence check would pass on `read`, which is the
        # exact value that produced the original failure.
        self.assertIn("permission-pull-requests: write", mint)
        self.assertIn("permission-contents: write", mint)

        release = step_using(steps, "googleapis/release-please-action")
        # Exact list, not `assertIn`: a second `token:` line -- a
        # GITHUB_TOKEN fallback appended below this one -- would take
        # precedence in YAML while leaving a containment check green.
        self.assertEqual(
            ["token: ${{ steps.app-token.outputs.token }}"],
            [line for line in release if line.startswith("token:")],
        )
        self.assertLess(steps.index(mint), steps.index(release))

    def test_third_party_actions_are_pinned_to_shas(self) -> None:
        # release-please.yml is in scope alongside ci.yml, and is arguably the
        # workflow that needs it more: its actions run against a token that can
        # write contents, tags and pull requests, where ci.yml's cannot. It had
        # been running `googleapis/release-please-action@v5` and
        # `actions/checkout@v6` — mutable tags the upstream maintainer can
        # repoint at any commit without notice.
        for path in (CI_WORKFLOW, RELEASE_PLEASE_WORKFLOW):
            text = path.read_text(encoding="utf-8")
            unpinned = [line.strip() for line in text.splitlines() if USES_ACTION.search(line) and not PINNED_ACTION.search(line)]

            self.assertEqual([], unpinned, path.name)

    def test_actionlint_knows_custom_self_hosted_labels(self) -> None:
        text = ACTIONLINT_CONFIG.read_text(encoding="utf-8")

        self.assertIn("Linux", text)
        self.assertIn("ARM64", text)

    def test_authoritative_package_manager_is_pnpm_and_only_pnpm(self) -> None:
        # #43: this repo committed pnpm-lock.yaml (v9) but no packageManager
        # field, and ci.yml still ran `npm install`. That is the
        # mixed-manager, non-reproducible path the issue names. Asserted
        # together rather than separately because each half alone is silent:
        # a future PR could add packageManager without removing the npm
        # lockfile, or remove the npm lockfile without pinning the manager,
        # and either pass a one-sided test.
        package_json = (ROOT / "package.json").read_text(encoding="utf-8")

        manifest = json.loads(package_json)
        # Exact field, not a substring: pinning the manager is the point, and
        # a `packageManager` mention buried in a README string would pass an
        # `assertIn` on the raw text.
        self.assertEqual(
            "pnpm@10.0.0",
            manifest.get("packageManager"),
            "package.json must pin packageManager to pnpm@10.0.0",
        )

        # Scan every workflow, not just the main CI lane. maxi-fix is synced
        # from maxi-config and installs an exact, untracked SDK transiently;
        # preserve that separate behavior, but reject any other local npm install.
        for workflow in workflow_files(ROOT):
            for step in steps_of(workflow.read_text(encoding="utf-8")):
                for manager, args in install_commands(step):
                    self.assert_valid_install(workflow.name, step[0], manager, args)

        for job in ("ci", "ci-fork"):
            # Scope each install to its job; an install in ci must not vouch
            # for a removed install in ci-fork (or vice versa).
            job_text = CI_WORKFLOW.read_text(encoding="utf-8").split(f"  {job}:", 1)[1]
            job_text = job_text.split("\n  ci-fork:", 1)[0] if job == "ci" else job_text
            installs = [
                step for step in steps_of("jobs:\n  " + job + ":\n" + job_text)
                if step[0] == "name: Install dependencies"
            ]
            self.assertEqual(1, len(installs), f"{job} needs an install step")
            self.assertIn(
                ("pnpm", "--frozen-lockfile"), install_commands(installs[0]),
                f"{job} needs a frozen pnpm install",
            )

        self_test = (ROOT / ".github" / "workflows" / "self-test.yml").read_text()
        self.assertIn("pnpm install --frozen-lockfile", self_test)
        for forbidden in ("package-lock.json", "yarn.lock"):
            self.assertFalse((ROOT / forbidden).exists(), f"{forbidden} must not be committed")

    def assert_valid_install(self, workflow: str, step: str, manager: str, args: str) -> None:
        if manager == "npm":
            global_install = bool(re.match(r"(?:-g|--global)(?=\s|$)", args))
            sdk_install = (
                workflow == "maxi-fix.yml"
                and step == "name: Install Jules SDK"
                and args == "--no-save @google/jules-sdk@0.2.0"
            )
            self.assertTrue(
                global_install or sdk_install,
                f"{workflow}: {step!r} uses a project npm install: {args}",
            )
        elif manager == "pnpm":
            self.assertRegex(
                args,
                r"(?:^|\s)--frozen-lockfile(?:\s|$)",
                f"{workflow}: {step!r} has an unfrozen pnpm install",
            )
        else:
            self.fail(f"{workflow}: {step!r} uses yarn install")

    def test_install_command_parser_rejects_bypasses(self) -> None:
        # Each bypass is invisible to the old parser (returns []) and must
        # now be visible AND rejected by the validator.
        bypasses = [
            ("pnpm install && pnpm install --frozen-lockfile", [("pnpm", ""), ("pnpm", "--frozen-lockfile")]),
            ("npm install --global-style", [("npm", "--global-style")]),
            ("npm install --global=false", [("npm", "--global=false")]),
            ("pnpm ci", [("pnpm", "")]),
            ("npm --package-lock=false install", [("npm", "--package-lock=false")]),
        ]
        for command, expected in bypasses:
            with self.subTest(command=command):
                self.assertEqual(expected, install_commands([command]))
                # The first parsed command is the bypass; the validator rejects it.
                manager, args = expected[0]
                with self.assertRaises(AssertionError):
                    self.assert_valid_install("ci.yml", "name: Install dependencies", manager, args)

        # Valid forms: options before the subcommand are preserved, and the
        # validator accepts them when they carry the required flag.
        valid = [
            ("pnpm --frozen-lockfile install", [("pnpm", "--frozen-lockfile")]),
            ("npm -g install pnpm@10.0.0", [("npm", "-g pnpm@10.0.0")]),
            ("npm install -g pnpm@10.0.0", [("npm", "-g pnpm@10.0.0")]),
        ]
        for command, expected in valid:
            with self.subTest(command=command):
                self.assertEqual(expected, install_commands([command]))
                manager, args = expected[0]
                self.assert_valid_install("ci.yml", "name: Install dependencies", manager, args)

    def test_workflow_scan_discovers_yaml_extension(self) -> None:
        # GitHub runs both `.yml` and `.yaml`. A scan that globs only one
        # lets a workflow with the other contain `npm install` and pass.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            workflow_dir.mkdir(parents=True)
            (workflow_dir / "bypass.yaml").write_text(
                "jobs:\n  ci:\n    steps:\n      - name: Install dependencies\n        run: npm --package-lock=false install\n",
                encoding="utf-8",
            )
            found = workflow_files(root)
            self.assertEqual([workflow_dir / "bypass.yaml"], found)
            # And the install inside it is visible to the validator.
            for workflow in found:
                for step in steps_of(workflow.read_text(encoding="utf-8")):
                    for manager, args in install_commands(step):
                        with self.assertRaises(AssertionError):
                            self.assert_valid_install(workflow.name, step[0], manager, args)


if __name__ == "__main__":
    unittest.main()
