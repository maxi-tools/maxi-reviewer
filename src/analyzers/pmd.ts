import { AnalyzerFinding } from "../types.js";
import {
  asPositiveInt,
  buildFinding,
  normalizeConfidence,
  normalizeSeverity,
} from "./normalize.js";

export function parsePmdXml(text: string): AnalyzerFinding[] {
  const version = attrs(text.match(/<pmd\b[^>]*>/)?.[0] ?? "").version;
  const findings: AnalyzerFinding[] = [];
  const filePattern = /<file\b([^>]*)>([\s\S]*?)<\/file>/g;

  for (const fileMatch of text.matchAll(filePattern)) {
    const fileAttrs = attrs(fileMatch[1]);
    const path = fileAttrs.name ?? "";
    const body = fileMatch[2];

    for (const violationMatch of body.matchAll(
      /<violation\b([^>]*)>([\s\S]*?)<\/violation>/g
    )) {
      const violationAttrs = attrs(violationMatch[1]);
      const startLine = asPositiveInt(Number(violationAttrs.beginline));
      findings.push(
        buildFinding({
          tool: "pmd",
          toolVersion: version,
          ruleId: violationAttrs.rule ?? "pmd-violation",
          ruleName: violationAttrs.ruleset,
          severity: normalizeSeverity(priorityToSeverity(violationAttrs.priority)),
          confidence: normalizeConfidence(undefined),
          message: decodeXml(violationMatch[2].trim()),
          path,
          startLine,
          endLine: asPositiveInt(Number(violationAttrs.endline), startLine),
          helpUri: violationAttrs.externalInfoUrl,
          raw: { file: fileAttrs, violation: violationAttrs },
        })
      );
    }
  }

  return findings;
}

export function parseCpdXml(text: string): AnalyzerFinding[] {
  const findings: AnalyzerFinding[] = [];

  for (const duplicationMatch of text.matchAll(
    /<duplication\b([^>]*)>([\s\S]*?)<\/duplication>/g
  )) {
    const duplicationAttrs = attrs(duplicationMatch[1]);
    const firstFile = duplicationMatch[2].match(/<file\b([^>]*)\/?>/);
    const fileAttrs = attrs(firstFile?.[1] ?? "");
    const startLine = asPositiveInt(Number(fileAttrs.line));
    const lines = asPositiveInt(Number(duplicationAttrs.lines), 1);

    findings.push(
      buildFinding({
        tool: "cpd",
        ruleId: "copy-paste-duplicate",
        severity: "warning",
        confidence: "medium",
        message: `Duplicate code block spans ${lines} lines.`,
        path: fileAttrs.path ?? "",
        startLine,
        endLine: startLine + lines - 1,
        raw: { duplication: duplicationAttrs },
      })
    );
  }

  return findings;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:]*)="([^"]*)"/g)) {
    out[match[1]] = decodeXml(match[2]);
  }
  return out;
}

function priorityToSeverity(priority: string | undefined): string {
  if (priority === "1" || priority === "2") return "error";
  if (priority === "3") return "warning";
  return "info";
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
