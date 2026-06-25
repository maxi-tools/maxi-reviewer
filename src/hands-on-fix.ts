import { JulesReviewComment } from "./types.js";

export interface HandsOnFixRequest {
  command: string;
  repository: string;
  headRepository: string;
  requestedFindingId: string;
  availableFindingIds: string[];
  tokenPermissions: { contents?: string; pullRequests?: string };
}

export interface AuthorizationResult {
  ok: boolean;
  reason?: string;
}

export function authorizeHandsOnFix(
  input: HandsOnFixRequest
): AuthorizationResult {
  if (!input.command.startsWith("/maxi fix ")) {
    return { ok: false, reason: "explicit /maxi fix command required" };
  }
  if (input.repository !== input.headRepository) {
    return {
      ok: false,
      reason: "hands-on fixes require a same-repository PR branch",
    };
  }
  if (!input.availableFindingIds.includes(input.requestedFindingId)) {
    return { ok: false, reason: "requested finding is not available" };
  }
  if (input.tokenPermissions.contents !== "write") {
    return { ok: false, reason: "contents: write permission required" };
  }
  if (input.tokenPermissions.pullRequests !== "write") {
    return { ok: false, reason: "pull-requests: write permission required" };
  }
  return { ok: true };
}

export function buildHandsOnFixPrompt(comment: JulesReviewComment): string {
  const location = `${comment.path}:${comment.line}`;
  const agentGuidance = comment.promptForAgents
    ? `\n\nSpecific fix guidance:\n${comment.promptForAgents}`
    : "";
  return `Fix Maxi review finding ${comment.id}.

Location: ${location}
Severity: ${comment.severity}
Confidence: ${comment.confidence}

Review finding:
${comment.message}${agentGuidance}

Make the smallest correct code change on the PR branch, run the relevant tests, and commit the fix.`;
}
