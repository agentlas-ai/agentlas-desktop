import type Database from "better-sqlite3";
import { supervisorIngressMessage } from "./supervisor-store";

/** The host binding of the turn that called a graph tool (team-control-server capability); never supplied by the model. */
export interface GraphOriginBinding {
  /** Host-only draft provenance. Explicit null keeps a legacy/unbound draft unbound. */
  draftOriginRunId?: string | null;
  supervisorReplyRunId?: string;
  personalSource?: { runId: string };
  historySource?: { runId: string };
}

/**
 * The owner message a graph's reports answer (22 O3): the message the calling run actually received.
 * Only the host-sealed ingress or the same run/chat's durable user-message receipt proves that origin.
 * Missing/invalid evidence stays unbound (null); message time or the latest user turn is never a binding.
 */
export function resolveGraphOriginMessage(db: Database.Database, chatId: string, binding: GraphOriginBinding): string | null {
  const runId = Object.prototype.hasOwnProperty.call(binding, "draftOriginRunId")
    ? binding.draftOriginRunId
    : binding.supervisorReplyRunId ?? binding.personalSource?.runId ?? binding.historySource?.runId;
  if (typeof runId !== "string" || !runId) return null;
  try {
    const isOwnerMessage = (id: unknown): id is string => typeof id === "string" && !!db.prepare(
      "SELECT 1 FROM chat_messages WHERE id=? AND chat_id=? AND role='user'",
    ).get(id, chatId);
    const sealed = supervisorIngressMessage(db, chatId, runId);
    if (sealed) return isOwnerMessage(sealed) ? sealed : null;
    const receipt = db.prepare(`SELECT json_extract(payload_json,'$.messageId') AS id FROM run_events
      WHERE run_id=? AND chat_id=? AND kind='origin_user_message' ORDER BY seq LIMIT 1`).get(runId, chatId) as { id: string | null } | undefined;
    return isOwnerMessage(receipt?.id) ? receipt!.id : null;
  } catch { return null; }
}
