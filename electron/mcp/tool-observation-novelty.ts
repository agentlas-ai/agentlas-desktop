import { createHash } from "node:crypto";
import { normalizeProgressText } from "../../shared/progress-key";
import type { McpInvocationEvent } from "../../shared/types";

/**






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
