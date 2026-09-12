/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { reviewTimeoutExplanation } from "../src/review-pr.js";

// Mock dependencies
vi.mock("@actions/core");
vi.mock("@actions/github");

// We need to import the action file in a way that doesn't trigger the run() immediately,
// but since it runs immediately, we can mock everything first, then dynamically import it.
// We'll reset modules before each test.

describe("index.ts", () => {
  let mockGetInput: any;
  let mockSetFailed: any;
  let mockGetBooleanInput: any;
  let mockInfo: any;
  let mockWarning: any;
  let mockOctokit: any;

  // mock sub-modules
  const mockGithubHelper = {
    fetchDiff: vi.fn(),
    loadRulesFromBase: vi.fn(),
    fetchOpenThreads: vi.fn(),
    fetchExistingFindings: vi.fn(),
    resolveThreads: vi.fn(),
    submitReview: vi.fn(),
    setStatus: vi.fn(),
    recordReviewArtifactComment: vi.fn(),
    listReviewArtifactComments: vi.fn(),
  };

  const mockJulesHelper = {
    runJulesReview: vi.fn(),
    wrapPermissionError: vi.fn(),
  };
  const mockReviewCommand = {
    runReviewCommand: vi.fn(),
  };
  const mockArtifact = {
    default: {
      uploadArtifact: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetInput = vi.spyOn(core, "getInput");
    mockGetBooleanInput = vi.spyOn(core, "getBooleanInput");
    mockSetFailed = vi.spyOn(core, "setFailed");
    mockInfo = vi.spyOn(core, "info");
    mockWarning = vi.spyOn(core, "warning");

    // Default inputs
    mockGetInput.mockImplementation((name: string) => {
      if (name === "jules_api_key") return "dummy_key";
      if (name === "github_token") return "dummy_token";
      if (name === "fail_on") return "any";
      if (name === "timeout_minutes") return "30";
      return "";
    });
    mockGetBooleanInput.mockReturnValue(false);

    mockOctokit = {
      rest: { pulls: {}, repos: {} },
    };
    (github as any).getOctokit = vi.fn().mockReturnValue(mockOctokit);

    // Default context
    (github as any).context = {
      eventName: "pull_request",
      repo: { owner: "owner", repo: "repo" },
      payload: {
        action: "opened",
        pull_request: {
          number: 1,
          head: { sha: "headSHA", repo: { full_name: "owner/repo" } },
          base: { sha: "baseSHA", ref: "main" },
          title: "PR Title",
          body: "PR Body",
          labels: [],
        },
      },
    };

    // mock helpers
    vi.doMock("../src/github.js", () => mockGithubHelper);
    vi.doMock("../src/jules.js", () => mockJulesHelper);
    vi.doMock("../src/review-command.js", () => mockReviewCommand);
    vi.doMock("@actions/artifact", () => mockArtifact);

    // default helper returns
    mockGithubHelper.fetchDiff.mockResolvedValue("diff");
    mockGithubHelper.fetchOpenThreads.mockResolvedValue([]);
    mockGithubHelper.fetchExistingFindings.mockResolvedValue([]);
    mockGithubHelper.listReviewArtifactComments.mockResolvedValue([]);
    mockGithubHelper.setStatus.mockResolvedValue(undefined);
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: {
        verdict: "approve",
        summary: "Good job",
        newComments: [],
      },
      sessionId: "session-id",
    });
    mockJulesHelper.wrapPermissionError.mockImplementation((e: any) => e);
    mockReviewCommand.runReviewCommand.mockResolvedValue(undefined);
    mockArtifact.default.uploadArtifact.mockResolvedValue({});
  });

  // vi.waitFor defaults to a 1000ms budget, which is not enough headroom for
  // any wait in this file. The action is loaded for real and has to settle
  // through its own async plumbing while 28 test files run in parallel under
  // v8 coverage instrumentation; a failure observed here took 2297ms to give
  // up, i.e. it was still waiting on a machine that was merely busy.
  //
  // Every `vi.waitFor` in this file passes these options. A bare one carries
  // the 1000ms default and is the same latent flake wearing a different test
  // name -- which is what the varying victim in #104 looked like.
  //
  // It flaked roughly one full run in six, and since `pnpm coverage` is the
  // last step of the pre-commit hook, that is a one-in-six chance of a commit
  // being rejected for a reason that has nothing to do with the commit --
  // which is its own argument for `--no-verify` (#104).
  //
  // Raising the deadline weakens nothing: every assertion after the wait is
  // unchanged, and a genuinely stuck action still fails, five seconds later.
  const SETTLE_OPTIONS = { timeout: 5000, interval: 25 };

  // The action settles through any of five paths, and which one it took is the
  // first thing you need to know when a test that follows the wait fails. The
  // wait used to throw a bare "Action has not settled yet.", so a timeout said
  // nothing about which signals were being waited on or what the action had
  // managed to do -- during the #104 flake hunt that gap cost a full CI cycle,
  // since a failure could not be told from an early exit down the wrong path.
  //
  // Named conditions, so the timeout can report the state of every one of them
  // and loadIndex can return which fired. Tests asserting on work that is NOT
  // a settle condition -- `truncates large diffs` on runJulesReview, `uses
  // ctx.payload.before` on fetchDiff -- are the ones that need this, because
  // for them the wait returning is not evidence their call happened.
  // src/github.ts:341 -- setStatus(octokit, owner, repo, sha, context, state,
  // description). Naming the offsets once means the three places that read a
  // mock call do not each restate them, and a signature change has one site to
  // fix rather than three to find.
  const STATUS_STATE_ARG = 5;
  const INFO_MESSAGE_ARG = 0;

  const SETTLE_CONDITIONS = {
    "review-command": () =>
      mockReviewCommand.runReviewCommand.mock.calls.length > 0,
    "set-failed": () => mockSetFailed.mock.calls.length > 0,
    "submit-review": () => mockGithubHelper.submitReview.mock.calls.length > 0,
    "final-status": () =>
      mockGithubHelper.setStatus.mock.calls.some(
        (call) => call[STATUS_STATE_ARG] !== "pending"
      ),
    "skip-or-bypass": () =>
      mockInfo.mock.calls.some(
        (call) =>
          String(call[INFO_MESSAGE_ARG]).startsWith("Skipping") ||
          String(call[INFO_MESSAGE_ARG]).startsWith("Bypass label")
      ),
  } as const;

  type SettleReason = keyof typeof SETTLE_CONDITIONS;
  const SETTLE_REASONS = Object.keys(SETTLE_CONDITIONS) as SettleReason[];

  // What the action has actually done, for the timeout message. Statuses are
  // the informative part: an action stuck on "pending" looks identical to one
  // that never called setStatus until you can see the list.
  const settleState = () =>
    [
      `setStatus=[${mockGithubHelper.setStatus.mock.calls
        .map((call) => String(call[STATUS_STATE_ARG]))
        .join(", ")}]`,
      `setFailed=${mockSetFailed.mock.calls.length}`,
      `submitReview=${mockGithubHelper.submitReview.mock.calls.length}`,
      `runReviewCommand=${mockReviewCommand.runReviewCommand.mock.calls.length}`,
      `info=[${mockInfo.mock.calls
        .map((call) => String(call[INFO_MESSAGE_ARG]).slice(0, 40))
        .join(" | ")}]`,
    ].join(" ");

  const loadIndex = async (): Promise<SettleReason[]> => {
    await import("../src/index.js");
    return await vi.waitFor(() => {
      const satisfied = SETTLE_REASONS.filter((reason) =>
        SETTLE_CONDITIONS[reason]()
      );
      if (satisfied.length > 0) {
        return satisfied;
      }
      throw new Error(
        "Action has not settled. No settle condition fired " +
          `(${SETTLE_REASONS.join(", ")}). State: ${settleState()}`
      );
    }, SETTLE_OPTIONS);
  };

  it("fails if eventName is pull_request_target", async () => {
    (github as any).context.eventName = "pull_request_target";
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("pull_request_target is not supported")
    );
  });

  it("reports which condition settled the action", async () => {
    // Covers the settle-reason plumbing itself. Without this, the named
    // conditions are only exercised through the paths other tests happen to
    // take, and a rename that silently stopped one from ever matching would
    // just look like a slower suite.
    (github as any).context.eventName = "pull_request_target";
    const reasons = await loadIndex();
    expect(reasons).toContain("set-failed");
  });

  it("fails if eventName is not pull_request", async () => {
    (github as any).context.eventName = "push";
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported event")
    );
  });

  it("routes issue comment events to the review command handler", async () => {
    (github as any).context.eventName = "issue_comment";
    (github as any).context.payload = {
      issue: { number: 1, pull_request: {} },
      comment: { body: "/maxi apply-all" },
    };
    await loadIndex();
    expect(mockReviewCommand.runReviewCommand).toHaveBeenCalled();
  });

  it("routes workflow dispatch events to the review command handler", async () => {
    (github as any).context.eventName = "workflow_dispatch";
    (github as any).context.payload = { inputs: {} };
    await loadIndex();
    expect(mockReviewCommand.runReviewCommand).toHaveBeenCalled();
  });

  it("fails if no pull_request payload", async () => {
    (github as any).context.payload.pull_request = undefined;
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith(
      "No pull_request payload found."
    );
  });

  it("fails if fail_on is invalid", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "fail_on") return "invalid";
      return "";
    });
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid fail_on")
    );
  });

  it("skips draft PR if skip_drafts is true", async () => {
    (github as any).context.payload.pull_request.draft = true;
    mockGetBooleanInput.mockImplementation(
      (name: string) => name === "skip_drafts"
    );
    await loadIndex();
    expect(mockInfo).toHaveBeenCalledWith("Skipping draft PR.");
  });

  it("skips fork PR if skip_forks is true", async () => {
    (github as any).context.payload.pull_request.head.repo.full_name =
      "fork/repo";
    mockGetBooleanInput.mockImplementation(
      (name: string) => name === "skip_forks"
    );
    await loadIndex();
    expect(mockInfo).toHaveBeenCalledWith(
      "Skipping fork PR (skip_forks=true)."
    );
  });

  it("skips if bypass label is present", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "jules_api_key") return "k";
      if (name === "github_token") return "t";
      if (name === "fail_on") return "any";
      if (name === "bypass_label") return "skip-review";
      return "";
    });
    (github as any).context.payload.pull_request.labels = [
      { name: "skip-review" },
    ];
    await loadIndex();
    expect(mockInfo).toHaveBeenCalledWith(
      'Bypass label "skip-review" present — skipping review.'
    );
  });

  it("uses ctx.payload.before for diff on synchronize event", async () => {
    (github as any).context.payload.action = "synchronize";
    (github as any).context.payload.before = "beforeSHA";
    await loadIndex();
    // Same reason as the truncation test: `fetchDiff` is not one of loadIndex's
    // settle conditions, so assert on it through a bounded wait.
    await vi.waitFor(
      () =>
        expect(mockGithubHelper.fetchDiff).toHaveBeenCalledWith(
          expect.anything(),
          "owner",
          "repo",
          expect.anything(),
          "beforeSHA",
          "headSHA"
        ),
      SETTLE_OPTIONS
    );
  });

  it("loads rules if rules_file is provided", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "rules_file") return "rules.md";
      if (name === "jules_api_key") return "k";
      if (name === "github_token") return "t";
      if (name === "fail_on") return "any";
      return "";
    });
    mockGithubHelper.loadRulesFromBase.mockResolvedValue("project rules");
    await loadIndex();
    expect(mockGithubHelper.loadRulesFromBase).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "repo",
      "rules.md",
      "baseSHA"
    );
  });

  it("truncates large diffs", async () => {
    const hugeDiff = "x".repeat(81_000);
    mockGithubHelper.fetchDiff.mockResolvedValue(hugeDiff);
    await loadIndex();
    // loadIndex settles on the status/failure signals, which can be reached by
    // an early-exit path that never calls the reviewer. Waiting on the call
    // being asserted turns "the reviewer never ran" into that message, instead
    // of a TypeError from indexing an empty `calls`.
    await vi.waitFor(
      () => expect(mockJulesHelper.runJulesReview).toHaveBeenCalled(),
      SETTLE_OPTIONS
    );
    const prompt = mockJulesHelper.runJulesReview.mock.calls[0][1];
    expect(prompt).toContain(
      "NOTE: The diff was truncated: original 81000 chars, kept first 80000."
    );
  });

  it("handles Jules failure to return review", async () => {
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: null,
      sessionId: "s1",
    });
    await loadIndex();
    await vi.waitFor(
      () =>
        expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
          expect.anything(),
          "owner",
          "repo",
          "headSHA",
          expect.anything(),
          "failure",
          "No review after 30 min: Jules never replied. Reviewer timeout, not a code finding — re-runs often pass."
        ),
      SETTLE_OPTIONS
    );
    expect(mockGithubHelper.submitReview).not.toHaveBeenCalled();
    expect(mockArtifact.default.uploadArtifact).toHaveBeenCalled();
    // Tracks the function, not a copy of its prose: this test is about the
    // timeout reaching the log and the job failure at all. `review timeout
    // wording` in review-pr.test.ts is what pins what it says.
    expect(mockWarning).toHaveBeenCalledWith(
      `${reviewTimeoutExplanation(30)} Recorded a harvestable review artifact.`
    );
    expect(mockSetFailed).toHaveBeenCalledWith(reviewTimeoutExplanation(30));
  });

  it("resolves open threads if resolvedCommentIds provided", async () => {
    mockGithubHelper.fetchOpenThreads.mockResolvedValue([
      {
        index: 1,
        threadId: "t1",
        path: "a.ts",
        line: 1,
        body: "root 1",
        comments: [],
      },
      {
        index: 2,
        threadId: "t2",
        path: "b.ts",
        line: 2,
        body: "root 2",
        comments: [],
      },
    ]);
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: {
        verdict: "approve",
        summary: "ok",
        resolvedCommentIds: [2],
      },
      sessionId: "s1",
    });
    await loadIndex();
    await vi.waitFor(
      () =>
        expect(mockGithubHelper.resolveThreads).toHaveBeenCalledWith(
          expect.anything(),
          ["t2"]
        ),
      SETTLE_OPTIONS
    );
  });

  it("submits review and sets status based on verdict", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "fail_on") return "blocking";
      return "";
    });
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: { verdict: "block", summary: "bad", newComments: [] },
      sessionId: "s1",
    });
    await loadIndex();
    await vi.waitFor(
      () => expect(mockGithubHelper.submitReview).toHaveBeenCalled(),
      SETTLE_OPTIONS
    );
    await vi.waitFor(
      () =>
        expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
          expect.anything(),
          "owner",
          "repo",
          "headSHA",
          expect.anything(),
          "failure",
          "Blocking issues found"
        ),
      SETTLE_OPTIONS
    );
  });

  it("handles fail_on = never", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "fail_on") return "never";
      if (name === "jules_api_key") return "k";
      if (name === "github_token") return "t";
      return "";
    });
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: { verdict: "block", summary: "bad", newComments: [] },
      sessionId: "s1",
    });
    await loadIndex();
    await vi.waitFor(
      () =>
        expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
          expect.anything(),
          "owner",
          "repo",
          "headSHA",
          expect.anything(),
          "success",
          "Review complete (verdict: block)"
        ),
      SETTLE_OPTIONS
    );
  });

  it("handles fail_on = any with approve verdict", async () => {
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: { verdict: "approve", summary: "ok", newComments: [] },
      sessionId: "s1",
    });
    await loadIndex();
    await vi.waitFor(
      () =>
        expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
          expect.anything(),
          "owner",
          "repo",
          "headSHA",
          expect.anything(),
          "success",
          "Approved"
        ),
      SETTLE_OPTIONS
    );
  });

  it("fails immediately when initial setStatus throws permission error", async () => {
    mockGithubHelper.setStatus.mockRejectedValueOnce(
      new Error("Initial setStatus failed")
    );
    mockJulesHelper.wrapPermissionError.mockReturnValueOnce(
      new Error("Wrapped initial setStatus failed")
    );
    await loadIndex();
    // It should have caught the error, wrapped it, and then caught it in the top level catch.
    expect(mockSetFailed).toHaveBeenCalledWith(
      "Jules PR review failed: Wrapped initial setStatus failed"
    );
  });

  it("top-level catch works when run throws synchronously", async () => {
    // If core.getInput throws, run() will reject before async things
    mockGetInput.mockImplementation(() => {
      throw new Error("Sync error");
    });
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith("Sync error");
  });

  it("top-level catch handles non-Error objects", async () => {
    mockGetInput.mockImplementation(() => {
      throw "String error";
    });
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith("String error");
  });

  it("handles exception in the process", async () => {
    mockGithubHelper.fetchDiff.mockRejectedValue(
      new Error("Fetch diff failed")
    );
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith(
      "Jules PR review failed: Fetch diff failed"
    );
    expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "repo",
      "headSHA",
      expect.anything(),
      "error",
      "Fetch diff failed"
    );
  });
});

describe("truncate", () => {
  let truncate: any;

  beforeEach(async () => {
    const mod = await import("../src/review-pr.js");
    truncate = mod.truncate;
  });

  it("returns original string if length is exactly max", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("returns original string if length is less than max", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });

  it("truncates string and appends ellipsis if length exceeds max", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });

  it("handles max of 1", () => {
    expect(truncate("a", 1)).toBe("a");
    expect(truncate("ab", 1)).toBe("…");
  });
});

describe("truncate", () => {
  let truncate: any;

  beforeEach(async () => {
    const mod = await import("../src/review-pr.js");
    truncate = mod.truncate;
  });

  it("returns original string if length is exactly max", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("returns original string if length is less than max", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });

  it("truncates string and appends ellipsis if length exceeds max", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });

  it("handles max of 1", () => {
    expect(truncate("a", 1)).toBe("a");
    expect(truncate("ab", 1)).toBe("…");
  });
});
