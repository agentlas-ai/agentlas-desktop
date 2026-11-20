import { askUser, type AskUserOption, type AskUserOutcome, type AskUserRequest } from "../confirm/ask-user";

/*
 * the target of a message between conversations is the id the HOST got from a person's choice, never a
 * word a model typed. When `message_send`'s `to` does not name exactly one conversation of the sender's project, the host puts the candidates to the owner
 * on a card - one button per candidate of the SAME project, plus "create a new conversation" - and only a button the host offered can name a target.
 * There is no free-text way in: the card asks with `allowFreeText: false`, and an answer that is not one of the offered labels (a typed line, a label
 * of another conversation) is read as "not picked". The card is the existing question card (confirm/ask-user.ts), answered on the sender's own
 * conversation pane and on a paired phone; no new surface, no table, no model call.
 */

export const PEER_PICK_MAX_OPTIONS = 8;   // ask-user.ts keeps at most 8 options: up to 7 conversations and the "new conversation" button

export type PeerPick =
  | { kind: "picked"; id: string }
  | { kind: "new_conversation" }
  | { kind: "closed"; why: "not_picked" | "declined" | "timeout" | "cancelled" | "no_surface" };

export interface PeerPickInput {
  fromChatId: string;
  /** What the model wrote in `to` (shown to the owner as the thing that was not found; never matched against anything). */
  wanted: string;
  /** The conversations of the sender's project the message may go to (scope-gate.peerCandidates), most similar first. */
  candidates: ReadonlyArray<{ id: string; title: string }>;
  projectName?: string;
  /** The message the card is for, short: the request an old card belongs to is readable on the card itself. */
  excerpt?: string;
  locale: "ko" | "en";
  signal?: AbortSignal;
}

const clean = (value: string, max: number): string => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const peerNewConversationLabel = (locale: "ko" | "en"): string => (locale === "ko" ? "새 대화 만들기" : "Create a new conversation");

/** The buttons and the table that turns a pressed label back into the id the host offered. Labels are unique (two equal titles get a short id suffix). */
export function peerPickOptions(input: Pick<PeerPickInput, "candidates" | "locale">): { options: AskUserOption[]; idByLabel: Map<string, string>; newLabel: string } {
  const idByLabel = new Map<string, string>();
  const options: AskUserOption[] = [];
  const shown = input.candidates.slice(0, PEER_PICK_MAX_OPTIONS - 1);
  for (const candidate of shown) {
    const base = clean(candidate.title, 80) || (input.locale === "ko" ? "이름 없는 대화" : "untitled conversation");
    const label = idByLabel.has(base) ? `${base} · ${candidate.id.slice(0, 6)}` : base;
    idByLabel.set(label, candidate.id);
    options.push({ label });
  }
  const newLabel = peerNewConversationLabel(input.locale);
  options.push({ label: newLabel });
  return { options, idByLabel, newLabel };
}

/** Raises the card and turns the owner's answer into a target. Never throws: any failure is a closed card, and a closed card sends nothing. */
export async function pickPeerTarget(input: PeerPickInput, ask: (req: AskUserRequest, opts?: { signal?: AbortSignal }) => Promise<AskUserOutcome> = askUser): Promise<PeerPick> {
  const { options, idByLabel, newLabel } = peerPickOptions(input);
  const wanted = clean(input.wanted, 80);
  const project = input.projectName ? clean(input.projectName, 60) : "";
  // One candidate is not "none matches": the host still asks (only a person's press names a target) but says what it found.
  const only = input.candidates.length === 1 ? clean(input.candidates[0]!.title, 80) || (input.locale === "ko" ? "이름 없는 대화" : "untitled conversation") : null;
  const question = only !== null
    ? input.locale === "ko"
      ? `「${wanted}」로 보낼 대화가 「${only}」 하나 있어요${project ? `(프로젝트 「${project}」)` : ""}. 이 대화로 보낼까요?`
      : `One conversation matches "${wanted}": "${only}"${project ? ` (project "${project}")` : ""}. Send the message there?`
    : input.locale === "ko"
    ? `메시지를 보낼 대화를 골라 주세요${project ? `(프로젝트 「${project}」)` : ""}. 「${wanted}」에 딱 맞는 대화가 없어요.`
    : `Pick the conversation to send the message to${project ? ` (project "${project}")` : ""}. None is named exactly "${wanted}".`;
  const forWhat = input.excerpt ? clean(input.excerpt, 60) : "";
  const withRequest = forWhat ? `${question}\n${input.locale === "ko" ? "메시지" : "Message"}: 「${forWhat}」` : question;
  let outcome: AskUserOutcome;
  try {
    outcome = await ask({ question: withRequest, options, allowFreeText: false, askedBy: "message_send", chatId: input.fromChatId }, input.signal ? { signal: input.signal } : {});
  } catch { return { kind: "closed", why: "cancelled" }; }
  if (outcome.status === "no-surface") return { kind: "closed", why: "no_surface" };
  if (outcome.status === "timeout") return { kind: "closed", why: "timeout" };
  if (outcome.status === "cancelled") return { kind: "closed", why: "cancelled" };
  if (outcome.status === "declined") return { kind: "closed", why: "declined" };
  const answer = clean(outcome.answer, 200);
  if (answer === newLabel) return { kind: "new_conversation" };
  const id = idByLabel.get(answer);
  return id ? { kind: "picked", id } : { kind: "closed", why: "not_picked" };
}
