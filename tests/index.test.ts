/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import * as github from "@actions/github";

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
    listReviewArtifactCommentRecords: vi.fn(),
    pruneReviewArtifactComments: vi.fn(),
    pruneReviewArtifactCommentsFromSnapshot: vi.fn(),
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
    mockGithubHelper.listReviewArtifactCommentRecords.mockResolvedValue([]);
    mockGithubHelper.pruneReviewArtifactComments.mockResolvedValue(0);
    mockGithubHelper.pruneReviewArtifactCommentsFromSnapshot.mockResolvedValue(
      0
    );
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

  const loadIndex = async () => {
    await import("../src/index.js");
    await vi.waitFor(() => {
      const hasFinalStatus = mockGithubHelper.setStatus.mock.calls.some(
        (call) => call[5] !== "pending"
      );
      const hasSkip = mockInfo.mock.calls.some(
        (call) =>
          String(call[0]).startsWith("Skipping") ||
          String(call[0]).startsWith("Bypass label")
      );
      if (
        mockReviewCommand.runReviewCommand.mock.calls.length > 0 ||
        mockSetFailed.mock.calls.length > 0 ||
        mockGithubHelper.submitReview.mock.calls.length > 0 ||
        hasFinalStatus ||
        hasSkip
      ) {
        return;
      }
      throw new Error("Action has not settled yet.");
    });
  };

  it("fails if eventName is pull_request_target", async () => {
    (github as any).context.eventName = "pull_request_target";
    await loadIndex();
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("pull_request_target is not supported")
    );
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
    expect(mockGithubHelper.fetchDiff).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "repo",
      expect.anything(),
      "beforeSHA",
      "headSHA"
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
    await vi.waitFor(() =>
      expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        "owner",
        "repo",
        "headSHA",
        expect.anything(),
        "failure",
        "Review timed out; see harvested artifact"
      )
    );
    expect(mockGithubHelper.submitReview).not.toHaveBeenCalled();
    expect(mockArtifact.default.uploadArtifact).toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(
      "Jules returned no review message within 30 minutes; recorded a harvestable review artifact."
    );
    expect(mockSetFailed).toHaveBeenCalledWith(
      "Jules returned no review message within 30 minutes."
    );
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
    await vi.waitFor(() =>
      expect(mockGithubHelper.resolveThreads).toHaveBeenCalledWith(
        expect.anything(),
        ["t2"]
      )
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
    await vi.waitFor(() =>
      expect(mockGithubHelper.submitReview).toHaveBeenCalled()
    );
    await vi.waitFor(() =>
      expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        "owner",
        "repo",
        "headSHA",
        expect.anything(),
        "failure",
        "Blocking issues found"
      )
    );
  });

  it("skips artifact pruning when retention sizing fails", async () => {
    mockGithubHelper.listReviewArtifactCommentRecords.mockRejectedValue(
      new Error("transient list failure")
    );

    await loadIndex();

    expect(mockGithubHelper.pruneReviewArtifactComments).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to size review artifact retention")
    );
  });

  it("sizes and prunes from the same artifact snapshot", async () => {
    const snapshot = [{ id: 7, body: "not a decodable artifact" }];
    mockGithubHelper.listReviewArtifactCommentRecords.mockResolvedValue(
      snapshot
    );

    await loadIndex();

    expect(
      mockGithubHelper.pruneReviewArtifactCommentsFromSnapshot
    ).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "repo",
      snapshot,
      expect.any(Number)
    );
    expect(mockGithubHelper.pruneReviewArtifactComments).not.toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        "owner",
        "repo",
        "headSHA",
        expect.anything(),
        "success",
        "Review complete (verdict: block)"
      )
    );
  });

  it("handles fail_on = any with approve verdict", async () => {
    mockJulesHelper.runJulesReview.mockResolvedValue({
      reviewResult: { verdict: "approve", summary: "ok", newComments: [] },
      sessionId: "s1",
    });
    await loadIndex();
    await vi.waitFor(() =>
      expect(mockGithubHelper.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        "owner",
        "repo",
        "headSHA",
        expect.anything(),
        "success",
        "Approved"
      )
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
