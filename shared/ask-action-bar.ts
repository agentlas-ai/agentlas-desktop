/**
 * The action row under a question card: what every button will actually do,
 * and why a button is off.
 *
 * Owner report 2026-09-27 (desktop 1.2.44/1.2.45, One): a multi-select question card,
 * "추가 항목", sat above the composer and no click ever advanced it. In One's compact
 * card a multi-select pick only toggled a highlight, and the card had no Submit,
 * no Skip and no free-text row, so the answer could never leave the screen. When the
 * owner then typed a new message, the card stayed up while that message was
 * "Preparing". A single-select click then committed the old question's answer next
 * to the new request, and One reported that it could not tell whether the new request
 * had been admitted.
 *
 * References for the row (researched 2026-09-27):
 *  - Paseo question card: checkboxes for multi-select, an "Other" text field, and
 *    Submit / Skip / Dismiss below the options. Its multi-select joins the checked
 *    labels with the Other text using ", " (getpaseo/paseo#4370).
 *  - Claude Code AskUserQuestion: an Other choice that sends the typed text instead
 *    of the word "Other", multi-select answers joined with ", ", number keys to
 *    pick, and a general `response` path for a reply that is not an answer to a
 *    specific question (our "send as a new message").
 *
 * The screen and the contract test call these same functions. If a label and its
 * action disagree, one place is wrong, not two.
 */

export type AskActionBlock =
  /** The question is current and answerable here. */
  | "none"
  /** A run is executing in this conversation; answering would start a second one. */
  | "running"
  /** The person already sent a newer message (or one is being admitted). */
  | "newer_message"
  /** This task cannot start execution from here. */
  | "read_only";

export interface AskActionBarInput {
  multiSelect: boolean;
  selectedCount: number;
  freeText: string;
  block: AskActionBlock;
}

export type AskPrimaryAction = "submit" | "resend";
export type AskSecondaryAction = "skip" | "dismiss";

export type AskDisabledReason =
  | "pick_or_type"
  | "type_or_pick_to_send"
  | "read_only";

export interface AskActionBarState {
  /** Option rows can be pressed (selection is local and always safe). */
  optionsEnabled: boolean;
  /** Pressing a single-select option sends it at once. */
  singleClickSubmits: boolean;
  primary: {
    action: AskPrimaryAction;
    enabled: boolean;
    /** How many things this press will send (selected options + typed text). */
    count: number;
    reason: AskDisabledReason | null;
  };
  secondary: { action: AskSecondaryAction; enabled: boolean };
  /** Why the card cannot answer directly, shown above the row. */
  notice: Exclude<AskActionBlock, "none"> | null;
}

export function askActionBarState(input: AskActionBarInput): AskActionBarState {
  const typed = input.freeText.trim().length > 0;
  const count = Math.max(0, input.selectedCount) + (typed ? 1 : 0);
  if (input.block === "read_only") {
    return {
      optionsEnabled: false,
      singleClickSubmits: false,
      primary: { action: "submit", enabled: false, count, reason: "read_only" },
      secondary: { action: "dismiss", enabled: true },
      notice: "read_only",
    };
  }
  if (input.block === "running" || input.block === "newer_message") {
    // The question can no longer take a direct answer. Selection still works,
    // and the answer goes out as a new message through the normal composer path,
    // which knows how to queue or steer. It is never silently dropped.
    return {
      optionsEnabled: true,
      singleClickSubmits: false,
      primary: {
        action: "resend",
        enabled: count > 0,
        count,
        reason: count > 0 ? null : "type_or_pick_to_send",
      },
      secondary: { action: "dismiss", enabled: true },
      notice: input.block,
    };
  }
  return {
    optionsEnabled: true,
    singleClickSubmits: !input.multiSelect,
    primary: {
      action: "submit",
      enabled: count > 0,
      count,
      reason: count > 0 ? null : "pick_or_type",
    },
    secondary: { action: "skip", enabled: true },
    notice: null,
  };
}

/** The exact reply text the agent receives for picked labels plus typed text. */
export function composeAskAnswer(labels: readonly string[], freeText: string): string {
  const parts = labels.map((label) => label.trim()).filter(Boolean);
  const typed = freeText.trim();
  if (typed) parts.push(typed);
  return parts.join(", ");
}

/** The reply the agent receives when the person skips the question. */
export function askSkipReply(locale: "ko" | "en", question: string): string {
  const q = question.trim();
  return locale === "ko"
    ? `(건너뜀) "${q}" 질문에는 답하지 않겠습니다. 이 항목은 알아서 판단해서 진행해 주세요.`
    : `(Skipped) I'm not answering "${q}". Use your best judgment on this and continue.`;
}

/** An answer sent as a new message after the question went stale. */
export function askResendMessage(locale: "ko" | "en", question: string, answer: string): string {
  const q = question.trim();
  return locale === "ko"
    ? `앞선 질문 "${q}"에 대한 답: ${answer}`
    : `Answer to your earlier question "${q}": ${answer}`;
}

export interface AskTranscriptRow {
  id: string;
  durableMessageId?: string;
  role: "user" | "assistant" | "system";
  /** Durable rows only. Optimistic rows have none. */
  createdAt?: string;
}

/**
 * Has the person already said something after this question?
 *
 * Main's rule (electron/confirm pendingQuestionMessage) sees only durable rows.
 * The screen also sees the optimistic row of a message still being admitted.
 * The owner's report caught exactly that window: new message shown, "Preparing",
 * card still answerable.
 */
export function questionOutrunByNewerUserMessage(
  question: { sourceMessageId: string; createdAt?: string },
  rows: readonly AskTranscriptRow[],
): boolean {
  const index = rows.findIndex((row) => row.id === question.sourceMessageId
    || row.durableMessageId === question.sourceMessageId);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.role !== "user") continue;
    if (row.createdAt && question.createdAt) {
      // Both durable: time decides (rows written in the same instant are not "after").
      if (row.createdAt > question.createdAt) return true;
      continue;
    }
    if (index >= 0) {
      // An optimistic row placed after the question is a message the person just sent.
      if (i > index) return true;
      continue;
    }
    // The question row is not on screen and this row has no time: it is optimistic,
    // i.e. sent now, after any question that is still pending.
    if (!row.createdAt) return true;
  }
  return false;
}

type Copy = {
  submit: (count: number) => string;
  submitSingle: string;
  resend: string;
  skip: string;
  dismiss: string;
  other: string;
  otherNote: string;
  placeholder: string;
  reason: Record<AskDisabledReason, string>;
  notice: Record<Exclude<AskActionBlock, "none">, string>;
  hint: { single: string; multi: string };
};

export const ASK_ACTION_COPY: Record<"ko" | "en", Copy> = {
  ko: {
    submit: (count) => (count > 0 ? `제출 (${count}개)` : "제출"),
    submitSingle: "보내기",
    resend: "이 답을 새 메시지로 보내기",
    skip: "건너뛰기",
    dismiss: "닫기",
    other: "직접 입력",
    otherNote: "보기에 없는 답을 적습니다.",
    placeholder: "여기에 직접 답을 적으세요",
    reason: {
      pick_or_type: "하나 이상 고르거나 직접 입력하세요.",
      type_or_pick_to_send: "보낼 답을 고르거나 적어 주세요.",
      read_only: "이 작업은 지금 읽기 전용이라 여기서 답할 수 없어요.",
    },
    notice: {
      running: "실행이 진행 중이라 이 질문에 바로 답하면 두 번째 실행이 겹칩니다. 고른 답은 새 메시지로 보내면 진행 중인 실행에 전달됩니다.",
      newer_message: "이 질문 뒤에 새 메시지를 보냈어요. 에이전트는 이제 새 메시지를 처리합니다. 이 답이 여전히 필요하면 새 메시지로 보내세요.",
      read_only: "이 작업은 지금 읽기 전용이라 여기서 답할 수 없어요.",
    },
    hint: { single: "숫자 키로 고르면 바로 보내집니다 · Esc 닫기", multi: "숫자 키로 고르고 Enter로 제출 · Esc 닫기" },
  },
  en: {
    submit: (count) => (count > 0 ? `Submit (${count})` : "Submit"),
    submitSingle: "Send",
    resend: "Send this answer as a new message",
    skip: "Skip",
    dismiss: "Close",
    other: "Other",
    otherNote: "Type an answer that is not listed.",
    placeholder: "Type your own answer here",
    reason: {
      pick_or_type: "Pick at least one option or type an answer.",
      type_or_pick_to_send: "Pick or type the answer you want to send.",
      read_only: "This task is read-only right now, so it cannot be answered here.",
    },
    notice: {
      running: "A run is in progress, so answering here would start a second one. Send your answer as a new message and it reaches the running work.",
      newer_message: "You sent a newer message after this question, and the agent is working on that now. If this answer still matters, send it as a new message.",
      read_only: "This task is read-only right now, so it cannot be answered here.",
    },
    hint: { single: "Press a number to send it · Esc to close", multi: "Press numbers to pick, Enter to submit · Esc to close" },
  },
};
