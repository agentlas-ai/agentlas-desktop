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
export function createToolObservationNovelty(): { note: (tool: NonNullable<McpInvocationEvent["tool"]>) => boolean } {
  const argsById = new Map<string, string>();
  const completedIds = new Set<string>();
  const seen = new Set<string>();
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
