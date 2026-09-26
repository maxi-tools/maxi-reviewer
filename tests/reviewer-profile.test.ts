import { describe, it, expect } from "vitest";
import {
  BOT_REVIEWERS,
  aggregateReviewerProfiles,
  classifyOutcome,
  isBotReviewer,
  pathGroupFor,
  ReviewerProfiles,
} from "../src/reviewer-profile.js";

const baseFinding = (
  overrides: Partial<{
    reviewer:
      | "codacy-production"
      | "coderabbitai"
      | "qltysh"
      | "chatgpt-codex-connector"
      | "cubic-dev-ai"
      | "github-advanced-security"
      | "maxi-reviewer";
    path: string;
    line: number;
    threadResolved: boolean;
    subsequentTouchedPaths: string[];
    touchedPathsKnown: boolean;
    subsequentCommitCount: number;
  }> = {}
) => ({
  reviewer: "maxi-reviewer" as const,
  repo: "maxi-tools/maxi-reviewer",
  prNumber: 1,
  path: "src/a.ts",
  line: 4,
  threadResolved: false,
  subsequentTouchedPaths: [],
  ...overrides,
});

describe("pathGroupFor", () => {
  it("routes source Rust files into rust-src and test Rust files into rust-test", () => {
    expect(pathGroupFor("crates/maxi-kvm-core/src/lib.rs")).toBe("rust-src");
    expect(pathGroupFor("src/lib.rs")).toBe("rust-src");
    expect(pathGroupFor("crates/maxi-kvm-core/tests/x.rs")).toBe("rust-test");
    expect(pathGroupFor("src/foo_test.rs")).toBe("rust-test");
    expect(pathGroupFor("src/foo.test.rs")).toBe("rust-test");
    expect(pathGroupFor("tests/test_foo.rs")).toBe("rust-test");
  });

  it("recognises the path groups the README documents", () => {
    expect(pathGroupFor(".github/workflows/ci.yml")).toBe("workflows");
    expect(pathGroupFor(".github/dependabot.yml")).toBe("config");
    expect(pathGroupFor("Cargo.lock")).toBe("lockfile");
    expect(pathGroupFor("package-lock.json")).toBe("lockfile");
    expect(pathGroupFor("pnpm-lock.yaml")).toBe("lockfile");
    expect(pathGroupFor("scripts/run.sh")).toBe("shell");
    expect(pathGroupFor("tools/x.bash")).toBe("shell");
    expect(pathGroupFor("Makefile")).toBe("shell");
    expect(pathGroupFor("tools/x.py")).toBe("python");
    expect(pathGroupFor("README.md")).toBe("docs");
  });

  it("falls back to the top-level directory for unknown extensions", () => {
    expect(pathGroupFor("src/foo.ts")).toBe("src");
    expect(pathGroupFor("lib/bar.go")).toBe("lib");
  });

  it("treats an empty path as unknown rather than throwing", () => {
    expect(pathGroupFor("")).toBe("(unknown)");
  });
});

describe("classifyOutcome", () => {
  it("marks a thread as accepted when a later commit touched the same file", () => {
    const outcome = classifyOutcome(
      baseFinding({
        threadResolved: false,
        subsequentTouchedPaths: ["src/a.ts", "src/b.ts"],
      })
    );
    expect(outcome).toBe("accepted");
  });

  // This asserted the OPPOSITE until 2026-09-19, and the example is why it
  // survived: lib.rs and peer.rs are the same crate and the same directory,
  // so "another file in the same path group" read as "a nearby related file".
  //
  // `pathGroupFor` does not implement proximity. It buckets every `.rs` file
  // outside a test directory as `rust-src`, repository-wide. The narrow
  // example licensed a global rule -- on a Rust PR, ANY later Rust commit
  // accepted EVERY Rust finding on that PR.
  //
  // Both cases are asserted now, the neighbour and the stranger, so the real
  // scope of the rule is written down instead of implied by one example.
  it("does not accept on a sibling file in the same directory", () => {
    const outcome = classifyOutcome(
      baseFinding({
        path: "crates/maxi-kvm-core/src/lib.rs",
        subsequentTouchedPaths: ["crates/maxi-kvm-core/src/peer.rs"],
      })
    );
    expect(outcome).toBe("unaddressed");
  });

  it("does not accept on an unrelated file that merely shares a path group", () => {
    // Both are `rust-src`. Under the old rule this was indistinguishable
    // from the author fixing the line, and it is what inflated every rate
    // in the 2026-09-19 harvest: `rust-src` came out top for six of seven
    // reviewers because it is the broadest bucket, not the best-reviewed.
    const outcome = classifyOutcome(
      baseFinding({
        path: "crates/maxi-kvm-core/src/lib.rs",
        subsequentTouchedPaths: ["crates/maxi-kvm-video/src/owned.rs"],
      })
    );
    expect(outcome).toBe("unaddressed");
  });

  it("still accepts when the touched list contains that exact file", () => {
    // The guard against over-correcting: a real fix must still register.
    const outcome = classifyOutcome(
      baseFinding({
        path: "crates/maxi-kvm-core/src/lib.rs",
        subsequentTouchedPaths: [
          "crates/maxi-kvm-video/src/owned.rs",
          "crates/maxi-kvm-core/src/lib.rs",
        ],
      })
    );
    expect(outcome).toBe("accepted");
  });

  it("marks a resolved thread with no follow-up edit as dismissed", () => {
    const outcome = classifyOutcome(
      baseFinding({
        threadResolved: true,
        subsequentTouchedPaths: [],
      })
    );
    expect(outcome).toBe("dismissed");
  });

  it("marks an open thread with no follow-up edit as unaddressed", () => {
    const outcome = classifyOutcome(
      baseFinding({
        path: "crates/x/src/lib.rs",
        threadResolved: false,
        subsequentTouchedPaths: ["docs/README.md", "scripts/run.sh"],
      })
    );
    expect(outcome).toBe("unaddressed");
  });
});

// A PR that merged with no commit after the bot commented gave the author no
// chance to act, so neither silence NOR a resolve is evidence about the
// finding. Measured 2026-09-21: 1,237 of the 3,039 PRs merged across
// maxi-tools in 30 days -- 41% -- are `maxi-config-sync/*` fan-out PRs, whose
// files all carry `# maxi-config-owned ` and cannot be edited in the consumer
// repo at all. Scoring those as not-accepted made every reviewer's rate a
// function of how much fan-out the window contained, and six of seven fell in
// 48 hours because of it.
describe("classifyOutcome on a PR nobody could amend", () => {
  it("reports unknown rather than unaddressed when no commit followed", () => {
    const outcome = classifyOutcome(
      baseFinding({
        path: ".github/workflows/ci.yml",
        threadResolved: false,
        subsequentTouchedPaths: [],
        subsequentCommitCount: 0,
      })
    );
    expect(outcome).toBe("unknown");
  });

  it("reports unknown rather than dismissed when the thread was resolved", () => {
    // The sharper half. On a fan-out PR the CORRECT response to a finding is
    // to fix it at the source in maxi-config and re-fan; the consumer thread
    // is then replied to and resolved with no commit here. Being right and
    // acting on it used to score against the reviewer.
    const outcome = classifyOutcome(
      baseFinding({
        path: ".github/workflows/ci.yml",
        threadResolved: true,
        subsequentTouchedPaths: [],
        subsequentCommitCount: 0,
      })
    );
    expect(outcome).toBe("unknown");
  });

  it("still scores normally once a single commit lands", () => {
    // The guard against over-correcting: one commit is opportunity enough,
    // and from there silence means what it always meant.
    expect(
      classifyOutcome(
        baseFinding({
          path: "src/a.ts",
          threadResolved: true,
          subsequentTouchedPaths: ["src/unrelated.ts"],
          subsequentCommitCount: 1,
        })
      )
    ).toBe("dismissed");
    expect(
      classifyOutcome(
        baseFinding({
          path: "src/a.ts",
          threadResolved: false,
          subsequentTouchedPaths: ["src/unrelated.ts"],
          subsequentCommitCount: 1,
        })
      )
    ).toBe("unaddressed");
  });

  it("still accepts a real fix even though the count is being consulted", () => {
    expect(
      classifyOutcome(
        baseFinding({
          path: "src/a.ts",
          subsequentTouchedPaths: ["src/a.ts"],
          subsequentCommitCount: 1,
        })
      )
    ).toBe("accepted");
  });

  it("keeps a failed walk unknown, and does not let a zero count mask it", () => {
    // Ordering check. `touchedPathsKnown: false` must win: it means we could
    // not look, which is a different fact from having looked and found no
    // commits, even though both classify the same way here.
    expect(
      classifyOutcome(
        baseFinding({
          subsequentTouchedPaths: [],
          touchedPathsKnown: false,
          subsequentCommitCount: 0,
        })
      )
    ).toBe("unknown");
  });

  it("preserves the old behaviour when the count was never recorded", () => {
    // `undefined` is "not recorded", not "zero". Callers written before this
    // field existed keep their meaning; the harvester always sets it, and
    // tests/reviewer-profile-build.test.ts holds it to that.
    const finding = baseFinding({
      threadResolved: true,
      subsequentTouchedPaths: [],
    });
    expect(finding.subsequentCommitCount).toBeUndefined();
    expect(classifyOutcome(finding)).toBe("dismissed");
  });

  it("keeps an unmeasurable finding out of the accept rate entirely", () => {
    // The end-to-end property: an un-amendable PR must move neither the
    // numerator nor the denominator, only `unknownN`.
    const out = aggregateReviewerProfiles(
      [
        baseFinding({
          reviewer: "coderabbitai",
          path: "crates/x/src/lib.rs",
          threadResolved: true,
          subsequentTouchedPaths: [],
          subsequentCommitCount: 0,
        }),
        baseFinding({
          reviewer: "coderabbitai",
          path: "crates/x/src/peer.rs",
          threadResolved: false,
          subsequentTouchedPaths: ["crates/x/src/peer.rs"],
          subsequentCommitCount: 2,
        }),
      ],
      "2026-09-21T00:00:00.000Z",
      30
    );
    const overall = out.reviewers["coderabbitai"].overall;
    expect(overall.n).toBe(1);
    expect(overall.unknownN).toBe(1);
    // 1 of 1 measurable findings accepted. Under the old classifier this was
    // 1 of 2 -- a 50% rate built half out of a PR that could not be changed.
    expect(overall.acceptRate).toBe(1);
  });
});

describe("aggregateReviewerProfiles", () => {
  it("emits the documented schema with all seven bot reviewers seeded to zero", () => {
    const out = aggregateReviewerProfiles([], "2026-09-18T00:00:00.000Z", 30);
    expect(out.schema).toBe("maxi.review.v1.reviewer-profiles");
    expect(out.windowDays).toBe(30);
    expect(out.generatedAt).toBe("2026-09-18T00:00:00.000Z");
    for (const bot of BOT_REVIEWERS) {
      expect(out.reviewers[bot]).toBeDefined();
      expect(out.reviewers[bot].overall).toEqual({
        n: 0,
        acceptRate: 0,
        unknownN: 0,
      });
    }
  });

  it("buckets findings by reviewer and by path group, dropping unknown reviewers", () => {
    const findings = [
      // maxi-reviewer: two findings on rust-src, one accepted (touched), one dismissed (resolved, untouched)
      baseFinding({
        reviewer: "maxi-reviewer",
        path: "crates/maxi-kvm-core/src/lib.rs",
        threadResolved: false,
        subsequentTouchedPaths: ["crates/maxi-kvm-core/src/lib.rs"],
      }),
      baseFinding({
        reviewer: "maxi-reviewer",
        path: "crates/maxi-kvm-core/src/peer.rs",
        threadResolved: true,
        subsequentTouchedPaths: [],
      }),
      // coderabbitai: one finding on workflows, accepted
      baseFinding({
        reviewer: "coderabbitai",
        path: ".github/workflows/ci.yml",
        threadResolved: false,
        subsequentTouchedPaths: [".github/workflows/ci.yml"],
      }),
      // coderabbitai: one finding on workflows, unaddressed (open, no touch)
      baseFinding({
        reviewer: "coderabbitai",
        path: ".github/workflows/calibration-harvest.yml",
        threadResolved: false,
        subsequentTouchedPaths: [],
      }),
      // codacy-production: dismissed on rust-src
      baseFinding({
        reviewer: "codacy-production",
        path: "src/main.rs",
        threadResolved: true,
        subsequentTouchedPaths: [],
      }),
      // unknown bot, should be dropped
      baseFinding({
        reviewer: "maxi-reviewer" as const,
        path: "src/x.ts",
      }),
    ];
    // Force the "unknown bot" path through a type-asserted reviewer name we don't allow.
    (findings[findings.length - 1] as { reviewer: string }).reviewer =
      "rogue-bot";

    const out: ReviewerProfiles = aggregateReviewerProfiles(
      findings as never,
      "2026-09-18T00:00:00.000Z",
      30
    );

    expect(out.reviewers["maxi-reviewer"].overall.n).toBe(2);
    expect(out.reviewers["maxi-reviewer"].overall.acceptRate).toBeCloseTo(0.5);
    const rustSrc = out.reviewers["maxi-reviewer"].byPathGroup["rust-src"];
    expect(rustSrc).toBeDefined();
    expect(rustSrc.n).toBe(2);
    expect(rustSrc.acceptRate).toBeCloseTo(0.5);

    expect(out.reviewers["coderabbitai"].overall.n).toBe(2);
    expect(out.reviewers["coderabbitai"].overall.acceptRate).toBeCloseTo(0.5);
    const workflows = out.reviewers["coderabbitai"].byPathGroup["workflows"];
    expect(workflows.n).toBe(2);
    expect(workflows.acceptRate).toBeCloseTo(0.5);

    expect(out.reviewers["codacy-production"].overall.n).toBe(1);
    expect(out.reviewers["codacy-production"].overall.acceptRate).toBe(0);
    expect(out.reviewers["qltysh"].overall.n).toBe(0);
  });

  it("exposes each reviewer's path-group buckets only for groups with samples", () => {
    const findings = [
      baseFinding({
        reviewer: "maxi-reviewer",
        path: "crates/x/src/lib.rs",
        threadResolved: false,
        subsequentTouchedPaths: ["crates/x/src/lib.rs"],
      }),
    ];
    const out = aggregateReviewerProfiles(
      findings,
      "2026-09-18T00:00:00.000Z",
      30
    );
    expect(out.reviewers["maxi-reviewer"].byPathGroup["rust-src"]?.n).toBe(1);
    expect(
      out.reviewers["maxi-reviewer"].byPathGroup["rust-test"]
    ).toBeUndefined();
  });
});

describe("isBotReviewer", () => {
  it("accepts every login the schema covers", () => {
    for (const login of BOT_REVIEWERS) {
      expect(isBotReviewer(login)).toBe(true);
    }
  });

  it("rejects logins outside the schema", () => {
    expect(isBotReviewer("maxiboch")).toBe(false);
    expect(isBotReviewer("")).toBe(false);
  });
});
