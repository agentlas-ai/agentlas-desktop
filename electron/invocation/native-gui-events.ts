import type { McpInvocationEvent } from "../../shared/types";

/**
 * Live invocation events of runs hosted by the background service (daemon), for Main-side consumers other than the
 * Desktop windows: the phone bridge (mobile-bridge/authority.ts).
 *
 * Since 2026-10-12 (c70be288) the daemon holds the personal One domain, and its events reached Main only through
 * native-gui-public.ts, which sent them to BrowserWindows. The phone bridge listens to Main's own invocation service,
 * so personal One turns produced no live text, no end-of-run snapshot refresh and no push on the phone: it waited on
 * its 5 s poll, kept "…" up and showed "Desktop 접수됨 · 대화 확인 필요" after 30 s (owner report 2026-10-14, "3일전에는
 * 됐다"). Kept free of `electron` so the daemon-loadable bridge can import it.
 */
export type NativeGuiInvocationEvent = Readonly<{ runId: string; chatId: string; event: McpInvocationEvent }>;

const eventListeners = new Set<(envelope: NativeGuiInvocationEvent) => void>();
const activeChatListeners = new Set<(chatIds: readonly string[]) => void>();
let observedActiveChatIds: readonly string[] = [];

export function onNativeGuiInvocationEvent(listener: (envelope: NativeGuiInvocationEvent) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function onNativeGuiActiveChats(listener: (chatIds: readonly string[]) => void): () => void {
  activeChatListeners.add(listener);
  return () => { activeChatListeners.delete(listener); };
}

/** The daemon's last reported active chats (empty until it reports). */
export function nativeGuiActiveChatIds(): readonly string[] {
  return observedActiveChatIds;
}

export function publishNativeGuiInvocationEvent(envelope: NativeGuiInvocationEvent): void {
  for (const listener of eventListeners) {
    try { listener(envelope); } catch (error) { console.warn("[native-invocation] event listener failed", error); }
  }
}

export function publishNativeGuiActiveChats(chatIds: readonly string[]): void {
  observedActiveChatIds = [...chatIds];
  for (const listener of activeChatListeners) {
    try { listener(observedActiveChatIds); } catch (error) { console.warn("[native-invocation] active-chat listener failed", error); }
  }
}
