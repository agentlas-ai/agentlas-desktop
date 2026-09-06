"use client";

// 에이전트의 **동기 질문** 시트 — 도구가 답을 기다리는 질문이다.
//
// 기존 ChatQuestionSheet 는 `<<agentlas-ask>>` 펜스를 그린다: 답이 다음 채팅 메시지로
// 가고 실행은 이미 끝나 있다. 대화에서는 자연스럽지만 **도구로는 쓸 수 없다** — 도구는
// 결과를 받아 다음 단계로 가야 한다. 이 시트가 답을 돌려주면 그 자리에서 실행이 이어진다.
//
// 형태는 BrowserActionApprovalSheet 와 같은 규칙(큐 + 만료 + 창 없으면 애초에 안 옴).
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";
import { AskCard } from "@/components/AskCard";
import { clearAskUserDraft, loadAskUserDraft, saveAskUserDraft } from "@/lib/ask-user-draft";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { AskUserRequestEvent } from "@/lib/types";

export function AskUserSheet() {
  const pathname = usePathname();
  const { locale } = useT();
  const ko = locale === "ko";
  const oneRoute = pathname.startsWith("/one");
  const [queue, setQueue] = useState<AskUserRequestEvent[]>([]);
  const liveRequestsRef = useRef(new Set<string>());
  const attemptsRef = useRef(new Map<string, symbol>());
  const [submission, setSubmission] = useState<{
    requestId: string;
    value: string | null;
    pending: boolean;
    error?: "unavailable" | "ended";
  } | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const req = queue[0] ?? null;
  const currentRequestIdRef = useRef<string | null>(null);
  currentRequestIdRef.current = req?.requestId ?? null;

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onAskUser) return;
    const unsubscribe = events.onAskUser((r) => {
      if (r.expiresAt <= Date.now()) {
        clearAskUserDraft(r);
        liveRequestsRef.current.delete(r.requestId);
        attemptsRef.current.delete(r.requestId);
        if (currentRequestIdRef.current === r.requestId) setDraftValue("");
      } else {
        liveRequestsRef.current.add(r.requestId);
      }
      setQueue((current) => {
        // expiresAt 0 = 이 질문은 끝났다(만료·취소). 시트에서 치운다.
        if (r.expiresAt <= Date.now()) {
          return current.filter((item) => item.requestId !== r.requestId);
        }
        return current.some((item) => item.requestId === r.requestId) ? current : [...current, r];
      });
    });
    return () => {
      unsubscribe();
      liveRequestsRef.current.clear();
      attemptsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!req) {
      setDraftValue("");
      return;
    }
    setDraftValue(loadAskUserDraft(req) ?? "");
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const remaining = Math.max(0, req.expiresAt - Date.now());
    const expire = window.setTimeout(() => {
      liveRequestsRef.current.delete(req.requestId);
      attemptsRef.current.delete(req.requestId);
      clearAskUserDraft(req);
      if (currentRequestIdRef.current === req.requestId) setDraftValue("");
      setQueue((current) => current.filter((item) => item.requestId !== req.requestId));
    }, remaining);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(expire);
    };
  }, [req]);

  if (!req) return null;

  const answer = async (value: string | null) => {
    const requestId = req.requestId;
    if (!liveRequestsRef.current.has(requestId) || attemptsRef.current.has(requestId)) return;
    const attempt = Symbol(requestId);
    attemptsRef.current.set(requestId, attempt);
    setSubmission({ requestId, value, pending: true });
    try {
      const api = ipc();
      if (typeof api?.confirm?.submitAskUserAnswer !== "function") throw new Error("ask_bridge_unavailable");
      const accepted = await api.confirm.submitAskUserAnswer(requestId, value);
      if (attemptsRef.current.get(requestId) !== attempt || !liveRequestsRef.current.has(requestId)) return;
      if (accepted === true) {
        clearAskUserDraft(req);
        setDraftValue("");
        liveRequestsRef.current.delete(requestId);
        setQueue((current) => current.filter((item) => item.requestId !== requestId));
      } else {
        // Main returns false only when this request is no longer pending. It
        // exposes no Desktop pending-list API; do not invent an accepted reply
        // or replay it into a different request. Keep the draft for the user.
        setSubmission((current) => current?.requestId === requestId
          ? { ...current, pending: false, error: "ended" } : current);
      }
    } catch {
      if (attemptsRef.current.get(requestId) !== attempt || !liveRequestsRef.current.has(requestId)) return;
      setSubmission((current) => current?.requestId === requestId
        ? { ...current, pending: false, error: "unavailable" } : current);
    } finally {
      if (attemptsRef.current.get(requestId) === attempt) attemptsRef.current.delete(requestId);
    }
  };

  const dismiss = () => {
    // Closing stays available even while an acknowledgement is in flight.
    // Never send a competing decline for an already-submitted answer.
    if (!attemptsRef.current.has(req.requestId)) void answer(null);
    liveRequestsRef.current.delete(req.requestId);
    attemptsRef.current.delete(req.requestId);
    clearAskUserDraft(req);
    setDraftValue("");
    setQueue((current) => current.filter((item) => item.requestId !== req.requestId));
  };
  const currentSubmission = submission?.requestId === req.requestId ? submission : null;
  const updateDraft = (value: string) => {
    setDraftValue(value);
    if (req.allowFreeText) saveAskUserDraft(req, value);
  };

  const secondsLeft = Math.max(0, Math.ceil((req.expiresAt - now) / 1_000));

  /*
   * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
   * 규격은 docs/DESIGN-ASK-CARD.md.
   */
  return (
    <div className={`aus ${oneRoute ? "aus-one" : ""}`} role="dialog" aria-modal="false">
      <div className="aus-card">
        <AskCard
          key={req.requestId}
          title={req.askedBy ? `${req.askedBy} · ${req.question}` : req.question}
          locale={ko ? "ko" : "en"}
          options={req.options.map((option, index) => ({
            id: option.label,
            title: option.label,
            note: option.description ?? undefined,
            active: currentSubmission ? currentSubmission.value === option.label : index === 0,
            disabled: currentSubmission?.pending,
          }))}
          freeText={draftValue}
          onFreeTextChange={updateDraft}
          onChoose={(id) => { void answer(id); }}
          onClose={dismiss}
          footer={req.allowFreeText
            ? {
              placeholder: ko ? "직접 답하기" : "Answer in your own words",
              skipLabel: ko ? `답하지 않음 · ${secondsLeft}초` : `Skip · ${secondsLeft}s`,
              onSkip: (text) => { void answer(text ? text : null); },
            }
            : undefined}
        >
          {currentSubmission?.pending && <p role="status">{ko ? "답변 전달 중…" : "Sending answer…"}</p>}
          {currentSubmission?.error && <p role="alert">
            {currentSubmission.error === "ended"
              ? (ko ? "이 질문은 이미 종료되었거나 다른 곳에서 답변되었습니다. 입력은 남겨 두었습니다. 닫고 현재 질문을 확인해 주세요."
                : "This question has ended or was answered elsewhere. Your draft is still here. Close it and check the current question.")
              : (ko ? "답변을 전달했는지 확인하지 못했습니다. 선택하거나 입력한 답변을 다시 보내 주세요."
                : "The answer was not acknowledged. Choose or submit your draft again to retry.")}
          </p>}
        </AskCard>
      </div>
      <style jsx>{`
        .aus {
          position: fixed;
          left: 50%;
          bottom: 22px;
          z-index: 95;
          transform: translateX(-50%);
          width: var(--popup-3-width);
        }
        .aus-card {
          padding: 14px 16px;
          border-radius: 14px;
          background: var(--rd-bg);
          color: var(--rd-ink);
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.12));
          box-shadow: 0 16px 44px rgba(0, 0, 0, 0.34);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .aus-one .aus-card {
          background: var(--one-toast-bg);
          color: var(--one-toast-ink);
          border-color: rgba(40, 48, 39, 0.12);
          box-shadow: 0 16px 44px rgba(28, 35, 27, 0.18);
        }
        .aus-top {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .aus-tag {
          font-size: 11px;
          font-weight: 600;
          padding: 3px 8px;
          border-radius: 999px;
          background: var(--info-soft);
          color: var(--info);
        }
        .aus-one .aus-tag {
          background: var(--accent-soft);
          color: var(--accent-strong);
        }
        .aus-by {
          font-size: 11.5px;
          opacity: 0.6;
        }
        .aus-question {
          font-size: 14px;
          line-height: 1.5;
          white-space: pre-wrap;
        }
        .aus-options {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .aus-option {
          text-align: left;
          padding: 9px 11px;
          border-radius: 10px;
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.14));
          background: transparent;
          color: inherit;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .aus-option:hover {
          border-color: rgba(120, 170, 255, 0.5);
        }
        .aus-option-label {
          font-size: 13px;
          font-weight: 600;
        }
        .aus-option-desc {
          font-size: 11.5px;
          opacity: 0.65;
        }
        .aus-free {
          display: flex;
          gap: 6px;
        }
        .aus-input {
          flex: 1;
          padding: 8px 10px;
          border-radius: 9px;
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.14));
          background: transparent;
          color: inherit;
          font-size: 13px;
        }
        .aus-send {
          padding: 8px 12px;
          border-radius: 9px;
          border: none;
          background: var(--accent);
          color: var(--white);
          font-size: 12.5px;
          cursor: pointer;
        }
        .aus-send:disabled {
          opacity: 0.4;
          cursor: default;
        }
        .aus-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .aus-note {
          font-size: 11.5px;
          opacity: 0.6;
        }
        .aus-skip {
          background: none;
          border: none;
          color: inherit;
          opacity: 0.6;
          font-size: 12px;
          cursor: pointer;
          padding: 4px 2px;
        }
      `}</style>
    </div>
  );
}
