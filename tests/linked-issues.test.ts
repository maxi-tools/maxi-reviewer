import { describe, it, expect, vi } from "vitest";
import {
  parseClosingIssueRefs,
  fetchLinkedIssues,
} from "../src/linked-issues.js";

const REPO = { owner: "maxi-tools", repo: "maxi-reviewer" };

describe("parseClosingIssueRefs", () => {
  it("parses every supported closing keyword, case-insensitively", () => {
    for (const kw of [
      "close",
      "Closes",
      "CLOSED",
      "fix",
      "Fixes",
      "fixed",
      "resolve",
      "Resolves",
      "resolved",
    ]) {
      const refs = parseClosingIssueRefs(`${kw} #13`, REPO);
      expect(refs).toEqual([
        { owner: "maxi-tools", repo: "maxi-reviewer", number: 13 },
      ]);
    }
  });

  it("accepts an optional colon after the keyword", () => {
    expect(parseClosingIssueRefs("Closes: #7", REPO)).toEqual([
      { owner: "maxi-tools", repo: "maxi-reviewer", number: 7 },
    ]);
  });

  it("ignores plain mentions that are not closing references", () => {
    expect(parseClosingIssueRefs("See #5 and related #6", REPO)).toEqual([]);
    expect(parseClosingIssueRefs("This relates to #5", REPO)).toEqual([]);
  });

  it("requires a word boundary so 'prefixclose #1' does not match", () => {
    expect(parseClosingIssueRefs("unfix #1", REPO)).toEqual([]);
  });

  it("parses owner/repo#n shorthand for the same repo", () => {
    expect(
      parseClosingIssueRefs("fixes maxi-tools/maxi-reviewer#42", REPO)
    ).toEqual([{ owner: "maxi-tools", repo: "maxi-reviewer", number: 42 }]);
  });

  it("drops cross-repo references", () => {
    expect(
      parseClosingIssueRefs("closes other-org/other-repo#42", REPO)
    ).toEqual([]);
  });

  it("matches owner/repo case-insensitively", () => {
    expect(
      parseClosingIssueRefs("closes Maxi-Tools/Maxi-Reviewer#9", REPO)
    ).toEqual([{ owner: "maxi-tools", repo: "maxi-reviewer", number: 9 }]);
  });

  it("parses a full issue URL", () => {
    expect(
      parseClosingIssueRefs(
        "Fixes https://github.com/maxi-tools/maxi-reviewer/issues/100",
        REPO
      )
    ).toEqual([{ owner: "maxi-tools", repo: "maxi-reviewer", number: 100 }]);
  });

  it("orders mixed URL and shorthand refs by position in the body", () => {
    const body =
      "fixes #1, resolves https://github.com/maxi-tools/maxi-reviewer/issues/2, closes #3";
    expect(parseClosingIssueRefs(body, REPO).map((r) => r.number)).toEqual([
      1, 2, 3,
    ]);
  });

  it("orders a leading URL ref before a later shorthand ref", () => {
    const body =
      "closes https://github.com/maxi-tools/maxi-reviewer/issues/5 and fixes #4";
    expect(parseClosingIssueRefs(body, REPO).map((r) => r.number)).toEqual([
      5, 4,
    ]);
  });

  it("dedupes repeated references and preserves first-seen order", () => {
    const refs = parseClosingIssueRefs(
      "Closes #3, fixes #5, resolves #3",
      REPO
    );
    expect(refs.map((r) => r.number)).toEqual([3, 5]);
  });

  it("returns [] for empty or missing bodies", () => {
    expect(parseClosingIssueRefs("", REPO)).toEqual([]);
    expect(parseClosingIssueRefs(null, REPO)).toEqual([]);
    expect(parseClosingIssueRefs(undefined, REPO)).toEqual([]);
  });
});

interface FakeIssue {
  title: string;
  body: string | null;
  state: string;
  pull_request?: unknown;
}

function octokitWith(issues: Record<number, FakeIssue | Error>): {
  rest: { issues: { get: ReturnType<typeof vi.fn> } };
} {
  return {
    rest: {
      issues: {
        get: vi.fn(async ({ issue_number }: { issue_number: number }) => {
          const entry = issues[issue_number];
          if (entry instanceof Error) throw entry;
          if (!entry) throw new Error("not found");
          return { data: entry };
        }),
      },
    },
  };
}

describe("fetchLinkedIssues", () => {
  const ref = (number: number) => ({
    owner: "maxi-tools",
    repo: "maxi-reviewer",
    number,
  });

  it("fetches title/body/state for each ref", async () => {
    const octokit = octokitWith({
      13: { title: "Ground review", body: "Acceptance: do X", state: "open" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await fetchLinkedIssues(octokit as any, [ref(13)]);
    expect(out).toEqual([
      {
        number: 13,
        title: "Ground review",
        body: "Acceptance: do X",
        state: "open",
        truncated: false,
      },
    ]);
  });

  it("caps the number of issues fetched", async () => {
    const octokit = octokitWith({
      1: { title: "a", body: "", state: "open" },
      2: { title: "b", body: "", state: "open" },
      3: { title: "c", body: "", state: "open" },
    });
    const out = await fetchLinkedIssues(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      octokit as any,
      [ref(1), ref(2), ref(3)],
      { maxIssues: 2 }
    );
    expect(out.map((i) => i.number)).toEqual([1, 2]);
    expect(octokit.rest.issues.get).toHaveBeenCalledTimes(2);
  });

  it("truncates long bodies and flags truncation", async () => {
    const octokit = octokitWith({
      1: { title: "t", body: "x".repeat(50), state: "open" },
    });
    const out = await fetchLinkedIssues(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      octokit as any,
      [ref(1)],
      { maxBodyChars: 10 }
    );
    expect(out[0].body).toBe("x".repeat(10));
    expect(out[0].truncated).toBe(true);
  });

  it("skips references that resolve to pull requests", async () => {
    const octokit = octokitWith({
      1: { title: "a PR", body: "", state: "open", pull_request: { url: "x" } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await fetchLinkedIssues(octokit as any, [ref(1)]);
    expect(out).toEqual([]);
  });

  it("skips fetch failures without throwing", async () => {
    const octokit = octokitWith({
      1: new Error("404"),
      2: { title: "ok", body: "b", state: "closed" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await fetchLinkedIssues(octokit as any, [ref(1), ref(2)]);
    expect(out.map((i) => i.number)).toEqual([2]);
    expect(out[0].state).toBe("closed");
  });

  it("normalises unexpected state values to open", async () => {
    const octokit = octokitWith({
      1: { title: "t", body: "b", state: "weird" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await fetchLinkedIssues(octokit as any, [ref(1)]);
    expect(out[0].state).toBe("open");
  });
});
