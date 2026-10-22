import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isOneArtifactBindingRequestV1,
  oneArtifactRailMergeKey,
  type OneEarlierOutputsPageV1,
  type OneEarlierOutputV1,
} from "@shared/one-artifacts";
import type { InvocationRunReceipt } from "@shared/types";
import { ipc } from "./ipc";
import type { OneActivityArtifact } from "./one-activity";
import { projectLatestRunArtifacts } from "./one-chat-outputs";

/**
 * The outputs earlier runs of a conversation saved, for the Outputs rail's "Earlier outputs" section.
 *
 * The rail lists the newest run's outputs and nothing else (one-activity.ts beginOneActivityState: "the Activity speaks for that
 * one run"); that list is left exactly as it is. The phone lists a conversation's whole output history, so a person who made a
 * file last week saw it on the phone and not here. Main answers the rest (oneArtifacts.listEarlier: everything sealed for the
 * chat that the newest run's own list does not hold, one entry per output name, newest save first) and the full One view and a
 * split pane draw it through this one hook, so both list the same entries.
 *
 * Nothing here is needed to draw the newest run's list: a host without the call, a failed call or an answer of another shape
 * draws no section.
 */

/** Entries one ask reads from Main (its page is 200 at most). */
export const ONE_EARLIER_OUTPUTS_PAGE = 100;
/** Entries the section draws when it opens and each press of "show more" adds. */
export const ONE_EARLIER_OUTPUTS_REVEAL = 20;

interface EarlierOutputsApi {
  oneArtifacts?: {
    listEarlier?: (input: { chatId: string; newestRunId: string; offset?: number; limit?: number }) => Promise<unknown>;
  } | null;
}

const OUTPUT_TYPES: ReadonlySet<string> = new Set(["document", "spreadsheet", "image", "video", "audio", "archive", "data", "other"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The renderer re-checks what IPC hands it: a closed shape, with the six identity fields a preview request names. */
export function isEarlierOutput(value: unknown): value is OneEarlierOutputV1 {
  if (!isRecord(value)) return false;
  const { label, type, sizeBytes, savedAt, ...identity } = value;
  return isOneArtifactBindingRequestV1(identity)
    && typeof label === "string" && label.trim().length > 0 && label.length <= 512
    && typeof type === "string" && OUTPUT_TYPES.has(type)
    && typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
    && (savedAt === undefined || typeof savedAt === "string");
}

export function isEarlierOutputsPage(value: unknown): value is OneEarlierOutputsPageV1 {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 200) return false;
  return typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= 0
    && (value.nextOffset === null || (typeof value.nextOffset === "number" && Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0))
    && typeof value.truncated === "boolean"
    && value.items.every(isEarlierOutput);
}

/**
 * One page of earlier outputs, or null when the host has no such call, it failed, or it answered another shape.
 * Never throws: the section is an addition, and the screen draws without it.
 */
export async function readEarlierOutputs(
  api: EarlierOutputsApi | null | undefined,
  chatId: string,
  newestRunId: string,
  offset = 0,
): Promise<OneEarlierOutputsPageV1 | null> {
  const listEarlier = api?.oneArtifacts?.listEarlier;
  if (typeof listEarlier !== "function") return null;
  try {
    const page = await listEarlier({ chatId, newestRunId, offset, limit: ONE_EARLIER_OUTPUTS_PAGE });
    return isEarlierOutputsPage(page) ? page : null;
  } catch {
    return null;
  }
}

/** The shape the rail already opens: an earlier entry is a file or an image with Main's exact binding. */
export function earlierOutputArtifact(output: OneEarlierOutputV1): OneActivityArtifact {
  return {
    id: `bound:${output.runId}:${output.artifactRef}`,
    kind: output.type === "image" ? "image" : "file",
    label: output.label,
    binding: {
      taskId: output.taskId,
      taskVersion: output.taskVersion,
      chatId: output.chatId,
      runId: output.runId,
      manifestId: output.manifestId,
      artifactRef: output.artifactRef,
    },
  };
}

/** The entry of the rail an artifact belongs to: kind, Task, chat and name (shared/one-artifacts.ts). */
export function railEntryKey(item: Pick<OneActivityArtifact, "kind" | "label" | "binding">): string {
  return oneArtifactRailMergeKey({
    taskId: item.binding.taskId,
    chatId: item.binding.chatId,
    type: item.kind,
    label: item.label,
  });
}

/**
 * The run a `runLedger.chatTimeline` read puts on the pane's rail: the last entry, as projectLatestRunArtifacts reads it
 * (lib/one-chat-outputs.ts). Null when the timeline holds no run.
 */
export function newestTimelineRunId(runs: unknown): string | null {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const latest = runs[runs.length - 1] as { receipt?: InvocationRunReceipt | null; events?: unknown } | null;
  const fromReceipt = latest?.receipt?.runId;
  if (typeof fromReceipt === "string" && fromReceipt) return fromReceipt;
  const firstEvent = Array.isArray(latest?.events) ? (latest?.events as Array<{ runId?: unknown }>)[0] : undefined;
  return typeof firstEvent?.runId === "string" && firstEvent.runId ? firstEvent.runId : null;
}

/**
 * The latest run's outputs, independently of the earlier-output history read.
 * A folded pane reads once; callers that show the rail poll at their existing cadence.
 * Late answers belong only to the chat/effect that requested them.
 */
export function useLatestRunOutputs(input: {
  chatId: string | null | undefined;
  poll: boolean;
  pollIntervalMs: number;
}): { artifacts: OneActivityArtifact[]; newestRunId: string | null } {
  const { chatId, poll, pollIntervalMs } = input;
  const [loaded, setLoaded] = useState<{
    chatId: string; artifacts: OneActivityArtifact[]; newestRunId: string | null;
  } | null>(null);
  // Preserve the pane's chat-switch reset, including A -> pending B -> A.
  useEffect(() => { setLoaded(null); }, [chatId]);
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    let loading = false;
    const api = ipc();
    if (!api) return;
    const load = async () => {
      if (cancelled || loading) return;
      loading = true;
      try {
        const runs = await api.runLedger.chatTimeline(chatId, { maxRuns: 1, eventsPerRun: 500 });
        if (cancelled || !Array.isArray(runs)) return;
        const artifacts = await projectLatestRunArtifacts(api, runs);
        if (!cancelled) setLoaded({ chatId, artifacts, newestRunId: newestTimelineRunId(runs) });
      } catch {
        if (!cancelled) setLoaded({ chatId, artifacts: [], newestRunId: null });
      } finally { loading = false; }
    };
    void load();
    if (!poll) return () => { cancelled = true; };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, pollIntervalMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [chatId, poll, pollIntervalMs]);
  return loaded && loaded.chatId === chatId ? loaded : { artifacts: [], newestRunId: null };
}

/** One entry of the section: the artifact the rail opens, plus what its row shows. */
export interface OneEarlierOutputItem {
  artifact: OneActivityArtifact;
  sizeBytes: number;
  /** When the ledger recorded the save (ISO time), when the row carries a readable time. */
  savedAt?: string;
}

/** What a rail draws for its "Earlier outputs" section. */
export interface OneEarlierOutputsView {
  /** The entries to draw, newest save first (as many as the person has revealed). */
  items: OneEarlierOutputItem[];
  /** Every earlier entry, not only the drawn ones. */
  count: number;
  /** The count is a floor: Main stopped at a bound. */
  truncated: boolean;
  /** More entries exist than are drawn. */
  hasMore: boolean;
  loadingMore: boolean;
  showMore: () => void;
}

interface LoadedEarlierOutputsState {
  chatId: string;
  newestRunId: string;
  items: OneEarlierOutputV1[];
  total: number;
  nextOffset: number | null;
  truncated: boolean;
}

const outputKey = (output: OneEarlierOutputV1): string => `${output.runId}\u0000${output.artifactRef}`;

/** The entries read so far from Main (`total` is every earlier entry it found, `items` the pages received). */
export type LoadedEarlierOutputs = Pick<LoadedEarlierOutputsState, "items" | "total" | "nextOffset" | "truncated">;

/**
 * What the section draws from what was read: the entries the newest run's list does not hold (a new output of the newest run
 * may be an entry Main listed before it was saved, until the read for the new list has answered), the first `revealed` of them,
 * and the count of every earlier entry. Null when nothing is left to draw.
 */
export function selectEarlierOutputs(
  loaded: LoadedEarlierOutputs,
  newestItems: readonly OneActivityArtifact[],
  revealed: number,
): Omit<OneEarlierOutputsView, "loadingMore" | "showMore"> | null {
  const onNewest = new Set(newestItems.map(railEntryKey));
  const entries = loaded.items.filter((item) => !onNewest.has(oneArtifactRailMergeKey({
    taskId: item.taskId, chatId: item.chatId, type: item.type, label: item.label,
  })));
  const dropped = loaded.items.length - entries.length;
  const count = Math.max(0, loaded.total - dropped);
  if (count === 0) return null;
  return {
    items: entries.slice(0, revealed).map((entry) => ({
      artifact: earlierOutputArtifact(entry),
      sizeBytes: entry.sizeBytes,
      ...(entry.savedAt ? { savedAt: entry.savedAt } : {}),
    })),
    count,
    truncated: loaded.truncated,
    hasMore: entries.length > revealed || loaded.nextOffset !== null,
  };
}

/** The next page appended to what was read (an entry received twice is kept once). */
export function appendEarlierOutputsPage<T extends LoadedEarlierOutputs>(now: T, page: OneEarlierOutputsPageV1): T {
  const held = new Set(now.items.map(outputKey));
  return {
    ...now,
    items: [...now.items, ...page.items.filter((item) => !held.has(outputKey(item)))],
    total: page.total,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
  };
}

/**
 * The "Earlier outputs" of the conversation `chatId`, under the newest run `newestRunId` that the rail lists as `newestItems`.
 *
 * `enabled` is whether a rail is open: nothing is read for a folded one. The read repeats only when the conversation, the
 * newest run or the newest run's list of entries changes (a new output of the newest run may be an entry the earlier list held),
 * not on a timer. Until the answer arrives, and for a host that cannot answer, the view is null.
 */
export function useEarlierOutputs(input: {
  chatId: string | null | undefined;
  newestRunId: string | null | undefined;
  newestItems: readonly OneActivityArtifact[];
  enabled: boolean;
}): OneEarlierOutputsView | null {
  const { chatId, newestRunId, newestItems, enabled } = input;
  const [loaded, setLoaded] = useState<LoadedEarlierOutputsState | null>(null);
  const [revealed, setRevealed] = useState(ONE_EARLIER_OUTPUTS_REVEAL);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadedRef = useRef<LoadedEarlierOutputsState | null>(null);
  loadedRef.current = loaded;
  const generationRef = useRef(0);
  const newestKeys = useMemo(() => newestItems.map(railEntryKey).sort().join("\n"), [newestItems]);
  const wanted = enabled && chatId && newestRunId ? `${chatId}\u0001${newestRunId}\u0001${newestKeys}` : null;

  useEffect(() => {
    const generation = ++generationRef.current;
    setLoadingMore(false);
    if (!wanted || !chatId || !newestRunId) {
      setLoaded(null);
      return undefined;
    }
    let cancelled = false;
    void readEarlierOutputs(ipc() as EarlierOutputsApi | null, chatId, newestRunId, 0).then((page) => {
      if (cancelled || generation !== generationRef.current) return;
      setLoaded(page && page.total > 0
        ? { chatId, newestRunId, items: page.items, total: page.total, nextOffset: page.nextOffset, truncated: page.truncated }
        : null);
    });
    return () => { cancelled = true; };
  }, [wanted, chatId, newestRunId]);

  // Another conversation, or a folded rail: nothing from the last one is drawn, and its reveal does not carry over.
  useEffect(() => { setRevealed(ONE_EARLIER_OUTPUTS_REVEAL); }, [chatId]);

  const showMore = useCallback(() => {
    const current = loadedRef.current;
    if (!current) return;
    const target = revealed + ONE_EARLIER_OUTPUTS_REVEAL;
    setRevealed(target);
    if (current.items.length >= target || current.nextOffset === null) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    void readEarlierOutputs(ipc() as EarlierOutputsApi | null, current.chatId, current.newestRunId, current.nextOffset).then((page) => {
      if (generation !== generationRef.current) return;
      setLoadingMore(false);
      if (!page) return;
      setLoaded((now) => (!now || now.chatId !== current.chatId || now.newestRunId !== current.newestRunId
        ? now
        : appendEarlierOutputsPage(now, page)));
    });
  }, [revealed]);

  return useMemo(() => {
    if (!loaded || !enabled || !chatId || loaded.chatId !== chatId) return null;
    const selected = selectEarlierOutputs(loaded, newestItems, revealed);
    return selected ? { ...selected, loadingMore, showMore } : null;
  }, [loaded, newestItems, revealed, loadingMore, showMore, enabled, chatId]);
}

/** Current-run and saved-history projections share a chat, but neither read awaits the other. */
export function useChatOutputs(input: {
  chatId: string | null | undefined;
  historyEnabled: boolean;
  poll: boolean;
  pollIntervalMs: number;
}) {
  const current = useLatestRunOutputs(input);
  const earlierOutputs = useEarlierOutputs({
    chatId: input.chatId,
    // A known chat can retain sealed outputs even when its current run has no
    // timeline yet. The host still validates every binding against that chat.
    newestRunId: current.newestRunId ?? "outputs-without-current-run",
    newestItems: current.artifacts,
    enabled: input.historyEnabled,
  });
  return { ...current, earlierOutputs };
}
