import type { McpInvocationEvent } from "../../shared/types";
import type { RunEventReplay, RunEventReplayInput } from "../../shared/run-event-delivery";
import { reassembleAgentLivePartial } from "../../shared/interrupted-partial";
import { RunEventDeliveryJournal } from "./event-delivery";

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
  hostedElsewhere.observe(envelope.runId, envelope.chatId, envelope.event);
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
  const textsOf = (runId: string): Record<string, string> => {
    const prefix = `${runId}\u0000`, out: Record<string, string> = {};
    for (const [key, text] of texts) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = text;
    return out;
  };
  return { relay, forgetRun, textsOf, get size() { return texts.size; } };
}
/** Main's one relay for daemon events (native-gui-public.ts publishes every daemon event here). */
const teammatePartials = createNativeTeammatePartialRelay();

/** A replay answer for a daemon-hosted run, with the live texts a hydrating viewer needs while the run is live. */
export interface HostedElsewhereReplay {
  replay: Omit<RunEventReplay, "receipt">;
  live?: { partialText: string; agentPartialTexts: Record<string, string> };
}

/**
 * Main's replay for runs the background service hosts (perf review 2026-10-17, R-04b / H2).
 *
 * The windows replay through Main, and Main had no journal for a daemon-hosted run: every replay answered
 * "unavailable" with no cursor. A view that subscribed after the run's first event (a reload, opening the chat mid-run,
 * the dispatch race) then held every pushed event above a hole it could never fill. Measured on the real ordered gate:
 * 0 of 46 pushed events shown, and replay plus a canonical recovery (a 500-event ledger read) 67 times in one second.
 *
 * Main already receives every event of those runs, in order, on the daemon's live channel. It mirrors them into its own
 * journal with their daemon delivery ordinals, and tracks the run's own live text from the same frames. It answers
 * only for a run it holds whole: first seen at ordinal 1, no ordinal skipped, every root delta proved by its textLen.
 * Anything else is forgotten, and replay keeps its old answer ("unavailable") for that run.
 */
export function createHostedElsewhereReplay(teammateTexts: (runId: string) => Record<string, string>) {
  const journal = new RunEventDeliveryJournal();
  const runs = new Map<string, { chatId: string; ordinal: number; root: string; settled: boolean }>();
  const forget = (runId: string): void => { runs.delete(runId); journal.forget(runId); };
  const observe = (runId: string, chatId: string, event: McpInvocationEvent): void => {
    // The mirror never fails the live channel that feeds it (a throw here would close the daemon projection).
    try { observeFrame(runId, chatId, event); } catch { forget(runId); }
  };
  const observeFrame = (runId: string, chatId: string, event: McpInvocationEvent): void => {
    const delivery = event.delivery;
    if (!delivery || delivery.runId !== runId || delivery.chatId !== chatId || !Number.isSafeInteger(delivery.ordinal)) return;
    let run = runs.get(runId);
    if (!run) {
      if (delivery.ordinal !== 1) return;
      run = { chatId, ordinal: 0, root: "", settled: false };
      runs.set(runId, run);
      // Runs whose journal the cap already dropped have nothing left to answer for.
      if (runs.size > 64) for (const [id, held] of runs) if (held.settled && id !== runId) runs.delete(id);
    }
    if (run.chatId !== chatId || delivery.ordinal !== run.ordinal + 1) { forget(runId); return; }
    if (event.kind === "partial" && !event.agentId) {
      if (typeof event.text === "string") run.root = event.text;
      else if (typeof event.delta === "string") {
        const next = run.root + event.delta;
        if (typeof event.textLen === "number" && next.length !== event.textLen) { forget(runId); return; }
        run.root = next;
      }
    }
    journal.publish(runId, chatId, event, delivery.ordinal);
    run.ordinal = delivery.ordinal;
    if (!event.agentId && (event.kind === "final" || event.kind === "error")) { run.settled = true; run.root = ""; }
  };
  const replay = (input: RunEventReplayInput): HostedElsewhereReplay | null => {
    const run = runs.get(input.runId);
    if (!run || run.chatId !== input.chatId || input.afterOrdinal > run.ordinal) return null;
    const answer = journal.replay(input);
    if (answer.status === "unavailable") { runs.delete(input.runId); return null; }
    return { replay: answer, ...(run.settled ? {} : { live: { partialText: run.root, agentPartialTexts: teammateTexts(input.runId) } }) };
  };
  return { observe, replay, get runCount() { return runs.size; } };
}
/** Main's one mirror of daemon-hosted runs, fed from publishNativeGuiInvocationEvent. */
const hostedElsewhere = createHostedElsewhereReplay((runId) => teammatePartials.textsOf(runId));
/** Replay for a run the background service hosts, or null when Main does not hold its whole stream. */
export function replayHostedElsewhere(input: RunEventReplayInput): HostedElsewhereReplay | null {
  return hostedElsewhere.replay(input);
}
