import type { Automation } from "../../shared/types";
import { sha256Value } from "../../shared/graph-execution-digest";
import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
import { getChat } from "../store/chats";
import { oneTeamDispatchOwnerChat } from "./team-dispatch";

const KIND = "one_graph_authority";
function authority(a: Automation) {
  // Runtime version pinning and scheduling cursors may change automatically;
  // tool/worker targets, graph contents and grants cannot inherit this receipt.
  return { schemaVersion: "agentlas.one-graph-authority.v1", automationId: a.id,
    automationCreatedAt: a.createdAt, ownerChatId: a.monitor?.originChatId,
    digest: sha256Value({ graph: a.graph, targetType: a.targetType, targetId: a.targetId,
      projectId: a.projectId, permission: a.executionPermission, hubMode: a.hubMode }) };
}

/** Only the authenticated One graph authoring handler calls this after save.
 * A monitor origin or model-authored payload alone is never a delegation grant. */
export function recordOneGraphAuthority(a: Automation, ownerChatId: string): void {
  if (a.monitor?.originChatId !== ownerChatId || oneTeamDispatchOwnerChat(ownerChatId) !== ownerChatId) throw new Error("one_graph_authority_owner_invalid");
  const receipt = authority(a);
  recordRunEvent({ runId: `one-graph-authority:${a.id}`, automationId: a.id, chatId: ownerChatId,
    kind: KIND, payload: receipt });
}

/** The trusted definition receipt lets a utility graph command One's workers
 * without pretending the graph is the Goal's continuation automation. */
export function oneGraphAuthorityOwner(a: Automation): string | null {
  const row = getDb().prepare("SELECT payload_json FROM run_events WHERE automation_id=? AND kind=? ORDER BY rowid DESC LIMIT 1").get(a.id, KIND) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const saved = JSON.parse(row.payload_json) as Record<string, unknown>;
    const expected = authority(a);
    const id = expected.ownerChatId;
    // The event store attaches runtimeEvidence to every payload. Compare the
    // authority fields, not host-added diagnostics or JSON property ordering.
    if (!id || Object.entries(expected).some(([key, value]) => saved[key] !== value) || getChat(id)?.archivedAt
      || oneTeamDispatchOwnerChat(id) !== id) return null;
    return id;
  } catch { return null; }
}
