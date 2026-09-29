"use client";

/*
 * 도구 승인 — 전역 표면은 **파란 점**이다, 모달도 칩도 아니다.
 *
 * ★오너 결정(2026-08-15): 승인 카드는 "묻는 순간, 그 실행이 있는 대화 안에서만".
 * 예전의 이 파일은 AppShell 전역 바텀시트라 요청이 오면 대시보드든 설정이든 지금 보고
 * 있는 화면 위로 튀어나왔다 — 그래서 "왜 대시보드에서 승인 카드가 뜨냐"는 질문이 나왔다.
 *
 * 지금은:
 *  - 대화 화면(One/Work)이 자기 chatId 의 요청을 인라인 카드로 그린다(ToolApprovalInline).
 *  - **지금 화면에 없는 대화**의 대기 요청은 전역 점(lib/attention)이 센다. 누르면 그
 *    대화로 간다(needsBadge 규칙 그대로 — 보이는 대화의 요청은 세지 않는다).
 *  - post-denial 은 아예 오지 않는다(큐가 live 만 담는다). 이미 거부된 호출은 러너의
 *    알림 한 줄로 실행 본문에 남는다.
 *  - 러너가 기다리는 **질문**(AskUserSheet — codex MCP 승인 elicitation 포함)도 같은
 *    규칙이다(2026-09-29).
 *
 * ★오너 2026-09-29 "시트 띄우지말고 좌측 메뉴 work one 등 고르는 부분에 파란동그라미 등으로
 *  피드백": 우하단 "도구 승인 대기 N건 · 대화 열기" 칩도 없앴다. 화면에 없는 대화의 요청은
 *  이제 좌측 위 제품 전환기의 파란 점(lib/attention · ProductModeMenu)만 알린다. 칩을 남길
 *  화면이 있는지 쟀다 — 전환기는 Work(SideNav·ProjectSidebar, 접힘 포함)·One·Science 모든
 *  화면에 있다(scripts/qa-attention-dot.cjs). 그래서 칩을 둘 화면이 없다.
 *
 *  여기 남은 것은 **갈 대화가 없는 요청**(chatId 없음)뿐이고, 그것도 오너가 점 목록의
 *  "대화 밖 요청"을 눌렀을 때만(revealOrphanAttention) 편다.
 */
import { useT } from "@/lib/i18n";
import { ToolApprovalCard } from "@/components/ToolApprovalInline";
import { useToolApprovals } from "@/lib/tool-approvals";
import { useOrphanAttentionRevealed } from "@/lib/attention";

/** 갈 대화가 없는 도구 승인 — 오너가 전환기 점 목록에서 열었을 때만 카드로 편다. */
export function ToolApprovalSheet() {
  const { locale } = useT();
  const ko = locale === "ko";
  const { queue } = useToolApprovals();
  const revealed = useOrphanAttentionRevealed();
  const orphan = queue.filter((request) => !request.chatId);
  if (!revealed || orphan.length === 0) return null;

  return (
    <div className="tab" data-testid="tool-approval-orphans" role="region" aria-label={ko ? "대화 밖 도구 승인" : "Tool approvals outside a chat"}>
      <div className="tab-cards">
        {orphan.map((request) => <ToolApprovalCard key={request.id} request={request} compact chip />)}
      </div>
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
        }
      `}</style>
    </div>
  );
}
