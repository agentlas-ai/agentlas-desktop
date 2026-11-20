"use client";

/*
 * "오너가 봐야 할 것" 전역 저장소 — 좌측 위 제품 전환기(ProductModeMenu)의 파란 점.
 *
 * ★오너 2026-09-29: "앱 켜져있으면 one 외 메뉴에 있을떄 시트 띄우지말고 좌측 메뉴 work one
 *   등 고르는 부분에 파란동그라미 등으로 피드백 주던지". 그리고 "다른 메뉴 가도 워크나 원
 *   정상적으로 알아서 돌아가고 있어야 한다".
 *
 * 그래서
 *  - 승인·질문을 기다리는 대화가 **화면에 없으면** 어디에도 시트·카드·칩을 띄우지 않는다.
 *    이 저장소가 세고, 전환기가 점 하나로만 알린다. 누르면 그 대화로 가고, 카드는 그 대화의
 *    작성창 위에서 지금처럼 편다.
 *    ★예외(오너 2026-10-27): 개인 에이전트 대화는 자기가 감독하는 방의 도구·브라우저 승인 카드를 그 방 chatId 로
 *    함께 편다(components/one/PersonalOneSupervisedApprovals). 그동안 그 방은 "보이는 대화"로 등록돼 점에서 빠진다.
 *  - 이 저장소는 **문서 수명**이다. 어느 라우트 트리(AppShell / One / Science)가 마운트돼
 *    있든 같은 구독이 계속 돈다. 예전에는 승인 대기 폴링(독 배지·알림 포함)이 AppShell 에만
 *    있어서 One 으로 넘어가면 멈췄고, 언마운트 정리에서 독 배지를 0 으로 지웠다.
 *
 * 무엇을 세나(모두 메인이 기다리는 것 — 화면이 지어내지 않는다):
 *  - 도구 승인(lib/tool-approvals 큐), 러너 질문(lib/ask-user-queue), 되돌릴 수 없는 브라우저
 *    행동 승인(browser:listPendingApprovals + 이벤트), 대화 질문(confirm:listPending)
 *  - 읽지 않은 결과: 화면에 없는 사이 끝난 실행(메인의 active-chats 방송에서 빠진 대화 —
 *    그 대화를 열면 지운다), One 팀원(oneOrg unreadCount), 빌드 화면 밖에서 끝난 빌드
 * 만료·시간 계약은 건드리지 않는다. 각 요청의 expiresAt 은 메인이 정한 그대로다.
 */
import { useMemo, useSyncExternalStore } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { pendingConfirmationHref } from "@/lib/open-pending-confirmation";
import { navigate } from "@/lib/navigation";
import { askUserQueueSnapshot, subscribeAskUserQueue } from "@/lib/ask-user-queue";
import { subscribeToolApprovals, toolApprovalIsWaiting, toolApprovalsSnapshot } from "@/lib/tool-approvals";
import type { BrowserApprovalRequestEvent, PendingConfirmation } from "@/lib/types";
import type { OneOrgMember } from "@shared/one-org";
import { isPendingConfirmationSnoozed } from "@shared/one-decision";
import { createCoalescedRefresh } from "@/lib/one-refresh-coordinator";
import { isPersonalAgentRoom, PERSONAL_AGENT_HREF } from "@/lib/personal-agent-room";

export type AttentionSurface = "one" | "work" | "science";
export type AttentionKind = "approval" | "result";

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  /** 요청이 속한 대화. null 이면 갈 대화가 없는 요청(오너가 점 목록에서 직접 연다). */
  chatId: string | null;
  /** null = 아직 모름(대화 조회 전). */
  surface: AttentionSurface | null;
  /** 대화가 아닌 목적지(빌드 화면·Science·One 조직도). */
  href: string | null;
  label: string | null;
  /**
   * The request belongs to a room the personal agent runs (owner 2026-10-27): the dot leads to the personal agent, whose
   * conversation shows that room's approval cards. chatId stays so a visible room still hides it.
   */
  personalAgent?: true;
}

/*
 * When the pending lists are read (rule: a signal, not a timer on unchanged state):
 *  - a new question is a chat message, and Main announces every chat write as store:changed {chat} (its own writes and
 *    the rows the background service inserts, electron/store/external-chat-changes.ts). That push drives the read,
 *    hidden or not, so the dock badge still rises while the app is put away.
 *  - an answer or a snooze committed from another surface (the phone, another window) and a browser approval resolved
 *    elsewhere are NOT announced by Main. Only for those a visible window keeps reading on the timers below.
 *    A hidden window runs no timer at all.
 */
const POLL_MS = 3_000;
const SLOW_POLL_MS = 15_000;
/** While hidden, a burst of chat changes is read at most this often (the old hidden rate); the first one is read at once. */
const HIDDEN_CHANGE_WINDOW_MS = 15_000;
/** The dock badge count is sent when it changes, and re-sent this often so a reloaded window stays right. */
const BADGE_HEARTBEAT_MS = 60_000;
let badgeSent: { count: number; at: number } | null = null;
/** Snoozed confirmations the last rebuild hid; a snooze that ran out since then must rebuild (it is time-based). */
let snoozedAtRebuild = 0;
let snoozeExpiryTimer: number | null = null;

let confirmations: PendingConfirmation[] = [];
let browserApprovals = new Map<string, BrowserApprovalRequestEvent>();
let orgUnread: OneOrgMember[] = [];
let buildDone: { name: string } | null = null;
let activeChats: ReadonlySet<string> | null = null;
const finishedUnseen = new Set<string>();
const chatInfo = new Map<string, { surface: "one" | "work"; title: string | null; personalAgent: boolean }>();
const chatLookups = new Set<string>();
let orphansRevealed = false;

const listeners = new Set<() => void>();
/**
 * The two lists this module already reads, shared with the screens that show the same lists (the approval inbox, the fleet strip,
 * the personal agent's supervised approvals) so they do not read them again on their own timers. Each reference changes only when
 * the list does: `null` until the first answer.
 */
const listWatchers = new Set<() => void>();
let confirmationList: PendingConfirmation[] | null = null;
let browserApprovalList: BrowserApprovalRequestEvent[] = [];
const NO_BROWSER_APPROVALS: BrowserApprovalRequestEvent[] = [];
function notifyListWatchers(): void { for (const watcher of [...listWatchers]) watcher(); }
let started = false;
let version = 0;
type AttentionCounts = { approvals: number; results: number };
let snapshot: { version: number; items: AttentionItem[]; visible: ReadonlySet<string>; orphansRevealed: boolean; byChat: ReadonlyMap<string, AttentionCounts>; pendingConfirmations: number } = {
  version: 0, items: [], visible: new Set(), orphansRevealed: false, byChat: new Map(), pendingConfirmations: 0,
};

function rebuild(): void {
  const items: AttentionItem[] = [];
  const tool = toolApprovalsSnapshot();
  for (const chatId of finishedUnseen) if (tool.visible.has(chatId)) finishedUnseen.delete(chatId);
  const info = (chatId: string | null) => (chatId ? chatInfo.get(chatId) ?? null : null);
  const pushChat = (key: string, kind: AttentionKind, chatId: string | null, fallbackSurface: AttentionSurface | null = null, href: string | null = null, label: string | null = null) => {
    const known = info(chatId);
    if (chatId && !known) lookupChat(chatId);
    if (known?.personalAgent) {
      // A personal agent's room (owner 2026-10-27): its finished run is the personal agent's to report, not a dot of its
      // own; its tool and browser approvals open in the personal agent's conversation. A question card still opens in the
      // room, where it is answered.
      if (kind === "result") return;
      if (key.startsWith("tool:") || key.startsWith("browser:")) {
        items.push({ key, kind, chatId, surface: "one", href: PERSONAL_AGENT_HREF, label: known.title ?? label, personalAgent: true });
        return;
      }
    }
    items.push({ key, kind, chatId, surface: known?.surface ?? fallbackSurface, href, label: known?.title ?? label });
  };
  // A card that expired (or was settled elsewhere) is a closed record the person only dismisses: it is not "waiting".
  for (const request of tool.queue) if (toolApprovalIsWaiting(request.id, tool.actions)) pushChat(`tool:${request.id}`, "approval", request.chatId ?? null);
  for (const question of askUserQueueSnapshot()) pushChat(`ask:${question.requestId}`, "approval", question.chatId ?? null);
  for (const request of browserApprovals.values()) {
    const owner = request.owner;
    if (owner?.context === "build") pushChat(`browser:${request.requestId}`, "approval", null, "work", "/build", request.summary);
    else if (owner?.surface === "science") pushChat(`browser:${request.requestId}`, "approval", null, "science", "/science", request.summary);
    else pushChat(`browser:${request.requestId}`, "approval", owner?.chatId ?? null, owner?.surface ?? null, null, request.summary);
  }
  snoozedAtRebuild = 0;
  let soonestSnoozeEnd = Number.POSITIVE_INFINITY;
  for (const item of confirmations) {
    if (!isPendingConfirmationSnoozed(item)) pushChat(`confirm:${item.sourceMessageId}`, "approval", item.chatId, null, null, item.chatTitle ?? null);
    else {
      snoozedAtRebuild += 1;
      const end = Date.parse(item.snoozedUntil ?? "");
      if (Number.isFinite(end)) soonestSnoozeEnd = Math.min(soonestSnoozeEnd, end);
    }
  }
  // A snooze ends at a known time: the question returns to the list (and the dock badge) then, also while the window is
  // hidden and nothing is polled.
  if (snoozeExpiryTimer !== null) window.clearTimeout(snoozeExpiryTimer);
  snoozeExpiryTimer = null;
  if (Number.isFinite(soonestSnoozeEnd)) {
    snoozeExpiryTimer = window.setTimeout(() => { snoozeExpiryTimer = null; rebuild(); },
      Math.min(Math.max(0, soonestSnoozeEnd - Date.now()) + 50, 2_147_000_000));
  }
  for (const chatId of finishedUnseen) pushChat(`done:${chatId}`, "result", chatId);
  for (const member of orgUnread) {
    items.push({ key: `org:${member.id}`, kind: "result", chatId: null, surface: "one", href: "/one", label: member.displayName });
  }
  if (buildDone) items.push({ key: "build:done", kind: "result", chatId: null, surface: "work", href: "/build", label: buildDone.name });
  if (orphansRevealed && !items.some((item) => item.kind === "approval" && !item.chatId && !item.href)) {
    orphansRevealed = false;
  }
  const sameVisible = tool.visible.size === snapshot.visible.size
    && [...tool.visible].every((chatId) => snapshot.visible.has(chatId));
  const sameItems = items.length === snapshot.items.length && items.every((item, index) => {
    const previous = snapshot.items[index];
    return item.key === previous.key && item.kind === previous.kind && item.chatId === previous.chatId
      && item.surface === previous.surface && item.href === previous.href && item.label === previous.label
      && item.personalAgent === previous.personalAgent;
  });
  // Active-chat broadcasts and approval action phases often leave every dot
  // unchanged. Preserve the snapshot so all routes and sidebar rows stay idle.
  if (sameVisible && sameItems && orphansRevealed === snapshot.orphansRevealed) return;
  const byChat = new Map<string, AttentionCounts>();
  let pendingConfirmations = 0;
  for (const item of items) {
    if (item.chatId && tool.visible.has(item.chatId)) continue;
    if (item.key.startsWith("confirm:")) pendingConfirmations += 1;
    if (!item.chatId) continue;
    const counts = byChat.get(item.chatId) ?? { approvals: 0, results: 0 };
    if (item.kind === "approval") counts.approvals += 1;
    else counts.results += 1;
    byChat.set(item.chatId, counts);
  }
  for (const [chatId, counts] of byChat) {
    const previous = snapshot.byChat.get(chatId);
    if (previous?.approvals === counts.approvals && previous.results === counts.results) byChat.set(chatId, previous);
  }
  version += 1;
  snapshot = { version, items, visible: tool.visible, orphansRevealed, byChat, pendingConfirmations };
  for (const listener of listeners) listener();
}

function lookupChat(chatId: string): void {
  if (chatLookups.has(chatId)) return;
  chatLookups.add(chatId);
  const api = ipc();
  if (!api?.chats?.get) return;
  void api.chats.get(chatId).then((chat) => {
    chatInfo.set(chatId, { surface: chat?.originSurface === "one" ? "one" : "work", title: chat?.title?.trim() || null,
      personalAgent: isPersonalAgentRoom(chat) });
    rebuild();
  }).catch(() => {
    // Unknown stays unknown; the next change retries.
    chatLookups.delete(chatId);
  });
}

/** Reads overlap (store change, visible 3 s timer, attention-refresh after an answer); only the newest read may land. */
let confirmationPollStarted = 0;
let confirmationPollApplied = 0;

/** The 3 s timer reads for answers given elsewhere (the phone); with no question open nothing can be answered, so it
 * only keeps a slow net under a missed store event. Every other trigger (store change, focus, answer) reads at once. */
/** Longer than the 30 s list Main holds (electron/confirm/index.ts PENDING_CONFIRMATIONS_TTL_MS): an idle read that fell
 * inside that hold re-read the same list and the net took 59 s. Worst case now 33 s + one 3 s tick. */
const IDLE_CONFIRMATION_POLL_MS = 33_000;
let confirmationsReadAtMs = 0;

async function pollConfirmations(): Promise<void> {
  const api = ipc();
  if (!api?.confirm?.listPending) return;
  confirmationsReadAtMs = Date.now();
  const poll = ++confirmationPollStarted;
  try {
    const list = await api.confirm.listPending();
    // A read that started before an answer resolving after the post-answer read would put the answered question back.
    if (poll < confirmationPollApplied) return;
    confirmationPollApplied = poll;
    const same = list.length === confirmations.length && list.every((item, index) => item.sourceMessageId === confirmations[index]?.sourceMessageId && item.snoozedUntil === confirmations[index]?.snoozedUntil);
    const firstAnswer = confirmationList === null;
    confirmations = list;
    if (!same || firstAnswer) { confirmationList = list; notifyListWatchers(); }
    // 독 배지·독 튕김·"승인 대기" OS 알림. 예전엔 AppShell 폴링에만 물려 One 에선 멈췄다.
    // Unchanged counts are not re-sent every 3 s; Main only acts on a change (perf review R-15).
    if (!badgeSent || badgeSent.count !== list.length || Date.now() - badgeSent.at >= BADGE_HEARTBEAT_MS) {
      await api.attention?.setPendingConfirmations(list.length);
      badgeSent = { count: list.length, at: Date.now() };
    }
    if (!same) rebuild();
  } catch {
    // Transient IPC errors keep the last known list instead of clearing the dot.
  }
}

/** A request Main already closed (answered anywhere, or expired) never comes back from a slower list read. Bounded. */
const closedBrowserRequests = new Set<string>();

function mergeBrowser(incoming: BrowserApprovalRequestEvent[], replace: boolean): void {
  const now = Date.now();
  const next = replace ? new Map<string, BrowserApprovalRequestEvent>() : new Map(browserApprovals);
  for (const item of incoming) {
    if (item.expiresAt <= now) {
      if (closedBrowserRequests.size >= 500) closedBrowserRequests.clear();
      closedBrowserRequests.add(item.requestId);
      next.delete(item.requestId);
    } else if (!closedBrowserRequests.has(item.requestId)) next.set(item.requestId, item);
  }
  for (const [id, item] of next) if (item.expiresAt <= now) next.delete(id);
  // The 15 s poll usually returns the same requests: then nothing is rebuilt and no subscriber re-renders.
  const same = next.size === browserApprovals.size && [...next].every(([id, item]) => {
    const previous = browserApprovals.get(id);
    return previous === item || (previous !== undefined && JSON.stringify(previous) === JSON.stringify(item));
  });
  browserApprovals = next;
  if (!same) { browserApprovalList = [...next.values()]; notifyListWatchers(); }
  // 메인이 정한 만료 시각에 점에서도 빠지게 — 다음 폴링까지 남아 있지 않게 한다.
  if (browserExpiryTimer !== null) window.clearTimeout(browserExpiryTimer);
  browserExpiryTimer = null;
  const soonest = Math.min(...[...next.values()].map((item) => item.expiresAt));
  if (Number.isFinite(soonest)) browserExpiryTimer = window.setTimeout(() => mergeBrowser([], false), Math.max(0, soonest - now) + 50);
  if (!same || confirmations.filter((item) => isPendingConfirmationSnoozed(item)).length !== snoozedAtRebuild) rebuild();
}
let browserExpiryTimer: number | null = null;

async function pollSlow(): Promise<void> {
  const api = ipc();
  try {
    const pending = await api?.browser?.listPendingApprovals?.();
    if (Array.isArray(pending)) mergeBrowser(pending, true);
  } catch { /* push events remain */ }
  try {
    const org = await api?.oneOrg?.get?.();
    const unread = (org?.members ?? []).filter((member) => !member.archivedAt && member.unreadCount > 0);
    const same = unread.length === orgUnread.length && unread.every((member, index) => member.id === orgUnread[index]?.id
      && member.unreadGeneration === orgUnread[index]?.unreadGeneration);
    orgUnread = unread;
    if (!same) rebuild();
  } catch { /* keep last */ }
}

// Timer, focus, visibility and answer events can arrive during the same slow
// IPC read. Keep one read and one fresh trailing batch instead of racing them.
const slowRefresh = createCoalescedRefresh<void>(pollSlow, () => undefined);
const refreshSlow = () => { void slowRefresh.request(undefined); };

function start(): void {
  if (started || typeof window === "undefined") return;
  const api = ipc();
  if (!api) return;
  started = true;
  subscribeToolApprovals(rebuild);
  subscribeAskUserQueue(rebuild);
  ipcEvents()?.onBrowserApproval?.((request) => mergeBrowser([request], false));
  // A chat or Goal change may add or close a question: read the list now, then at most once per window while changes
  // keep coming (a streaming run writes many rows). Leading and trailing, so the last change is never dropped.
  let confirmationsReadAt = Number.NEGATIVE_INFINITY;
  let confirmationsTrailing: number | null = null;
  const readConfirmationsOnChange = () => {
    if (confirmationsTrailing !== null) return;
    const windowMs = document.visibilityState === "hidden" ? HIDDEN_CHANGE_WINDOW_MS : POLL_MS;
    const wait = confirmationsReadAt + windowMs - Date.now();
    // A hidden window has no slow timer either: a teammate's unread post is a chat change too, so it is read here.
    const read = () => {
      confirmationsReadAt = Date.now();
      void pollConfirmations();
      if (document.visibilityState === "hidden") refreshSlow();
    };
    if (wait <= 0) { read(); return; }
    confirmationsTrailing = window.setTimeout(() => { confirmationsTrailing = null; read(); }, wait);
  };
  ipcEvents()?.onStoreChanged?.((change) => {
    if (change.entity === "chat" || change.entity === "long-run") readConfirmationsOnChange();
    // The org roster (members added, archived, marked read) is what the unread list is built from.
    if (change.entity === "one-org") refreshSlow();
    // A room that stopped (or started) being the personal agent's is looked up again ("내가 직접 이어가기").
    if (change.entity !== "chat" || !change.id || !chatInfo.has(change.id)) return;
    chatInfo.delete(change.id);
    chatLookups.delete(change.id);
    rebuild();
  });
  const applyActive = (chatIds: string[]) => {
    const next = new Set(chatIds);
    const visible = toolApprovalsSnapshot().visible;
    // 방금 끝난 실행 — 그 대화가 화면에 없으면 오너가 아직 결과를 못 봤다.
    if (activeChats) for (const chatId of activeChats) if (!next.has(chatId) && !visible.has(chatId)) finishedUnseen.add(chatId);
    for (const chatId of next) finishedUnseen.delete(chatId);
    activeChats = next;
    rebuild();
  };
  void api.invoke?.activeChats?.().then((ids) => { if (!activeChats) applyActive(ids); }).catch(() => {});
  ipcEvents()?.onActiveChats?.(applyActive);
  void pollConfirmations();
  refreshSlow();
  // Visible only: these timers exist for the changes Main does not announce (see POLL_MS). While hidden nothing
  // is polled; a new question still reaches the dock badge through the store-change read above, and coming back
  // to the window reads everything once.
  let fast: number | null = null;
  let slow: number | null = null;
  const armVisibleTimers = () => {
    if (fast !== null) window.clearInterval(fast);
    if (slow !== null) window.clearInterval(slow);
    fast = slow = null;
    if (document.visibilityState === "hidden") return;
    fast = window.setInterval(() => {
      // A clock that went back makes the age negative: read then, not after the clock catches up.
      const age = Date.now() - confirmationsReadAtMs;
      if (confirmations.length === 0 && age >= 0 && age < IDLE_CONFIRMATION_POLL_MS) return;
      void pollConfirmations();
    }, POLL_MS);
    slow = window.setInterval(() => refreshSlow(), SLOW_POLL_MS);
  };
  armVisibleTimers();
  document.addEventListener("visibilitychange", () => {
    armVisibleTimers();
    if (document.visibilityState !== "hidden") { void pollConfirmations(); refreshSlow(); }
  });
  window.addEventListener("agentlas:attention-refresh", () => { void pollConfirmations(); refreshSlow(); });
  window.addEventListener("focus", () => refreshSlow());
  rebuild();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => { listeners.delete(listener); };
}
function subscribeLists(watcher: () => void): () => void {
  listWatchers.add(watcher);
  start();
  return () => { listWatchers.delete(watcher); };
}

/** The questions waiting for the owner, as Main last listed them (null until the first answer). One read for every screen. */
export function usePendingConfirmationList(): readonly PendingConfirmation[] | null {
  return useSyncExternalStore(subscribeLists, () => confirmationList, () => null);
}

/** The browser approvals Main is waiting on (answered or expired ones drop out on the next read or at their expiry). */
export function usePendingBrowserApprovals(): readonly BrowserApprovalRequestEvent[] {
  return useSyncExternalStore(subscribeLists, () => browserApprovalList, () => NO_BROWSER_APPROVALS);
}
const SERVER = { version: 0, items: [] as AttentionItem[], visible: new Set<string>() as ReadonlySet<string>, orphansRevealed: false, byChat: new Map<string, AttentionCounts>(), pendingConfirmations: 0 };

/** 앱 루트에서 한 번 부른다 — 전환기가 없는 화면에서도 폴링·독 배지가 멈추지 않게. */
export function ensureAttention(): void {
  start();
}

/** 빌드 화면 밖에서 빌드가 끝났다 — 토스트 대신 점 하나. 빌드 화면을 열면 지운다. */
export function markBuildDoneUnseen(name: string): void {
  buildDone = { name };
  rebuild();
}
export function clearBuildDoneUnseen(): void {
  if (!buildDone) return;
  buildDone = null;
  rebuild();
}

/** 갈 대화가 없는 요청(chatId 없음)을 오너가 점 목록에서 직접 열었다. */
export function revealOrphanAttention(): void {
  orphansRevealed = true;
  rebuild();
}
export function useOrphanAttentionRevealed(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot.orphansRevealed, () => false);
}

export function surfaceForPath(pathname: string): AttentionSurface {
  if (pathname.startsWith("/one")) return "one";
  if (pathname.startsWith("/science")) return "science";
  return "work";
}

export interface AttentionChatEntry {
  chatId: string | null;
  href: string | null;
  surface: AttentionSurface | null;
  label: string | null;
  approvals: number;
  results: number;
  /** 갈 대화가 없는 승인(오너가 목록에서 열면 그 자리에서 카드가 뜬다). */
  orphan: boolean;
  /** A personal agent's room: opening it goes to the personal agent (href), not the room. */
  personalAgent?: true;
}
export interface AttentionView {
  /** 화면에 없는 것 전부. */
  items: AttentionItem[];
  approvals: number;
  results: number;
  bySurface: Record<AttentionSurface, { approvals: number; results: number }>;
  /** 드롭다운 목록 — 대화(또는 목적지)당 한 줄. */
  entries: AttentionChatEntry[];
  byChat: ReadonlyMap<string, { approvals: number; results: number }>;
}

/**
 * 지금 화면(pathname)에서 **보이지 않는** 것만 센다. 보이는 대화의 요청은 그 대화가 작성창
 * 위에서 직접 그린다. 조직도의 읽지 않은 결과는 One 화면에서는 조직도가 이미 점으로 보여 준다.
 */
export function useAttention(pathname: string): AttentionView {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => SERVER);
  return useMemo(() => {
    const here = surfaceForPath(pathname);
    const onBuild = pathname === "/build" || pathname.startsWith("/build/");
    const items = state.items.filter((item) => {
      if (item.chatId) return !state.visible.has(item.chatId);
      if (item.href === "/build") return !onBuild;
      if (item.href === "/science") return here !== "science";
      if (item.href === "/one") return here !== "one";
      return true;
    });
    const bySurface: AttentionView["bySurface"] = {
      one: { approvals: 0, results: 0 }, work: { approvals: 0, results: 0 }, science: { approvals: 0, results: 0 },
    };
    const byChat = new Map<string, { approvals: number; results: number }>();
    const entries = new Map<string, AttentionChatEntry>();
    let approvals = 0;
    let results = 0;
    for (const item of items) {
      const bump = (target: { approvals: number; results: number }) => {
        if (item.kind === "approval") target.approvals += 1; else target.results += 1;
      };
      if (item.kind === "approval") approvals += 1; else results += 1;
      if (item.surface) bump(bySurface[item.surface]);
      if (item.chatId) {
        const counts = byChat.get(item.chatId) ?? { approvals: 0, results: 0 };
        bump(counts);
        byChat.set(item.chatId, counts);
      }
      const entryKey = item.chatId ? `chat:${item.chatId}` : item.href ? `href:${item.href}:${item.key}` : "orphan";
      const entry = entries.get(entryKey) ?? {
        chatId: item.chatId, href: item.href, surface: item.surface, label: item.label,
        approvals: 0, results: 0, orphan: !item.chatId && !item.href,
        ...(item.personalAgent ? { personalAgent: true as const } : {}),
      };
      bump(entry);
      if (!entry.label && item.label) entry.label = item.label;
      if (!entry.surface && item.surface) entry.surface = item.surface;
      entries.set(entryKey, entry);
    }
    return { items, approvals, results, bySurface, entries: [...entries.values()], byChat };
  }, [pathname, state]);
}

/** 대화 목록 행(세션 목록·프로젝트 사이드바)에 찍을 점 — 그 대화가 기다리는 것. */
export function useChatAttention(chatId: string | null | undefined): { approvals: number; results: number } | null {
  return useSyncExternalStore(
    subscribe,
    () => chatId ? snapshot.byChat.get(chatId) ?? null : null,
    () => null,
  );
}

/** What one waiting item is, read from its key (the keys are made in rebuild() above: tool: / browser: = an approval, ask: / confirm: = a question, done: = a finished run). */
export type AttentionItemClass = "approval" | "question" | "done" | "other";
export function attentionItemClass(key: string): AttentionItemClass {
  if (key.startsWith("tool:") || key.startsWith("browser:")) return "approval";
  if (key.startsWith("ask:") || key.startsWith("confirm:")) return "question";
  if (key.startsWith("done:")) return "done";
  return "other";
}

/**
 * The count on the Dashboard menu row: every item waiting for an answer that is not on the screen the owner is looking at.
 * It is the set the old product switcher counted as `approvals` (useAttention): the same items, the same on-screen and on-Build filter.
 * No read of its own: it counts what this module already holds.
 */
export function usePendingApprovalCount(pathname: string): number {
  return useSyncExternalStore(subscribe, () => {
    const onBuild = pathname === "/build" || pathname.startsWith("/build/");
    const here = surfaceForPath(pathname);
    let count = 0;
    for (const item of snapshot.items) {
      if (item.kind !== "approval") continue;
      if (item.chatId) { if (snapshot.visible.has(item.chatId)) continue; }
      else if (item.href === "/build") { if (onBuild) continue; }
      else if (item.href === "/science") { if (here === "science") continue; }
      else if (item.href === "/one") { if (here === "one") continue; }
      count += 1;
    }
    return count;
  }, () => 0);
}

export interface ChatWaiting { approvals: number; questions: number; done: number; personalAgentHref: string | null }
const NO_WAITING: ReadonlyMap<string, ChatWaiting> = new Map();
/**
 * Per chat, what waits there: how many approvals, how many questions, whether a run finished unseen. The Dashboard's Work in progress cards
 * read this (a red dot and the kind in words). Same map while the lists are unchanged.
 */
export function useWaitingByChat(): ReadonlyMap<string, ChatWaiting> {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => SERVER);
  return useMemo(() => {
    if (state.items.length === 0) return NO_WAITING;
    const map = new Map<string, ChatWaiting>();
    for (const item of state.items) {
      if (!item.chatId || state.visible.has(item.chatId)) continue;
      const kind = attentionItemClass(item.key);
      if (kind === "other") continue;
      const row = map.get(item.chatId) ?? { approvals: 0, questions: 0, done: 0, personalAgentHref: null };
      if (kind === "approval") row.approvals += 1; else if (kind === "question") row.questions += 1; else row.done += 1;
      if (item.personalAgent && item.href) row.personalAgentHref = item.href;
      map.set(item.chatId, row);
    }
    return map;
  }, [state]);
}

const NO_CONFIRMATIONS: readonly PendingConfirmation[] = [];
const confirmationsByChat = new Map<string, readonly PendingConfirmation[]>();
/**
 * The questions one chat waits on. A chat on screen is left out of the dots (they would point at where the person already
 * is), so a pane that cannot draw the answer card itself reads them here and says so. Same array while unchanged.
 */
export function useChatConfirmations(chatId: string | null | undefined): readonly PendingConfirmation[] {
  return useSyncExternalStore(subscribe, () => {
    if (!chatId) return NO_CONFIRMATIONS;
    const mine = confirmations.filter((item) => item.chatId === chatId && !isPendingConfirmationSnoozed(item));
    if (mine.length === 0) { confirmationsByChat.delete(chatId); return NO_CONFIRMATIONS; }
    const before = confirmationsByChat.get(chatId);
    if (before && before.length === mine.length && before.every((item, index) => item.sourceMessageId === mine[index].sourceMessageId)) return before;
    if (confirmationsByChat.size > 64) confirmationsByChat.clear();
    confirmationsByChat.set(chatId, mine);
    return mine;
  }, () => NO_CONFIRMATIONS);
}

/** The shared shell only needs this count; unrelated results must not render its entire tree. */
export function usePendingConfirmationCount(): number {
  return useSyncExternalStore(subscribe, () => snapshot.pendingConfirmations, () => 0);
}

/** 점의 읽는 이름 — "승인 대기 2건", "새 결과 1건". */
export function attentionLabel(counts: { approvals: number; results: number }, locale: "ko" | "en"): string {
  const parts: string[] = [];
  if (counts.approvals > 0) parts.push(locale === "ko" ? `승인 대기 ${counts.approvals}건` : `${counts.approvals} pending approval${counts.approvals === 1 ? "" : "s"}`);
  if (counts.results > 0) parts.push(locale === "ko" ? `새 결과 ${counts.results}건` : `${counts.results} new result${counts.results === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * 점 또는 점 찍힌 항목을 눌렀다 — 그 대화(또는 목적지)로 간다. 카드는 거기서 편다.
 * `push` 는 부르는 화면의 App Router(soft navigation). One·Science 는 AppShell 밖이라
 * lib/navigation 의 등록 라우터가 없을 수 있고, 그러면 hard navigation 이 되어 정적 export
 * 에서 문서를 통째로 다시 띄운다(실측: QA 에서 대기열이 비었다).
 */
export async function openAttentionEntry(
  entry: Pick<AttentionChatEntry, "chatId" | "href" | "orphan" | "personalAgent">,
  push: (href: string) => void = navigate,
): Promise<void> {
  if (entry.personalAgent && entry.href) {
    push(entry.href);
    return;
  }
  if (entry.chatId) {
    push(await pendingConfirmationHref({ chatId: entry.chatId }));
    return;
  }
  if (entry.href) {
    push(entry.href);
    return;
  }
  // Science 화면은 네이티브 뷰가 본문을 덮는다 — 대화 밖 요청 카드는 Work 화면에서 편다.
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/science")) push("/dashboard");
  revealOrphanAttention();
}
