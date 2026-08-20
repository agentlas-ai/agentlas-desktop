"use client";

/*
 * "항상 승인"을 받은 대화 — 승인 채널 셋이 공유하는 단일 사실.
 *
 * 왜 공용이어야 하는가(2026-08-19 실측): 하나의 게시 작업이 승인을 세 번 물었다.
 *   1) One 결정 시트   — "이 글을 올릴까요?"
 *   2) 브라우저 액션   — "x.com 에서 클릭해도 될까요?"
 *   3) 런타임 도구 승인 — "이 도구 호출을 허용할까요?"
 * 그래서 허락은 채널이 아니라 **대화**에 붙는다.
 *
 * ★저장 위치 이관(오너 결정 2026-08-20): renderer localStorage 전용이던 이 사실을
 *   공유 DB의 capability_grants(capability='*', scope='chat:<id>')로 옮겼다.
 *   - main 프로세스 중재자가 직접 소비한다(런타임 도구 승인이 카드 없이 통과).
 *   - 터미널·모바일 등 다른 채널도 같은 원장을 본다.
 *   - 감사·해지가 renderer 밖에서도 가능하다.
 *   이 모듈은 동기 API 를 유지하기 위해 인메모리 미러를 들고, IPC 로 write-through 한다.
 *   기존 localStorage 값은 첫 로드에서 한 번 DB 로 옮기고 지운다.
 *
 * 경계(변함없음):
 *  · 결제와 브라우저 코드 실행은 이 허락으로 뚫리지 않는다(각 채널이 매번 확인).
 *  · `revoke` 로 언제든 되돌릴 수 있다.
 *  · 자동으로 통과한 승인도 각 채널의 기록에 그대로 남는다.
 */

import { ipc } from "@/lib/ipc";

const LEGACY_STORAGE_KEY = "agentlas.one.alwaysApprovedChats.v1";

type Listener = (chatIds: readonly string[]) => void;

let chatIds: string[] = [];
let hydrated = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(chatIds);
}

function applyServerList(ids: unknown): void {
  if (!Array.isArray(ids)) return;
  chatIds = ids.filter((id): id is string => typeof id === "string");
  emit();
}

/** 첫 소비 시 1회: 레거시 localStorage → DB 이관 후 서버 목록으로 대체. */
function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const api = ipc();
  if (!api?.listAlwaysApprovedChats) return;
  let legacy: string[] = [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) legacy = parsed.filter((id): id is string => typeof id === "string");
  } catch { /* 없거나 깨진 레거시 값 — 이관할 것이 없다 */ }
  void (async () => {
    try {
      for (const id of legacy) await api.grantChatAlwaysApproval?.(id);
      if (legacy.length > 0) window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      applyServerList(await api.listAlwaysApprovedChats());
    } catch { /* main 미준비 — 다음 grant/revoke 가 다시 동기화한다 */ }
  })();
}

export function alwaysApprovedChatIds(): readonly string[] {
  hydrate();
  return chatIds;
}

export function isChatAlwaysApproved(chatId: string | null | undefined): boolean {
  hydrate();
  return Boolean(chatId) && chatIds.includes(String(chatId));
}

export function grantAlwaysApproval(chatId: string): void {
  if (!chatId || chatIds.includes(chatId)) return;
  chatIds = [...chatIds, chatId]; // 낙관적 미러 — 카드 억제는 즉시 동작해야 한다.
  emit();
  void ipc()?.grantChatAlwaysApproval?.(chatId).then(applyServerList).catch(() => {});
}

export function revokeAlwaysApproval(chatId: string): void {
  if (!chatIds.includes(chatId)) return;
  chatIds = chatIds.filter((id) => id !== chatId);
  emit();
  void ipc()?.revokeChatAlwaysApproval?.(chatId).then(applyServerList).catch(() => {});
}

export function subscribeAlwaysApproved(listener: Listener): () => void {
  hydrate();
  listeners.add(listener);
  listener(chatIds);
  return () => { listeners.delete(listener); };
}
