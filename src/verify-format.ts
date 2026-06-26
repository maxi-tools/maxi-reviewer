import { validateJulesReview } from "./schema.js";
import { JulesReview } from "./types.js";

export interface VerificationContext {
  changedLines: Map<string, Set<number>>;
  files: Map<string, string>;
}

export interface VerificationIssue {
  kind:
    | "parse"
    | "schema"
    | "suggestion-fence"
    | "unchanged-line"
    | "missing-file"
    | "invalid-range"
    | "non-applying";
  message: string;
}

export function parseJulesReview(message: string): JulesReview {
  const match = message.match(/```json\s*\n([\s\S]*?)\n?```/);
  const text = match ? match[1] : message;
  const parsed = JSON.parse(text) as unknown;
  const validated = validateJulesReview(parsed);
  if (!validated.ok || !validated.value) {
    throw new Error(validated.errors.join("; "));
  }
  return validated.value;
}

export function verifyJulesReview(
  review: JulesReview,
  context: VerificationContext
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const schema = validateJulesReview(review);
  if (!schema.ok) {
    issues.push(
      ...schema.errors.map((message) => ({
        kind: "schema" as const,
        message,
      }))
    );
  }

  for (const comment of review.comments) {
    const label = `${comment.id} (${comment.path}:${comment.line})`;
    const changed = context.changedLines.get(comment.path);
    if (!changed || !changed.has(comment.line)) {
      issues.push({
        kind: "unchanged-line",
        message: `${label} targets a line that is not in the changed diff.`,
      });
    }

    issues.push(...findSuggestionFenceIssues(comment.message, label));

    const suggestion = comment.suggestion;
    if (!suggestion) continue;
    if (suggestion.path !== comment.path) {
      issues.push({
        kind: "invalid-range",
        message: `${label} suggestion path must match the comment path.`,
      });
    }
    const file = context.files.get(suggestion.path);
    if (file === undefined) {
      issues.push({
        kind: "missing-file",
        message: `${label} suggestion file is not available: ${suggestion.path}.`,
      });
      continue;
    }
    const lineCount = Math.max(1, file.split("\n").length - 1);
    if (
      suggestion.startLine < 1 ||
      suggestion.endLine < suggestion.startLine ||
      suggestion.endLine > lineCount
    ) {
      issues.push({
        kind: "invalid-range",
        message: `${label} suggestion range ${suggestion.startLine}-${suggestion.endLine} is outside ${suggestion.path}.`,
      });
    } else if (
      currentRange(file, suggestion.startLine, suggestion.endLine) ===
      suggestion.replacement
    ) {
      issues.push({
        kind: "non-applying",
        message: `${label} suggestion replacement does not change ${suggestion.path}:${suggestion.startLine}-${suggestion.endLine}.`,
      });
    }
    const suggestionChanged = context.changedLines.get(suggestion.path);
    for (let line = suggestion.startLine; line <= suggestion.endLine; line++) {
      if (!suggestionChanged || !suggestionChanged.has(line)) {
        issues.push({
          kind: "unchanged-line",
          message: `${label} suggestion targets unchanged line ${line}.`,
        });
        break;
      }
    }
    if (!comment.message.includes("```suggestion")) {
      issues.push({
        kind: "suggestion-fence",
        message: `${label} has structured suggestion data but no GitHub suggestion fence in the comment message.`,
      });
    }
  }

  return issues;
}

function currentRange(
  file: string,
  startLine: number,
  endLine: number
): string {
  return file
    .replace(/\n$/, "")
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
}

export function buildReviewRepairPrompt(
  reviewOrRaw: unknown,
  issues: VerificationIssue[]
): string {
  const previous =
    typeof reviewOrRaw === "string"
      ? reviewOrRaw
      : JSON.stringify(reviewOrRaw, null, 2);
  return `Fix only the Maxi review JSON.

The previous response failed validation:
${issues.map((issue) => `- ${issue.kind}: ${issue.message}`).join("\n")}

Return exactly one complete maxi.review.v1.jules-review JSON object, optionally wrapped in a \`\`\`json fence. Preserve valid findings where possible. Do not add prose outside the JSON.

Previous response:
\`\`\`text
${previous}
\`\`\``;
}

function findSuggestionFenceIssues(
  message: string,
  label: string
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const lines = message.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.includes("```suggestion") && !/^```\s*suggestion\s*$/.test(line)) {
      issues.push({
        kind: "suggestion-fence",
        message: `${label} has a malformed suggestion fence on message line ${lineIndex + 1}.`,
      });
    }
    if (!/^```\s*suggestion\s*$/.test(line)) continue;

    const closeIndex = lines.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > lineIndex && /^```\s*$/.test(candidate)
    );
    if (closeIndex === -1) {
      issues.push({
        kind: "suggestion-fence",
        message: `${label} has an unclosed suggestion block.`,
      });
      continue;
    }
    if (closeIndex === lineIndex + 1) {
      issues.push({
        kind: "suggestion-fence",
        message: `${label} has an empty suggestion block.`,
      });
    }
    lineIndex = closeIndex;
  }

  return issues;
}
