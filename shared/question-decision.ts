import { extractAskFences, type AgentlasAskQuestion } from "./ask-fence-flatten";

/** A presentation only. Neither a question nor any of its IDs grants execution. */
export type QuestionDecisionQuestion = AgentlasAskQuestion & { id: string };
export interface QuestionDecisionView {
  schema: "agentlas.question-decision.v1";
  chatId: string;
  sourceRunId: string;
  sourceMessageId: string;
  sourceMessageSha256: string;
  questionBankSha256: string;
  createdAt: string;
  awaitingOwner: boolean;
  /** Legacy rows stay visible without manufacturing missing execution authority. */
  readOnlyReason?: "legacy-source-reference" | "legacy-control-fence" | "control-changed" | "host-unavailable";
  questions: QuestionDecisionQuestion[];
  committed?: { reply: string; continuationRunId: string; ts: string };
}

/** Same parser and message-scoped identities on every consumer, including partial text. */
export function projectQuestionDecisionText(text: string, messageId: string): {
  text: string; questions: QuestionDecisionQuestion[];
} {
  const projected = extractAskFences(text);
  return { text: projected.text, questions: projected.questions.map((question, index) => ({
    ...question, id: `${messageId}-q${index}`,
  })) };
}

/** Closed canonical bytes for the host's bank digest; not model-written JSON identity. */
export function questionDecisionBankJson(view: Pick<QuestionDecisionView,
  "chatId" | "sourceRunId" | "sourceMessageId" | "sourceMessageSha256" | "questions">): string {
  return JSON.stringify({ chatId: view.chatId, sourceRunId: view.sourceRunId,
    sourceMessageId: view.sourceMessageId, sourceMessageSha256: view.sourceMessageSha256,
    questions: view.questions.map(question => ({ id: question.id, question: question.question,
      ...(question.header ? {header: question.header} : {}), multiSelect: question.multiSelect,
      options: question.options.map(option => ({label: option.label,
        ...(option.description ? {description: option.description} : {})})),
    })),
  });
}
