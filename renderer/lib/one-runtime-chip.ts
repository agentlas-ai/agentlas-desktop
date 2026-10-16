// The One composer's model chip, bound to one conversation's durable pin (chats.runtime_selection_json).
//
// Owner rule: the chip governs the conversation's orchestrator. Main runs every turn of that conversation on the same pin
// when the turn names no runtime: the owner's message from the personal window, a host-started review, a phone message
// (electron/runtime/room-chip-runtime.ts). Host selection only: nothing here reaches a model.
import { readAppUiPreference } from "./app-ui-preferences";
import { runtimeMatchesSelection } from "@shared/runtime-selection";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import type { RuntimeSelection, RuntimeStatus } from "@shared/types";

export function oneEffortLabel(id: string): string {
  const known: Record<string, string> = {
    none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
    high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra",
  };
  return known[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Same per-model effort contract as the One composer (OneShell withOneRuntimeSelection). */
export function withOneRuntimeSelection(
  runtime: RuntimeStatus,
  model: string | null,
  requestedEffort: string | null | undefined,
): RuntimeStatus {
  const profile = model ? runtime.allocationModelProfiles?.[model] : undefined;
  const supported = profile?.efforts;
  const effort = supported === undefined
    ? requestedEffort ?? runtime.effort ?? null
    : requestedEffort && supported.includes(requestedEffort)
      ? requestedEffort
      : profile?.defaultEffort ?? supported[0] ?? null;
  return {
    ...runtime,
    model,
    effort,
    efforts: supported === undefined
      ? runtime.efforts
      : supported.map((id) => ({ id, label: oneEffortLabel(id) })),
  };
}

/** What the chip shows: the conversation's pin, or the default orchestrator runtime when it has none (as in a room). */
export function chipRuntimeFor(runtimes: readonly RuntimeStatus[], pin: RuntimeSelection | null): RuntimeStatus | null {
  const matched = pin
    ? runtimes.find((runtime) => runtimeMatchesSelection(runtime, pin))
    : runtimes.find((runtime) => runtime.active);
  if (!matched) return null;
  return withOneRuntimeSelection(
    { ...matched, active: true, longContextEnabled: pin?.longContext ?? matched.longContextEnabled },
    pin?.model ?? matched.model ?? null,
    pin?.effort ?? (pin?.model ? undefined : matched.effort),
  );
}

/** Conversation id whose chip already took over the renderer-global One pin. */
export const PERSONAL_RUNTIME_PIN_MIGRATION_KEY = "agentlas.one.personal.runtime-pin-migrated.v1";

type ChatPinApi = {
  setRuntimeSelection(id: string, selection: RuntimeSelection | null): Promise<{ id: string; runtimeSelection?: RuntimeSelection | null } | null>;
};

/**
 * Once per conversation. The personal window used to send the renderer-global One pin
 * (`agentlas.one.runtime-selection.v1`, written by any One chat's picker) with every message, so Hope ran that value
 * whatever its conversation's chip said. That value becomes the conversation's chip, so the owner's current choice
 * survives. A conversation that already has its own pin keeps it: that pin is what the chip shows.
 * Returns the pin Main acknowledged, or null when nothing was written.
 */
export async function adoptStoredOneRuntimeOnce(api: ChatPinApi, chatId: string, chatPin: RuntimeSelection | null): Promise<RuntimeSelection | null> {
  let migrated: string | null = null;
  try { migrated = window.localStorage.getItem(PERSONAL_RUNTIME_PIN_MIGRATION_KEY); } catch { /* storage unavailable */ }
  if (migrated === chatId) return null;
  const mark = () => { try { window.localStorage.setItem(PERSONAL_RUNTIME_PIN_MIGRATION_KEY, chatId); } catch { /* retried next time */ } };
  if (chatPin) { mark(); return null; }
  let stored: RuntimeSelection | null = null;
  try { stored = readAppUiPreference("oneRuntimeSelection"); } catch { stored = null; }
  if (!stored) { mark(); return null; }
  const selection: RuntimeSelection = { ...stored, role: "orchestrator", inherit: false };
  const updated = await api.setRuntimeSelection(chatId, selection);
  if (!updated || updated.id !== chatId || !runtimeSelectionReceiptMatches(selection, updated.runtimeSelection)) {
    throw new Error("runtime_pin_migration_unacknowledged");
  }
  mark();
  return updated.runtimeSelection;
}
