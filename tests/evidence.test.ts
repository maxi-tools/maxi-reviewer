import { describe, it, expect } from "vitest";
import { holdBlockToItsEvidence } from "../src/evidence.js";
import { EvidenceSource, ReviewComment, ReviewResult } from "../src/types.js";

function finding(
  severity: ReviewComment["severity"],
  evidenceSource?: EvidenceSource,
  file = "src/a.ts"
): ReviewComment {
  return {
    file,
    line: 1,
    severity,
    confidence: "High",
    message: "m",
    promptForAgents: "p",
    ...(evidenceSource ? { evidenceSource } : {}),
  };
}

function review(
  verdict: ReviewResult["verdict"],
  newComments: ReviewComment[]
): ReviewResult {
  return { summary: "s", verdict, resolvedCommentIds: [], newComments };
}

describe("holdBlockToItsEvidence", () => {
  it("keeps a block supported by evidence the reader can check", () => {
    for (const src of ["diff", "context", "retrieval", "analyzer"] as const) {
      const out = holdBlockToItsEvidence(
        review("block", [finding("High", src)])
      );
      expect(out.review.verdict, src).toBe("block");
      expect(out.issues, src).toEqual([]);
    }
  });

  it("downgrades a block whose High findings all rest on memory", () => {
    // The maxi-kvm#85 shape: an external API contract asserted from memory at
    // High severity and High confidence.
    const out = holdBlockToItsEvidence(
      review("block", [
        finding("High", "memory", ".github/workflows/qodana.yml"),
      ])
    );
    expect(out.review.verdict).toBe("comment");
    expect(out.issues.join(" ")).toContain("downgraded from block to comment");
    expect(out.issues.join(" ")).toContain(".github/workflows/qodana.yml:1");
  });

  it("keeps the findings themselves when it downgrades the verdict", () => {
    // The finding may still be worth reading; it is the GATE that was
    // unsupported, not necessarily the observation.
    const out = holdBlockToItsEvidence(
      review("block", [finding("High", "memory")])
    );
    expect(out.review.newComments).toHaveLength(1);
  });

  it("keeps a block when one High finding is checkable and another is not", () => {
    const out = holdBlockToItsEvidence(
      review("block", [finding("High", "memory"), finding("High", "diff")])
    );
    expect(out.review.verdict).toBe("block");
  });

  it("records but does not enforce a missing evidenceSource", () => {
    // Deliberate: enforcing an absent field would downgrade every block from a
    // model that has not started filling it in yet.
    const out = holdBlockToItsEvidence(review("block", [finding("High")]));
    expect(out.review.verdict).toBe("block");
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toContain("no evidenceSource");
    expect(out.issues[0]).toContain("recorded, not enforced");
  });

  it("ignores severities below High", () => {
    const out = holdBlockToItsEvidence(
      review("block", [finding("Warning", "memory"), finding("Info", "memory")])
    );
    expect(out.review.verdict).toBe("block");
    expect(out.issues).toEqual([]);
  });

  it("leaves approve and comment verdicts alone", () => {
    for (const v of ["approve", "comment"] as const) {
      const out = holdBlockToItsEvidence(
        review(v, [finding("High", "memory")])
      );
      expect(out.review.verdict, v).toBe(v);
      expect(out.issues, v).toEqual([]);
    }
  });

  it("does not mutate the review it is given", () => {
    const input = review("block", [finding("High", "memory")]);
    holdBlockToItsEvidence(input);
    expect(input.verdict).toBe("block");
  });
});
