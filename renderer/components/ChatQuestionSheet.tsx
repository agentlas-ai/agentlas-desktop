"use client";
// 챗 질문 시트 — Claude 데스크탑 질문 카드 스타일:
//  · 헤더: "1/2" 진행 칩 + 질문 한 줄, 우측에 접기(v)·닫기(×)
//  · 옵션: 회색 행(제목+설명) + 우측 숫자 배지, 마지막은 "기타" + 아래 자유입력
//  · 푸터: 단추 하나 — 답한 것(고른 보기 또는 자유입력)이 없으면 "건너뛰기", 있으면
//    "다음 질문"(뒤에 질문이 더 있을 때) 또는 "이 답 보내기"(마지막 질문). 질문은 한 번에 하나
//  · 전송은 배치 1회: 질문 하나 답할 때마다 프롬프트로 쏘지 않는다(질문 꼬리물기 방지)
//  · 선택/입력은 로컬 상태 — 스트리밍 중에도 즉시 클릭 가능, 최종 전송만 busy에 묶인다
//  · 답장 스캐폴딩은 UI locale — 입력 언어 고착 방지
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatQuestion } from "@/components/ChatStream";
import { useT } from "@/lib/i18n";
import { AskCard } from "@/components/AskCard";
import { ComposerDecisionPortal } from "@/components/ComposerDecisionPortal";
import {
  ASK_ACTION_COPY,
  askActionBarState,
  askResendMessage,
  askSkipReply,
  type AskActionBlock,
} from "@shared/ask-action-bar";

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
  initialReply,
  busy,
  onConfirm,
  onRetryCommitted,
  onDismiss,
  block = "none",
  onResend,
}: {
  /** 현재 답변 대기 중인(unanswered) 질문들 — 최신 어시스턴트 메시지 기준. */
  questions: ChatQuestion[];
  /** Main accepted this exact answer but its continuation did not start. */
  initialReply?: string;
  /** 실행 중이면 최종 전송만 잠근다(선택은 허용). */
  busy: boolean;
  onConfirm: (reply: string, perQuestion: QuestionSheetAnswer[]) => void;
  /** Retry only the existing Main-owned continuation; never create a new answer. */
  onRetryCommitted?: () => void;
  /** ×로 닫기 — 이 배치를 답하지 않고 접는다(전송 없음). */
  onDismiss: () => void;
  /** 이 질문에 지금 바로 답할 수 없는 이유(shared/ask-action-bar). 새 메시지 뒤면 "newer_message". */
  block?: AskActionBlock;
  /** 막힌 질문의 답을 새 메시지로 보낸다(작성창과 같은 전송 경로). */
  onResend?: (text: string) => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  // 실행 중에 낸 답 — 실행이 정리되는 순간 그대로 보낸다(푸터 문구 "실행이 정리되면 전송"의 실체).
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 키는 document 에서 받는다. 시트를 감싼 div 는 포커스를 받을 수 없어 onKeyDown 이
  // 한 번도 불리지 않았다 — 새로 뜬 시트에서 숫자 배지도 Enter 도 무반응이었다(2026-09-03 실측).
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const key = `${questions.map((q) => q.id).join("|")}\0${initialReply ?? ""}`;

  // 새 질문 묶음이 오면 로컬 상태 초기화.
  useEffect(() => {
    setSelected({});
    setNotes({});
    setActive(0);
    setCollapsed(false);
    setPendingSubmit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const composed = useMemo(
    () => composeQuestionReply(questions, selected, notes, ko),
    [questions, selected, notes, ko],
  );
  const q = questions[Math.min(active, questions.length - 1)];
  const isLast = active >= questions.length - 1;
  const currentAnswered = q ? (selected[q.id]?.length ?? 0) > 0 || Boolean((notes[q.id] ?? "").trim()) : false;
  const hasAnyAnswer = composed.reply.trim().length > 0;

  // 실행 중에 제출한 답은 busy 가 풀리는 즉시 보낸다. 안 보내면 사용자는 Enter 를 두 번 쳐야 하고,
  // 그 사이 시트에는 "건너뛰기"만 보인다(2026-09-02 실측).
  useEffect(() => {
    if (initialReply?.trim() || !pendingSubmit || busy) return;
    if (!hasAnyAnswer) {
      setPendingSubmit(false);
      return;
    }
    setPendingSubmit(false);
    onConfirm(composed.reply, composed.perQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReply, pendingSubmit, busy, hasAnyAnswer, composed]);

  if (initialReply?.trim()) {
    // This is an immutable accepted answer, not an editable draft. Its text
    // format cannot unambiguously recover question boundaries from quoted
    // headings, so display the canonical bytes and retry its original run.
    keyHandlerRef.current = () => {};
    return (
      <ComposerDecisionPortal enabled>
      <div className="titlebar-nodrag" ref={rootRef} data-composer-decision-card="true">
        <AskCard
          title={ko ? "이미 저장된 답변" : "Previously saved answer"}
          locale={ko ? "ko" : "en"}
          onClose={onDismiss}
          options={[{
            id: "retry-committed",
            title: busy ? (ko ? "재개 중" : "Resuming") : (ko ? "기존 실행 다시 시도" : "Retry the existing run"),
            disabled: busy || !onRetryCommitted,
          }]}
          onChoose={() => { if (!busy) onRetryCommitted?.(); }}
        >
          <p style={{ margin: "0 0 12px" }}>
            {onRetryCommitted
              ? (ko ? "저장된 원문으로만 재시도합니다. 답변을 바꾸려면 닫은 뒤 새 메시지로 보내 주세요."
                : "Retry uses the saved text unchanged. To change your answer, close this card and send a new message.")
              : (ko ? "기존 실행 정보를 찾지 못해 여기서 재개할 수 없습니다. 닫은 뒤 새 메시지로 요청해 주세요."
                : "The original run is unavailable. Close this card and send a new message to make a new request.")}
          </p>
          <pre data-committed-question-reply="true" tabIndex={0} style={{
            margin: "0 0 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            maxHeight: "min(320px, 35vh)", overflow: "auto", font: "inherit",
          }}>{initialReply}</pre>
        </AskCard>
      </div>
      </ComposerDecisionPortal>
    );
  }

  if (questions.length === 0 || !q) {
    keyHandlerRef.current = () => {};
    return null;
  }

  /**
   * 전송은 반드시 "방금 반영한" 상태로 판단한다. 이전엔 setState 직후 렌더 전의 옛 composed 로
   * 판단해, 마지막 질문에 입력한 답이 통째로 빠진 채 전송되거나(여러 질문), 한 질문짜리 시트에선
   * 아무 일도 안 일어났다(2026-09-02 재현: 입력 후 Enter → 건너뛰기만 남음).
   */
  const copy = ASK_ACTION_COPY[ko ? "ko" : "en"];
  const multi = Boolean(q.multiSelect);
  const currentNote = notes[q.id] ?? "";
  const currentPicks = selected[q.id] ?? [];
  /*
   * 아래 동작 줄 판단은 One 과 같은 한 곳(shared/ask-action-bar.ts)이 한다 — 오너 2026-09-27:
   * "Work 질문 카드에도 같은 수리". 제출 (N개)·건너뛰기·직접 입력·막힌 이유·새 메시지로 보내기.
   */
  const bar = askActionBarState({
    multiSelect: multi,
    selectedCount: !multi && currentNote.trim() ? 0 : currentPicks.length,
    freeText: currentNote,
    block,
  });
  const stale = bar.primary.action === "resend";

  const submitWith = (sel: Record<string, string[]>, nts: Record<string, string>) => {
    const c = composeQuestionReply(questions, sel, nts, ko);
    if (!c.reply.trim()) return;
    if (stale) {
      onResend?.(askResendMessage(ko ? "ko" : "en", questions.map((item) => item.question).join(" / "), c.reply));
      return;
    }
    if (busy) {
      setPendingSubmit(true);
      return;
    }
    onConfirm(c.reply, c.perQuestion);
  };

  const submit = () => submitWith(selected, notes);

  const advanceWith = (sel: Record<string, string[]>, nts: Record<string, string>) => {
    if (isLast) submitWith(sel, nts);
    else setActive(active + 1);
  };

  const next = () => advanceWith(selected, notes);

  const skip = () => {
    if (stale) { onDismiss(); return; }
    if (!isLast) { setActive(active + 1); return; }
    // 앞 질문에 답한 것이 있으면 그것을 보낸다. 아무것도 안 답했으면 에이전트에 "건너뜀"을
    // 답으로 보낸다 — 조용히 접으면 에이전트는 영영 답을 기다린다(One 과 같은 규칙).
    if (hasAnyAnswer) { submit(); return; }
    if (busy) { onDismiss(); return; }
    onConfirm(
      askSkipReply(ko ? "ko" : "en", questions.map((item) => item.question).join(" / ")),
      [],
    );
  };

  /** 선택을 반영한 다음 상태를 돌려준다(전송 판단에 그대로 쓰기 위해). */
  const pickNext = (label: string): { sel: Record<string, string[]>; nts: Record<string, string> } => {
    const cur = selected[q.id] ?? [];
    const nts = q.multiSelect ? notes : { ...notes, [q.id]: "" };
    const sel = q.multiSelect
      ? { ...selected, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
      // Single-select options submit immediately. Keep an already-selected
      // option selected so a failed save can be retried with the same click.
      : { ...selected, [q.id]: [label] };
    return { sel, nts };
  };

  const pick = (label: string) => {
    const { sel, nts } = pickNext(label);
    setSelected(sel);
    setNotes(nts);
    return { sel, nts };
  };

  const choose = (label: string) => {
    const { sel, nts } = pick(label);
    // 하나만 고르는 질문은 고르는 순간이 답이다 — 방금 고른 상태로 판단·전송한다.
    // 막힌 질문(새 메시지 뒤)은 고른 상태로만 두고, 주 단추가 새 메시지로 보낸다.
    if (!q.multiSelect && sel[q.id]?.length && !stale) advanceWith(sel, nts);
  };

  const primaryEnabled = isLast ? (bar.primary.enabled || (!stale && hasAnyAnswer)) : currentAnswered;
  const runPrimary = (typed: string) => {
    const nts = typed !== currentNote ? { ...notes, [q.id]: typed } : notes;
    const sel = !multi && typed.trim() ? { ...selected, [q.id]: [] } : selected;
    if (nts !== notes) setNotes(nts);
    if (sel !== selected) setSelected(sel);
    const answeredNow = (sel[q.id]?.length ?? 0) > 0 || Boolean((nts[q.id] ?? "").trim());
    if (!isLast) { if (answeredNow) setActive(active + 1); return; }
    submitWith(sel, nts);
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    const target = e.target as HTMLElement | null;
    const inSheet = Boolean(target && rootRef.current?.contains(target));
    const tag = target?.tagName?.toLowerCase();
    const editable = tag === "input" || tag === "textarea" || tag === "select" || Boolean(target?.isContentEditable);
    if (e.key === "Escape" && (inSheet || !editable)) {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (editable) return;
    // 다른 묻는 카드(도구 승인 등)에 포커스가 있으면 그쪽 차례다.
    const focused = document.activeElement as HTMLElement | null;
    if (focused?.closest("[data-ask-card]") && !rootRef.current?.contains(focused)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      choose(q.options[n - 1].label);
      return;
    }
    // "기타" 배지 번호 — 자유입력에 포커스(배지가 장식이 되지 않게).
    if (n === q.options.length + 1) {
      e.preventDefault();
      rootRef.current?.querySelector("input")?.focus();
      return;
    }
    if (e.key === "Enter") {
      // 옵션 버튼에 포커스가 있으면 그 버튼의 기본 활성화가 답이다. 여기서 preventDefault 하면
      // 버튼이 눌리지도 다음으로 넘어가지도 않아 키보드만으로는 고를 수 없었다(2026-09-03 실측).
      if (target?.closest("button")) return;
      e.preventDefault();
      if (primaryEnabled) next();
    }
  };
  keyHandlerRef.current = handleKey;

  /*
   * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
   * 여러 질문이면 제목에 1/2 처럼 몇 번째인지 붙는다.
   * 규격은 docs/DESIGN-ASK-CARD.md.
   */
  const stepPrefix = questions.length > 1 ? `${active + 1}/${questions.length} · ` : "";
  const primaryLabel = stale
    ? copy.resend
    : !isLast
      ? (ko ? "다음 질문" : "Next question")
      : busy
        ? (ko ? "실행이 정리되면 전송" : "Sends when settled")
        : multi ? copy.submit(bar.primary.count) : copy.submitSingle;
  const secondaryLabel = stale ? copy.dismiss : copy.skip;
  return (
    <ComposerDecisionPortal enabled>
    <div className="titlebar-nodrag" ref={rootRef} data-composer-decision-card="true" data-work-question-block={block}>
      <AskCard
        // 질문이 바뀌면 자유입력칸도 새로 — 앞 질문에 친 글이 다음 질문에 그대로 남지 않게.
        key={q.id}
        title={`${stepPrefix}${q.header?.trim() || q.question}`}
        subtitle={q.header?.trim() ? q.question : undefined}
        locale={ko ? "ko" : "en"}
        onClose={onDismiss}
        options={q.options.map((opt) => ({
          id: opt.label,
          title: opt.label,
          note: opt.description ?? undefined,
          active: currentPicks.includes(opt.label),
          ...(multi ? { checked: currentPicks.includes(opt.label) } : {}),
        }))}
        otherOption={{ title: copy.other, note: copy.otherNote }}
        freeText={currentNote}
        onFreeTextChange={(value) => {
          setNotes((current) => ({ ...current, [q.id]: value }));
          // 하나만 고르는 질문에서 직접 입력은 고른 보기를 대신한다.
          if (!multi && value.trim()) setSelected((current) => ({ ...current, [q.id]: [] }));
        }}
        onChoose={(id) => choose(id)}
        data-testid="work-question-ask-card"
        footer={{
          placeholder: copy.placeholder,
          skipLabel: copy.skip,
          // 고른 보기가 있으면 이 단추는 건너뛰지 않고 보낸다 — 라벨도 그렇게 말해야 한다.
          hasSelection: currentAnswered,
          submitLabel: primaryLabel,
          hideButton: true,
          onSkip: (typed) => { if (typed || primaryEnabled) runPrimary(typed); },
        }}
        actionRow={{
          notice: bar.notice ? copy.notice[bar.notice] : null,
          reason: primaryEnabled ? null : bar.primary.reason ? copy.reason[bar.primary.reason] : null,
          hint: stale ? null : multi ? copy.hint.multi : copy.hint.single,
          secondary: { id: stale ? "dismiss" : "skip", label: secondaryLabel },
          primary: { id: stale ? "resend" : isLast ? "submit" : "next", label: primaryLabel, disabled: !primaryEnabled },
          onAction: (id, typed) => {
            if (id === "skip" || id === "dismiss") skip();
            else runPrimary(typed);
          },
        }}
      />
    </div>
    </ComposerDecisionPortal>
  );
}
