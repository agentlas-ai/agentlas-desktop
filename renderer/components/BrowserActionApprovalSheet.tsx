"use client";

// 경량 승인 바텀시트 — 되돌릴 수 없는 브라우저 행동(전송·게시·삭제·결제) 전에 뜬다.
// 기존 ChatQuestionSheet 대비 최소 UI: 한 줄 설명 + [한 번만] [항상 승인] [거부].
//  - 현재 이 시트에 도달하는 건 결제(payment)/임의코드(unsafe-code)뿐이고 둘 다 allowAlways=false라
//    "항상 승인" 버튼은 뜨지 않는다(승인 캐시 금지 = 매번 확인). 버튼은 플래그로만 살아난다.
//  - "거부"는 electron이 site+action 으로 기억 → 다음부터 시트 없이 차단(browser:revokePermission으로 해제).
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";
import { AskCard } from "@/components/AskCard";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { BrowserApprovalRequestEvent, BrowserApprovalDecision } from "@/lib/types";
import { OneBottomSheet } from "@/components/one/OneBottomSheet";

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
  const pathname = usePathname();
  const { locale } = useT();
  const ko = locale === "ko";
  const oneRoute = pathname.startsWith("/one");
  const [queue, setQueue] = useState<BrowserApprovalRequestEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [expiredNotice, setExpiredNotice] = useState<string | null>(null);
  const req = queue[0] ?? null;

  useEffect(() => {
    const events = ipcEvents();
    if (!events) return;
    return events.onBrowserApproval((r) => {
      setQueue((current) => {
        if (r.expiresAt <= Date.now()) {
          return current.filter((item) => item.requestId !== r.requestId);
        }
        return current.some((item) => item.requestId === r.requestId) ? current : [...current, r];
      });
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
      <div className={`baa-expired ${oneRoute ? "one" : ""}`} role="status">
        {expiredNotice}
        <style jsx>{`
          .baa-expired {
            position: fixed;
            left: 50%;
            bottom: 22px;
            z-index: 90;
            transform: translateX(-50%);
            max-width: var(--popup-3-width);
            padding: 10px 14px;
            border-radius: 10px;
            background: var(--rd-bg);
            color: var(--rd-ink);
            border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.12));
            box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
            font-size: 12.5px;
          }
          .baa-expired.one {
            border-color: rgba(40, 48, 39, 0.12);
            background: var(--one-toast-bg);
            color: var(--one-toast-ink);
            box-shadow: 0 12px 36px rgba(28, 35, 27, 0.18);
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
  const onePresentation = oneRoute;
  const unsafeCodeDetail = req.summary.replace(/^unsafe-code\s*:\s*/i, "").trim();
  const oneDescription = isUnsafeCode
    ? ko
      ? "페이지 코드는 여러 동작을 한 번에 실행할 수 있습니다. 대상과 코드를 확인한 뒤 이번 한 번만 허용하거나 거부하세요."
      : "Page code can perform multiple actions at once. Review the target and code, then allow it once or deny it."
    : req.summary;

  /*
   * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
   * 규격은 docs/DESIGN-ASK-CARD.md.
   */
  const remainingSeconds = Math.max(0, Math.ceil((req.expiresAt - now) / 1_000));
  const askTitle = `${actionName}${req.site ? ` · ${req.site}` : ""}`;
  const summaryLine = isUnsafeCode ? (unsafeCodeDetail || req.summary) : req.summary;
  const safetyNote = isPayment
    ? (ko ? "결제는 안전을 위해 매번 확인합니다." : "Payments are confirmed every time for safety.")
    : isUnsafeCode
      ? (ko ? "임의 코드는 페이지에서 여러 동작을 한 번에 실행할 수 있어 매번 확인합니다."
            : "Arbitrary code can perform multiple page actions and is confirmed every time.")
      : null;

  const content = (
    <>
      <AskCard
        title={askTitle}
        locale={ko ? "ko" : "en"}
        options={[
          {
            id: "once",
            title: ko ? "한 번만 허용" : "Allow once",
            note: summaryLine,
            active: true,
          },
          ...(req.allowAlways ? [{
            id: "always",
            title: ko ? "항상 승인" : "Always allow",
            note: ko ? "이 사이트의 같은 동작은 다시 묻지 않습니다." : "The same action on this site will not ask again.",
          }] : []),
          {
            id: "deny",
            title: ko ? "거부" : "Deny",
            note: safetyNote
              ?? (ko ? `${remainingSeconds}초 안에 고르지 않으면 거부됩니다 · 대기 ${queue.length}건`
                     : `Denied automatically in ${remainingSeconds}s · ${queue.length} pending`),
          },
        ]}
        onChoose={(id) => resolve(id as "once" | "always" | "deny")}
      />
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
          width: var(--popup-3-width);
          background: var(--rd-bg);
          color: var(--rd-ink);
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
          background: var(--rd-accent);
          color: var(--white);
        }
        .baa-tag.pay {
          background: var(--rd-err);
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
          color: var(--rd-ink);
        }
        .baa-actions .deny {
          color: var(--rd-err);
          margin-right: auto;
        }
        .baa-actions .always {
          background: var(--rd-accent);
          color: var(--white);
          border-color: transparent;
        }
        .baa-one {
          width: auto;
          margin: 0;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: var(--one-sheet-ink);
          box-shadow: none;
          animation: none;
        }
        .baa-one .baa-tag,
        .baa-one .baa-summary:not(.code) {
          display: none;
        }
        .baa-one .baa-summary.code {
          margin: 0 0 14px;
          padding: 12px 14px;
          border: 1px solid var(--one-sheet-control-border);
          border-radius: var(--one-sheet-control-radius);
          background: var(--one-sheet-card-muted);
          color: var(--one-sheet-ink);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
          font-weight: 560;
          overflow-wrap: anywhere;
        }
        .baa-one .baa-top {
          justify-content: flex-end;
        }
        .baa-one .baa-site,
        .baa-one .baa-note {
          color: var(--one-sheet-muted);
          opacity: 1;
        }
        .baa-one .baa-actions button {
          min-height: var(--one-sheet-control-height);
          border-color: var(--one-sheet-control-border);
          border-radius: var(--one-sheet-control-radius);
          color: var(--one-sheet-ink);
        }
        .baa-one .baa-actions button:focus-visible {
          outline: none;
          box-shadow: var(--one-sheet-focus);
        }
        .baa-one .baa-actions .deny {
          color: var(--one-sheet-danger);
        }
        .baa-one .baa-actions .once,
        .baa-one .baa-actions .always {
          border-color: var(--one-sheet-primary);
          background: var(--one-sheet-primary);
          color: var(--white);
        }
      `}</style>
    </>
  );

  if (onePresentation) {
    return (
      <OneBottomSheet
        open
        onClose={() => resolve("deny")}
        closeLabel={ko ? "브라우저 작업 거부" : "Deny browser action"}
        ariaLabelledBy="one-browser-approval-title"
        dialogRole="alertdialog"
        closeOnBackdrop={false}
        closeOnEscape={false}
        eyebrow={actionName}
        title={ko ? "이 브라우저 작업을 허용할까요?" : "Allow this browser action?"}
        titleId="one-browser-approval-title"
        description={oneDescription}
      >
        {content}
      </OneBottomSheet>
    );
  }

  return <div className="baa-wrap" role="alertdialog" aria-live="assertive">{content}</div>;
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
