/*
 * a refusal or failure a PERSON can clear by acting is a card with
 * buttons, never one prose line. This is the ONE table that says which code has which buttons and which words.
 *
 * Pure and import-light (shared types only): Main, the background service, the renderer and the phone bridge read it. No store, no clock, no model.
 *
 * The table reads the tables that already exist instead of copying them:
 *   - shared/owner-failure-class.ts (`externalFailureEntry`): provider_limit -> "resend_other_ai", provider_auth -> "login", owner_state -> the
 *     working-folder codes of OWNER_FIXABLE_RUN_FAILURE_CODES -> "pick_project_folder".
 *   - the harness refusal codes of harness/plain-outcome.ts and harness/deliver-runtime.ts that a person can clear (listed once, below).
 * A code that no table names has no buttons and no words of its own: the card says "the app did not do this", never the code.
 *
 * The buttons are a CLOSED list (REMEDY_ACTIONS). What each one does belongs to the screen that draws it (components/ReceiptCard.tsx); this file
 * only says which ones a code owns and the words of the reason in Korean and English.
 */
import { externalFailureEntry } from "./owner-failure-class";
import { OWNER_FIXABLE_RUN_FAILURE_CODES } from "./transient-send-refusal";

export type RemedyAction =
  /** Send the same message again through another AI (usage limit). */
  | "resend_other_ai"
  /** Hand the work to the personal agent (another project's conversation is not reachable from here). */
  | "hand_to_personal_one"
  /** Raise this conversation's permission for the step (read-only permission). */
  | "grant_permission"
  /** Sign in to the AI or service the run needs. */
  | "login"
  /** Pick the project's working folder. */
  | "pick_project_folder"
  /** Open the question card that was closed. */
  | "reopen_question";

export const REMEDY_ACTIONS: ReadonlySet<string> = new Set<RemedyAction>([
  "resend_other_ai", "hand_to_personal_one", "grant_permission", "login", "pick_project_folder", "reopen_question",
]);

export interface RemedyWords { readonly ko: string; readonly en: string }
export interface Remedy {
  /** The buttons, in the order they are drawn. Empty = the reason is told, nothing a person can press clears it. */
  readonly actions: readonly RemedyAction[];
  readonly words: RemedyWords;
}

const R = (actions: readonly RemedyAction[], ko: string, en: string): Remedy => ({ actions, words: { ko, en } });

/** Codes a person can clear by acting that no failure-class table owns: the refusals of the harness ports (plain-outcome.ts) and of message delivery (deliver-runtime.ts). */
const HARNESS_REMEDIES: Readonly<Record<string, Remedy>> = {
  // Another project's conversation, or a project with no other conversation: the personal agent reaches across projects.
  not_same_project: R(["hand_to_personal_one"], "다른 프로젝트의 대화에는 여기서 보낼 수 없어요", "This conversation cannot write to another project's conversation"),
  no_peer: R(["hand_to_personal_one"], "이 프로젝트에는 메시지를 받을 다른 대화가 없어요", "This project has no other conversation to write to"),
  no_project: R(["hand_to_personal_one"], "이 대화는 프로젝트가 없어 다른 대화로 보낼 수 없어요", "This conversation has no project, so it cannot write to other conversations"),
  not_found: R([], "받을 대화를 찾지 못했어요", "The receiving conversation was not found"),
  ambiguous: R([], "받을 대화가 하나로 정해지지 않았어요", "The receiving conversation was not a single one"),
  target_not_allowed: R([], "그 대화로는 메시지를 보낼 수 없어요", "Messages cannot be sent to that conversation"),
  repeated: R([], "같은 내용을 이미 보냈어요", "The same words were already sent"),
  chain_stopped: R([], "메시지 연결이 멈춰 있어 보내지 않았어요", "The chain of messages was stopped, so nothing was sent"),
  too_long: R([], "메시지가 너무 길어 보내지 않았어요", "The message was too long, so nothing was sent"),
  // The person was asked on a card (which conversation, or the first-send yes) and has not answered / did not pick: nothing was sent, and the words say so.
  waiting_for_owner: R([], "고르실 때까지 기다리는 중이라 아직 보내지 않았어요", "Waiting for your choice, so nothing was sent yet"),
  not_picked: R([], "보낼 대화를 고르지 않아서 보내지 않았어요", "No conversation was picked, so nothing was sent"),
  // The app closed while the card was open: the card is gone with it, so the message was not sent and the person can ask again.
  intent_lost: R([], "앱이 다시 켜져 카드가 닫혀서 보내지 않았어요", "The app restarted and the card closed, so nothing was sent"),
  owner_declined: R([], "보내도 된다는 답이 없어 보내지 않았어요", "There was no yes to send it, so nothing was sent"),
  // A schedule the host cannot read as a time it will keep (every other week, the last Friday, public holidays, an end date it does not take): not saved, and said so.
  automation_schedule_unreadable: R([], "이 반복 방식은 저장할 수 없어 예약하지 않았어요", "That repeat pattern cannot be saved, so nothing was scheduled"),
  automation_workspace_folder_unavailable: R(["pick_project_folder"], "프로젝트 폴더를 쓸 수 없어 예약하지 않았어요", "The project folder cannot be used, so nothing was scheduled"),
  // Read-only permission: the person can raise it for this step.
  "execution-permission-read-only": R(["grant_permission"], "이 대화는 읽기 전용이라 바꾸지 못했어요", "This conversation is read-only, so nothing was changed"),
  app_control_write_permission_required: R(["grant_permission"], "이 대화는 읽기 전용이라 바꾸지 못했어요", "This conversation is read-only, so nothing was changed"),
  permission_escalation_required: R(["grant_permission"], "이 단계에는 더 높은 권한이 필요해요", "This step needs a higher permission"),
};

/** The working-folder codes of OWNER_FIXABLE_RUN_FAILURE_CODES: the person picks a folder. The other owner-fixable codes are told, with no button (restoring an agent is in Settings). */
const FOLDER_WORDS = R(["pick_project_folder"], "프로젝트 폴더를 찾을 수 없어요", "The project folder cannot be found");
const FOLDER_CODES: ReadonlySet<string> = new Set(["project_folder_missing", "project_folder_not_directory", "project_folder_unreadable", "agent_no_folder"]);

const LIMIT_WORDS = R(["resend_other_ai"], "AI의 사용량 한도에 닿았어요", "The AI's usage limit was reached");
const LOGIN_WORDS = R(["login"], "AI에 로그인이 필요해요", "The AI needs you to sign in");
const OWNER_STATE_WORDS = R([], "이 대화를 시작할 수 없는 상태예요", "This conversation cannot start in its current state");

/** The remedy a code owns, or null when no table names it. `cause` (a failure-class cause the caller already read) is used when the code alone is not in a table. */
export function ownerRemedyOf(code: string | null | undefined, cause?: string | null): Remedy | null {
  const c = typeof code === "string" ? code : "";
  if (c && HARNESS_REMEDIES[c]) return HARNESS_REMEDIES[c];
  if (c && FOLDER_CODES.has(c)) return FOLDER_WORDS;
  const entry = c ? externalFailureEntry(c) : null;
  const klass = entry?.cause ?? cause ?? null;
  if (klass === "provider_limit") return LIMIT_WORDS;
  if (klass === "provider_auth") return LOGIN_WORDS;
  if (klass === "owner_state" || (c && OWNER_FIXABLE_RUN_FAILURE_CODES.has(c))) return OWNER_STATE_WORDS;
  return null;
}

/** The buttons of a code; [] when none. */
export function remedyActionsOf(code: string | null | undefined, cause?: string | null): RemedyAction[] {
  return [...(ownerRemedyOf(code, cause)?.actions ?? [])];
}

/** The reason in plain words, or "" when no table has words for the code (the caller then says the generic line; the code itself is never shown). */
export function remedyWordsOf(code: string | null | undefined, locale: "ko" | "en", cause?: string | null): string {
  const remedy = ownerRemedyOf(code, cause);
  return remedy ? remedy.words[locale] : "";
}

const SHORT_WHY: Readonly<Record<string, readonly [string, string]>> = {
  not_same_project: ["다른 프로젝트", "other project"], no_peer: ["받을 대화 없음", "no recipient"], no_project: ["프로젝트 없음", "no project"],
  not_found: ["대화 못 찾음", "not found"], ambiguous: ["대화 불분명", "unclear target"], target_not_allowed: ["보낼 수 없는 대화", "not allowed"],
  repeated: ["이미 보냄", "already sent"], chain_stopped: ["연결 멈춤", "chain stopped"], too_long: ["너무 김", "too long"],
  waiting_for_owner: ["선택 대기", "waiting for you"], not_picked: ["고르지 않음", "none picked"], owner_declined: ["허락 없음", "no yes"], intent_lost: ["카드 닫힘", "card closed"],
  automation_schedule_unreadable: ["반복 방식 미지원", "repeat unsupported"], automation_workspace_folder_unavailable: ["폴더 못 씀", "folder unusable"],
  "execution-permission-read-only": ["읽기 전용", "read-only"], app_control_write_permission_required: ["읽기 전용", "read-only"],
  permission_escalation_required: ["권한 필요", "needs permission"],
};

/** The reason in two or three words for a card's one line ("" when no table has it); the full sentence stays in remedyWordsOf. */
export function remedyShortWordsOf(code: string | null | undefined, locale: "ko" | "en", cause?: string | null): string {
  const remedy = ownerRemedyOf(code, cause);
  if (!remedy) return "";
  const i = locale === "ko" ? 0 : 1;
  const own = typeof code === "string" ? SHORT_WHY[code] : undefined;
  if (own) return own[i];
  if (remedy === FOLDER_WORDS) return ["폴더 없음", "no folder"][i]!;
  if (remedy === LIMIT_WORDS) return ["한도", "limit"][i]!;
  if (remedy === LOGIN_WORDS) return ["로그인 필요", "sign-in needed"][i]!;
  return ["시작 불가", "cannot start"][i]!;
}

/** Whether a value read from storage or the wire is one of the closed buttons. */
export function isRemedyAction(value: unknown): value is RemedyAction {
  return typeof value === "string" && REMEDY_ACTIONS.has(value);
}

/** Every code this table gives words or buttons to, for the coverage gate (the gate checks each OWNER_FIXABLE code has a decision). */
export function remedyCodesOfHarness(): string[] { return Object.keys(HARNESS_REMEDIES); }
