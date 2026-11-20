/*
 * Scope gate - the pure part.
 * Pure and import-free: Main, the background service and (later) the renderer read this one file. No store, no clock, no model, no timer.
 *
 * Every object that crosses a boundary (an approval, a question, a delivery, a hand-over, a card, a receipt, a lock, a schedule, a grant)
 * is stamped when it is made. The stamp is computed in ONE place (electron/runtime/approval-scope.ts scopeStampOfChat) and judged by the
 * functions below, one door per surface (electron/scope/scope-gate.ts).
 *
 * Account comparison is deliberately lenient on null: a null account is an install nobody signed in on (or a host that could not read the
 * session at that moment). It matches anything, so a card made by the background service while its own session read was empty is still
 * shown to the signed-in window (the class of "the other host did not know"). Two DIFFERENT accounts never match.
 */

/** Where an object was made. `chat` null = an app-wide object (an API-key request, an automation strategy): it never goes into a conversation pane. */
export interface ScopeStamp {
  readonly account: string | null;
  readonly project: string | null;
  readonly chat: string | null;
  /** The top-level group room a member's hidden session belongs to (its pane shows the room). Absent when the chat is its own pane. */
  readonly room?: string | null;
  readonly run?: string;
}

/** How long a grant lives: this run, this conversation (until the app quits), this project (stored). */
export type GrantLifetime = "run" | "chat" | "project";

export type ScopeSurface =
  /** A conversation pane of the desktop (Work, One, a room, the personal workspace). `chats` = the pane's conversation and its member sessions. */
  | "chat-pane"
  /** A pane that shows a new, still-unsent conversation: it takes no object at all. */
  | "draft-pane"
  /** The app-wide sheet (AppShell). */
  | "global-sheet"
  /** A paired phone. */
  | "phone"
  /** A relay of the background service. */
  | "relay";

export interface ScopeViewer {
  account: string | null;
  surface: ScopeSurface;
  chats?: readonly string[];
  /** Phone and relay: true only when the device is a paired one of this account (the bridge's own check, passed in). */
  deviceTrusted?: boolean;
}

export interface ScopeAnswerer extends ScopeViewer {
  /** The conversation the answer says it is for (a newer phone sends it; an older one does not). */
  claimedChat?: string | null;
}

export type ScopeRefusalCode =
  | "other_account" | "draft_pane" | "no_chat" | "other_chat" | "device_not_paired"
  | "no_stamp" | "self" | "no_project" | "not_same_project";

export type ScopeVerdict = { ok: true } | { ok: false; code: ScopeRefusalCode };

const OK: ScopeVerdict = { ok: true };
const no = (code: ScopeRefusalCode): ScopeVerdict => ({ ok: false, code });

/** Two accounts match unless both are known and different (see the header). */
export function sameScopeAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return true;
  return a === b;
}

/** May this surface SEE the object. One function for the IPC list, the broadcast, a window's pane pick, the phone snapshot and the daemon relay. */
export function admitScopeView(stamp: ScopeStamp | null | undefined, viewer: ScopeViewer): ScopeVerdict {
  if (!stamp) return no("no_stamp");
  if (!sameScopeAccount(stamp.account, viewer.account)) return no("other_account");
  switch (viewer.surface) {
    case "draft-pane": return no("draft_pane");
    case "chat-pane": {
      if (!stamp.chat) return no("no_chat");
      const chats = viewer.chats ?? [];
      return chats.includes(stamp.chat) || (stamp.room != null && chats.includes(stamp.room)) ? OK : no("other_chat");
    }
    case "global-sheet": return OK;
    case "phone":
    case "relay": return viewer.deviceTrusted === true ? OK : no("device_not_paired");
  }
}

/**
 * May this surface ANSWER the object (rule 9). The same test as seeing it, plus: an answer that says which conversation it is for must name the
 * object's own. An answer that does not say (an older phone) is taken when the surface itself is allowed to see it.
 */
export function admitScopeAnswer(stamp: ScopeStamp | null | undefined, answerer: ScopeAnswerer): ScopeVerdict {
  const seen = admitScopeView(stamp, answerer);
  if (!seen.ok) return seen;
  const claimed = answerer.claimedChat;
  if (claimed && stamp!.chat && claimed !== stamp!.chat && claimed !== stamp!.room) return no("other_chat");
  return OK;
}

/**
 * May a message go from one conversation to another. `peer` = the model's message_send (the same project, always); `personal` = the personal
 * agent's one_chat_send (it may cross projects of the SAME account; the card and the receipt then name the receiving project, `crossProject`).
 */
export function admitScopeDelivery(
  from: ScopeStamp | null | undefined,
  to: ScopeStamp | null | undefined,
  mode: "peer" | "personal",
): ScopeVerdict | { ok: true; crossProject: boolean } {
  if (!from || !to) return no("no_stamp");
  if (!sameScopeAccount(from.account, to.account)) return no("other_account");
  if (from.chat && from.chat === to.chat) return no("self");
  if (mode === "personal") return { ok: true, crossProject: from.project !== to.project };
  if (!from.project) return no("no_project");
  if (!to.project || to.project !== from.project) return no("not_same_project");
  return { ok: true, crossProject: false };
}

export interface PeerToolFacts { exists: boolean; projectId: string | null; pack: boolean; personal: boolean; hubCallOnly: boolean }

/**
 * Rule 10: what the conversation is OFFERED. A conversation of a project always has `message_send`: a project with no other conversation answers
 * with the typed `no_peer` refusal (and the host's card), never with a tool that is not there and a model that improvises.
 */
export function offeredPeerToolNames(facts: PeerToolFacts): readonly string[] {
  return facts.exists && facts.projectId && !facts.pack && !facts.personal && !facts.hubCallOnly ? ["message_send"] : [];
}

/**
 * Rule 5: does a grant made under `granted` still cover a request stamped `asking`.
 * run: the same conversation (and the same run when both are known); chat: the same conversation; project: the same non-null project.
 */
export function scopeGrantCovers(granted: { lifetime: GrantLifetime; stamp: ScopeStamp | null }, asking: ScopeStamp | null | undefined): boolean {
  const g = granted.stamp;
  // A grant or a request with no conversation (a cwd-keyed ACP seed) cannot be compared: the session key that found it is the only unit, as before.
  if (!g || !asking) return true;
  if (!sameScopeAccount(g.account, asking.account)) return false;
  switch (granted.lifetime) {
    case "project": return g.project !== null && g.project === asking.project;
    case "chat": return g.chat === asking.chat;
    case "run": return g.chat === asking.chat && (g.run == null || asking.run == null || g.run === asking.run);
  }
}
