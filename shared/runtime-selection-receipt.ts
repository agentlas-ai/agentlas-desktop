import type { RuntimeSelection } from "./types";

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

/**
 * User-selected runtime pins are exact action contracts. Main may normalize
 * omitted optional fields to their defaults, but it may not acknowledge a
 * different provider, model, effort, authority role, or inheritance mode.
 */
export function runtimeSelectionReceiptMatches(
  requested: RuntimeSelection,
  acknowledged: RuntimeSelection | null | undefined,
): acknowledged is RuntimeSelection {
  if (!acknowledged) return false;
  return requested.kind.trim() === acknowledged.kind.trim()
    && optionalText(requested.backend) === optionalText(acknowledged.backend)
    && optionalText(requested.model) === optionalText(acknowledged.model)
    && optionalText(requested.effort) === optionalText(acknowledged.effort)
    && Boolean(requested.longContext) === Boolean(acknowledged.longContext)
    && (optionalText(requested.role) ?? "orchestrator") === (optionalText(acknowledged.role) ?? "orchestrator")
    && Boolean(requested.inherit) === Boolean(acknowledged.inherit);
}
