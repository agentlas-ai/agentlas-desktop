import type { Automation } from "./types";
import { decideGraphRunRequest } from "./graph-run-request";

export type GraphCommandDelivery =
  | { ok: true; input: Record<string, string>; dryRun: boolean }
  | { ok: false; code: string; reason: string; nextAction: string };

/** Source commands are data envelopes, not arbitrary trigger variables.
 * Decode at delivery too: a queued request may outlive its saved definition. */
export function decodeGraphCommandDelivery(
  automation: Automation, payload: Record<string, unknown>, currentRevision?: string,
): GraphCommandDelivery | null {
  if (!["one-mcp", "toolchain", "sdk", "mcp", "telegram"].includes(String(payload.source))) return null;
  if (payload.source !== "one-mcp" && payload.source !== "toolchain" && !Object.hasOwn(payload, "input")) return null;
  const refused = (code: string): GraphCommandDelivery => ({ ok: false, code,
    reason: code, nextAction: "Inspect the current graph definition and submit a new request identity." });
  if ((payload.dryRun !== undefined && typeof payload.dryRun !== "boolean") || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) return refused("graph_command_payload_invalid");
  if (payload.source === "one-mcp" && (typeof currentRevision !== "string"
    || payload.definitionRevision !== currentRevision
    || payload.ownerChatId !== automation.monitor?.originChatId)) return refused("graph_command_definition_changed");
  // A Toolchain call comes from any conversation by design: it answers to the exact
  // definition its contract was searched against, and the scheduler re-checks that the
  // contract is still callable. It never inherits the origin conversation's authority.
  if (payload.source === "toolchain" && (typeof currentRevision !== "string"
    || payload.definitionRevision !== currentRevision)) return refused("graph_command_definition_changed");
  const decision = decideGraphRunRequest({ ref: automation.id, automations: [automation],
    input: payload.input as Record<string, unknown>, dryRun: payload.dryRun === true });
  return decision.ok ? { ok: true, input: decision.input, dryRun: payload.dryRun === true } : decision;
}
