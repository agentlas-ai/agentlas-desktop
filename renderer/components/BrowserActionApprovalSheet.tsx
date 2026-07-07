"use client";

// 경량 승인 바텀시트 — 되돌릴 수 없는 브라우저 행동(전송·게시·삭제·결제) 전에 뜬다.
// 기존 ChatQuestionSheet 대비 최소 UI: 한 줄 설명 + [한 번만] [항상 승인] [거부].
//  - 결제(payment)는 allowAlways=false → "항상 승인" 버튼을 숨겨 매번 확인.
//  - "항상 승인"은 electron이 site+action 으로 기억 → 다음부터 스킵(동적 권한).
import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { BrowserApprovalRequestEvent, BrowserApprovalDecision } from "@/lib/types";

const ACTION_LABEL: Record<string, string> = {
  send: "메시지 전송",
  publish: "게시/공개",
  delete: "삭제",
  payment: "결제",
  post: "게시",
  submit: "제출",
};

export function BrowserActionApprovalSheet() {
  const [req, setReq] = useState<BrowserApprovalRequestEvent | null>(null);

  useEffect(() => {
    const events = ipcEvents();
    if (!events) return;
    return events.onBrowserApproval((r) => setReq(r));
  }, []);

  if (!req) return null;

  const resolve = (decision: BrowserApprovalDecision) => {
    void ipc()?.browser.resolveApproval(req.requestId, decision);
    setReq(null);
  };

  const actionName = ACTION_LABEL[req.actionType] ?? req.actionType;
  const isPayment = req.actionType === "payment";

  return (
    <div className="baa-wrap" role="alertdialog" aria-live="assertive">
      <div className="baa">
        <div className="baa-top">
          <span className={`baa-tag ${isPayment ? "pay" : ""}`}>{actionName}</span>
          {req.site && <span className="baa-site">{req.site}</span>}
        </div>
        <div className="baa-summary">{req.summary}</div>
        {isPayment && <div className="baa-note">결제는 안전을 위해 매번 확인합니다.</div>}
        <div className="baa-actions">
          <button className="deny" onClick={() => resolve("deny")}>
            거부
          </button>
          <button className="once" onClick={() => resolve("once")}>
            한 번만
          </button>
          {req.allowAlways && (
            <button className="always" onClick={() => resolve("always")}>
              항상 승인
            </button>
          )}
        </div>
      </div>
      <style jsx>{`
        .baa-wrap {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          justify-content: center;
          padding: 0 16px 20px;
          z-index: 90;
          pointer-events: none;
        }
        .baa {
          pointer-events: auto;
          width: min(460px, 96vw);
          background: var(--rd-bg, #14151a);
          color: var(--rd-ink, #f3f4f8);
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.12));
          border-radius: 16px;
          padding: 16px 18px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
          animation: baa-in 0.16s ease-out;
        }
        @keyframes baa-in {
          from {
            transform: translateY(14px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .baa {
            animation: none;
          }
        }
        .baa-top {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .baa-tag {
          font-size: 11.5px;
          font-weight: 800;
          padding: 2px 9px;
          border-radius: 999px;
          background: var(--rd-accent, #7c7cff);
          color: var(--rd-accent-text, #fff);
        }
        .baa-tag.pay {
          background: var(--rd-err, #e5484d);
        }
        .baa-site {
          font-size: 12px;
          opacity: 0.6;
          font-family: ui-monospace, Menlo, monospace;
        }
        .baa-summary {
          font-size: 14px;
          line-height: 1.5;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .baa-note {
          font-size: 12px;
          opacity: 0.6;
          margin-bottom: 4px;
        }
        .baa-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 12px;
        }
        .baa-actions button {
          border-radius: 9px;
          padding: 8px 15px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.14));
          background: none;
          color: var(--rd-ink, #f3f4f8);
        }
        .baa-actions .deny {
          color: var(--rd-err, #e5484d);
          margin-right: auto;
        }
        .baa-actions .always {
          background: var(--rd-accent, #7c7cff);
          color: var(--rd-accent-text, #fff);
          border-color: transparent;
        }
      `}</style>
    </div>
  );
}
