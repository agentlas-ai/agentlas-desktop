import { createHash, randomUUID } from "node:crypto";
import type { Chat } from "../../shared/types";
import { emitDesktopStoreChange } from "./change-bus";
import { createChat, getChat } from "./chats";
import { getDb } from "./db";

export type AutomationSessionTarget =
  | { kind: "host"; id: "default" }
  | { kind: "agent"; id: string }
  | { kind: "firm"; id: string }
  | { kind: "hub"; id: string };

export interface AutomationExecutionSession {
  id: string;
  automationId: string;
  target: AutomationSessionTarget;
  chat: Chat;
  createdAt: string;
  updatedAt: string;
}

interface AutomationSessionRow {
  id: string;
  automation_id: string;
  target_kind: AutomationSessionTarget["kind"];
  target_id: string;
  ledger_chat_id: string;
  created_at: string;
  updated_at: string;
}

function targetFor(input: { agentId?: string; firmId?: string | null; hubId?: string | null }): AutomationSessionTarget {
  if (input.firmId) return { kind: "firm", id: input.firmId };
  if (input.agentId) return { kind: "agent", id: input.agentId };
  if (input.hubId) return { kind: "hub", id: input.hubId };
  return { kind: "host", id: "default" };
}

function legacyMarker(automationId: string, target: AutomationSessionTarget): string {
  const digest = createHash("sha256").update(target.kind).update("\0").update(target.id).digest("hex").slice(0, 16);
  return `⟦automation⟧${automationId}::target:${target.kind}:${digest}`;
}

function rowToSession(row: AutomationSessionRow): AutomationExecutionSession | null {
  const chat = getChat(row.ledger_chat_id);
  if (!chat) return null;
  return {
    id: row.id,
    automationId: row.automation_id,
    target: { kind: row.target_kind, id: row.target_id } as AutomationSessionTarget,
    chat,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Canonical owner for an automation transcript. Chat is an execution ledger only. */
export function getOrCreateAutomationSession(input: {
  automationId: string;
  agentId?: string;
  firmId?: string | null;
  hubId?: string | null;
  projectId?: string | null;
}): AutomationExecutionSession {
  const db = getDb();
  const target = targetFor(input);
  const existing = db.prepare(
    "SELECT * FROM automation_sessions WHERE automation_id = ? AND target_kind = ? AND target_id = ? LIMIT 1",
  ).get(input.automationId, target.kind, target.id) as AutomationSessionRow | undefined;
  if (existing) {
    const session = rowToSession(existing);
    if (session) {
      if ((session.chat.projectId ?? null) !== (input.projectId ?? null)) {
        db.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(input.projectId ?? null, session.chat.id);
        const updated = rowToSession(existing);
        if (updated) return updated;
      }
      return session;
    }
    db.prepare("DELETE FROM automation_sessions WHERE id = ?").run(existing.id);
  }

  const marker = legacyMarker(input.automationId, target);
  const legacy = db.prepare(
    "SELECT id FROM chats WHERE kind = 'division' AND title = ? LIMIT 1",
  ).get(marker) as { id: string } | undefined;
  const chat = legacy
    ? getChat(legacy.id)
    : createChat({
        agentId: input.agentId,
        firmId: input.firmId ?? null,
        projectId: input.projectId ?? null,
        title: marker,
        kind: "division",
      });
  if (!chat) throw new Error("automation_session_ledger_unavailable");

  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO automation_sessions
       (id, automation_id, target_kind, target_id, ledger_chat_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.automationId, target.kind, target.id, chat.id, now, now);
  emitDesktopStoreChange({ entity: "automation", id: input.automationId });
  return { id, automationId: input.automationId, target, chat, createdAt: now, updatedAt: now };
}

export function removeAutomationSessions(automationId: string): void {
  const db = getDb();
  const rows = db.prepare(
    "SELECT ledger_chat_id FROM automation_sessions WHERE automation_id = ? OR automation_id LIKE ?",
  ).all(automationId, `${automationId}::%`) as Array<{ ledger_chat_id: string }>;
  db.prepare("DELETE FROM automation_sessions WHERE automation_id = ? OR automation_id LIKE ?")
    .run(automationId, `${automationId}::%`);
  const removeLedger = db.prepare("DELETE FROM chats WHERE id = ?");
  for (const row of rows) removeLedger.run(row.ledger_chat_id);
  emitDesktopStoreChange({ entity: "automation", id: automationId });
}
