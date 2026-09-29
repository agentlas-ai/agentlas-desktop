"use client";

/*
 * 러너가 기다리는 질문(ask_user · codex MCP 승인 elicitation)의 **앱 전역 대기열**.
 *
 * ★왜 모듈 저장소인가 (2026-09-29, 오너 "다른 메뉴 가도 워크나 원 정상적으로 알아서
 * 돌아가고 있어야 한다"):
 *   예전에는 대기열이 AskUserSheet 컴포넌트의 useState 였다. 그 시트는 AppShell(Work)과
 *   /one 페이지에 **따로** 마운트돼 있어서, Work 화면에서 도착한 질문은 One 으로 넘어가는
 *   순간(다른 라우트 트리) 새 시트가 처음부터 다시 구독해야 했다(preload 의 onAskUser 가
 *   구독할 때 confirm:listPendingAskUser 로 대기 질문을 다시 보내 주므로 복구는 됐다).
 *   그러나 시트가 없는 화면(Science)에서는 아무도 구독하지 않아 질문이 보이지 않은 채
 *   만료될 수 있었고, 전역 점(lib/attention)은 시트와 무관하게 질문을 세야 한다.
 *   그래서 대기열은 문서 수명(모듈) 에 둔다. 어느 화면이 마운트돼 있든 같은 목록이다.
 *
 * 만료는 **메인이 정한 expiresAt 그대로** 따른다(이 파일은 늘리지도 줄이지도 않는다).
 * 화면을 떠나 있어도 더 빨리 끝나지 않는다: 시트 마운트와 무관한 타이머 하나가 치운다.
 */
import { useSyncExternalStore } from "react";
import { ipcEvents } from "@/lib/ipc";
import type { AskUserRequestEvent } from "@/lib/types";
import { clearAskUserDraft } from "@/lib/ask-user-draft";

let queue: readonly AskUserRequestEvent[] = [];
const listeners = new Set<() => void>();
const expiryTimers = new Map<string, number>();
let subscribed = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function remove(requestId: string, expired = false): void {
  if (expired) {
    const ended = queue.find((item) => item.requestId === requestId);
    if (ended) clearAskUserDraft(ended);
  }
  const timer = expiryTimers.get(requestId);
  if (timer !== undefined) window.clearTimeout(timer);
  expiryTimers.delete(requestId);
  if (!queue.some((item) => item.requestId === requestId)) return;
  queue = queue.filter((item) => item.requestId !== requestId);
  emit();
}

function upsert(request: AskUserRequestEvent): void {
  // expiresAt 가 지났으면(0 포함) 메인이 이 질문을 끝낸 것이다.
  if (request.expiresAt <= Date.now()) {
    clearAskUserDraft(request);
    remove(request.requestId);
    return;
  }
  if (queue.some((item) => item.requestId === request.requestId)) return;
  queue = [...queue, request];
  const timer = window.setTimeout(() => remove(request.requestId, true), Math.max(0, request.expiresAt - Date.now()));
  expiryTimers.set(request.requestId, timer);
  emit();
}

/** 첫 구독에서 한 번만 IPC 에 붙는다. 이후 화면 전환·언마운트와 무관하게 계속 받는다. */
export function ensureAskUserQueue(): void {
  if (subscribed || typeof window === "undefined") return;
  const events = ipcEvents();
  if (!events?.onAskUser) return;
  subscribed = true;
  events.onAskUser((request) => upsert(request));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureAskUserQueue();
  return () => { listeners.delete(listener); };
}

const EMPTY: readonly AskUserRequestEvent[] = [];
/** 지금 살아 있는 질문 전부(도착 순서). */
export function useAskUserQueue(): readonly AskUserRequestEvent[] {
  return useSyncExternalStore(subscribe, () => queue, () => EMPTY);
}
export function askUserQueueSnapshot(): readonly AskUserRequestEvent[] {
  return queue;
}
export function subscribeAskUserQueue(listener: () => void): () => void {
  return subscribe(listener);
}
/** 답이 수락됐거나 메인이 "이미 끝났다"고 알린 질문을 치운다. */
export function removeAskUserRequest(requestId: string): void {
  remove(requestId);
}
