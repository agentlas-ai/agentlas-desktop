import { randomUUID } from "node:crypto";

/*
 * What an owner's button or menu asks the next turn of one conversation to carry: an installed plugin and one of its declared
 * workflows. The owner pressing "create with AI" on a screen is an explicit intent; the model should not have to discover it.
 *
 *   screen (owner gesture) -> harness turn.capability.request (owner surface only) -> run_events owner_capability_request
 *   next turn of that chat -> takeOwnerCapabilityRequests -> tool selection routes the plugin as "requested" with that workflow
 *     -> the routed-plugin pointer names the workflow's SKILL.md instead of the plugin router
 *
 * Typed data only (slug, workflow id), never prose. A request is used by one turn and expires unused after REQUEST_TTL_MS.
 * Nothing here names a domain. No electron import (the daemon runs turns too).
 */

export interface OwnerCapabilityRequest { plugin: string; workflow: string }
const KIND = "owner_capability_request";
const TAKEN = "owner_capability_request_taken";
const REQUEST_TTL_MS = 6 * 60 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKFLOW = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Record the owner's request for this chat's next turn. Refuses an unknown plugin or an undeclared workflow. */
export async function recordOwnerCapabilityRequest(input: { chatId: string; plugin: string; workflow: string }): Promise<{ requestId: string }> {
  const chatId = String(input.chatId ?? "").trim(), plugin = String(input.plugin ?? "").trim(), workflow = String(input.workflow ?? "").trim();
  if (!chatId || chatId.length > 200) throw new Error("capability_request_chat_required");
  if (!SLUG.test(plugin) || !WORKFLOW.test(workflow)) throw new Error("capability_request_invalid");
  const { installedPluginWorkflowPath } = await import("./router-prompt");
  if (!installedPluginWorkflowPath(plugin, workflow)) throw new Error("capability_request_workflow_unknown");
  const { getDb } = await import("../store/db");
  if (!getDb().prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)) throw new Error("capability_request_chat_unknown");
  const requestId = `ocr_${randomUUID()}`;
  const { recordRunEvent } = await import("../store/run-events");
  recordRunEvent({ runId: `owner-request:${requestId}`, chatId, kind: KIND, payload: { requestId, plugin, workflow } });
  return { requestId };
}

/** The open requests of a chat (newest per plugin), marked as taken by `runId` so no later turn carries them again. The same run asking
 *  again (a retried tool selection) gets what it took. */
export async function takeOwnerCapabilityRequests(chatId: string, runId?: string): Promise<OwnerCapabilityRequest[]> {
  try {
    const { getDb } = await import("../store/db");
    const rows = getDb().prepare(
      "SELECT run_id, kind, payload_json, ts FROM run_events WHERE chat_id = ? AND kind IN (?, ?) ORDER BY rowid DESC LIMIT 50",
    ).all(chatId, KIND, TAKEN) as Array<{ run_id: string; kind: string; payload_json: string; ts: string | number }>;
    const requests = new Map<string, OwnerCapabilityRequest & { requestId: string; at: number }>();
    for (const row of rows) {
      if (row.kind !== KIND) continue;
      const payload = JSON.parse(row.payload_json) as { requestId?: unknown; plugin?: unknown; workflow?: unknown };
      if (typeof payload.requestId !== "string" || typeof payload.plugin !== "string" || !SLUG.test(payload.plugin)
        || typeof payload.workflow !== "string" || !WORKFLOW.test(payload.workflow)) continue;
      requests.set(payload.requestId, { requestId: payload.requestId, plugin: payload.plugin, workflow: payload.workflow, at: typeof row.ts === "number" ? row.ts : Date.parse(String(row.ts)) });
    }
    const takenBy = new Map<string, string>();
    for (const row of rows) if (row.kind === TAKEN) {
      const ids = (JSON.parse(row.payload_json) as { requestIds?: unknown }).requestIds;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && !takenBy.has(id)) takenBy.set(id, row.run_id);
    }
    const mine = runId ? [...requests.values()].filter((row) => takenBy.get(row.requestId) === runId) : [];
    if (mine.length) return mine.map(({ plugin, workflow }) => ({ plugin, workflow }));
    const open = new Map<string, OwnerCapabilityRequest & { requestId: string }>();
    for (const row of requests.values()) {
      if (takenBy.has(row.requestId) || !Number.isFinite(row.at) || Date.now() - row.at > REQUEST_TTL_MS || open.has(row.plugin)) continue;
      open.set(row.plugin, { requestId: row.requestId, plugin: row.plugin, workflow: row.workflow });
    }
    if (!open.size) return [];
    const { recordRunEvent } = await import("../store/run-events");
    recordRunEvent({ runId: runId || `owner-request-taken:${randomUUID()}`, chatId, kind: TAKEN, payload: { requestIds: [...open.values()].map((row) => row.requestId) } });
    return [...open.values()].map(({ plugin, workflow }) => ({ plugin, workflow }));
  } catch {
    return [];
  }
}
