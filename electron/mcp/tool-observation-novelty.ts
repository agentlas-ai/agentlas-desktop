import { createHash } from "node:crypto";
import { normalizeProgressText } from "../../shared/progress-key";
import type { McpInvocationEvent } from "../../shared/types";

/**
 * Observations this invocation already made. A continuous Goal pass whose completed tool calls only reproduced them
 * (same tool, same arguments, same result up to numbers: shared/progress-key) found nothing new, even though it
 * completed tool calls. Production 2026-10-17 19:45Z, Yotube room: one turn ran 15 passes in 7 minutes; the last 8
 * re-ran the same 68-character command against a publication scheduled for the next day and got
 * "<date> public now: 0 of 15" each time. Every pass posted a status message, and its completed tool call made it
 * count as work.
 */
/*
 * A capability the host says is not there is not a new observation (Finance validation 2026-10-28: the Goal asked for a chart
 * the app has no tool for, and one turn drove 8 more passes — searching the catalog again, asking an app map that was not
 * ready, describing operations — each pass counted as work because it completed tool calls). The marker is the host's own
 * typed harness answer, never the model's words:
 *  - harness_call / harness_describe answering status "unavailable" (the operation exists, nothing can run it here) or
 *    "refused" with a reason from the closed list below (nothing by that name, or not built);
 *  - harness_search answering no items (`items: []`, or a canonical search with noMatch).
 * Once this invocation has met such a gap, catalog discovery alone (harness_search / harness_describe) is not progress either:
 * looking for the missing tool again under another word finds nothing new to do. Real work after the gap (an operation that
 * answered ok, any other tool) still counts, so a Goal that turns to what it can do keeps going.
 */
const CAPABILITY_GAP_REASONS: ReadonlySet<string> = new Set([
  "operation_unknown", "id_unknown", "feature_unknown", "port_missing", "port_not_wired", "not_built", "app_unknown", "route_not_ready",
]);

function harnessLeaf(name: string): "harness_search" | "harness_describe" | "harness_call" | null {
  const leaf = /(?:^|[._]|__)(harness_(?:search|describe|call))$/.exec(name.trim())?.[1];
  return leaf === "harness_search" || leaf === "harness_describe" || leaf === "harness_call" ? leaf : null;
}

function resultObject(result: unknown): Record<string, unknown> | null {
  let value = result;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") || text.length > 262_144) return null;
    try { value = JSON.parse(text); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // An MCP result envelope ({content:[{type:"text",text:"{…}"}]}) carries the host's answer as its one text part.
  if (Array.isArray(record.content) && record.content.length === 1) {
    const part = record.content[0] as { type?: unknown; text?: unknown } | null;
    if (part && part.type === "text" && typeof part.text === "string") return resultObject(part.text);
  }
  return record;
}

/** The host's typed "this capability is not here" answer, or null. Exported for gates. */
export function harnessCapabilityGap(tool: Pick<NonNullable<McpInvocationEvent["tool"]>, "name" | "result">): string | null {
  const leaf = harnessLeaf(tool.name);
  if (!leaf || tool.result === undefined) return null;
  const value = resultObject(tool.result);
  if (!value) return null;
  if (leaf === "harness_search") {
    if (value.noMatch === true) return "harness_no_match";
    return Array.isArray(value.items) && value.items.length === 0 && value.refused === undefined ? "harness_no_match" : null;
  }
  if (value.status === "unavailable") return typeof value.reason === "string" && value.reason ? `unavailable:${value.reason.slice(0, 60)}` : "unavailable";
  if (value.status === "refused" && typeof value.reason === "string" && CAPABILITY_GAP_REASONS.has(value.reason)) return `refused:${value.reason}`;
  return null;
}

export function createToolObservationNovelty(): { note: (tool: NonNullable<McpInvocationEvent["tool"]>) => boolean } {
  const argsById = new Map<string, string>();
  const completedIds = new Set<string>();
  const seen = new Set<string>();
  let capabilityGapSeen = false;
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
  };
  return {
    note(tool): boolean {
      const id = tool.id?.trim();
      if (tool.result === undefined && !tool.observationDigest) {
        if (id && tool.args !== undefined) {
          if (argsById.size >= 4096 && !argsById.has(id)) argsById.delete(argsById.keys().next().value!);
          argsById.set(id, text(tool.args));
        }
        return false;
      }
      // A completion the runtime reports twice is one observation.
      if (id && completedIds.has(id)) return false;
      if (harnessCapabilityGap(tool)) {
        capabilityGapSeen = true;
        if (id) { argsById.delete(id); completedIds.add(id); }
        return false;
      }
      const leaf = harnessLeaf(tool.name);
      if (capabilityGapSeen && (leaf === "harness_search" || leaf === "harness_describe")) {
        if (id) { argsById.delete(id); completedIds.add(id); }
        return false;
      }
      if (id) {
        if (completedIds.size >= 4096) completedIds.delete(completedIds.values().next().value!);
        completedIds.add(id);
      }
      // Arguments stay exact: an edit that changes only a number is new work.
      const args = tool.args !== undefined ? text(tool.args) : (id ? argsById.get(id) ?? "" : "");
      if (id) argsById.delete(id);
      const key = createHash("sha256").update([tool.name.trim().toLowerCase(), args,
        normalizeProgressText(text(tool.result)), tool.isError === true ? "error" : "", tool.observationDigest ?? ""].join("\0")).digest("hex");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}
