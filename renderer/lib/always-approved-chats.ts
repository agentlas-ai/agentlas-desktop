"use client";

/*
 * "항상 승인"을 받은 대화 — 승인 채널 셋이 공유하는 단일 사실.
 *
 * 왜 공용이어야 하는가(2026-08-19 실측): 하나의 게시 작업이 승인을 세 번 물었다.
 *   1) One 결정 시트   — "이 글을 올릴까요?"
 *   2) 브라우저 액션   — "x.com 에서 클릭해도 될까요?"
 *   3) 런타임 도구 승인 — "이 도구 호출을 허용할까요?"
 * 각 채널이 자기만의 허락 상태를 들고 있어서, 사용자가 "항상 승인"을 눌러도 나머지
 * 둘이 다시 물었다. 사용자 입장에서 "항상"이라고 쓰인 버튼이 항상이 아니었다 —
 * 승인 자체가 작업을 막는 장애물이 된 것이다(오너 지적).
 *
 * 그래서 허락은 채널이 아니라 **대화**에 붙는다. 한 대화에서 한 번 "항상 승인"을
 * 누르면 그 대화의 모든 승인 채널이 조용히 통과한다.
 *
 * 경계:
 *  · 범위는 그 대화뿐이다. 전역 허락이 아니다(오너 결정 2026-08-15: 승인은 묻는 순간,
 *    그 대화 안에서만).
 *  · 결제와 브라우저 코드 실행은 이 허락으로 뚫리지 않는다. 그 둘만 여전히 매번 묻고
 *    (electron/browser/connect.ts — 일반 navigate/click/type 은 이미 자동 통과한다),
 *    "다시 묻지 않기"가 돈 쓰는 일까지 삼키면 그건 편의가 아니라 사고다.
 *  · 지워지지 않는 허락은 위험하므로 `revoke` 로 언제든 되돌릴 수 있다.
 *  · 자동으로 통과한 승인도 각 채널의 기록(committedAnswers, 도구 영수증)에 그대로
 *    남는다 — 조용히 통과하는 것과 흔적이 없는 것은 다르다.
 */

const STORAGE_KEY = "agentlas.one.alwaysApprovedChats.v1";

type Listener = (chatIds: readonly string[]) => void;

let chatIds: string[] = read();
const listeners = new Set<Listener>();

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(chatIds));
  } catch {
    /* private mode — 이번 세션 동안은 메모리 값이 계속 쓰인다 */
  }
}

function emit(): void {
  for (const listener of listeners) listener(chatIds);
}

export function alwaysApprovedChatIds(): readonly string[] {
  return chatIds;
}

export function isChatAlwaysApproved(chatId: string | null | undefined): boolean {
  return Boolean(chatId) && chatIds.includes(String(chatId));
}

export function grantAlwaysApproval(chatId: string): void {
  if (!chatId || chatIds.includes(chatId)) return;
  chatIds = [...chatIds, chatId];
  persist();
  emit();
}

export function revokeAlwaysApproval(chatId: string): void {
  if (!chatIds.includes(chatId)) return;
  chatIds = chatIds.filter((id) => id !== chatId);
  persist();
  emit();
}

export function subscribeAlwaysApproved(listener: Listener): () => void {
  listeners.add(listener);
  listener(chatIds);
  return () => { listeners.delete(listener); };
}
