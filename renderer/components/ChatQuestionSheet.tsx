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
import { AskCard } from "@/components/AskCard";

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

  const submitFreeText = (freeText: string) => {
    const answer = freeText.trim();
    if (!answer) {
      skip();
      return;
    }
    // Do not wait for setNotes() before submitting the last question: React
    // state updates are batched, so the old hasAnyAnswer value would make an
    // Enter press silently look like a skipped/empty answer.
    if (isLast && !busy) {
      const nextNotes = { ...notes, [q.id]: answer };
      const nextSelected = !q.multiSelect ? { ...selected, [q.id]: [] } : selected;
      const nextComposed = composeQuestionReply(questions, nextSelected, nextNotes, ko);
      if (nextComposed.reply.trim()) onConfirm(nextComposed.reply, nextComposed.perQuestion);
      return;
    }
    setNotes((prev) => ({ ...prev, [q.id]: answer }));
    if (!q.multiSelect) setSelected((prev) => ({ ...prev, [q.id]: [] }));
    next();
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
      if (e.key === "Enter") {
        e.preventDefault();
        if (currentAnswered || (isLast && hasAnyAnswer)) next();
      }
    }
  };

  const nextLabel = isLast ? (ko ? "제출" : "Submit") : ko ? "다음" : "Next";

  /*
   * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
   * 여러 질문이면 제목에 1/2 처럼 몇 번째인지 붙는다.
   * 규격은 docs/DESIGN-ASK-CARD.md.
   */
  const stepPrefix = questions.length > 1 ? `${active + 1}/${questions.length} · ` : "";
  return (
    <div className="titlebar-nodrag" onKeyDown={onKeyDown}>
      <AskCard
        title={`${stepPrefix}${q.question}`}
        locale={ko ? "ko" : "en"}
        onClose={onDismiss}
        options={q.options.map((opt) => ({
          id: opt.label,
          title: opt.label,
          note: opt.description ?? undefined,
          active: (selected[q.id] ?? []).includes(opt.label),
        }))}
        onChoose={(id) => {
          pick(id);
          // 하나만 고르는 질문은 고르는 순간이 답이다.
          if (!q.multiSelect) next();
        }}
        footer={{
          placeholder: ko ? "여기에 답변을 입력하세요" : "Type your answer here",
          skipLabel: busy
            ? (ko ? "실행이 정리되면 전송" : "Sends when settled")
            : (ko ? "건너뛰기" : "Skip"),
          onSkip: (freeText) => {
            submitFreeText(freeText);
          },
        }}
      />
    </div>
  );
}
