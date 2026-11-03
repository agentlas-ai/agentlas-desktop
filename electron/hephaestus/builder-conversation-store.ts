import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RuntimeSelection } from "../../shared/types";

/** This is a conversation record, not proof that a package was registered. */
export interface StoredBuilderConversation {
  schema: 1;
  revision: number;
  buildId: string;
  workspace: string;
  workspaceIdentity: { realPath: string; dev: string; ino: string; birthtimeNs: string };
  request: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  runtimeSessionId: string | null;
  hostAuthoredContinuation: boolean;
  conversationTurn: number | null;
  terminalText: string | null;
  supplementalQuestion: unknown;
  mode: "single" | "team" | "package" | null;
  runtime: RuntimeSelection | null;
  runtimePinned: boolean;
  status: "waiting-user" | "completed" | "unknown" | "stopped";
  updatedAt: string;
}

export interface BuilderConversationOwner { userId: string; workspaceId: string; scope?: "account" | "local" }

function ownerKey(owner: BuilderConversationOwner): string {
  if (typeof owner.userId !== "string" || !owner.userId || typeof owner.workspaceId !== "string" || !owner.workspaceId) throw new Error("builder_owner_required");
  if (owner.scope !== undefined && owner.scope !== "account" && owner.scope !== "local") throw new Error("builder_owner_required");
  return createHash("sha256").update(JSON.stringify([owner.scope ?? "account", owner.userId, owner.workspaceId])).digest("hex");
}

function key(owner: BuilderConversationOwner, buildId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(buildId)) throw new Error("builder_id_invalid");
  return `builder-conversation-v1:${ownerKey(owner)}:${buildId}`;
}

function validate(record: StoredBuilderConversation): void {
  if (!record || record.schema !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0
    || typeof record.workspace !== "string" || !record.workspace || typeof record.request !== "string" || !record.request
    || !record.workspaceIdentity || typeof record.workspaceIdentity.realPath !== "string"
    || ![record.workspaceIdentity.dev, record.workspaceIdentity.ino, record.workspaceIdentity.birthtimeNs].every((v) => typeof v === "string" && /^\d+$/.test(v))
    || typeof record.buildId !== "string" || !Array.isArray(record.history)
    || record.history.some((m) => !m || !["user", "assistant"].includes(m.role) || typeof m.text !== "string")
    || !["waiting-user", "completed", "unknown", "stopped"].includes(record.status)
    || typeof record.hostAuthoredContinuation !== "boolean"
    || (record.conversationTurn !== null && (!Number.isSafeInteger(record.conversationTurn) || record.conversationTurn < 0 || record.conversationTurn > 10000))
    || (record.terminalText !== null && typeof record.terminalText !== "string")
    || ![null, "single", "team", "package"].includes(record.mode)
    || typeof record.runtimePinned !== "boolean"
    || (record.runtime !== null && (typeof record.runtime !== "object" || Array.isArray(record.runtime)))
    || (record.runtimeSessionId !== null && typeof record.runtimeSessionId !== "string")
    || typeof record.updatedAt !== "string" || Buffer.byteLength(JSON.stringify(record), "utf8") > 4 * 1024 * 1024) {
    throw new Error("builder_conversation_invalid");
  }
}

export function writeBuilderConversation(db: Database.Database, owner: BuilderConversationOwner, record: StoredBuilderConversation, expectedRevision: number | null): void {
  validate(record);
  db.transaction(() => {
    const previous = readBuilderConversation(db, owner, record.buildId);
    if ((previous?.revision ?? null) !== expectedRevision || record.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) {
      throw new Error("builder_conversation_revision_conflict");
    }
    if (previous && previous.workspace !== record.workspace) throw new Error("builder_workspace_mismatch");
    if (previous?.status === "stopped" && record.status !== "stopped") throw new Error("builder_stop_is_terminal");
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key(owner, record.buildId), JSON.stringify(record));
    if (expectedRevision === null) {
      db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(`builder-conversation-latest-v1:${ownerKey(owner)}`, record.buildId);
    }
  }).immediate();
}

export function readLatestBuilderConversation(db: Database.Database, owner: BuilderConversationOwner): StoredBuilderConversation | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(`builder-conversation-latest-v1:${ownerKey(owner)}`) as { value: string } | undefined;
    return row ? readBuilderConversation(db, owner, row.value) : null;
  }).deferred();
}

export function readBuilderConversation(db: Database.Database, owner: BuilderConversationOwner, buildId: string): StoredBuilderConversation | null {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key(owner, buildId)) as { value: string } | undefined;
  if (!row) return null;
  const record = JSON.parse(row.value) as StoredBuilderConversation;
  validate(record);
  if (record.buildId !== buildId) throw new Error("builder_conversation_invalid");
  return record;
}
