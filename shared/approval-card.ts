/*
 * Approval cards: the two facts every surface shares (decision and). Pure and import-free: Main, the
 * background service and the renderer all read this one file.
 *
 * 1. The cards only the owner answers. The approval rule (electron/runtime/approval-rule.ts) raises a card for exactly three kinds of
 *    action and writes the kind on the request (`capability`: money | delete | send). When such a card exists, Main has already
 *    decided the owner must answer it: the owner's own "always allow" and the owner's own "always approve this conversation" were
 *    applied BEFORE the card was made, and full access never makes a delete / send card. So:
 *      - a conversation marked "always approved" never answers one (a room teammate's hidden session carries a mark the HOST gave
 *        it, which is not the owner's answer): approvalNeedsOwnerAnswer;
 *      - full access, and the owner's own switch that settles the cards already waiting, settle a delete / send card left from before
 *        but never a money card: approvalIsMoney. Money is asked every time, in every mode, on every surface.
 * 2. What one "always allow" covers: the project of the conversation; a conversation without a project is its own unit. The
 *    unit is written in the consent binding's workspace identity in the readable form below, so the card and the settings list can
 *    say which project it is without another lookup table.
 */
export const OWNER_ANSWERED_APPROVAL_KINDS: readonly string[] = ["money", "delete", "send"];

/** True for a card no conversation-wide mark may answer for the owner. */
export function approvalNeedsOwnerAnswer(request: { capability?: string | null } | null | undefined): boolean {
  return typeof request?.capability === "string" && OWNER_ANSWERED_APPROVAL_KINDS.includes(request.capability);
}

/** True for a payment / transfer card: nothing settles it but the owner's own press, once, each time. */
export function approvalIsMoney(request: { capability?: string | null } | null | undefined): boolean {
  return request?.capability === "money";
}

/** The unit one "always allow" covers. */
export interface ApprovalScope { kind: "project" | "chat"; id: string }
const SCOPE_PREFIX = "approval-scope:";
/** Every agent of the scope: an "always allow" is not per agent. */
export const APPROVAL_SCOPE_ANY_AGENT = `${SCOPE_PREFIX}any-agent`;

export function approvalScopeIdentity(scope: ApprovalScope): string {
  return `${SCOPE_PREFIX}${scope.kind}:${scope.id}`;
}

export function parseApprovalScopeIdentity(value: string | null | undefined): ApprovalScope | null {
  const match = /^approval-scope:(project|chat):([A-Za-z0-9._:-]{1,200})$/.exec(String(value ?? ""));
  return match ? { kind: match[1] as ApprovalScope["kind"], id: match[2]! } : null;
}

/**
 * One step of finding a conversation's unit, shared by Main (runtime/approval-scope.ts, reading the store) and the card (reading
 * through the bridge): its project if it has one; a group room's hidden member session (kind "division") belongs to its room, so
 * the walk goes up to the parent; otherwise the conversation itself is the unit.
 */
export function approvalScopeStep(
  chatId: string,
  row: { projectId?: string | null; parentChatId?: string | null; kind?: string | null } | null | undefined,
): { scope: ApprovalScope } | { parent: string } {
  if (row?.projectId) return { scope: { kind: "project", id: row.projectId } };
  if (row && row.kind === "division" && row.parentChatId) return { parent: row.parentChatId };
  return { scope: { kind: "chat", id: chatId } };
}
