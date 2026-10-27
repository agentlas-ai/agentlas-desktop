"use client";

import { ComposerDecisionPortal } from "./ComposerDecisionPortal";

// 경량 승인 바텀시트 — 되돌릴 수 없는 브라우저 행동(전송·게시·삭제·결제) 전에 뜬다.
// 기존 ChatQuestionSheet 대비 최소 UI: 한 줄 설명 + [한 번만] [항상 승인] [거부].
//  - Full access는 Main 게이트에서 모든 브라우저 체크포인트를 통과시키므로 이 시트에 도달하지
//    않는다. 대화를 "항상 허용"으로 둔 경우도 임의코드(unsafe-code)는 Main 이 묻지 않고 통과시킨다
//    (오너 지시 2026-10-04). 그 밖의 gated 실행에서 도달하는 결제(payment)/임의코드는
//    allowAlways=false라 사이트 단위 "항상 승인" 버튼은 뜨지 않는다. 버튼은 플래그로만 살아난다.
//  - "거부"는 electron이 site+action 으로 기억 → 다음부터 시트 없이 차단(browser:revokePermission으로 해제).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useOrphanAttentionRevealed } from "@/lib/attention";
import type { BrowserApprovalRequestEvent, BrowserApprovalDecision } from "@/lib/types";
import { ApprovalPrompt, type ApprovalPromptDeck } from "./ApprovalPrompt";
import { useApprovalDeck } from "@/lib/tool-approvals";
import { cleanApprovalNote, clearApprovalNoteDraft } from "@/lib/approval-note-drafts";

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

export function BrowserActionApprovalSheet({ chatId, onStandaloneHeightChange, supervisedRoom = false, pinRequestId, deck: deckOverride }: {
  // Kept temporarily for call-site compatibility only. Main owns authority;
  // the renderer must never auto-resolve from the currently visible setting.
  permission?: "auto" | "read" | "write" | "full";
  chatId?: string | null;
  onStandaloneHeightChange?: (height: number) => void;
  /**
   * `chatId` is a room the personal agent oversees, drawn in the personal conversation (owner 2026-10-27). Its
   * requests match by that room alone, whatever surface they came from, and the card stays where it is drawn
   * instead of moving to the composer. The answer goes to the same request as in the room itself.
   */
  supervisedRoom?: boolean;
  /**
   * Draw exactly this request (the personal agent's one-at-a-time queue picks which one is on screen) and take the
   * "1/3 · Next" position from that queue instead of this sheet's own.
   */
  pinRequestId?: string;
  deck?: ApprovalPromptDeck;
} = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { locale } = useT();
  const ko = locale === "ko";
  const orphansRevealed = useOrphanAttentionRevealed();
  const oneRoute = pathname.startsWith("/one");
  const buildRoute = pathname === "/build" || pathname.startsWith("/build/");
  const surface = oneRoute ? "one" : pathname.startsWith("/science") ? "science" : "work";
  const currentChatId = chatId !== undefined ? chatId : (oneRoute ? null : searchParams.get("id"));
  const [queue, setQueue] = useState<BrowserApprovalRequestEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [expiredNotice, setExpiredNotice] = useState<string | null>(null);
  // "No, and do this instead": the request whose refusal (with the owner's line) is on its way, the send error to show on
  // its card, and the line the room could not take (kept visible until dismissed).
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [noteFailedText, setNoteFailedText] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const eventRevisionRef = useRef(0);
  const latestEventRevisionRef = useRef(new Map<string, number>());
  const ownedQueue = queue.filter((request) => {
    const owner = request.owner;
    if (!owner) return false;
    if (supervisedRoom) return owner.context !== "build" && owner.chatId !== null && owner.chatId === currentChatId;
    if (buildRoute) {
      return owner.surface === "work" && owner.chatId === null && owner.context === "build";
    }
    if (owner.context === "build" || owner.surface !== surface) return false;
    if (surface === "science") return true;
    // 대화가 없는 요청은 오너가 전환기 점 목록에서 열었을 때만(아래 orphansRevealed).
    return owner.chatId === null ? orphansRevealed : owner.chatId === currentChatId;
  });
  /*
   * ★소유자 없는 요청이 아무 화면에나 뜨던 길을 닫았다 (오너 2026-09-29 "시트 띄우지말고 …").
   *   화면 밖 요청은 전환기의 파란 점(lib/attention)이 세고, 갈 대화가 없는 요청은 오너가
   *   그 점 목록의 "대화 밖 요청"을 눌렀을 때만 여기서 편다. 만료는 메인의 expiresAt 그대로다.
   */
  const ownerlessQueue = orphansRevealed ? queue.filter((request) => request.owner === null) : [];
  const visibleQueue = ownedQueue.length > 0 ? ownedQueue : ownerlessQueue;
  // One card at a time (owner 2026-10-27): the rest wait behind "1/3 · Next" instead of stacking.
  const ownDeck = useApprovalDeck(visibleQueue.map((request) => ({ id: request.requestId })));
  const req = (pinRequestId
    ? visibleQueue.find((request) => request.requestId === pinRequestId)
    : visibleQueue.find((request) => request.requestId === ownDeck.current?.id) ?? visibleQueue[0]) ?? null;
  const deck: ApprovalPromptDeck | undefined = deckOverride
    ?? (ownDeck.total > 1 ? { index: ownDeck.index, total: ownDeck.total, onPrev: ownDeck.prev, onNext: ownDeck.next } : undefined);
  const usesConversationComposer = !supervisedRoom && Boolean(
    req?.owner
    && req.owner.context !== "build"
    && req.owner.surface !== "science"
    && currentChatId !== null
    && req.owner.chatId === currentChatId,
  );
  useLayoutEffect(() => {
    if (!onStandaloneHeightChange) return;
    const wrapper = wrapperRef.current;
    if (!req || usesConversationComposer || !wrapper) {
      onStandaloneHeightChange(0);
      return;
    }
    const measure = () => onStandaloneHeightChange(Math.ceil(wrapper.getBoundingClientRect().height) + 112);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => { observer.disconnect(); onStandaloneHeightChange(0); };
  }, [req, usesConversationComposer, onStandaloneHeightChange]);

  const mergePending = useCallback((incoming: BrowserApprovalRequestEvent | BrowserApprovalRequestEvent[]) => {
    const additions = Array.isArray(incoming) ? incoming : [incoming];
    setQueue((current) => {
      const timestamp = Date.now();
      const cancelledIds = new Set(additions.filter((item) => item.expiresAt <= timestamp).map((item) => item.requestId));
      const next = current.filter((item) => item.expiresAt > timestamp && !cancelledIds.has(item.requestId));
      const known = new Set(next.map((item) => item.requestId));
      for (const item of additions) {
        if (item.expiresAt <= timestamp || known.has(item.requestId)) continue;
        known.add(item.requestId);
        next.push(item);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const events = ipcEvents();
    if (!events) return;
    return events.onBrowserApproval((request) => {
      const revision = ++eventRevisionRef.current;
      latestEventRevisionRef.current.set(request.requestId, revision);
      mergePending(request);
    });
  }, [mergePending]);

  useEffect(() => {
    let active = true;
    const browser = ipc()?.browser;
    if (!browser) return;
    const hydrationRevision = eventRevisionRef.current;
    void browser.listPendingApprovals()
      .then((pending) => {
        if (!active) return;
        mergePending(pending.filter((request) => (
          latestEventRevisionRef.current.get(request.requestId) ?? 0
        ) <= hydrationRevision));
      })
      .catch(() => { /* push events remain the fail-closed fallback */ });
    return () => { active = false; };
  }, [currentChatId, mergePending, pathname]);

  useLayoutEffect(() => { setExpiredNotice(null); }, [currentChatId, pathname]);

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

  const feedbackNode = sendError || noteFailedText ? (
    <div role="alert" data-testid="browser-approval-outcome"
      style={{ marginTop: 8, padding: "8px 10px", borderRadius: 10, border: "1px solid color-mix(in srgb, currentColor 18%, transparent)", fontSize: 12, lineHeight: 1.45 }}>
      {sendError ? <span>{sendError}</span> : (
        <>
          <span>{ko ? "거절은 적용됐지만 지시를 방에 보내지 못했습니다. 아래 글을 방 입력창에 직접 보내 주세요."
            : "The refusal was applied, but the instruction could not be sent to the room. Send the text below in the room yourself."}</span>
          <q data-testid="browser-approval-note-failed" style={{ display: "block", marginTop: 4, overflowWrap: "anywhere", userSelect: "text" }}>{noteFailedText}</q>
          <button type="button" onClick={() => setNoteFailedText(null)} style={{ marginTop: 4 }}>{ko ? "확인" : "Dismiss"}</button>
        </>
      )}
    </div>
  ) : null;

  if (!req) {
    return expiredNotice || noteFailedText ? (
      <div className={`baa-expired ${oneRoute ? "one" : ""}`} role="status">
        {expiredNotice ?? feedbackNode}
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

  const resolve = (decision: BrowserApprovalDecision, rawNote?: string) => {
    const requestId = req.requestId;
    const note = decision === "deny" ? cleanApprovalNote(rawNote) : undefined;
    if (note === undefined) {
      clearApprovalNoteDraft(requestId);
      setQueue((current) => current.filter((item) => item.requestId !== requestId));
      void ipc()?.browser.resolveApproval(requestId, decision).then((result) => {
        if (!result?.ok) {
          setExpiredNotice(
            ko ? "이미 만료된 요청입니다. 작업은 실행되지 않았습니다." : "That request already expired. No action was taken.",
          );
        }
      });
      return;
    }
    // A refusal with the owner's line: the card stays (locked, text kept) until Main says the refusal took effect and what
    // became of the line; a send that fails outright leaves the card to answer again.
    if (submittingId === requestId) return;
    setSubmittingId(requestId);
    setSendError(null);
    void Promise.resolve(ipc()?.browser.resolveApproval(requestId, decision, note)).then((result) => {
      setSubmittingId(null);
      setQueue((current) => current.filter((item) => item.requestId !== requestId));
      clearApprovalNoteDraft(requestId);
      if (!result?.ok) {
        setExpiredNotice(
          ko ? "이미 만료된 요청입니다. 작업은 실행되지 않았습니다." : "That request already expired. No action was taken.",
        );
      } else if (result.ownerNote?.status === "failed") {
        setNoteFailedText(note);
      }
    }).catch(() => {
      setSubmittingId(null);
      setSendError(ko ? "결정을 보내지 못했습니다. 승인 카드는 그대로입니다. 다시 선택해 주세요." : "The decision was not sent. The approval is still waiting; choose again.");
    });
  };

  const actionName = browserActionName(req.actionType, ko);
  const isPayment = req.actionType === "payment";
  const isUnsafeCode = req.actionType === "unsafe-code";
  const unsafeCodeDetail = req.summary.replace(/^unsafe-code\s*:\s*/i, "").trim();

  /*
   * 오너 2026-10-27: 도구 승인과 같은 문법 — 질문 한 줄, 실제 실행될 내용(코드 블록), 번호 선택지(components/ApprovalPrompt).
   * 선택지의 뜻과 보내는 값(once · always · deny)은 그대로다. "항상 허용"은 이 사이트의 같은 종류 작업만(electron/browser/connect.ts).
   */
  const remainingSeconds = Math.max(0, Math.ceil((req.expiresAt - now) / 1_000));
  const approvalKicker = req.owner?.context === "build"
    ? "Build"
    : req.owner?.surface === "science"
      ? "Science"
      : null;
  const summaryLine = isUnsafeCode ? (unsafeCodeDetail || req.summary) : req.summary;
  const codeText = [summaryLine || (ko ? "실행 전에 확인하세요." : "Confirm before running."), req.target ? `→ ${req.target}` : ""]
    .filter(Boolean).join("\n");
  const warning = isPayment
    ? (ko ? "결제는 항상 직접 확인하세요." : "Always check payments yourself.")
    : isUnsafeCode
      ? (ko ? "여러 페이지 동작을 실행할 수 있습니다. 이 대화의 ‘항상 허용’을 켜면 확인을 생략합니다."
            : "Code can perform multiple page actions. Always allow in this conversation skips this check.")
      : null;
  const options = [
    { id: "once", title: ko ? "예" : "Yes", role: "primary" as const, note: ko ? "이번 한 번만 실행합니다." : "Runs this action once." },
    ...(req.allowAlways ? [{
      id: "always",
      title: ko ? "예, 항상 허용" : "Yes, always allow",
      showNote: true,
      note: ko ? "이 사이트의 같은 종류 작업은 다시 묻지 않습니다." : "This kind of action on this site is not asked again.",
    }] : []),
    { id: "deny", title: ko ? "아니오" : "No", role: "deny" as const, note: ko ? "실행하지 않고, 같은 사이트·작업은 다음부터 막습니다." : "Not run; the same site and action is blocked from now on." },
  ];

  const content = (
    <>
      <ApprovalPrompt
        key={req.requestId}
        question={ko ? "이 브라우저 작업을 허용할까요?" : "Allow this browser action?"}
        ariaLabel={`${actionName}${req.site ? ` · ${req.site}` : ""}`}
        code={codeText}
        codeLabel={isUnsafeCode ? (ko ? "실행할 브라우저 코드" : "Browser code to execute") : (ko ? "실행될 브라우저 작업" : "Browser action to run")}
        meta={<>{approvalKicker ? `${approvalKicker} · ` : ""}{actionName}{req.site ? ` · ${req.site}` : ""}</>}
        warning={warning}
        options={options}
        locked={submittingId === req.requestId}
        onChoose={(id, note) => resolve(id as BrowserApprovalDecision, note)}
        // The line goes to the room the action runs in; a build or Science action (or one with no room) has none to tell.
        denyNote={req.owner?.chatId && req.owner.context !== "build" && req.owner.surface !== "science" ? { draftKey: req.requestId } : null}
        footer={feedbackNode}
        deck={deck}
        trailing={<span className="baa-timer" title={ko ? "남은 시간 — 지나면 실행되지 않습니다" : "Time left — the action is not run after it ends"}>{ko ? `${remainingSeconds}초` : `${remainingSeconds}s`}</span>}
        className="baa-chip"
        testId="browser-action-approval"
        attrs={{ "data-browser-approval-id": req.requestId }}
      />
      <style jsx global>{`
        [data-browser-action-approval-wrap="true"] {
          position: fixed;
          left: 50%;
          bottom: 96px;
          transform: translateX(-50%);
          width: min(var(--agentlas-composer-width, 720px), calc(100% - 32px));
          z-index: 90;
          pointer-events: none;
        }
        [data-browser-action-approval-wrap="true"] .baa-chip { pointer-events: auto; }
      `}</style>
    </>
  );
  return (
    <ComposerDecisionPortal enabled={usesConversationComposer}>
      <div
        ref={wrapperRef}
        className="baa-wrap"
        data-browser-action-approval-wrap="true"
        data-browser-action-approval-placement={supervisedRoom ? "supervised-room" : usesConversationComposer ? "conversation" : "standalone"}
        data-composer-decision-card="true"
      >
        {content}
      </div>
    </ComposerDecisionPortal>
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
