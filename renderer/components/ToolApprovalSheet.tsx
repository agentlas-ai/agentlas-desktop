"use client";

/*
 * 도구 승인 — 전역 표면은 **배지**다, 모달이 아니다.
 *
 * ★오너 결정(2026-08-15): 승인 카드는 "묻는 순간, 그 실행이 있는 대화 안에서만".
 * 예전의 이 파일은 AppShell 전역 바텀시트라 요청이 오면 대시보드든 설정이든 지금 보고
 * 있는 화면 위로 튀어나왔다 — 그래서 "왜 대시보드에서 승인 카드가 뜨냐"는 질문이 나왔다.
 *
 * 지금은:
 *  - 대화 화면(One/Work)이 자기 chatId 의 요청을 인라인 카드로 그린다(ToolApprovalInline).
 *  - 여기(전역)는 **지금 화면에 없는 대화**의 대기 요청만 작은 배지로 센다. 누르면 그
 *    대화로 간다. 대화가 없는 요청(chatId 없음)만 여기서 직접 카드를 편다 — 갈 곳이 없으니.
 *  - post-denial 은 아예 오지 않는다(큐가 live 만 담는다). 이미 거부된 호출은 러너의
 *    알림 한 줄로 실행 본문에 남는다.
 */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { ToolApprovalCard } from "@/components/ToolApprovalInline";
import { needsBadge, useToolApprovals } from "@/lib/tool-approvals";

async function openConversation(chatId: string): Promise<void> {
  const api = ipc();
  const chat = api ? await api.chats.get(chatId).catch(() => null) : null;
  if (chat?.originSurface === "one") {
    const task = api ? await api.tasks.findForChat(chatId).catch(() => null) : null;
    navigate(task ? `/one?task=${encodeURIComponent(task.id)}` : `/one?chat=${encodeURIComponent(chatId)}`);
    return;
  }
  navigate(`/workspace/task?id=${encodeURIComponent(chatId)}`);
}

export function ToolApprovalSheet() {
  const { locale } = useT();
  const ko = locale === "ko";
  const { queue, visible } = useToolApprovals();
  const [expanded, setExpanded] = useState(false);
  const elsewhere = queue.filter((request) => needsBadge(request, visible));
  if (elsewhere.length === 0) return null;
  const withChat = elsewhere.filter((request) => request.chatId);
  const orphan = elsewhere.filter((request) => !request.chatId);
  const first = withChat[0];

  return (
    <div className="tab" data-testid="tool-approval-badge" aria-live="polite">
      {first && (
        <button type="button" className="tab-pill" onClick={() => void openConversation(first.chatId as string)}>
          <span className="tab-dot" aria-hidden />
          {ko
            ? `도구 승인 대기 ${withChat.length}건 · 대화 열기`
            : `${withChat.length} tool approval${withChat.length > 1 ? "s" : ""} waiting · open conversation`}
        </button>
      )}
      {orphan.length > 0 && !expanded && (
        <button type="button" className="tab-pill" onClick={() => setExpanded(true)}>
          <span className="tab-dot" aria-hidden />
          {ko ? `도구 승인 대기 ${orphan.length}건 · 보기` : `${orphan.length} tool approval${orphan.length > 1 ? "s" : ""} waiting · view`}
        </button>
      )}
      {orphan.length > 0 && expanded && (
        <div className="tab-cards">
          {orphan.map((request) => <ToolApprovalCard key={request.id} request={request} compact chip />)}
        </div>
      )}
      <style jsx>{`
        .tab {
          position: fixed; right: 84px; bottom: 16px; z-index: 60; /* 도움말 FAB(우하단) 왼쪽 */
          display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
          max-width: min(420px, calc(100vw - 32px));
          pointer-events: none;
        }
        .tab > * { pointer-events: auto; }
        :global(body:has([aria-labelledby="work-onboarding-title"])) .tab {
          top: 100px;
          bottom: auto;
          z-index: 1401;
        }
        .tab-pill {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 8px 12px; border-radius: 999px;
          border: 1px solid var(--accent-strong);
          background: var(--paper); color: var(--ink); font-size: 13px; cursor: pointer;
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
        }
        .tab-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-strong); }
        .tab-cards {
          background: var(--paper); border-radius: 14px; padding: 4px 8px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16); max-height: 60vh; overflow: auto;
        }
        @media (max-width: 600px) {
          .tab {
            right: 16px;
            left: 16px;
            max-width: none;
            align-items: stretch;
          }
          :global(body:has([aria-labelledby="work-onboarding-title"])) .tab { top: 126px; bottom: auto; }
          :global(body:has([data-testid="tool-approval-badge"]) [aria-labelledby="work-onboarding-title"] > section > main) {
            padding-top: 88px;
          }
          .tab-pill { justify-content: center; text-align: center; }
        }
      `}</style>
    </div>
  );
}
