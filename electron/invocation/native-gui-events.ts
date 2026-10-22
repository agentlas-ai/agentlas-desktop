import type { McpInvocationEvent, RuntimeSelection, ToolApprovalRequestEvent } from "../../shared/types";
import type { NativePublicSettlement } from "./native-public-events";
import type { RunEventReplay, RunEventReplayInput } from "../../shared/run-event-delivery";
import { reassembleAgentLivePartial } from "../../shared/interrupted-partial";
import { RunEventDeliveryJournal } from "./event-delivery";

/**








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

/** Only a currently active, contiguous daemon stream can supply the current model. */
export function nativeGuiActiveRuntimeSelection(chatId: string): RuntimeSelection | null {
  return observedActiveChatIds.includes(chatId) ? hostedElsewhere.currentRuntimeSelection(chatId) : null;
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

/**





 */
const settledListeners = new Set<(settlement: NativePublicSettlement) => void>();
const approvalListeners = new Set<(request: ToolApprovalRequestEvent) => void>();

export function onNativeGuiSettled(listener: (settlement: NativePublicSettlement) => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

export function publishNativeGuiSettled(settlement: NativePublicSettlement): void {
  hostedElsewhere.retireModel(settlement.runId);
  for (const listener of settledListeners) {
    try { listener(settlement); } catch (error) { console.warn("[native-invocation] settled listener failed", error); }
  }
}

export function onNativeGuiApprovalRequested(listener: (request: ToolApprovalRequestEvent) => void): () => void {
  approvalListeners.add(listener);
  return () => { approvalListeners.delete(listener); };
}

export function publishNativeGuiApprovalRequested(request: ToolApprovalRequestEvent): void {
  for (const listener of approvalListeners) {
    try { listener(request); } catch (error) { console.warn("[native-invocation] approval listener failed", error); }
  }
}

export function publishNativeGuiActiveChats(chatIds: readonly string[]): void {
  hostedElsewhere.retireInactiveModels(new Set(chatIds));
  observedActiveChatIds = [...chatIds];
  for (const listener of activeChatListeners) {
    try { listener(observedActiveChatIds); } catch (error) { console.warn("[native-invocation] active-chat listener failed", error); }
  }
}

/** Concurrent daemon-hosted teammate streams whose text Main rebuilds; a run's own end frees its own. */
const MAX_RELAYED_TEAMMATE_STREAMS = 256;

/**




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











 */
export function createHostedElsewhereReplay(teammateTexts: (runId: string) => Record<string, string>) {
  const journal = new RunEventDeliveryJournal();
  const runs = new Map<string, { chatId: string; ordinal: number; root: string; settled: boolean; modelRetired?: boolean; runtimeSelection?: RuntimeSelection }>();
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
    if (!event.agentId && (!event.modelRole || event.modelRole === "orchestrator") && event.runtimeSelection && event.runtimeSelection.role !== "worker") {
      run.runtimeSelection = { ...event.runtimeSelection };
    }
    if (!event.agentId && event.runtimeSelection?.role !== "worker"
      && (!event.modelRole || event.modelRole === "orchestrator")
      && (event.kind === "final" || event.kind === "error")) {
      run.modelRetired = true; run.runtimeSelection = undefined;
    }
    if (!event.agentId && (event.kind === "final" || event.kind === "error")) { run.settled = true; run.root = ""; }
  };
  const replay = (input: RunEventReplayInput): HostedElsewhereReplay | null => {
    const run = runs.get(input.runId);
    if (!run || run.chatId !== input.chatId || input.afterOrdinal > run.ordinal) return null;
    const answer = journal.replay(input);
    if (answer.status === "unavailable") { runs.delete(input.runId); return null; }
    return { replay: answer, ...(run.settled ? {} : { live: { partialText: run.root, agentPartialTexts: teammateTexts(input.runId) } }) };
  };
  const currentRuntimeSelection = (chatId: string): RuntimeSelection | null => {
    const active = [...runs.values()].filter(run => run.chatId === chatId && !run.modelRetired);
    return active.length === 1 && active[0].runtimeSelection ? { ...active[0].runtimeSelection } : null;
  };
  const retireModel = (runId: string): void => {
    const run = runs.get(runId);
    if (run) { run.modelRetired = true; run.runtimeSelection = undefined; }
  };
  const retireInactiveModels = (chatIds: ReadonlySet<string>): void => {
    for (const [runId, run] of runs) if (!chatIds.has(run.chatId)) retireModel(runId);
  };
  return { observe, replay, currentRuntimeSelection, retireModel, retireInactiveModels, get runCount() { return runs.size; } };
}
/** Main's one mirror of daemon-hosted runs, fed from publishNativeGuiInvocationEvent. */
const hostedElsewhere = createHostedElsewhereReplay((runId) => teammatePartials.textsOf(runId));
/** Replay for a run the background service hosts, or null when Main does not hold its whole stream. */
export function replayHostedElsewhere(input: RunEventReplayInput): HostedElsewhereReplay | null {
  return hostedElsewhere.replay(input);
}
