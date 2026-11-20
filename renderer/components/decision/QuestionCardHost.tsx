"use client";
// THE question card (feature registry "question-card"). Every question the app asks a person - a model's <<agentlas-ask>> fence in Work, a One decision
// question, the personal agent's question, a teammate's question in a room, a tool's ask_user - is drawn by this file and nothing else. A surface hands it the
// questions and the callbacks; it owns the look (AskCard), the keys, the answer text, and what X and "Skip" do, so the same action gives the same result on
// every surface.
//
// What the card does (the sheet's state machine):
//   choose / type  -> onConfirm(reply)                      the person's own words as the next message
//   Skip           -> onSkip(), or by default onConfirm(askSkipReply)   the agent learns it was skipped and decides itself
//   X / Escape     -> onDismiss()                           closed: nothing is sent, no run stops; the surface keeps a "Reopen" line (ClosedQuestionLine)
//
// Kept from the first implementation (Claude Code desktop question-card style):
//  - head: "1/2 - " + the question, collapse (v) and close (x) on the right; options are divided rows; the last "Other" row is the input itself
//  - below: [Skip][Submit], a "Input needed" chip under the card; number keys pick
//  - sending is one batch; choosing and typing are local state and work while a run is streaming: the parent saves the answer in Main and continues when
// the run settles (HMG room: a card that held the answer waiting for `busy` to clear never delivered it)
//  - the reply scaffolding follows the UI locale, never the language the person typed
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useT, tFor } from "@/lib/i18n";
import { AskCard } from "@/components/AskCard";
import { IconChat, IconReply } from "@/components/Icon";
import { ComposerDecisionPortal, decisionKeysBelongHere } from "@/components/ComposerDecisionPortal";
import { QUESTION_CARD_ATTRS, type QuestionCardSource } from "@/lib/question-cards";
import {
  ASK_ACTION_COPY,
  askActionBarState,
  askResendMessage,
  askSkipReply,
  composeAskAnswer,
  type AskActionBlock,
} from "@shared/ask-action-bar";
import { composeQuestionReply, type QuestionSheetAnswer } from "@shared/question-reply";

export { composeQuestionReply, type QuestionSheetAnswer } from "@shared/question-reply";

/** One question of a card: the same shape every source is normalised to (lib/question-cards.ts). */
export interface HostQuestion {
  id: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/**
 * The drawn card with its registration marks: the ONE place that puts an AskCard on screen for a question. A card whose answering is not the
 * multi-question flow (a tool's ask_user, which answers at once and can time out) draws through this frame, so its look, its marks and its X are the same.
 */
export function QuestionCardFrame({ source, ...card }: { source: QuestionCardSource } & ComponentProps<typeof AskCard>) {
  return (
    <div {...QUESTION_CARD_ATTRS} data-question-source={source} className="titlebar-nodrag">
      <AskCard {...card} />
    </div>
  );
}

export function QuestionCardHost({
  source,
  questions,
  initialReply,
  busy = false,
  onConfirm,
  onRetryCommitted,
  onDismiss,
  onSkip,
  block = "none",
  onResend,
  autoDelivering = false,
  chatId,
  keysActive = true,
  replyStyle = "scaffold",
  portal = true,
  locked = false,
}: {
  source: QuestionCardSource;
  /** The questions waiting for an answer (the newest batch). */
  questions: HostQuestion[];
  /** Main accepted this exact answer but its continuation did not start. */
  initialReply?: string;
  /** A running turn locks only the final send (choosing stays allowed). */
  busy?: boolean;
  onConfirm: (reply: string, perQuestion: QuestionSheetAnswer[]) => void;
  /** Retry only the existing Main-owned continuation; never create a new answer. */
  onRetryCommitted?: () => void;
  /** X / Escape: close this batch without answering (nothing is sent). */
  onDismiss: () => void;
  /** Skip when it is not "tell the agent it was skipped" (default: send askSkipReply through onConfirm). */
  onSkip?: () => void;
  /** Why this question cannot take a direct answer now (shared/ask-action-bar). A newer message after it: "newer_message". */
  block?: AskActionBlock;
  /** A blocked question's answer goes as a new message (the composer's own send path). */
  onResend?: (text: string) => void;
  /** The saved answer (initialReply) continues by itself as soon as the chat is free: say so instead of asking for Retry. */
  autoDelivering?: boolean;
  /** The conversation that asked: the card is drawn in that conversation's own composer, and only that pane's keys answer it. */
  chatId?: string | null;
  /** False in a pane that does not hold the keyboard: the document's number/Enter/Esc keys answer only the focused pane's card. */
  keysActive?: boolean;
  /**
   * What the reply looks like. "scaffold": the labelled batch text Main parses back into answers (a fence's questions). "plain": the chosen labels and
   * the typed words, which is what a Main decision matches against its options.
   */
  replyStyle?: "scaffold" | "plain";
  /** False when the surface already sits inside the composer's decision slot. */
  portal?: boolean;
  /** The surface cannot take an answer right now (a reply is streaming, an attachment is being prepared): the options show but do not answer. */
  locked?: boolean;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Keys come from the document: the card's wrapper div cannot take focus, so an onKeyDown on it was never called.
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const keysActiveRef = useRef(keysActive);
  keysActiveRef.current = keysActive;
  const key = `${questions.map((q) => q.id).join("|")}\0${initialReply ?? ""}`;

  // A new batch resets the local state. The card holds no answer (a sent answer is already in the parent and Main).
  useEffect(() => {
    setSelected({});
    setNotes({});
    setActive(0);
    setCollapsed(false);
  }, [key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (keysActiveRef.current) keyHandlerRef.current(event); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const compose = (sel: Record<string, string[]>, nts: Record<string, string>): { reply: string; perQuestion: QuestionSheetAnswer[] } => {
    const scaffold = composeQuestionReply(questions, sel, nts, ko);
    if (replyStyle === "scaffold") return scaffold;
    // Plain: what the person chose and typed, nothing around it (a single question's answer; several are joined by " / ").
    const parts = scaffold.perQuestion.map((item) => composeAskAnswer(item.answers, ""));
    return { reply: parts.join(" / "), perQuestion: scaffold.perQuestion };
  };
  const composed = useMemo(
    () => compose(selected, notes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, selected, notes, ko, replyStyle],
  );
  const q = questions[Math.min(active, questions.length - 1)];
  const isLast = active >= questions.length - 1;
  const currentAnswered = q ? (selected[q.id]?.length ?? 0) > 0 || Boolean((notes[q.id] ?? "").trim()) : false;
  const hasAnyAnswer = composed.reply.trim().length > 0;

  if (initialReply?.trim()) {
    // This is an immutable accepted answer, not an editable draft. Its text format cannot unambiguously recover question boundaries from quoted
    // headings, so display the canonical bytes and retry its original run.
    keyHandlerRef.current = () => {};
    const wrapped = (
      <div className="titlebar-nodrag" ref={rootRef} data-composer-decision-card="true">
        <QuestionCardFrame
          source={source}
          title={tFor(ko ? "ko" : "en", "question.saved.title")}
          locale={ko ? "ko" : "en"}
          onClose={onDismiss}
          options={[{
            id: "retry-committed",
            title: busy || autoDelivering ? tFor(ko ? "ko" : "en", "question.saved.auto") : tFor(ko ? "ko" : "en", "question.saved.retry"),
            disabled: busy || !onRetryCommitted,
          }]}
          onChoose={() => { if (!busy) onRetryCommitted?.(); }}
        >
          <p style={{ margin: "0 0 12px" }}>
            {autoDelivering
              ? tFor(ko ? "ko" : "en", "question.saved.autoBody")
              : onRetryCommitted
              ? tFor(ko ? "ko" : "en", "question.saved.retryBody")
              : tFor(ko ? "ko" : "en", "question.saved.lostBody")}
          </p>
          <pre data-committed-question-reply="true" tabIndex={0} style={{
            margin: "0 0 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            maxHeight: "min(320px, 35vh)", overflow: "auto", font: "inherit",
          }}>{initialReply}</pre>
        </QuestionCardFrame>
      </div>
    );
    return portal ? <ComposerDecisionPortal enabled chatId={chatId}>{wrapped}</ComposerDecisionPortal> : wrapped;
  }

  if (questions.length === 0 || !q) {
    keyHandlerRef.current = () => {};
    return null;
  }

  /*
   * A send judges the state it has JUST set, never the render before: an answer typed into the last question went missing, and a one-question card did
   * nothing after Enter.
   */
  const copy = ASK_ACTION_COPY[ko ? "ko" : "en"];
  const multi = Boolean(q.multiSelect);
  const currentNote = notes[q.id] ?? "";
  const currentPicks = selected[q.id] ?? [];
  // One place decides the action row (shared/ask-action-bar.ts): Submit (N), Skip, typed answer, why it is blocked, send as a new message.
  const bar = askActionBarState({
    multiSelect: multi,
    selectedCount: !multi && currentNote.trim() ? 0 : currentPicks.length,
    freeText: currentNote,
    block,
  });
  const stale = bar.primary.action === "resend";
  const optionsEnabled = bar.optionsEnabled && !locked;

  const submitWith = (sel: Record<string, string[]>, nts: Record<string, string>) => {
    const c = compose(sel, nts);
    if (!c.reply.trim()) return;
    if (stale) {
      onResend?.(askResendMessage(ko ? "ko" : "en", questions.map((item) => item.question).join(" / "), c.reply));
      return;
    }
    // A running turn does not hold the answer here: the parent saves it in Main now and continues it when the run settles.
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
    // An earlier answer is sent. With nothing answered, "skipped" is the answer: closing quietly would leave the agent waiting for ever.
    if (hasAnyAnswer) { submit(); return; }
    if (onSkip) { onSkip(); return; }
    onConfirm(askSkipReply(ko ? "ko" : "en", questions.map((item) => item.question).join(" / ")), []);
  };

  /** The next state after a pick (so a send can judge it at once). */
  const pickNext = (label: string): { sel: Record<string, string[]>; nts: Record<string, string> } => {
    const cur = selected[q.id] ?? [];
    const nts = q.multiSelect ? notes : { ...notes, [q.id]: "" };
    const sel = q.multiSelect
      ? { ...selected, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
      // Single-select options submit immediately. Keep an already-selected option selected so a failed save can be retried with the same click.
      : { ...selected, [q.id]: [label] };
    return { sel, nts };
  };

  const pick = (label: string) => {
    if (!optionsEnabled) return { sel: selected, nts: notes };
    const { sel, nts } = pickNext(label);
    setSelected(sel);
    setNotes(nts);
    return { sel, nts };
  };

  const choose = (label: string) => {
    if (!optionsEnabled) return;
    const { sel, nts } = pick(label);
    // A single choice is the answer the moment it is picked. A blocked question (a newer message came after it) only keeps the pick; the main
    // button then sends it as a new message.
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
    // Every pane's card listens on the document; a key belongs to the pane that holds the focus.
    if (!decisionKeysBelongHere(rootRef.current, e.target)) return;
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
    // A folded card shows no options: a number or Enter must not send an answer nobody can see (Escape is handled above).
    if (collapsed) return;
    // Another asking card (a tool approval) holds the focus: it is its turn.
    const focused = document.activeElement as HTMLElement | null;
    if (focused?.closest("[data-ask-card]") && !rootRef.current?.contains(focused)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      choose(q.options[n - 1].label);
      return;
    }
    // The "Other" badge number focuses the free text (the badge is not decoration).
    if (n === q.options.length + 1) {
      e.preventDefault();
      rootRef.current?.querySelector("input")?.focus();
      return;
    }
    if (e.key === "Enter") {
      // A focused option button answers with its own default activation; preventing it here made the keyboard unable to pick.
      if (target?.closest("button")) return;
      e.preventDefault();
      if (primaryEnabled) next();
    }
  };
  keyHandlerRef.current = handleKey;

  // Several questions: the title says which one of how many (1/2). One asking card everywhere.
  const stepPrefix = questions.length > 1 ? `${active + 1}/${questions.length} · ` : "";
  const primaryLabel = stale
    ? copy.resend
    : !isLast
      ? tFor(ko ? "ko" : "en", "question.next")
      : busy
        ? tFor(ko ? "ko" : "en", "question.sendsWhenSettled")
        : multi ? copy.submit(bar.primary.count) : copy.submitSingle;
  const secondaryLabel = stale ? copy.dismiss : copy.skip;
  const card = (
    <div className="titlebar-nodrag" ref={rootRef} data-composer-decision-card="true" data-work-question-block={block} data-one-question-block={block}>
      <QuestionCardFrame
        source={source}
        // A new question gets a fresh free-text box: what was typed for the one before must not stay in the next.
        key={q.id}
        title={`${stepPrefix}${q.header?.trim() || q.question}`}
        subtitle={q.header?.trim() ? q.question : undefined}
        locale={ko ? "ko" : "en"}
        onClose={onDismiss}
        // Closing is not an answer and not a stop: nothing is sent, the run is untouched, and a message typed below continues the conversation.
        closeLabel={tFor(ko ? "ko" : "en", "question.closeLabel")}
        // Folding leaves the title row so the conversation under it shows again. A folded card still waits for its answer.
        collapsible
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        options={q.options.map((opt) => ({
          id: opt.label,
          title: opt.label,
          note: opt.description ?? undefined,
          disabled: !optionsEnabled,
          active: currentPicks.includes(opt.label),
          ...(multi ? { checked: currentPicks.includes(opt.label) } : {}),
        }))}
        otherOption={optionsEnabled ? { title: copy.other, note: copy.otherNote } : undefined}
        freeText={currentNote}
        onFreeTextChange={(value) => {
          setNotes((current) => ({ ...current, [q.id]: value }));
          // In a single-choice question typed words replace the chosen option.
          if (!multi && value.trim()) setSelected((current) => ({ ...current, [q.id]: [] }));
        }}
        onChoose={(id) => choose(id)}
        data-testid="work-question-ask-card"
        statusLabel={copy.needsInput}
        footer={optionsEnabled ? {
          placeholder: copy.placeholder,
          skipLabel: copy.skip,
          // With a chosen option this button sends instead of skipping - its label must say so.
          hasSelection: currentAnswered,
          submitLabel: primaryLabel,
          hideButton: true,
          onSkip: (typed) => { if (typed || primaryEnabled) runPrimary(typed); },
        } : undefined}
        actionRow={{
          notice: bar.notice ? copy.notice[bar.notice] : null,
          reason: primaryEnabled ? null : bar.primary.reason ? copy.reason[bar.primary.reason] : null,
          hint: stale ? null : multi ? copy.hint.multi : copy.hint.single,
          secondary: { id: stale ? "dismiss" : "skip", label: secondaryLabel, disabled: !bar.secondary.enabled },
          primary: { id: stale ? "resend" : isLast ? "submit" : "next", label: primaryLabel, disabled: !primaryEnabled },
          onAction: (id, typed) => {
            if (id === "skip" || id === "dismiss") skip();
            else runPrimary(typed);
          },
        }}
      />
    </div>
  );
  return portal ? <ComposerDecisionPortal enabled chatId={chatId}>{card}</ComposerDecisionPortal> : card;
}

// Where a question card was closed with its X: how many are left, and the way back. Every surface draws this one line.
export function ClosedQuestionLine({ count, onReopen }: { count: number; onReopen: () => void }) {
  const { locale } = useT();
  return (
    <div data-feature="question-card" data-impl="question-card-host" data-question-closed="true" role="status"
      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: 0.8, padding: "4px 2px" }}>
      <IconChat size={13} aria-hidden="true" />
      <span>{tFor(locale, "question.closed.line", { count })}</span>
      <button type="button" className="btn" data-question-reopen="true" title={tFor(locale, "question.reopen")} aria-label={tFor(locale, "question.reopen")} onClick={onReopen}>
        <IconReply size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
