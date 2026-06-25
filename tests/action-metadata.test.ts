import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("action metadata", () => {
  it("uses the maxi-review identity and Node 24 runtime", () => {
    const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      name: string;
    };

    expect(pkg.name).toBe("maxi-review");
    expect(action).toContain('name: "Maxi Review"');
    expect(action).toContain('using: "node24"');
    expect(action).not.toContain("jules-pr-reviewer");
    expect(action).not.toContain("node20");
  });
});
