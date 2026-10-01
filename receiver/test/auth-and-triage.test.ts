/**
 * Tests for the WebCrypto helpers in `auth.ts` and the webhook triage in
 * `worker.ts`. Pure unit tests — no HTTP, no GitHub API.
 *
 * The Worker entrypoint itself is exercised via Cloudflare's
 * `workerd`/`Miniflare` runtime in CI (out of scope here); this file
 * pins down the parts that matter most: the HMAC verification accepts
 * only valid signatures, and the triage function filters events to the
 * four that should re-trigger the gate.
 */

import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, mintAppJwt } from "../src/auth.js";
import { triage } from "../src/triage.js";

describe("verifyWebhookSignature", () => {
  const secret = "shhh-very-secret";
  const body = '{"action":"resolved"}';

  it("accepts a valid signature", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
    );
    const hex = Array.from(new Uint8Array(sigBuf), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const header = "sha256=" + hex;
    expect(await verifyWebhookSignature(secret, body, header)).toBe(true);
  });

  it("rejects a header without sha256= prefix", async () => {
    expect(await verifyWebhookSignature(secret, body, "abc")).toBe(false);
  });

  it("rejects a signature with the wrong bytes", async () => {
    expect(
      await verifyWebhookSignature(secret, body, "sha256=" + "A".repeat(64))
    ).toBe(false);
  });

  it("rejects null/missing header", async () => {
    expect(await verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  it("rejects a body whose signature matches a different body", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode("other body")
    );
    const hex = Array.from(new Uint8Array(sigBuf), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const header = "sha256=" + hex;
    expect(await verifyWebhookSignature(secret, body, header)).toBe(false);
  });
});

describe("mintAppJwt", () => {
  it("produces a three-segment token", async () => {
    // Generate a throw-away key for the test.
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
    const jwt = await mintAppJwt({
      appId: "123456",
      privateKeyPem: pem,
      nowSeconds: 1_700_000_000,
    });
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
    // The header decodes to RS256.
    const header = JSON.parse(
      atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))
    );
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    // The payload names the app id and a sensible exp.
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    expect(payload.iss).toBe("123456");
    expect(payload.exp).toBe(1_700_000_000 + 9 * 60);
    // GitHub downloads PKCS#1 PEM; it must sign as well as PKCS#8.
    const pkcs1 = createPrivateKey({
      key: Buffer.from(der),
      format: "der",
      type: "pkcs8",
    })
      .export({ format: "pem", type: "pkcs1" })
      .toString();
    const githubJwt = await mintAppJwt({
      appId: "123456",
      privateKeyPem: pkcs1,
      nowSeconds: 1_700_000_000,
    });
    expect(githubJwt.split(".")).toHaveLength(3);
  });
});

describe("triage", () => {
  const repo = {
    full_name: "maxi-tools/maxi-reviewer",
  };

  it("ignores pull_request_review_thread created actions", () => {
    expect(
      triage("pull_request_review_thread", {
        action: "created",
        pull_request: { number: 1, head: { sha: "abc" } },
        repository: repo,
      })
    ).toBeNull();
  });

  it("triage_pull_request_review_thread_resolved", () => {
    const r = triage("pull_request_review_thread", {
      action: "resolved",
      pull_request: { number: 7, head: { sha: "abc123" } },
      repository: repo,
    });
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      owner: "maxi-tools",
      repo: "maxi-reviewer",
      pr: 7,
      reason: "pull_request_review_thread",
    });
  });

  it("triage_pull_request_review_submitted", () => {
    const r = triage("pull_request_review", {
      action: "submitted",
      pull_request: { number: 7, head: { sha: "abc123" } },
      repository: repo,
    });
    expect(r).toMatchObject({ reason: "pull_request_review", pr: 7 });
  });

  it("triage_pull_request_opened", () => {
    const r = triage("pull_request", {
      action: "opened",
      pull_request: { number: 7, head: { sha: "abc123" } },
      repository: repo,
    });
    expect(r).toMatchObject({ reason: "pull_request", pr: 7 });
  });

  it.each(["synchronize", "converted_to_draft", "labeled", "unlabeled"])(
    "reevaluates pull_request %s",
    (action) => {
      expect(
        triage("pull_request", {
          action,
          pull_request: { number: 7 },
          repository: repo,
        })
      ).toMatchObject({ reason: "pull_request", pr: 7 });
    }
  );

  it.each(["created", "deleted"])(
    "reevaluates standalone review comment %s",
    (action) => {
      expect(
        triage("pull_request_review_comment", {
          action,
          pull_request: { number: 7 },
          repository: repo,
        })
      ).toMatchObject({ reason: "pull_request_review_comment", pr: 7 });
    }
  );

  it("ignores pull_request on closed/edited", () => {
    expect(
      triage("pull_request", {
        action: "closed",
        pull_request: { number: 7, head: { sha: "abc" } },
        repository: repo,
      })
    ).toBeNull();
  });

  it("triage_check_run_rerequested_only_for_our_own_check", () => {
    const own = triage("check_run", {
      action: "rerequested",
      check_run: {
        name: "maxi-reviewer/review-gate (review threads)",
        head_sha: "deadbeef",
        pull_requests: [{ number: 42, head: { sha: "deadbeef" } }],
      },
      repository: repo,
    });
    expect(own).toMatchObject({ reason: "check_run.rerequested", pr: 42 });

    const foreign = triage("check_run", {
      action: "rerequested",
      check_run: {
        name: "some-other-app/check",
        head_sha: "deadbeef",
        pull_requests: [{ number: 42, head: { sha: "deadbeef" } }],
      },
      repository: repo,
    });
    expect(foreign).toBeNull();
  });

  it("returns null when the repo cannot be identified", () => {
    expect(
      triage("pull_request", {
        action: "opened",
        pull_request: { number: 1 },
      })
    ).toBeNull();
  });
});
