import { describe, expect, it } from "vitest";
import {
  authorizeHandsOnFix,
  buildHandsOnFixPrompt,
} from "../src/hands-on-fix.js";

describe("hands-on fix authorization", () => {
  it("allows same-repository PR branch with explicit command", () => {
    const result = authorizeHandsOnFix({
      command: "/maxi fix c1",
      repository: "maxi/example",
      headRepository: "maxi/example",
      requestedFindingId: "c1",
      availableFindingIds: ["c1"],
      tokenPermissions: { contents: "write", pullRequests: "write" },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects fork PR branches", () => {
    const result = authorizeHandsOnFix({
      command: "/maxi fix c1",
      repository: "maxi/example",
      headRepository: "other/example",
      requestedFindingId: "c1",
      availableFindingIds: ["c1"],
      tokenPermissions: { contents: "write", pullRequests: "write" },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("same-repository");
  });

  it("rejects missing explicit command, unknown findings, and missing permissions", () => {
    expect(
      authorizeHandsOnFix({
        command: "/fix c1",
        repository: "maxi/example",
        headRepository: "maxi/example",
        requestedFindingId: "c1",
        availableFindingIds: ["c1"],
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }).reason
    ).toContain("/maxi fix");

    expect(
      authorizeHandsOnFix({
        command: "/maxi fix c2",
        repository: "maxi/example",
        headRepository: "maxi/example",
        requestedFindingId: "c2",
        availableFindingIds: ["c1"],
        tokenPermissions: { contents: "write", pullRequests: "write" },
      }).reason
    ).toContain("not available");

    expect(
      authorizeHandsOnFix({
        command: "/maxi fix c1",
        repository: "maxi/example",
        headRepository: "maxi/example",
        requestedFindingId: "c1",
        availableFindingIds: ["c1"],
        tokenPermissions: { contents: "read", pullRequests: "write" },
      }).reason
    ).toContain("contents: write");
  });

  it("builds a hands-on Jules fix prompt for one comment", () => {
    const prompt = buildHandsOnFixPrompt({
      id: "c1",
      path: "src/a.ts",
      line: 4,
      severity: "High",
      confidence: "High",
      message: "Fix this bug.",
      promptForAgents: "Change src/a.ts line 4.",
    });

    expect(prompt).toContain("c1");
    expect(prompt).toContain("src/a.ts:4");
    expect(prompt).toContain("Change src/a.ts line 4.");
  });
});
