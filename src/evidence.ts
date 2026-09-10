import { EvidenceSource, ReviewResult } from "./types.js";

/**
 * Evidence classes that a reviewer can point at inside the material it was
 * given. `memory` is the one that cannot be checked by anyone reading the run.
 */
export const CHECKABLE_EVIDENCE: readonly EvidenceSource[] = [
  "diff",
  "context",
  "retrieval",
  "analyzer",
];

/**
 * Hold `block` to the rule the prompt already states.
 *
 * WHY THIS IS CODE AND NOT MORE PROSE. src/prompt.ts has said for a long time
 * that for third-party tools and APIs, "if you are relying only on memory of an
 * external API, mention the uncertainty and do not use `block`". On
 * maxi-tools/maxi-kvm#85 the reviewer returned severity High, confidence High,
 * verdict `block`, asserting that actions/create-github-app-token requires
 * `app-id` and rejects `client-id`. Upstream documents the reverse. Applying
 * that finding would have broken the step it claimed to repair. The rule was
 * right and unenforced, and an instruction that has been ignored once will be
 * ignored again.
 *
 * WHY NOT "a block must cite evidence". That over-rejects. The worked example
 * in the prompt -- an `unwrap()` that panics on external input -- is a
 * legitimate block resting on nothing but the diff, with no analyzer finding
 * and no retrieval round. The distinction is not whether evidence exists but
 * WHERE IT LIVES: the panic is verifiable from the changed line, the input
 * schema of somebody else's Action is not verifiable from anything in the
 * review. So the model declares the class and the runner holds it to it.
 *
 * DELIBERATELY LENIENT ABOUT AN ABSENT FIELD. A missing `evidenceSource` is
 * recorded and not enforced. Enforcing it would downgrade every block emitted
 * by a model that has not yet started filling the field in, turning a
 * calibration change into an outage of the verdict. The recorded issues make
 * the omission rate measurable first -- src/calibration.ts already aggregates
 * these artifacts -- so the decision to enforce can follow a number.
 */
export function holdBlockToItsEvidence(review: ReviewResult): {
  review: ReviewResult;
  issues: string[];
} {
  if (review.verdict !== "block") {
    return { review, issues: [] };
  }

  const high = (review.newComments || []).filter((c) => c.severity === "High");
  if (high.length === 0) {
    return { review, issues: [] };
  }

  const undeclared = high.filter((c) => !c.evidenceSource);
  const issues = undeclared.map(
    (c) =>
      `${c.file}:${c.line} is severity High with no evidenceSource; recorded, not enforced.`
  );

  // EVERY High finding must have declared `memory` before the verdict moves.
  //
  // A mixed set -- one finding saying `memory`, another saying nothing -- has
  // not told us the block is unsupported. The silent one may well be checkable;
  // an absent field is recorded and not acted on, and that stance cannot hold
  // if a single `memory` sibling is enough to drag the verdict down with it.
  // The earlier version compared undeclared.length against high.length and fell
  // through to the downgrade on any mix, which both broke that rule and emitted
  // a message claiming every finding had declared `memory` when one had not.
  //
  // A value outside the vocabulary cannot reach here -- the parse boundary in
  // jules.ts drops unknown labels, so they arrive as absent -- and if one did,
  // this comparison leaves the verdict alone rather than mislabelling it.
  const memory = high.filter((c) => c.evidenceSource === "memory");
  if (memory.length !== high.length) {
    return { review, issues };
  }

  return {
    review: { ...review, verdict: "comment" },
    issues: [
      "verdict downgraded from block to comment: every severity-High finding " +
        'supporting it declared evidenceSource "memory" ' +
        `(${memory.map((c) => `${c.file}:${c.line}`).join(", ")}), ` +
        "which the reviewer's own rule says cannot support a block.",
      ...issues,
    ],
  };
}
