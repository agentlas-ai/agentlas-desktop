/*
 * What one "always allow" covers: the PROJECT. Pressing "always allow" on a delete / sending-out card keeps that
 * tool quiet in every room, session and agent of the same project; another project asks once again. A conversation without a
 * project is its own unit (a group room's hidden member sessions count as their room). Money is never remembered.
 *
 * One function for every card that follows this rule: the tool cards of the approval rule (host-tool-permission-policy.ts) and the
 * first-send card of messages between sessions both build their binding with scopedAlwaysAllowBinding.
 *
 * Storage: no new table or column. The unit is the binding's workspace identity (capability_grants.workspace_identity) in the
 * readable form of shared/approval-card.ts. Read by the arbiter on each asked call and by the settings list; deleted when the owner
 * turns the row off, when the project is deleted (store/projects.ts removeProject) and when the conversation is deleted
 * (store/room-purge.ts purgeRoomRows).
 */
import { getDb } from "../store/db";
import { APPROVAL_SCOPE_ANY_AGENT, approvalScopeIdentity, approvalScopeStep, type ApprovalScope } from "../../shared/approval-card";
import type { ToolApprovalConsentBinding } from "../../shared/types";
import type { ScopeStamp } from "../../shared/scope-stamp";

/** One walk for both answers below: the unit of a conversation, and the top-level room it was found under (a member's hidden session belongs to its room). */
function walkApprovalScope(chatId: string): { scope: ApprovalScope; top: string } {
  try {
    const read = getDb().prepare("SELECT project_id AS projectId, parent_chat_id AS parentChatId, kind FROM chats WHERE id = ?");
    let id = chatId;
    // A member's hidden session belongs to its room: walk up, bounded (shared/approval-card.ts approvalScopeStep).
    for (let hop = 0; hop < 4; hop += 1) {
      const step = approvalScopeStep(id, read.get(id) as { projectId?: string | null; parentChatId?: string | null; kind?: string | null } | undefined);
      if ("scope" in step) return { scope: step.scope, top: id };
      id = step.parent;
    }
    return { scope: { kind: "chat", id }, top: id };
  } catch {
    // An unreadable store: the conversation itself is the narrowest true unit.
    return { scope: { kind: "chat", id: chatId }, top: chatId };
  }
}

/** The project of a conversation, else the conversation itself (its top-level room for a hidden member session). One or two indexed reads. */
export function approvalScopeOfChat(chatId: string | null | undefined): ApprovalScope | null {
  if (!chatId) return null;
  return walkApprovalScope(chatId).scope;
}

/*
 * The ONE function that stamps an object with where it was made. The project is the same value `approvalScopeOfChat` gives the
 * approval rule and the first-send card (so the project a person sees and the project the gate uses cannot differ -); the account comes from
 * the host's own session reader, installed once by the host policy (the renderer never supplies it). A host that cannot read a session stamps null,
 * which the gate treats as "this install" (shared/scope-stamp.ts).
 */
let scopeAccountReader: (() => string | null) | null = null;
export function setScopeAccountReader(fn: (() => string | null) | null): void { scopeAccountReader = fn; }
function currentScopeAccount(): string | null { try { return scopeAccountReader?.() ?? null; } catch { return null; } }

/** The stamp of a conversation (null for no conversation). `run` is the run the object belongs to, when the caller knows it. */
export function scopeStampOfChat(chatId: string | null | undefined, run?: string | null): ScopeStamp | null {
  if (!chatId) return null;
  const { scope, top } = walkApprovalScope(chatId);
  return {
    account: currentScopeAccount(),
    project: scope.kind === "project" ? scope.id : null,
    chat: chatId,
    ...(top !== chatId ? { room: top } : {}),
    ...(run ? { run } : {}),
  };
}

/** A stamp for an object that belongs to no conversation (an app-wide question): it goes to the app-wide sheet only. */
export function appWideScopeStamp(): ScopeStamp {
  return { account: currentScopeAccount(), project: null, chat: null };
}

/** The binding an "always allow" is saved and looked up under: this account, this unit, any agent, this resource. */
export function scopedAlwaysAllowBinding(input: {
  userIdentity: string;
  chatId: string | null | undefined;
  resourceIdentity: string;
}): ToolApprovalConsentBinding | null {
  const scope = approvalScopeOfChat(input.chatId);
  if (!scope) return null;
  return {
    userIdentity: input.userIdentity,
    workspaceIdentity: approvalScopeIdentity(scope),
    requesterIdentity: APPROVAL_SCOPE_ANY_AGENT,
    credentialResourceIdentity: input.resourceIdentity,
    permissionScope: "write",
  };
}
