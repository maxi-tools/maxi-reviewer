/**
 * GitHub App authentication helpers.
 *
 * `mintAppJwt` builds an RS256 JWT from a PEM private key using WebCrypto.
 * `installationToken` exchanges that JWT at `POST /app/installations/{id}/access_tokens`
 * for a short-lived installation token; cache that token for ten minutes
 * (its actual TTL is shorter; the cap is on the request budget, not the
 * server).
 *
 * Both use only the WebCrypto + fetch APIs that exist in Cloudflare Workers.
 * No Node-only crypto, no Buffer.
 */

const APP_JWT_TTL_SECONDS = 9 * 60; // 9 min — under GitHub's 10-min cap

let cachedPemKey: CryptoKey | null = null;
let cachedPemKeyPem: string | null = null;

/** Strip PEM armour and base64-decode a PKCS#8 RSA private key. */
function pemToDer(pem: string): Uint8Array {
  const stripped = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (stripped.length === 0) {
    throw new Error("PEM private key is empty");
  }
  const binary = atob(stripped);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64url(input: Uint8Array | string): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedPemKey && cachedPemKeyPem === pem) return cachedPemKey;
  const der = pemToDer(pem);
  // The WebCrypto API takes an `ArrayBuffer`, not the broader
  // `ArrayBufferLike`; copy into a fresh buffer so the call site sees a
  // plain ArrayBuffer-backed Uint8Array.
  const ab = new ArrayBuffer(der.byteLength);
  new Uint8Array(ab).set(der);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    ab,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  cachedPemKey = key;
  cachedPemKeyPem = pem;
  return key;
}

export interface AppJwtInputs {
  appId: string;
  /** PKCS#8 PEM-encoded private key from the App settings page. */
  privateKeyPem: string;
  /** Optional override; defaults to "now". */
  nowSeconds?: number;
}

/** Build an RS256 JWT for the App — caller passes it to installationToken. */
export async function mintAppJwt(inputs: AppJwtInputs): Promise<string> {
  const now = inputs.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now,
    exp: now + APP_JWT_TTL_SECONDS,
    iss: inputs.appId,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = headerB64 + "." + payloadB64;
  const key = await importPrivateKey(inputs.privateKeyPem);
  const payloadBytes = new TextEncoder().encode(signingInput);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    toArrayBuffer(payloadBytes)
  );
  const sigB64 = b64url(new Uint8Array(sig));
  return signingInput + "." + sigB64;
}

export interface InstallationTokenInputs {
  appJwt: string;
  installationId: number;
  fetchImpl?: typeof fetch;
}

export interface InstallationToken {
  token: string;
  /** Unix-seconds expiry reported by GitHub, if present. */
  expiresAt?: number;
}

interface AccessTokensResponse {
  token: string;
  expires_at?: string;
}

/** Exchange an App JWT for an installation access token. */
export async function installationToken(
  inputs: InstallationTokenInputs
): Promise<InstallationToken> {
  const f = inputs.fetchImpl ?? fetch;
  const res = await f(
    `https://api.github.com/app/installations/${inputs.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inputs.appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "maxi-reviewer-receiver",
      },
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `installation token request failed: ${res.status} ${res.statusText}: ${body.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as AccessTokensResponse;
  let expiresAt: number | undefined;
  if (typeof data.expires_at === "string") {
    const ms = Date.parse(data.expires_at);
    if (!Number.isNaN(ms)) expiresAt = Math.floor(ms / 1000);
  }
  return { token: data.token, expiresAt };
}

/**
 * Verify a webhook HMAC, returning true iff `headerValue` is a valid
 * `sha256=...` signature of `body` under `secret`.
 *
 * Constant-time compare on the bytes of the signature; refuses on any
 * length mismatch.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  headerValue: string | null
): Promise<boolean> {
  if (typeof headerValue !== "string" || !headerValue.startsWith("sha256=")) {
    return false;
  }
  const provided = headerValue.slice("sha256=".length).trim();
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(new TextEncoder().encode(body))
  );
  const computed = b64url(new Uint8Array(sig));
  if (provided.length !== computed.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ computed.charCodeAt(i);
  }
  return diff === 0;
}
