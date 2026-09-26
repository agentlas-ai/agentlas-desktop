// 승인 대기 질문 하나를 "그 질문이 있는 정확한 자리"로 여는 단일 경로.
//
// 상단 배너(AppShell AttentionNudge)와 대시보드 승인 인박스 행이 같은 규칙을 쓴다.
// 예전 배너는 항상 /dashboard#approval-inbox 로 스크롤만 했다 — 에이전트가 기다리는 곳은
// 대시보드가 아니라 그 대화다(오너 지적 2026-09-26).
//
// 경로 규칙(인박스 "답하기" 가 이미 쓰던 것을 그대로 옮겨 왔다):
//   One 에서 시작한 대화  → /one?task=<task>  (task 가 없으면 /one?chat=<chat>)
//   Work 대화(프로젝트 포함) → /workspace/task?id=<chat>
// 자동화·부서(division) 대화는 승인 목록 대상이 아니다(listRecentChats 가 kind='user' 만 본다).
"use client";
import { ipc } from "./ipc";
import { navigate } from "./navigation";
import type { PendingConfirmation } from "./types";

export async function pendingConfirmationHref(item: Pick<PendingConfirmation, "chatId">): Promise<string> {
  const api = ipc();
  const chat = api ? await api.chats.get(item.chatId).catch(() => null) : null;
  if (chat?.originSurface === "one") {
    const task = api ? await api.tasks.findForChat(item.chatId).catch(() => null) : null;
    return task
      ? `/one?task=${encodeURIComponent(task.id)}`
      : `/one?chat=${encodeURIComponent(item.chatId)}`;
  }
  return `/workspace/task?id=${encodeURIComponent(item.chatId)}`;
}

/**
 * 질문 카드가 뜨면 화면 안으로 끌어오고 첫 선택지에 초점을 준다.
 * One 은 작성창 위 DecisionInline, Work 는 ChatQuestionSheet(작성창 결정 슬롯)다.
 * 둘 다 [data-ask-card] 를 가진 AskCard 로 그려진다(도구 승인 등 다른 카드는 잡지 않는다). 카드가 끝내 안 뜨면(이미 답했거나
 * 대화가 다른 상태) 아무것도 하지 않는다 — 없는 카드를 만들지 않는다.
 */
function focusQuestionWhenReady(timeoutMs = 8_000): void {
  if (typeof window === "undefined") return;
  const started = Date.now();
  const tick = () => {
    const card = document.querySelector<HTMLElement>(
      '[data-testid="one-decision-inline"] [data-ask-card], [data-composer-decision-card] [data-ask-card]',
    );
    if (card && card.getClientRects().length > 0) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      // 첫 선택지가 먼저다 — 목록 순서대로 고르면 카드 머리의 닫기(×)에 초점이 간다(실측).
      const target = card.querySelector<HTMLElement>("[data-ask-option]:not(:disabled)")
        ?? card.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)");
      target?.focus({ preventScroll: true });
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(tick, 150);
  };
  window.setTimeout(tick, 150);
}

export async function openPendingConfirmation(item: Pick<PendingConfirmation, "chatId">): Promise<void> {
  navigate(await pendingConfirmationHref(item));
  focusQuestionWhenReady();
}
