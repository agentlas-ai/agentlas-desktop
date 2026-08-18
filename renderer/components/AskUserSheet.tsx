"use client";

// 에이전트의 **동기 질문** 시트 — 도구가 답을 기다리는 질문이다.
//
// 기존 ChatQuestionSheet 는 `<<agentlas-ask>>` 펜스를 그린다: 답이 다음 채팅 메시지로
// 가고 실행은 이미 끝나 있다. 대화에서는 자연스럽지만 **도구로는 쓸 수 없다** — 도구는
// 결과를 받아 다음 단계로 가야 한다. 이 시트가 답을 돌려주면 그 자리에서 실행이 이어진다.
//
// 형태는 BrowserActionApprovalSheet 와 같은 규칙(큐 + 만료 + 창 없으면 애초에 안 옴).
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { AskUserRequestEvent } from "@/lib/types";

export function AskUserSheet() {
  const pathname = usePathname();
  const { locale } = useT();
  const ko = locale === "ko";
  const oneRoute = pathname.startsWith("/one");
  const [queue, setQueue] = useState<AskUserRequestEvent[]>([]);
  const [freeText, setFreeText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const req = queue[0] ?? null;

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onAskUser) return;
    return events.onAskUser((r) => {
      setQueue((current) => {
        // expiresAt 0 = 이 질문은 끝났다(만료·취소). 시트에서 치운다.
        if (r.expiresAt <= Date.now()) {
          return current.filter((item) => item.requestId !== r.requestId);
        }
        return current.some((item) => item.requestId === r.requestId) ? current : [...current, r];
      });
    });
  }, []);

  useEffect(() => {
    setFreeText("");
  }, [req?.requestId]);

  useEffect(() => {
    if (!req) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const remaining = Math.max(0, req.expiresAt - Date.now());
    const expire = window.setTimeout(() => {
      setQueue((current) => current.filter((item) => item.requestId !== req.requestId));
    }, remaining);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(expire);
    };
  }, [req]);

  if (!req) return null;

  const answer = (value: string | null) => {
    const requestId = req.requestId;
    setQueue((current) => current.filter((item) => item.requestId !== requestId));
    void ipc()?.confirm?.submitAskUserAnswer?.(requestId, value);
  };

  const secondsLeft = Math.max(0, Math.ceil((req.expiresAt - now) / 1_000));

  return (
    <div className={`aus ${oneRoute ? "aus-one" : ""}`} role="dialog" aria-modal="false">
      <div className="aus-card">
        <div className="aus-top">
          <span className="aus-tag">{ko ? "에이전트의 질문" : "The agent is asking"}</span>
          {req.askedBy && <span className="aus-by">{req.askedBy}</span>}
        </div>
        <div className="aus-question">{req.question}</div>
        {req.options.length > 0 && (
          <div className="aus-options">
            {req.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className="aus-option"
                onClick={() => answer(option.label)}
              >
                <span className="aus-option-label">{option.label}</span>
                {option.description && <span className="aus-option-desc">{option.description}</span>}
              </button>
            ))}
          </div>
        )}
        {req.allowFreeText && (
          <form
            className="aus-free"
            onSubmit={(event) => {
              event.preventDefault();
              if (freeText.trim()) answer(freeText);
            }}
          >
            <input
              className="aus-input"
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              placeholder={ko ? "직접 답하기" : "Answer in your own words"}
              aria-label={ko ? "직접 답하기" : "Answer in your own words"}
            />
            <button type="submit" className="aus-send" disabled={!freeText.trim()}>
              {ko ? "보내기" : "Send"}
            </button>
          </form>
        )}
        <div className="aus-foot">
          <span className="aus-note">
            {ko
              ? `${secondsLeft}초 안에 답해주세요 · 대기 ${queue.length}건`
              : `${secondsLeft}s left · ${queue.length} waiting`}
          </span>
          <button type="button" className="aus-skip" onClick={() => answer(null)}>
            {ko ? "답하지 않음" : "Skip"}
          </button>
        </div>
      </div>
      <style jsx>{`
        .aus {
          position: fixed;
          left: 50%;
          bottom: 22px;
          z-index: 95;
          transform: translateX(-50%);
          width: min(520px, calc(100vw - 32px));
        }
        .aus-card {
          padding: 14px 16px;
          border-radius: 14px;
          background: var(--rd-bg, #14151a);
          color: var(--rd-ink, #f3f4f8);
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.12));
          box-shadow: 0 16px 44px rgba(0, 0, 0, 0.34);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .aus-one .aus-card {
          background: #fffdf9;
          color: #20251f;
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
          background: rgba(120, 170, 255, 0.16);
          color: #9dc0ff;
        }
        .aus-one .aus-tag {
          background: rgba(60, 110, 60, 0.12);
          color: #3f6b3f;
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
          background: #4d7fd6;
          color: #fff;
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
