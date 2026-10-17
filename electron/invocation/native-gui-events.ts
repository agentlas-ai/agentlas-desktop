import type { McpInvocationEvent } from "../../shared/types";
import { reassembleAgentLivePartial } from "../../shared/interrupted-partial";

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
  // Main-side readers get a daemon-hosted teammate's partial whole, as they always read it (createNativeTeammatePartialRelay).
  const event = teammatePartials.relay(envelope.runId, envelope.event);
  const delivered = event === envelope.event ? envelope : { ...envelope, event };
  for (const listener of eventListeners) {
    try { listener(delivered); } catch (error) { console.warn("[native-invocation] event listener failed", error); }
  }
}

export function publishNativeGuiActiveChats(chatIds: readonly string[]): void {
  observedActiveChatIds = [...chatIds];
  for (const listener of activeChatListeners) {
    try { listener(observedActiveChatIds); } catch (error) { console.warn("[native-invocation] active-chat listener failed", error); }
  }
}

/** Concurrent daemon-hosted teammate streams whose text Main rebuilds; a run's own end frees its own. */
const MAX_RELAYED_TEAMMATE_STREAMS = 256;

/**
 * Rebuilds daemon-hosted teammate partials for Main-side readers (perf review 2026-10-17, R-03). The daemon sends a
 * teammate's partial as `delta` + `textLen` (the windows rebuild it in their ordered gate); the phone bridge, like
 * every phone app, reads a teammate row's `text`. Keyed by run and teammate. A run's entries go with its own final or
 * error; past the cap the least recently streamed go (that stream then shows its length until its next whole frame).
 */
export function createNativeTeammatePartialRelay(maxStreams = MAX_RELAYED_TEAMMATE_STREAMS) {
  const texts = new Map<string, string>();
  const forgetRun = (runId: string): void => {
    for (const key of texts.keys()) if (key.startsWith(`${runId}\u0000`)) texts.delete(key);
  };
  const relay = (runId: string, event: McpInvocationEvent): McpInvocationEvent => {
    if (event.kind === "partial" && event.agentId) {
      const key = `${runId}\u0000${event.agentId}`;
      const known = texts.get(key);
      // Re-insert so the Map's order is least recently streamed first.
      if (known !== undefined) { texts.delete(key); texts.set(key, known); }
      const rebuilt = reassembleAgentLivePartial(texts, key, event);
      while (texts.size > maxStreams) texts.delete(texts.keys().next().value!);
      return rebuilt;
    }
    if (!event.agentId && (event.kind === "final" || event.kind === "error")) forgetRun(runId);
    return event;
  };
  return { relay, forgetRun, get size() { return texts.size; } };
}
/** Main's one relay for daemon events (native-gui-public.ts publishes every daemon event here). */
const teammatePartials = createNativeTeammatePartialRelay();
