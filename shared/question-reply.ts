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
