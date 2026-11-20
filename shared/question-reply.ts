import { composeDeclaredPrompt, type PromptOrderingMetadata } from "../electron/runtime/prompt-order";
import type { QuestionDecisionQuestion } from "./question-decision";

export const QUESTION_REPLY_MODULE = {
  id: "question.reply.owner-answer", revision: 1, stability: "turn-context",
  changeTriggers: ["owner-input", "locale", "model-output"],
} as const satisfies PromptOrderingMetadata;
export const QUESTION_REPLY_FORMULA = {channel:"question.reply.user",revision:1,modules:[QUESTION_REPLY_MODULE.id]} as const;

export type QuestionReplyQuestion = Omit<QuestionDecisionQuestion,"multiSelect"> & {multiSelect?:boolean};

export interface QuestionSheetAnswer {
  questionId: string;
  answers: string[];
}

export function composeQuestionReply(
  questions: QuestionReplyQuestion[],
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
  return { reply: composeDeclaredPrompt(QUESTION_REPLY_FORMULA.modules.map(id=>({...QUESTION_REPLY_MODULE,id,text:chunks.join("\n\n")}))), perQuestion };
}


/** The hidden lock mark of a question that closed without an answer (the stream does not draw it). */
export const QUESTION_NOT_ANSWERED_MARK = "—";

/**
 * What a question holds once the owner has written something after it and no answer was received for it.
 * Only the card's own reply (the scaffold above) answers a question; anything else the owner typed is a newer message, the same as in Main
 * (a question with a newer owner message is stale and takes no answer) and in the card's own notice. The question closes unanswered instead
 * of showing that message as its answer.
 */
export function questionsAfterOwnerReply<Q extends { question: string; answer?: string[] }>(questions: readonly Q[], replyText: string): Q[] {
  const scaffold = parseQuestionBatchReply(replyText);
  return questions.map((q) => {
    if (q.answer && q.answer.length) return q;
    const match = scaffold?.find((chunk) => chunk.question === q.question.trim());
    return { ...q, answer: match && match.answers.length ? match.answers : [QUESTION_NOT_ANSWERED_MARK] };
  });
}

/** 배치 답장 스캐폴드 파서 — "질문:" 시작 청크마다 {question, answers(선택+답변)}로 분해.
 *  스캐폴드 형식이 아니면 null → 기존 줄 분해 폴백. */
export function parseQuestionBatchReply(text: string): Array<{ question: string; answers: string[] }> | null {
  const trimmed = text.trim();
  if (!/^(질문|Question): /.test(trimmed)) return null;
  const chunks = trimmed.split(/\n\n+/);
  const parsed: Array<{ question: string; answers: string[] }> = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const qLine = lines.find((l) => /^(질문|Question): /.test(l));
    if (!qLine) continue;
    const question = qLine.replace(/^(질문|Question): /, "").trim();
    const answers: string[] = [];
    for (const line of lines) {
      const m = line.match(/^(선택|답변|Selected|Answer): (.*)$/);
      if (!m) continue;
      if (m[1] === "선택" || m[1] === "Selected") {
        answers.push(...m[2].split(",").map((s) => s.trim()).filter(Boolean));
      } else {
        const note = m[2].trim();
        if (note) answers.push(note);
      }
    }
    parsed.push({ question, answers });
  }
  return parsed.length > 0 ? parsed : null;
}


export interface QuestionDecisionAnswer {
  questionId: string;
  selectedIndexes: number[];
  note: string;
}

/** Structured answers are rebound to the host's canonical bank before composing existing reply text. */
export function composeQuestionDecisionReply(
  questions: readonly QuestionDecisionQuestion[], answers: readonly QuestionDecisionAnswer[], ko: boolean,
): { reply: string; perQuestion: QuestionSheetAnswer[] } {
  if (!Array.isArray(answers) || answers.length > questions.length) throw new Error("question-answers-invalid");
  const byId = new Map(questions.map(question => [question.id, question]));
  const selected: Record<string,string[]> = {}, notes: Record<string,string> = {};
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)
      || Object.keys(answer).some(key => !["questionId","selectedIndexes","note"].includes(key))
      || typeof answer.questionId !== "string" || seen.has(answer.questionId)
      || !Array.isArray(answer.selectedIndexes) || typeof answer.note !== "string") throw new Error("question-answers-invalid");
    const question = byId.get(answer.questionId);
    if (!question || answer.selectedIndexes.some((index:number, offset:number) => !Number.isSafeInteger(index)
      || index < 0 || index >= question.options.length || answer.selectedIndexes.indexOf(index) !== offset)
      || (!question.multiSelect && answer.selectedIndexes.length > 1)) throw new Error("question-answers-invalid");
    seen.add(answer.questionId);
    selected[answer.questionId] = answer.selectedIndexes.map((index:number) => question.options[index].label);
    notes[answer.questionId] = answer.note;
  }
  return composeQuestionReply([...questions],selected,notes,ko);
}
