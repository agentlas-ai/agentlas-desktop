"use client";
// 챗 질문 시트 — Claude 데스크탑 질문 카드 스타일:
//  · 헤더: "1/2" 진행 칩 + 질문 한 줄, 우측에 접기(v)·닫기(×)
//  · 옵션: 회색 행(제목+설명) + 우측 숫자 배지, 마지막은 "기타" + 아래 자유입력
//  · 푸터: [건너뛰기] [다음 ↵] — 질문은 한 번에 하나, 마지막 질문에서 다음=전송
//  · 전송은 배치 1회: 질문 하나 답할 때마다 프롬프트로 쏘지 않는다(질문 꼬리물기 방지)
//  · 선택/입력은 로컬 상태 — 스트리밍 중에도 즉시 클릭 가능, 최종 전송만 busy에 묶인다
//  · 답장 스캐폴딩은 UI locale — 입력 언어 고착 방지
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatQuestion } from "@/components/ChatStream";
import { useT } from "@/lib/i18n";

export interface QuestionSheetAnswer {
  questionId: string;
  answers: string[];
}

export function composeQuestionReply(
  questions: ChatQuestion[],
  selected: Record<string, string[]>,
  notes: Record<string, string>,
  ko: boolean,
): { reply: string; perQuestion: QuestionSheetAnswer[] } {
  const chunks: string[] = [];
  const perQuestion: QuestionSheetAnswer[] = [];
  for (const q of questions) {
    const picks = selected[q.id] ?? [];
    const note = (notes[q.id] ?? "").trim();
    if (!picks.length && !note) continue;
    const canonicalPicks = !q.multiSelect && note ? [] : picks;
    const combined = [...canonicalPicks, ...(note ? [note] : [])];
    perQuestion.push({ questionId: q.id, answers: combined });
    const lines = [`${ko ? "질문" : "Question"}: ${q.question}`];
    if (canonicalPicks.length) lines.push(`${ko ? "선택" : "Selected"}: ${canonicalPicks.join(", ")}`);
    if (note) lines.push(`${ko ? "답변" : "Answer"}: ${note}`);
    chunks.push(lines.join("\n"));
  }
  return { reply: chunks.join("\n\n"), perQuestion };
}

export function ChatQuestionSheet({
  questions,
  busy,
  onConfirm,
  onDismiss,
}: {
  /** 현재 답변 대기 중인(unanswered) 질문들 — 최신 어시스턴트 메시지 기준. */
  questions: ChatQuestion[];
  /** 실행 중이면 최종 전송만 잠근다(선택은 허용). */
  busy: boolean;
  onConfirm: (reply: string, perQuestion: QuestionSheetAnswer[]) => void;
  /** ×로 닫기 — 이 배치를 답하지 않고 접는다(전송 없음). */
  onDismiss: () => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const otherInputRef = useRef<HTMLInputElement | null>(null);
  const key = questions.map((q) => q.id).join("|");

  // 새 질문 묶음이 오면 로컬 상태 초기화.
  useEffect(() => {
    setSelected({});
    setNotes({});
    setActive(0);
    setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const composed = useMemo(
    () => composeQuestionReply(questions, selected, notes, ko),
    [questions, selected, notes, ko],
  );
  const q = questions[Math.min(active, questions.length - 1)];
  const isLast = active >= questions.length - 1;
  const currentAnswered = q ? (selected[q.id]?.length ?? 0) > 0 || Boolean((notes[q.id] ?? "").trim()) : false;
  const hasAnyAnswer = composed.reply.trim().length > 0;

  if (questions.length === 0 || !q) return null;

  const submit = () => {
    if (busy || !hasAnyAnswer) return;
    onConfirm(composed.reply, composed.perQuestion);
  };

  const next = () => {
    if (isLast) submit();
    else setActive(active + 1);
  };

  const skip = () => {
    if (isLast) {
      if (hasAnyAnswer && !busy) submit();
      else onDismiss();
      return;
    }
    setActive(active + 1);
  };

  const pick = (label: string) => {
    if (!q.multiSelect) {
      setNotes((prev) => ({ ...prev, [q.id]: "" }));
    }
    setSelected((prev) => {
      const cur = prev[q.id] ?? [];
      if (q.multiSelect) {
        return { ...prev, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      }
      return { ...prev, [q.id]: cur.includes(label) ? [] : [label] };
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const inInput = (e.target as HTMLElement).tagName === "INPUT";
    if (!inInput) {
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length) {
        e.preventDefault();
        pick(q.options[n - 1].label);
        return;
      }
      // "기타" 배지 번호 — 자유입력에 포커스(배지가 장식이 되지 않게).
      if (n === q.options.length + 1) {
        e.preventDefault();
        otherInputRef.current?.focus();
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (currentAnswered || (isLast && hasAnyAnswer)) next();
    }
  };

  const nextLabel = isLast ? (ko ? "제출" : "Submit") : ko ? "다음" : "Next";

  return (
    <div className="chat-qsheet titlebar-nodrag" role="dialog" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="chat-qsheet-head">
        {questions.length > 1 && (
          <span className="chat-qsheet-step">{active + 1}/{questions.length}</span>
        )}
        <strong className="chat-qsheet-question">{q.question}</strong>
        <button
          type="button"
          className="chat-qsheet-iconbtn"
          aria-label={collapsed ? (ko ? "펼치기" : "Expand") : ko ? "접기" : "Collapse"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? "▴" : "▾"}
        </button>
        <button type="button" className="chat-qsheet-iconbtn" aria-label={ko ? "닫기" : "Dismiss"} onClick={onDismiss}>
          ✕
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="chat-qsheet-opts">
            {q.options.map((opt, i) => {
              const on = (selected[q.id] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className="chat-qsheet-opt"
                  data-selected={on ? "true" : "false"}
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={on}
                  onClick={() => pick(opt.label)}
                >
                  <span className="chat-qsheet-opt-body">
                    <strong>{opt.label}</strong>
                    {opt.description && <span>{opt.description}</span>}
                  </span>
                  <kbd className="chat-qsheet-opt-key">{i + 1}</kbd>
                </button>
              );
            })}
            {/* 기타 — 자유입력 */}
            <div
              className="chat-qsheet-opt chat-qsheet-other"
              data-selected={(notes[q.id] ?? "").trim() ? "true" : "false"}
            >
              <span className="chat-qsheet-opt-body">
                <strong>{ko ? "기타" : "Other"}</strong>
              </span>
              <kbd className="chat-qsheet-opt-key">{q.options.length + 1}</kbd>
            </div>
            <input
              ref={otherInputRef}
              value={notes[q.id] ?? ""}
              onChange={(e) => {
                const nextValue = e.target.value;
                setNotes((prev) => ({ ...prev, [q.id]: nextValue }));
                if (!q.multiSelect && nextValue.trim()) {
                  setSelected((prev) => ({ ...prev, [q.id]: [] }));
                }
              }}
              placeholder={ko ? "여기에 답변을 입력하세요" : "Type your answer here"}
              className="chat-qsheet-other-input"
            />
          </div>

          <div className="chat-qsheet-foot">
            {busy && (
              <span className="chat-qsheet-hint">
                {ko ? "실행이 정리되면 전송돼요 — 답은 지금 골라두세요." : "Sends when the run settles — pick answers now."}
              </span>
            )}
            <button type="button" className="chat-qsheet-skip" onClick={skip}>
              {ko ? "건너뛰기" : "Skip"}
            </button>
            <button
              type="button"
              className="chat-qsheet-next"
              disabled={isLast ? busy || !hasAnyAnswer : !currentAnswered}
              onClick={next}
            >
              {nextLabel} ↵
            </button>
          </div>
        </>
      )}
    </div>
  );
}
