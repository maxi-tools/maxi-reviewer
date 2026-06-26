import { AnalyzerFinding } from "../types.js";
import {
  asArray,
  asPositiveInt,
  asRecord,
  asText,
  buildFinding,
  normalizeConfidence,
  normalizeSeverity,
} from "./normalize.js";

export function parseOpengrepJson(text: string): AnalyzerFinding[] {
  const root = asRecord(JSON.parse(text));
  if (!root) return [];

  return asArray(root.results).flatMap((result) => {
    const item = asRecord(result);
    if (!item) return [];

    const extra = asRecord(item.extra) ?? {};
    const metadata = asRecord(extra.metadata) ?? {};
    const path = asText(item.path);
    const ruleId = asText(item.check_id, "unknown-rule");
    const start = asRecord(item.start) ?? {};
    const end = asRecord(item.end) ?? {};
    const message = asText(extra.message, ruleId);

    return [
      buildFinding({
        tool: "opengrep",
        toolVersion: asText(root.version, undefined),
        ruleId,
        severity: normalizeSeverity(extra.severity),
        confidence: normalizeConfidence(metadata.confidence),
        message,
        path,
        startLine: asPositiveInt(start.line),
        endLine: asPositiveInt(end.line, asPositiveInt(start.line)),
        helpUri: asText(metadata.source, undefined),
        license: asText(metadata.license, undefined),
        raw: item,
      }),
    ];
  });
}

export function parseOpengrepSarif(text: string): AnalyzerFinding[] {
  const root = asRecord(JSON.parse(text));
  if (!root) return [];

  return asArray(root.runs).flatMap((run) => {
    const runRecord = asRecord(run);
    if (!runRecord) return [];

    const tool = asRecord(runRecord.tool) ?? {};
    const driver = asRecord(tool.driver) ?? {};
    const ruleMap = new Map<string, Record<string, unknown>>();
    for (const rule of asArray(driver.rules)) {
      const record = asRecord(rule);
      if (!record) continue;
      const id = asText(record.id);
      if (id) ruleMap.set(id, record);
    }

    return asArray(runRecord.results).flatMap((result) => {
      const item = asRecord(result);
      if (!item) return [];

      const ruleId = asText(item.ruleId, "unknown-rule");
      const rule = ruleMap.get(ruleId) ?? {};
      const message = asRecord(item.message) ?? {};
      const firstLocation = asRecord(asArray(item.locations)[0]) ?? {};
      const physicalLocation = asRecord(firstLocation.physicalLocation) ?? {};
      const artifactLocation =
        asRecord(physicalLocation.artifactLocation) ?? {};
      const region = asRecord(physicalLocation.region) ?? {};
      const startLine = asPositiveInt(region.startLine);

      return [
        buildFinding({
          tool: "opengrep",
          toolVersion: asText(driver.version, undefined),
          ruleId,
          ruleName: asText(rule.name, undefined),
          severity: normalizeSeverity(item.level),
          confidence: normalizeConfidence(asRecord(rule.properties)?.precision),
          message: asText(message.text, ruleId),
          path: asText(artifactLocation.uri),
          startLine,
          endLine: asPositiveInt(region.endLine, startLine),
          helpUri: asText(rule.helpUri, undefined),
          raw: item,
        }),
      ];
    });
  });
}
