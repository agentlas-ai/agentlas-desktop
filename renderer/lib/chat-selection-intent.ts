import { useEffect, useSyncExternalStore } from "react";
import type { AgentlasIpc, Chat, RuntimeSelection } from "@shared/types";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import { ipcErrorCode } from "@shared/ipc-error-code";

// A picker may await Goal context before sending its selection to Main. If a
// newer choice for the same chat is made meanwhile, the old read must not
// initiate a later write. Overlapping Goal receipts also retain their durable
// order in this renderer. Main and other windows own write ordering and updates.
type SelectionState = {
  current: symbol | null;
  outstanding: number;
  goalReceipts: Map<string, { outstanding: number; newest: number | null }>;
};

const pendingSelections = new Map<string, SelectionState>();

export function beginChatSelection(chatId: string, selection?: RuntimeSelection): {
  isCurrent(): boolean;
  /** "confirmed": the saved selection is this choice. "overtaken": a newer choice (the phone, another window, a quicker
   * click) was saved after Main acknowledged this one - the saved selection is simply the latest, this choice is dropped
   * and the chip shows it, with nothing said. "stale": this view moved on. */
  confirm(api: AgentlasIpc): Promise<"confirmed" | "overtaken" | "stale">;
  /** Drop this choice if it is still the shown one, so the chip shows the saved selection again (no write was made, or a newer one won). */
  yieldToSaved(): void;
  markUnknown(cause: unknown): void;
  bindGoalReceiptScope(goalId: string, goalRevision: number): void;
  acceptGoalReceipt(receipt: { goalId: string; goalRevision: number; selectionRevision: number }): boolean;
  finish(): void;
} {
  const identity = Symbol();
  const choice: ChoiceEntry | null = selection ? { snapshot: { chatId, requestId: crypto.randomUUID(), selection: { ...selection }, status: "pending" }, observationRevision: 0 } : null;
  if (choice) { choices.set(chatId, choice); emit(); }
  const state = pendingSelections.get(chatId) ?? { current: null, outstanding: 0, goalReceipts: new Map() };
  state.current = identity;
  state.outstanding += 1;
  pendingSelections.set(chatId, state);
  let finished = false;
  let goalScope: string | null = null;
  return {
    isCurrent: () => pendingSelections.get(chatId) === state && state.current === identity
      && (!choice || choices.get(chatId) === choice),
    confirm: async (api) => {
      if (!choice) return "confirmed";
      const current = () => choices.get(chatId) === choice && state.current === identity;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const observationRevision = choice.observationRevision;
        const observed = await readCurrentSelection(api, chatId);
        if (!current()) return "stale";
        if (choice.observationRevision !== observationRevision) continue;
        if (!observed) continue;
        if (!runtimeSelectionReceiptMatches(choice.snapshot.selection, observed.runtimeSelection)) {
          dropChoice(choice);
          return "overtaken";
        }
        updateChoice(choice, { status: "confirmed" });
        return "confirmed";
      }
      // The caller only asks after Main acknowledged this exact selection. A read that timed out twice (a busy Main)
      // is not evidence against that acknowledgement; a real change elsewhere is still caught above and by reconcile.
      updateChoice(choice, { status: "confirmed" });
      return "confirmed";
    },
    yieldToSaved: () => { if (choice) dropChoice(choice); },
    markUnknown: (cause) => {
      if (choice && choices.get(chatId) === choice && choice.snapshot.status !== "conflicted") {
        updateChoice(choice, { status: "unknown", reason: ipcErrorCode(cause) || undefined });
      }
    },
    bindGoalReceiptScope: (goalId, goalRevision) => {
      if (finished || goalScope || !goalId || !Number.isSafeInteger(goalRevision) || goalRevision < 1) return;
      goalScope = JSON.stringify([goalId, goalRevision]);
      const scope = state.goalReceipts.get(goalScope) ?? { outstanding: 0, newest: null };
      scope.outstanding += 1;
      state.goalReceipts.set(goalScope, scope);
    },
    acceptGoalReceipt: (receipt) => {
      // Only a comparable, durable Goal revision proves that another response
      // represents a later commit. Legacy or malformed receipts give no order.
      if (!receipt.goalId || !Number.isSafeInteger(receipt.goalRevision) || receipt.goalRevision < 1
        || !Number.isSafeInteger(receipt.selectionRevision) || receipt.selectionRevision < 1) return true;
      const key = JSON.stringify([receipt.goalId, receipt.goalRevision]);
      const scope = key === goalScope ? state.goalReceipts.get(key) : undefined;
      if (!scope) return true;
      if (scope.newest !== null && receipt.selectionRevision < scope.newest) return false;
      scope.newest = receipt.selectionRevision;
      return true;
    },
    finish: () => {
      if (finished) return;
      finished = true;
      if (goalScope) {
        const scope = state.goalReceipts.get(goalScope);
        if (scope && --scope.outstanding === 0) state.goalReceipts.delete(goalScope);
      }
      state.outstanding -= 1;
      if (state.current === identity) state.current = null;
      if (state.outstanding === 0 && pendingSelections.get(chatId) === state) pendingSelections.delete(chatId);
    },
  };
}

export type ChatSelectionSnapshot = {
  chatId: string;
  requestId: string;
  selection: RuntimeSelection;
  /** "conflicted" is no longer produced: a choice overtaken by a newer one is dropped (dropChoice) and the chip shows the saved selection. */
  status: "pending" | "confirmed" | "unknown" | "conflicted";
  reason?: string;
};
type ChoiceEntry = { snapshot: ChatSelectionSnapshot; observationRevision: number };
// Renderer view ownership only. Durable write order still belongs to Main.
const choices = new Map<string, ChoiceEntry>();
const listeners = new Set<() => void>();
const viewCounts = new Map<string, number>();
const emit = () => { for (const listener of listeners) listener(); };
export function subscribeChatSelectionIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function readChatSelectionIntent(chatId: string | null): ChatSelectionSnapshot | null {
  return chatId ? choices.get(chatId)?.snapshot ?? null : null;
}
export function useChatSelectionIntent(chatId: string | null): ChatSelectionSnapshot | null {
  useEffect(() => {
    if (!chatId) return;
    viewCounts.set(chatId, (viewCounts.get(chatId) ?? 0) + 1);
    return () => {
      const remaining = (viewCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) viewCounts.set(chatId, remaining);
      else { viewCounts.delete(chatId); invalidateChatSelectionIntent(chatId); }
    };
  }, [chatId]);
  return useSyncExternalStore(subscribeChatSelectionIntent, () => readChatSelectionIntent(chatId), () => null);
}
/** Restoring a draft/closing its last view revokes projection, not a host write. */
export function invalidateChatSelectionIntent(chatId: string): void {
  choices.delete(chatId);
  emit();
}
/** Forget this shown choice (only if it is still the current one); the view falls back to the saved selection. */
function dropChoice(entry: ChoiceEntry): void {
  if (choices.get(entry.snapshot.chatId) !== entry) return;
  choices.delete(entry.snapshot.chatId);
  emit();
}
function updateChoice(entry: ChoiceEntry, patch: Partial<ChatSelectionSnapshot>): void {
  const next = { ...entry.snapshot, ...patch };
  if (JSON.stringify(next) === JSON.stringify(entry.snapshot)) return;
  entry.snapshot = next;
  if (choices.get(entry.snapshot.chatId) === entry) emit();
}
async function readCurrentSelection(api: AgentlasIpc, chatId: string): Promise<Chat | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([api.chats.get(chatId), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 750); })]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}
/** One read after a store event; no polling or automatic preference rewrite. Resolves true when a shown choice was
 * dropped because the saved selection is a newer choice (the caller re-reads the saved selection into its view). */
export async function reconcileChatSelectionIntent(api: AgentlasIpc, chatId: string): Promise<boolean> {
  const entry = choices.get(chatId);
  if (!entry) return false;
  const observationRevision = ++entry.observationRevision;
  if (entry.snapshot.status !== "confirmed" && entry.snapshot.status !== "unknown") return false;
  const chat = await readCurrentSelection(api, chatId);
  if (entry.observationRevision !== observationRevision || !chat) return false;
  const same = runtimeSelectionReceiptMatches(entry.snapshot.selection, chat.runtimeSelection);
  // An unanswered write settles by itself the moment the saved selection shows it landed.
  if (entry.snapshot.status === "unknown") { if (same) updateChoice(entry, { status: "confirmed", reason: undefined }); return false; }
  // The saved selection is now someone else's newer choice: show it, say nothing.
  if (same || choices.get(chatId) !== entry) return false;
  dropChoice(entry);
  return true;
}
