// The One composer's model chip, bound to one conversation's durable pin (chats.runtime_selection_json).
//
// Owner rule: the chip governs the conversation's orchestrator. Main runs every turn of that conversation on the same pin
// when the turn names no runtime: the owner's message from the personal window, a host-started review, a phone message
// (electron/runtime/room-chip-runtime.ts). Host selection only: nothing here reaches a model.
import { readAppUiPreference } from "./app-ui-preferences";
import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "./ipc";
import { createTrailingDebounce } from "./store-change-policy";
import { runtimeMatchesSelection } from "@shared/runtime-selection";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import type { ChatContinuitySnapshot, RuntimeSelection, RuntimeStatus } from "@shared/types";

/** A model observation is display-only: it cannot reconstruct an exact runtime pin. */
export function runningComposerModel(snapshot: ChatContinuitySnapshot | null, chatId: string): string | null {
  return snapshot?.chatId === chatId && snapshot.hostActiveChat && snapshot.invocation?.state === "active"
    ? snapshot.invocation.model?.model?.trim() || null : null;
}

export function composerModelLabel(requested: string, running: string | null, locale: "ko" | "en"): string {
  return running ? locale === "ko" ? `현재 실행 ${running} · 다음 요청 ${requested}` : `Running ${running} · Next request ${requested}` : requested;
}

/** Bounded Main observations; stale responses never paint another session or claim a model is still running. */
export function useRunningComposerModel(chatId: string | null): string | null {
  const [observation, setObservation] = useState<{ chatId: string; model: string | null } | null>(null);
  useEffect(() => {
    const api = ipc();
    if (!chatId || !api?.chats?.getContinuitySnapshot) { setObservation(null); return; }
    let disposed = false, reading = false, pending = false, generation = 0;
    const refresh = async () => {
      const request = ++generation;
      if (reading) { pending = true; return; }
      reading = true;
      try {
        const snapshot = await api.chats.getContinuitySnapshot(chatId);
        if (!disposed && request === generation) setObservation({ chatId, model: runningComposerModel(snapshot, chatId) });
      } catch { if (!disposed && request === generation) setObservation(null); }
      finally { reading = false; if (!disposed && pending) { pending = false; void refresh(); } }
    };
    const update = createTrailingDebounce({ waitMs: 100, maxWaitMs: 500, run: () => { void refresh(); } });
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "runtime" || change.entity === "run-event" || change.entity === "long-run"
        || change.entity === "chat" && change.id === chatId) { generation += 1; setObservation(null); update.call(); }
    });
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(visible, 10_000);
    void refresh();
    return () => { disposed = true; off?.(); update.cancel(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [chatId]);
  return observation?.chatId === chatId ? observation.model : null;
}

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
  // A detected engine can remember another role's last model. The exact role
  // selection, rather than inventory order or that remembered model, owns a new composer.
  const selection = pin ?? matched.roleSelections?.orchestrator;
  return withOneRuntimeSelection(
    { ...matched, active: true, longContextEnabled: selection?.longContext ?? matched.longContextEnabled },
    selection ? selection.model ?? null : matched.model ?? null,
    selection?.effort ?? (selection?.model ? undefined : matched.effort),
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
