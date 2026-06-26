import { ReviewResult } from "./types.js";

export function findReviewFormatIssues(review: ReviewResult): string[] {
  const issues: string[] = [];
  for (const [index, comment] of (review.newComments || []).entries()) {
    const label = `comment ${index + 1} (${comment.file}:${comment.line})`;
    const lines = comment.message.split("\n");

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (
        line.includes("```suggestion") &&
        !/^```\s*suggestion\s*$/.test(line)
      ) {
        issues.push(
          `${label} has a malformed suggestion fence on message line ${lineIndex + 1}; use exactly \`\`\`suggestion on its own line.`
        );
      }
      if (!/^```\s*suggestion\s*$/.test(line)) continue;

      const closeIndex = lines.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > lineIndex && /^```\s*$/.test(candidate)
      );
      if (closeIndex === -1) {
        issues.push(`${label} has an unclosed \`\`\`suggestion block.`);
        continue;
      }
      if (closeIndex === lineIndex + 1) {
        issues.push(`${label} has an empty \`\`\`suggestion block.`);
      }
      lineIndex = closeIndex;
    }
  }
  return issues;
}

export function buildFormatRepairPrompt(
  review: ReviewResult,
  issues: string[]
): string {
  return `Fix only the review response formatting.

The previous response had GitHub suggested-change formatting issues:
${issues.map((issue) => `- ${issue}`).join("\n")}

Return the complete review JSON again. Preserve the same findings, files, lines, severities, confidence values, verdict, summary, and resolvedCommentIds unless a formatting issue requires changing a comment message.

For concrete replacements, use GitHub suggested-change fences exactly like this inside the comment message:
\`\`\`suggestion
replacement code
\`\`\`

Previous review JSON:
\`\`\`json
${JSON.stringify(review, null, 2)}
\`\`\``;
}

export function buildJsonRepairPrompt(
  rawResponse: string,
  parseError: unknown
): string {
  const message =
    parseError instanceof Error ? parseError.message : String(parseError);
  return `Fix only the review response JSON.

The previous response could not be parsed as the required review JSON.

Parse error:
${message}

Return exactly one complete JSON object, optionally wrapped in a \`\`\`json fence. Preserve all valid findings from the previous response. Do not add prose outside the JSON.

Previous response:
\`\`\`text
${rawResponse}
\`\`\``;
}
