/*
 * Scope gate - Main / background-service door. One door per surface: the approval list, the
 * broadcast, an answer, a relay to the daemon or the phone, a delivery and the tool menu all ask THIS file, which asks the pure functions of
 * shared/scope-stamp.ts. It reads the store only through `scopeOfChat` (runtime/approval-scope.ts). It imports no model, no timer, no Electron
 * (the background service imports it too) and writes nothing.
 */
import { approvalScopeOfChat, scopeStampOfChat, appWideScopeStamp, setScopeAccountReader } from "../runtime/approval-scope";
import { getDb } from "../store/db";
import {
  admitScopeAnswer, admitScopeDelivery, admitScopeView, offeredPeerToolNames, sameScopeAccount,
  type PeerToolFacts, type ScopeAnswerer, type ScopeStamp, type ScopeVerdict, type ScopeViewer,
} from "../../shared/scope-stamp";

export { scopeStampOfChat as scopeOfChat, appWideScopeStamp, setScopeAccountReader, approvalScopeOfChat, sameScopeAccount };
export { admitScopeView as admitView, admitScopeAnswer as admitAnswer, admitScopeDelivery as admitDeliver, offeredPeerToolNames as offeredPeerTools };
export type { ScopeStamp, ScopeViewer, ScopeAnswerer, ScopeVerdict, PeerToolFacts };

/** Keeps the objects a viewer may see, in order. The one filter the IPC list, the broadcast and the phone snapshot use. */
export function filterForViewer<T extends { scope?: ScopeStamp | null }>(items: readonly T[], viewer: ScopeViewer): T[] {
  return items.filter((item) => admitScopeView(item.scope, viewer).ok);
}

/**
 * The conversations a message from `fromChatId` may be offered to, and only those: not itself, not archived, a person's own conversation (no hidden
 * member session), no screen pack's - and, by the gate, the SAME project and account as the sender (a candidate is never read out of another project).
 */
export function peerCandidates(fromChatId: string, limit = 200): Array<{ id: string; title: string }> {
  const from = scopeStampOfChat(fromChatId);
  if (!from?.project) return [];
  let rows: Array<{ id: string; title: string }> = [];
  try {
    // A hidden member session writes as its room: neither the session nor its own room is a "other" conversation.
    rows = getDb().prepare("SELECT id, title FROM chats WHERE project_id = ? AND kind = 'user' AND archived_at IS NULL AND surface_pack IS NULL AND id <> ? AND id <> ? ORDER BY updated_at DESC LIMIT ?")
      .all(from.project, fromChatId, from.room ?? fromChatId, limit) as Array<{ id: string; title: string }>;
  } catch { return []; }
  // Defence in depth: each candidate is judged by the same gate a delivery to it will be.
  return rows.filter((row) => {
    const verdict = admitScopeDelivery(from, scopeStampOfChat(row.id), "peer");
    return verdict.ok;
  });
}
