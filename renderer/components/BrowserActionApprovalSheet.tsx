"use client";

import { ComposerDecisionPortal } from "./ComposerDecisionPortal";

// 경량 승인 바텀시트 — 되돌릴 수 없는 브라우저 행동(전송·게시·삭제·결제) 전에 뜬다.
// 기존 ChatQuestionSheet 대비 최소 UI: 한 줄 설명 + [한 번만] [항상 승인] [거부].
//  - Full access는 Main 게이트에서 모든 브라우저 체크포인트를 통과시키므로 이 시트에 도달하지
//    않는다. gated 실행에서 도달하는 결제(payment)/임의코드(unsafe-code)는 allowAlways=false라
//    "항상 승인" 버튼은 뜨지 않는다(승인 캐시 금지 = 매번 확인). 버튼은 플래그로만 살아난다.
//  - "거부"는 electron이 site+action 으로 기억 → 다음부터 시트 없이 차단(browser:revokePermission으로 해제).
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
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

export function BrowserActionApprovalSheet({ permission }: {
  permission?: "auto" | "read" | "write" | "full";
} = {}) {
  const pathname = usePathname();
  const { locale } = useT();
  const ko = locale === "ko";
  const oneRoute = pathname.startsWith("/one");
  const [queue, setQueue] = useState<BrowserApprovalRequestEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [expiredNotice, setExpiredNotice] = useState<string | null>(null);
  const req = queue[0] ?? null;
  const permissionRef = useRef(permission);
  permissionRef.current = permission;

  const resolveFullAccessRequest = (requestId: string) => {
    void ipc()?.browser.resolveApproval(requestId, "once");
  };

  useEffect(() => {
    const events = ipcEvents();
    if (!events) return;
    return events.onBrowserApproval((r) => {
      if (permissionRef.current === "full") {
        // A stale gated request may arrive while the person explicitly
        // switches this One session to Full access. Do not paint an Allow once
        // chip; settle the already-issued request under that new authority.
        resolveFullAccessRequest(r.requestId);
        return;
      }
      setQueue((current) => {
        if (r.expiresAt <= Date.now()) {
          return current.filter((item) => item.requestId !== r.requestId);
        }
        return current.some((item) => item.requestId === r.requestId) ? current : [...current, r];
      });
    });
  }, []);

  useEffect(() => {
    if (permission !== "full" || queue.length === 0) return;
    const pending = queue;
    setQueue([]);
    for (const item of pending) resolveFullAccessRequest(item.requestId);
  }, [permission, queue]);

  useEffect(() => {
    if (!req) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const remaining = Math.max(0, req.expiresAt - Date.now());
    const expire = window.setTimeout(() => {
      setQueue((current) => current.filter((item) => item.requestId !== req.requestId));
      setExpiredNotice(
        ko
          ? "승인 시간이 만료되어 이번 브라우저 작업은 실행되지 않았습니다."
          : "Approval expired. This browser action was not executed.",
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
  const unsafeCodeDetail = req.summary.replace(/^unsafe-code\s*:\s*/i, "").trim();

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
      <section className="baa-chip" role="alertdialog" aria-live="assertive" aria-label={askTitle}>
        {/* 설명은 왼쪽 글 묶음이 갖고, 오른쪽 끝은 단추가 갖는다. 안전 문구를 꼬리 슬롯에
            두면 짧은 카운트다운용으로 만든 자리(flex 0 0 auto · nowrap)를 긴 문장이 차지해
            정작 무엇을 승인하는지(제목·코드)가 줄임표로 잘린다. */}
        <div className="baa-chip-copy">
          <span className="baa-chip-kicker">{ko ? "승인 필요" : "Approval needed"}</span>
          <strong>{askTitle}</strong>
          <small>{summaryLine || (ko ? "실행 전에 확인하세요." : "Confirm before running.")}</small>
          {safetyNote && <small className="baa-chip-note">{safetyNote}</small>}
        </div>
        {/* 남은 시간은 안전 문구가 있어도 사라지면 안 된다 — 만료되면 이 요청은
            fail-closed 로 조용히 죽으므로, 매번 묻는 종류일수록 더 필요하다. */}
        <span className="baa-chip-timer">
          {ko ? `${remainingSeconds}초 · 대기 ${queue.length}건` : `${remainingSeconds}s · ${queue.length} pending`}
        </span>
        <div className="baa-chip-actions" role="group" aria-label={ko ? "승인 선택" : "Approval choices"}>
          <button type="button" className="baa-chip-once" onClick={() => resolve("once")}>{ko ? "이번만 허용" : "Allow once"}</button>
          {req.allowAlways && <button type="button" onClick={() => resolve("always")}>{ko ? "항상 허용" : "Always allow"}</button>}
          <button type="button" className="baa-chip-deny" onClick={() => resolve("deny")}>
            {ko ? "거부" : "Deny"}
          </button>
        </div>
      </section>
      {isUnsafeCode && (
        <details className="baa-code-review">
          <summary>{ko ? "실행할 코드 전체 보기" : "Review full code"}</summary>
          <pre tabIndex={0} aria-label={ko ? "실행할 브라우저 코드" : "Browser code to execute"}>{unsafeCodeDetail}</pre>
        </details>
      )}
      <style jsx>{`
        .baa-code-review { margin-top: 12px; }
        .baa-code-review summary { cursor: pointer; font-size: 13px; }
        .baa-code-review pre { max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; font-size: 12px; line-height: 1.5; }
        .baa-wrap {
          position: fixed;
          left: 50%;
          bottom: 96px;
          transform: translateX(-50%);
          width: min(var(--agentlas-composer-width, 720px), calc(100% - 32px));
          z-index: 90;
          pointer-events: none;
        }
        .baa-chip {
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          box-sizing: border-box;
          padding: 8px 10px 8px 12px;
          border: 1px solid var(--paper-edge, rgba(25, 31, 36, .14));
          border-radius: 13px;
          background: var(--paper, #fff);
          color: var(--ink, #202428);
          box-shadow: 0 7px 20px rgba(25, 31, 36, .12);
        }
        .baa-chip-copy { min-width: 0; flex: 1 1 auto; display: grid; gap: 2px; }
        .baa-chip-kicker { color: var(--warn, #a26a00); font-size: 9px; font-weight: 800; letter-spacing: .04em; }
        .baa-chip-copy strong, .baa-chip-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .baa-chip-copy strong { font-size: 11px; font-weight: 720; }
        .baa-chip-copy small, .baa-chip-timer { color: var(--muted-deep, #667078); font-size: 9px; line-height: 1.3; }
        /* 안전 문구는 한 줄에 안 들어가는 문장이다 — 줄바꿈을 허용하고 제목처럼 자르지 않는다. */
        .baa-chip-copy .baa-chip-note { white-space: normal; overflow: visible; }
        .baa-chip-actions { display: flex; flex: 0 0 auto; gap: 5px; align-items: center; margin-left: auto; }
        .baa-chip-actions button { min-height: 32px; padding: 0 10px; border: 1px solid var(--paper-edge-strong, #ccd2d6); border-radius: 9px; background: var(--paper, #fff); color: var(--ink-soft, #374047); font: inherit; font-size: 10px; font-weight: 680; white-space: nowrap; cursor: pointer; }
        .baa-chip-actions button:hover, .baa-chip-actions button:focus-visible { outline: 2px solid rgba(42, 47, 50, .12); }
        .baa-chip-actions .baa-chip-once { border-color: var(--black, #202428); background: var(--black, #202428); color: var(--white, #fff); }
        .baa-chip-actions .baa-chip-deny { border-color: var(--danger-soft, #e9b8b8); color: var(--danger, #9f3030); }
        .baa-chip-timer { flex: 0 0 auto; white-space: nowrap; }
        @media (max-width: 700px) {
          .baa-chip { align-items: stretch; flex-direction: column; gap: 7px; padding: 9px; }
          .baa-chip-actions { width: 100%; overflow-x: auto; }
          .baa-chip-timer { white-space: normal; }
        }
      `}</style>
    </>
  );
  return <ComposerDecisionPortal enabled><div className="baa-wrap" data-composer-decision-card="true" role="alertdialog" aria-live="assertive">{content}</div></ComposerDecisionPortal>;
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
