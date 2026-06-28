import { randomBytes } from "node:crypto";

/**
 * Per-review, unguessable boundary token for untrusted blocks.
 *
 * Generated at review time so that a PR author (who writes their content
 * earlier) cannot include it to forge or prematurely close an untrusted block.
 * Shared by the prompt builder and the retrieval loop so every untrusted value
 * the model ever sees -- diff, PR body, prior threads, AND on-demand retrieval
 * results -- is fenced with the same token under one consistent framing.
 */
export function makeNonce(): string {
  return randomBytes(12).toString("hex").toUpperCase();
}

/**
 * Wrap untrusted content between per-review BEGIN/END markers the model is told
 * to treat as inert DATA. The author cannot guess the nonce, so cannot forge or
 * close the markers -- this neutralises fence-break prompt injection.
 */
export function fence(nonce: string, label: string, content: string): string {
  return `<<<BEGIN ${label} ${nonce}>>>\n${content}\n<<<END ${label} ${nonce}>>>`;
}
