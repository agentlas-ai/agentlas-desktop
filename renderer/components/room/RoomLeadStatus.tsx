"use client";

import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { ToolApprovalInline } from "../ToolApprovalInline";
import { useToolApprovals } from "@/lib/tool-approvals";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import { childOfRoom, useRoomChildren } from "@/lib/room-children";
import { homeBridge } from "@/lib/home-tree";
import styles from "../one/OneShell.module.css";

/*
 * What only a team-lead room has (Agentlas 2.0): who is working, who is lined up behind an earlier turn, who waits out a provider
 * limit, Stop for the whole room, and the cards of the members' own sessions. The room chat never runs a turn itself, so the One
 * conversation view cannot know any of this from the chat: it mounts <RoomLeadStatus> above its composer. Moved out of RoomPane
 * unchanged (RoomPane's split variant and the One view in a Space pane use the same code).
 */

/** The row above the composer of a group room in a pane: the working row and the members' approval strips. */
export function RoomLeadStatus({ roomChatId, locale, permission }: { roomChatId: string; locale: "ko" | "en"; permission: "auto" | "read" | "write" | "full" }) {
  const childIds = useRoomChildren(roomChatId, true);
  return (
    <>
      <RoomPaneWorking roomChatId={roomChatId} locale={locale} childIds={childIds} />
      <RoomPaneMemberAsks childIds={childIds} permission={permission} />
    </>
  );
}

/**
 * The cards of the members' own sessions (a member asks a question, a browser step wants approval): they are addressed to the child
 * session, which is not on screen by itself. Mounting the approval strip for each child makes its chat "visible" in this pane,
 * so the shared sheets draw its cards here instead of nowhere.
 */
export function RoomPaneMemberAsks({ childIds, permission }: { childIds: string[]; permission: "auto" | "read" | "write" | "full" }) {
  if (childIds.length === 0) return null;
  return <>{childIds.map((id) => <ToolApprovalInline key={id} permission={permission} chatId={id} compact chip />)}</>;
}

/**
 * "Working" row: the members whose turn in THIS room is running right now. It reads only live state - the app's active-chats broadcast
 * joined with each running chat's parent room - so after a restart (nothing runs) it shows nothing, never a stale "working".
 */
/**
 * Members the router holds back, from Main's live state: lined up behind their own earlier turn ("turn") or waiting out a provider
 * limit ("retry"). Read on a store change of this room (coalesced); an older window without the bridge call shows none.
 */
function useRoomWaiting(roomChatId: string): { busy: boolean; held: ReadonlyArray<{ agentId: string; kind: "turn" | "retry"; retryAt?: number }> } {
  const [waiting, setWaiting] = useState<{ busy: boolean; held: ReadonlyArray<{ agentId: string; kind: "turn" | "retry"; retryAt?: number }> }>({ busy: false, held: [] });
  useEffect(() => {
    const bridge = homeBridge();
    if (!bridge?.roomWaiting) return;
    let cancelled = false;
    let burst: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      burst = null;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void bridge.roomWaiting!(roomChatId).then((list) => {
        if (cancelled) return;
        const next = { busy: Boolean(list?.busy), held: Array.isArray(list?.held) ? list.held : [] };
        setWaiting((previous) => (previous.busy === next.busy && previous.held.length === next.held.length && previous.held.every((item, index) => item.agentId === next.held[index].agentId && item.kind === next.held[index].kind && item.retryAt === next.held[index].retryAt) ? previous : next));
      }).catch(() => undefined);
    };
    const off = subscribeStoreChanges((change) => {
      if (change.entity !== "chat" || (change.id && change.id !== roomChatId) || burst) return;
      burst = setTimeout(read, 250);
    });
    return () => { cancelled = true; off(); if (burst) clearTimeout(burst); setWaiting({ busy: false, held: [] }); };
  }, [roomChatId]);
  return waiting;
}

export function RoomPaneWorking({ roomChatId, locale, childIds: runningChildren }: { roomChatId: string; locale: "ko" | "en"; childIds: string[] }) {
  const { busy, held } = useRoomWaiting(roomChatId);
  const { queue: approvalQueue } = useToolApprovals();
  const [names, setNames] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const workers = runningChildren.map((id) => childOfRoom.get(id)).filter((entry): entry is { parent: string | null; agentId: string } => Boolean(entry));
  const key = [...workers.map((entry) => entry.agentId), ...held.map((item) => item.agentId)].join(",");
  useEffect(() => {
    if (!key) return;
    const bridge = homeBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.participants(roomChatId).then((list) => { if (!cancelled) setNames(new Map(list.map((item) => [item.agentId, item.name]))); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [key, roomChatId]);
  // Which of the running members are WAITING for a free run slot: the run's own machine-readable `queue_wait` signal, live only.
  const childIds = runningChildren;
  const childKey = childIds.join(",");
  const [waitingChildren, setWaitingChildren] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events || !childKey) { setWaitingChildren((previous) => (previous.size ? new Set() : previous)); return; }
    let cancelled = false;
    const offs: Array<() => void> = [];
    const mark = (childId: string, queued: boolean) => setWaitingChildren((previous) => {
      if (previous.has(childId) === queued) return previous;
      const next = new Set(previous); if (queued) next.add(childId); else next.delete(childId); return next;
    });
    for (const childId of childKey.split(",")) {
      void api.invoke.attach(childId, { includeEvents: true }).then((attached) => {
        if (cancelled || !attached) return;
        const last = [...(attached.events ?? [])].reverse().find((event) => event.activity?.code !== "runtime_wait");
        mark(childId, last?.activity?.code === "queue_wait");
        offs.push(events.on(api.invoke.eventChannel(attached.runId), (event) => { if (event.activity?.code !== "runtime_wait") mark(childId, event.activity?.code === "queue_wait"); }));
      }).catch(() => undefined);
    }
    return () => { cancelled = true; offs.forEach((off) => off()); };
  }, [childKey]);
  if (workers.length === 0 && held.length === 0 && !busy && approvalQueue.every((item) => !(item.chatId && childOfRoom.get(item.chatId)?.parent === roomChatId))) return null;
  const ko = locale === "ko";
  const nameOf = (entry: { agentId: string }) => names.get(entry.agentId) ?? (ko ? "팀원" : "A member");
  // A member whose card (money, delete, send) is waiting for the owner is not "working": the row says whose answer it waits for.
  const askingIds = new Set(approvalQueue.filter((item) => item.mode === "live" && item.chatId && childOfRoom.get(item.chatId)?.parent === roomChatId).map((item) => item.chatId as string));
  const askingNames = [...askingIds].map((id) => nameOf(childOfRoom.get(id)!));
  const waitingNames = childIds.filter((id) => waitingChildren.has(id) && !askingIds.has(id)).map((id) => nameOf(childOfRoom.get(id)!));
  const workingNames = childIds.filter((id) => !waitingChildren.has(id) && !askingIds.has(id)).map((id) => nameOf(childOfRoom.get(id)!));
  const queuedNames = held.filter((item) => item.kind === "turn").map((item) => nameOf(item));
  const limitNames = held.filter((item) => item.kind === "retry").map((item) => nameOf(item));
  // When the wait ends, so the owner sees the limit lifts by itself and roughly when (the router's own retry time, local clock).
  const limitTimes = held.filter((item) => item.kind === "retry" && typeof item.retryAt === "number").map((item) => item.retryAt as number);
  const limitClock = limitTimes.length ? new Date(Math.min(...limitTimes)).toLocaleTimeString(ko ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  const stop = homeBridge()?.stopRoom;
  return (
    <p role="status" className={styles.splitPaneNote} data-room-pane-working={roomChatId}>
      {!workingNames.length && !waitingNames.length && !queuedNames.length && !limitNames.length && !askingNames.length ? <span data-room-pane-working-now="true"><span className={styles.sessionRunningDot} aria-hidden="true" /> {ko ? "주고받는 중" : "Members are talking"}</span> : null}
      {workingNames.length ? <span data-room-pane-working-now="true"><span className={styles.sessionRunningDot} aria-hidden="true" /> {ko ? `${workingNames.join(", ")} 작업 중` : `${workingNames.join(", ")} working`}</span> : null}
      {askingNames.length ? <span data-room-pane-waiting-approval="true">{(workingNames.length ? " · " : "")}{ko ? `${askingNames.join(", ")}가 허락을 기다려요` : `${askingNames.join(", ")} waiting for your approval`}</span> : null}
      {(workingNames.length || askingNames.length) && waitingNames.length ? " · " : ""}
      {waitingNames.length ? <span data-room-pane-waiting-slot="true">{ko ? `${waitingNames.join(", ")} 대기 중` : `${waitingNames.join(", ")} waiting for a turn`}</span> : null}
      {queuedNames.length ? <span data-room-pane-waiting-turn="true">{(workingNames.length || waitingNames.length ? " · " : "")}{ko ? `${queuedNames.join(", ")} 앞선 차례를 기다리는 중` : `${queuedNames.join(", ")} waiting for an earlier turn`}</span> : null}
      {limitNames.length ? <span data-room-pane-waiting-limit="true">{(workingNames.length || waitingNames.length || queuedNames.length ? " · " : "")}{limitClock
        ? (ko ? `${limitNames.join(", ")}는 한도에 걸려 ${limitClock}쯤 다시 시도해요` : `${limitNames.join(", ")} hit a usage limit and try again around ${limitClock}`)
        : (ko ? `${limitNames.join(", ")} 사용 한도 때문에 잠시 뒤 다시 시도해요` : `${limitNames.join(", ")} will try again shortly (usage limit)`)}</span> : null}
      {stop ? <>{" "}<button type="button" className={styles.splitPaneRailToggle} data-room-pane-stop={roomChatId} onClick={() => { void stop(roomChatId).catch(() => undefined); }}>{ko ? "중단" : "Stop"}</button></> : null}
    </p>
  );
}
