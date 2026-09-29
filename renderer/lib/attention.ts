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
import { subscribeToolApprovals, toolApprovalsSnapshot } from "@/lib/tool-approvals";
import type { BrowserApprovalRequestEvent, PendingConfirmation } from "@/lib/types";
import type { OneOrgMember } from "@shared/one-org";
import { isPendingConfirmationSnoozed } from "@shared/one-decision";

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
}

const POLL_MS = 3_000;
const POLL_HIDDEN_MS = 15_000;
const SLOW_POLL_MS = 15_000;

let confirmations: PendingConfirmation[] = [];
let browserApprovals = new Map<string, BrowserApprovalRequestEvent>();
let orgUnread: OneOrgMember[] = [];
let buildDone: { name: string } | null = null;
let activeChats: ReadonlySet<string> | null = null;
const finishedUnseen = new Set<string>();
const chatInfo = new Map<string, { surface: "one" | "work"; title: string | null }>();
const chatLookups = new Set<string>();
let orphansRevealed = false;

const listeners = new Set<() => void>();
let started = false;
let version = 0;
let snapshot: { version: number; items: AttentionItem[]; visible: ReadonlySet<string>; orphansRevealed: boolean } = {
  version: 0, items: [], visible: new Set(), orphansRevealed: false,
};

function rebuild(): void {
  const items: AttentionItem[] = [];
  const tool = toolApprovalsSnapshot();
  for (const chatId of finishedUnseen) if (tool.visible.has(chatId)) finishedUnseen.delete(chatId);
  const info = (chatId: string | null) => (chatId ? chatInfo.get(chatId) ?? null : null);
  const pushChat = (key: string, kind: AttentionKind, chatId: string | null, fallbackSurface: AttentionSurface | null = null, href: string | null = null, label: string | null = null) => {
    const known = info(chatId);
    if (chatId && !known) lookupChat(chatId);
    items.push({ key, kind, chatId, surface: known?.surface ?? fallbackSurface, href, label: known?.title ?? label });
  };
  for (const request of tool.queue) pushChat(`tool:${request.id}`, "approval", request.chatId ?? null);
  for (const question of askUserQueueSnapshot()) pushChat(`ask:${question.requestId}`, "approval", question.chatId ?? null);
  for (const request of browserApprovals.values()) {
    const owner = request.owner;
    if (owner?.context === "build") pushChat(`browser:${request.requestId}`, "approval", null, "work", "/build", request.summary);
    else if (owner?.surface === "science") pushChat(`browser:${request.requestId}`, "approval", null, "science", "/science", request.summary);
    else pushChat(`browser:${request.requestId}`, "approval", owner?.chatId ?? null, owner?.surface ?? null, null, request.summary);
  }
  for (const item of confirmations) if (!isPendingConfirmationSnoozed(item)) pushChat(`confirm:${item.sourceMessageId}`, "approval", item.chatId, null, null, item.chatTitle ?? null);
  for (const chatId of finishedUnseen) pushChat(`done:${chatId}`, "result", chatId);
  for (const member of orgUnread) {
    items.push({ key: `org:${member.id}`, kind: "result", chatId: null, surface: "one", href: "/one", label: member.displayName });
  }
  if (buildDone) items.push({ key: "build:done", kind: "result", chatId: null, surface: "work", href: "/build", label: buildDone.name });
  version += 1;
  snapshot = { version, items, visible: tool.visible, orphansRevealed };
  if (orphansRevealed && !items.some((item) => item.kind === "approval" && !item.chatId && !item.href)) {
    orphansRevealed = false;
    snapshot = { ...snapshot, orphansRevealed };
  }
  for (const listener of listeners) listener();
}

function lookupChat(chatId: string): void {
  if (chatLookups.has(chatId)) return;
  chatLookups.add(chatId);
  const api = ipc();
  if (!api?.chats?.get) return;
  void api.chats.get(chatId).then((chat) => {
    chatInfo.set(chatId, { surface: chat?.originSurface === "one" ? "one" : "work", title: chat?.title?.trim() || null });
    rebuild();
  }).catch(() => {
    // Unknown stays unknown; the next change retries.
    chatLookups.delete(chatId);
  });
}

async function pollConfirmations(): Promise<void> {
  const api = ipc();
  if (!api?.confirm?.listPending) return;
  try {
    const list = await api.confirm.listPending();
    const same = list.length === confirmations.length && list.every((item, index) => item.sourceMessageId === confirmations[index]?.sourceMessageId && item.snoozedUntil === confirmations[index]?.snoozedUntil);
    confirmations = list;
    // 독 배지·독 튕김·"승인 대기" OS 알림. 예전엔 AppShell 폴링에만 물려 One 에선 멈췄다.
    await api.attention?.setPendingConfirmations(list.length);
    if (!same) rebuild();
  } catch {
    // Transient IPC errors keep the last known list instead of clearing the dot.
  }
}

function mergeBrowser(incoming: BrowserApprovalRequestEvent[], replace: boolean): void {
  const now = Date.now();
  const next = replace ? new Map<string, BrowserApprovalRequestEvent>() : new Map(browserApprovals);
  for (const item of incoming) {
    if (item.expiresAt <= now) next.delete(item.requestId);
    else next.set(item.requestId, item);
  }
  for (const [id, item] of next) if (item.expiresAt <= now) next.delete(id);
  browserApprovals = next;
  // 메인이 정한 만료 시각에 점에서도 빠지게 — 다음 폴링까지 남아 있지 않게 한다.
  if (browserExpiryTimer !== null) window.clearTimeout(browserExpiryTimer);
  browserExpiryTimer = null;
  const soonest = Math.min(...[...next.values()].map((item) => item.expiresAt));
  if (Number.isFinite(soonest)) browserExpiryTimer = window.setTimeout(() => mergeBrowser([], false), Math.max(0, soonest - now) + 50);
  rebuild();
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

function start(): void {
  if (started || typeof window === "undefined") return;
  const api = ipc();
  if (!api) return;
  started = true;
  subscribeToolApprovals(rebuild);
  subscribeAskUserQueue(rebuild);
  ipcEvents()?.onBrowserApproval?.((request) => mergeBrowser([request], false));
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
  void pollSlow();
  let fast = window.setInterval(() => void pollConfirmations(), POLL_MS);
  window.setInterval(() => void pollSlow(), SLOW_POLL_MS);
  // 승인 대기(독 배지)는 앱을 내려놓은 사이에도 떠야 하므로 숨김 중에도 돈다 — 간격만 늘린다.
  document.addEventListener("visibilitychange", () => {
    window.clearInterval(fast);
    const hidden = document.visibilityState === "hidden";
    fast = window.setInterval(() => void pollConfirmations(), hidden ? POLL_HIDDEN_MS : POLL_MS);
    if (!hidden) { void pollConfirmations(); void pollSlow(); }
  });
  window.addEventListener("agentlas:attention-refresh", () => { void pollConfirmations(); void pollSlow(); });
  window.addEventListener("focus", () => void pollSlow());
  rebuild();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => { listeners.delete(listener); };
}
const SERVER = { version: 0, items: [] as AttentionItem[], visible: new Set<string>() as ReadonlySet<string>, orphansRevealed: false };

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
  const state = useSyncExternalStore(subscribe, () => snapshot, () => SERVER);
  return useMemo(() => {
    if (!chatId || state.visible.has(chatId)) return null;
    let approvals = 0;
    let results = 0;
    for (const item of state.items) {
      if (item.chatId !== chatId) continue;
      if (item.kind === "approval") approvals += 1; else results += 1;
    }
    return approvals + results > 0 ? { approvals, results } : null;
  }, [chatId, state]);
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
  entry: Pick<AttentionChatEntry, "chatId" | "href" | "orphan">,
  push: (href: string) => void = navigate,
): Promise<void> {
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
