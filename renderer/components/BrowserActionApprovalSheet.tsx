"use client";

// 경량 승인 바텀시트 — 되돌릴 수 없는 브라우저 행동(전송·게시·삭제·결제) 전에 뜬다.
// 기존 ChatQuestionSheet 대비 최소 UI: 한 줄 설명 + [한 번만] [항상 승인] [거부].
//  - 결제(payment)는 allowAlways=false → "항상 승인" 버튼을 숨겨 매번 확인.
//  - "항상 승인"은 electron이 site+action 으로 기억 → 다음부터 스킵(동적 권한).
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { BrowserApprovalRequestEvent, BrowserApprovalDecision } from "@/lib/types";

const ACTION_LABEL: Record<string, { ko: string; en: string }> = {
  send: { ko: "메시지 전송", en: "Send message" },
  publish: { ko: "게시/공개", en: "Publish" },
  delete: { ko: "삭제", en: "Delete" },
  payment: { ko: "결제", en: "Payment" },
  "unsafe-code": { ko: "브라우저 코드 실행", en: "Browser code execution" },
  post: { ko: "게시", en: "Post" },
  submit: { ko: "제출", en: "Submit" },
  action: { ko: "브라우저 작업", en: "Browser action" },
};

export function BrowserActionApprovalSheet() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [queue, setQueue] = useState<BrowserApprovalRequestEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [expiredNotice, setExpiredNotice] = useState<string | null>(null);
  const req = queue[0] ?? null;

  useEffect(() => {
    const events = ipcEvents();
    if (!events) return;
    return events.onBrowserApproval((r) => {
      setQueue((current) =>
        current.some((item) => item.requestId === r.requestId) ? current : [...current, r],
      );
    });
  }, []);

  useEffect(() => {
    if (!req) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const remaining = Math.max(0, req.expiresAt - Date.now());
    const expire = window.setTimeout(() => {
      setQueue((current) => current.filter((item) => item.requestId !== req.requestId));
      setExpiredNotice(
        ko
          ? "응답 시간이 지나 이번 브라우저 작업을 안전하게 거부했습니다."
          : "This browser action timed out and was safely denied.",
      );
    }, remaining);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(expire);
    };
  }, [ko, req]);

  useEffect(() => {
    if (!expiredNotice) return;
    const timer = window.setTimeout(() => setExpiredNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [expiredNotice]);

  if (!req) {
    return expiredNotice ? (
      <div className="baa-expired" role="status">
        {expiredNotice}
        <style jsx>{`
          .baa-expired {
            position: fixed;
            left: 50%;
            bottom: 22px;
            z-index: 90;
            transform: translateX(-50%);
            max-width: min(440px, calc(100vw - 32px));
            padding: 10px 14px;
            border-radius: 10px;
            background: var(--rd-bg, #14151a);
            color: var(--rd-ink, #f3f4f8);
            border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.12));
            box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
            font-size: 12.5px;
          }
        `}</style>
      </div>
    ) : null;
  }

  const resolve = (decision: BrowserApprovalDecision) => {
    const requestId = req.requestId;
    setQueue((current) => current.filter((item) => item.requestId !== requestId));
    void ipc()?.browser.resolveApproval(requestId, decision).then((result) => {
      if (!result?.ok) {
        setExpiredNotice(
          ko ? "이미 만료된 요청입니다. 작업은 실행되지 않았습니다." : "That request already expired. No action was taken.",
        );
      }
    });
  };

  const actionName = browserActionName(req.actionType, ko);
  const isPayment = req.actionType === "payment";
  const isUnsafeCode = req.actionType === "unsafe-code";

  return (
    <div className="baa-wrap" role="alertdialog" aria-live="assertive">
      <div className="baa">
        <div className="baa-top">
          <span className={`baa-tag ${isPayment || isUnsafeCode ? "pay" : ""}`}>{actionName}</span>
          {req.site && <span className="baa-site">{req.site}</span>}
        </div>
        <div className="baa-summary">{req.summary}</div>
        <div className="baa-note">
          {ko
            ? `${Math.max(0, Math.ceil((req.expiresAt - now) / 1_000))}초 안에 선택 · 대기 ${queue.length}건`
            : `Choose within ${Math.max(0, Math.ceil((req.expiresAt - now) / 1_000))}s · ${queue.length} pending`}
        </div>
        {isPayment && (
          <div className="baa-note">
            {ko ? "결제는 안전을 위해 매번 확인합니다." : "Payments are confirmed every time for safety."}
          </div>
        )}
        {isUnsafeCode && (
          <div className="baa-note">
            {ko
              ? "임의 코드는 페이지에서 여러 동작을 한 번에 실행할 수 있어 매번 확인합니다."
              : "Arbitrary code can perform multiple page actions and is confirmed every time."}
          </div>
        )}
        <div className="baa-actions">
          <button className="deny" onClick={() => resolve("deny")}>
            {ko ? "거부" : "Deny"}
          </button>
          <button className="once" onClick={() => resolve("once")}>
            {ko ? "한 번만" : "Allow once"}
          </button>
          {req.allowAlways && (
            <button className="always" onClick={() => resolve("always")}>
              {ko ? "항상 승인" : "Always allow"}
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
          color: #fff;
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
          color: #fff;
          border-color: transparent;
        }
      `}</style>
    </div>
  );
}

function browserActionName(actionType: string, ko: boolean): string {
  const label = ACTION_LABEL[actionType];
  if (label) return ko ? label.ko : label.en;
  return actionType
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
