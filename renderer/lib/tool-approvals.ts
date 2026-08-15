"use client";

/*
 * 도구 승인 대기열 — 화면 어디서든 같은 큐를 본다.
 *
 * ★오너 결정(2026-08-15): 승인 카드는 **묻는 순간, 그 실행이 붙어 있는 대화 안에서만**
 * 뜬다. 예전에는 시트가 AppShell 전역 모달이라 대시보드든 설정이든 지금 보고 있는 화면
 * 위로 튀어나왔고, 그 실행이 어느 대화의 것인지 화면이 알 길이 없었다.
 *
 * 그래서 이 모듈은
 *  - live 요청만 담는다. post-denial(런타임이 이미 거부하고 지나간 것)은 카드가 아니라
 *    실행 본문의 알림 한 줄로만 남는다 — 이미 각 러너가 onNotice 로 남기고 있다.
 *  - 요청의 `chatId` 로 "어느 대화 것인가"를 들고 다닌다. 대화 화면은 자기 chatId 로
 *    카드를 인라인 렌더하고, 다른 화면은 배지만 본다.
 *  - 답을 한 번만 보낸다(같은 id 는 한 번 결정되면 큐에서 사라진다).
 */
import { useSyncExternalStore } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { ToolApprovalRequestEvent, ToolApprovalDecision } from "@/lib/types";

let queue: ToolApprovalRequestEvent[] = [];
const visibleChats = new Map<string, number>();
const listeners = new Set<() => void>();
let subscribed = false;
const decided = new Set<string>();

type Snapshot = { queue: ToolApprovalRequestEvent[]; visible: ReadonlySet<string> };
let current: Snapshot = { queue, visible: new Set() };

function emit(): void {
  // useSyncExternalStore 는 스냅샷 참조가 바뀌어야 다시 그린다 — 큐든 가시성이든 변할 때
  // 새 객체를 만든다.
  current = { queue, visible: new Set(visibleChats.keys()) };
  for (const fn of listeners) fn();
}

function upsert(next: ToolApprovalRequestEvent): void {
  if (next.mode !== "live") return; // 사후 고지는 카드가 아니다.
  if (decided.has(next.id) || queue.some((item) => item.id === next.id)) return;
  queue = [...queue, next];
  emit();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  const events = ipcEvents();
  const api = ipc();
  if (!events?.onToolApproval || !api) return;
  subscribed = true;
  events.onToolApproval(upsert);
  // 화면이 뜨기 전에 온 요청 — 메인이 아직 답을 기다리고 있으면 여기서 따라잡는다.
  void api.listToolApprovals?.().then((pending) => {
    for (const item of pending ?? []) upsert(item);
  }).catch(() => {});
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  ensureSubscribed();
  return () => { listeners.delete(fn); };
}

const SERVER: Snapshot = { queue: [], visible: new Set() };
function snapshot(): Snapshot {
  return current;
}

/** 대기 중인 live 승인 요청 전부(렌더 순서 = 도착 순서) + 지금 보이는 대화 집합. */
export function useToolApprovals(): Snapshot {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER);
}

/** 사용자의 답. 큐에서 지우고 메인으로 보낸다 — 두 번 보내지 않는다. */
export function decideToolApproval(id: string, decision: ToolApprovalDecision): void {
  if (decided.has(id)) return;
  decided.add(id);
  queue = queue.filter((item) => item.id !== id);
  emit();
  void ipc()?.resolveToolApproval(id, decision);
}

/*
 * "지금 화면에 보이는 대화" 등록 — 대화 화면이 마운트되면 자기 chatId 를 올려 둔다.
 * 전역 배지는 여기 없는 대화의 요청만 세고, 여기 있는 대화의 요청은 그 대화가 인라인으로
 * 그린다. 같은 대화를 두 화면이 동시에 보여도 각자 그리는 것은 무해하다(답은 한 번).
 */
export function markChatVisible(chatId: string | null | undefined): () => void {
  if (!chatId) return () => {};
  visibleChats.set(chatId, (visibleChats.get(chatId) ?? 0) + 1);
  emit();
  return () => {
    const n = (visibleChats.get(chatId) ?? 1) - 1;
    if (n <= 0) visibleChats.delete(chatId); else visibleChats.set(chatId, n);
    emit();
  };
}
/** 요청을 인라인으로 그릴 대화가 지금 화면에 없는가(→ 배지 대상). */
export function needsBadge(request: ToolApprovalRequestEvent, visible: ReadonlySet<string>): boolean {
  return !(request.chatId && visible.has(request.chatId));
}
