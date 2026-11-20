/**
 * The words and shapes of the hand-off wire, desktop side. Types and closed words only - no logic, no imports - so the receiver, the sender, the host gate and the cards agree on one
 * spelling. A word here is the server's word; it is never renamed on this side.
 */
/** 3 = this desktop draws the consent chip: a sender with v < 3 is refused `desktop_update` by the server, so work is never handed over without the person's answer. */
export const PLURAL_PLACES_V = 3;

/** What a question is about: only these three are ever asked. */
export type AskKind = "money" | "delete" | "send";
export type AskAnswer = "allow" | "allow_task" | "deny";
/** Why a question closed without the person's answer: the card then reads "확인 요청 취소". `answered_here` = answered on the screen of the desktop that runs the Work and the row could not be reached first. */
export type CloseWhy = "timeout" | "runtime_refused" | "work_stopped" | "lost" | "answered_here";

export type FinishState = "done" | "failed" | "stopped";
export type FailedWhy = "interrupted" | "no_runner" | "limit" | "desktop_update" | "error" | "approval_unavailable" | "permission" | "phone_app";
export type StoppedWhy = "cancelled" | "stopped_here" | "interrupted" | "released";
export type FinishWhy = FailedWhy | StoppedWhy;
/** The end the desktop reports for a row it ran: a machine value read from the Work's own end, never from model text. `started` = the Work went into execution. */
export interface PluralEnd { state: FinishState; why?: FinishWhy; started: boolean; text?: string }

/**
 * How a Work started from a row asks about money / delete / send. `row` = every question goes up to the row first (the sender answers on a phone or another desktop); `local` = an older phone (172) sent the row:
 * the questions stay on this desktop's own card with the old five minutes. Carried: row -> startWork -> the Work's request payload -> the host gate (looked up by the Work's chat, see plural-remote-ask.ts).
 */
export interface RemoteAsk { rowId: string; askVia: "row" | "local"; from: string; fromName: string }

/** One question as it goes up: the qid is this process's own request id. */
export interface PluralQuestion { qid: string; kind: AskKind; target: string; preview?: string }
/** What the host gate gets back from the row for one question. */
export type RowDecision = { kind: "answered"; answer: AskAnswer } | { kind: "allowed" } | { kind: "refused" };

/** A row's answer to the desktop that holds it, as the receiver reads it (GET `held[]`). */
export interface HeldEntry { id: string; run: string; approvals: Array<{ qid: string; answer: AskAnswer }>; taskAllow: AskKind[] }

/** What the sender side keeps of a row this desktop sent (GET `open[]` / `done[]`), for the conversation's cards. Nothing here is a model word. */
export type SentCardState = "asking" | "reserved" | "waiting_desktop_off" | "waiting_phone_app" | "claimed" | "claimed_desktop_off" | "approval" | "done" | "failed" | "stopped" | "expired" | "cancelled";
export interface SentCard {
  id: string; to: string; toName: string; brief: string; state: SentCardState; why?: FinishWhy; started?: boolean;
  /** Questions waiting for an answer (state `approval`). */
  approvals: Array<{ qid: string; kind: AskKind; target: string; preview?: string }>;
  result?: string; endedAt?: string; lateEnd?: boolean;
  /** Why the card reads the way it does when the row went through the consent chip (the server's `consent` of the row): sent by an Always-allow rule, denied, or never answered. */
  consent?: ConsentEnd;
  /** Local to this process (never on the wire): the person was not in the turn that handed this over, so the phone is told once. */
  away?: true;
}

/** The person's answer to the chip. `always` also writes the server's rule for (from, to). */
export type ConsentAnswer = "allow" | "always" | "deny";
export type ConsentEnd = "rule" | "deny" | "unanswered";
/** One chip waiting on THIS desktop's screen (GET `consent[]`): another agent wants to hand work to this desktop's agent. Nothing of it is sent before the person answers. */
export interface ConsentAsk { id: string; from: string; fromName: string; brief: string; doneWhen?: string; createdAt?: string; expiresAt?: string }
/** One standing rule of Always allow (`allows` op): from -> to, each `phone` or a host id; names only when the server knows them. */
export interface ConsentRule { from: string; fromName?: string; to: string; toName?: string; at?: string }
