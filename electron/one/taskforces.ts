import { randomUUID } from "node:crypto";
import type {
  CreateOneTaskforceInput,
  OneTaskforce,
  RemoveOneTaskforceInput,
  UpdateOneTaskforceInput,
} from "../../shared/one-taskforces";
import { createChat, removeChat, renameChat } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getDb } from "../store/db";

type Row = {
  id: string;
  chat_id: string;
  title: string;
  member_agent_ids_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
};

const MAX_MEMBERS = 16;

function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Taskforce title must be text.");
  const title = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!title || Array.from(title).length > 80 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error("Taskforce title is invalid.");
  }
  return title;
}

function normalizeMemberIds(value: unknown, options: { allowUnavailable: boolean }): string[] {
  if (!Array.isArray(value) || value.length > MAX_MEMBERS) {
    throw new Error(`A Taskforce may include up to ${MAX_MEMBERS} staff members.`);
  }
  const ids = [...new Set(value.map((id) => assertId(id, "memberAgentId")))];
  if (!options.allowUnavailable && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = getDb().prepare(
      `SELECT installed_agent_id FROM one_org_members
       WHERE archived_at IS NULL AND installed_agent_id IN (${placeholders})`,
    ).all(...ids) as Array<{ installed_agent_id: string }>;
    const available = new Set(rows.map((row) => row.installed_agent_id));
    const missing = ids.filter((id) => !available.has(id));
    if (missing.length > 0) throw new Error("Only active One staff can be added to a Taskforce.");
  }
  return ids;
}

function assertMembersAvailable(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT installed_agent_id FROM one_org_members
     WHERE archived_at IS NULL AND installed_agent_id IN (${placeholders})`,
  ).all(...ids) as Array<{ installed_agent_id: string }>;
  const available = new Set(rows.map((row) => row.installed_agent_id));
  if (ids.some((id) => !available.has(id))) {
    throw new Error("Only active One staff can be added to a Taskforce.");
  }
}

function readMemberIds(raw: string): string[] {
  try {
    return normalizeMemberIds(JSON.parse(raw), { allowUnavailable: true });
  } catch {
    return [];
  }
}

function toTaskforce(row: Row): OneTaskforce {
  return {
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    memberAgentIds: readMemberIds(row.member_agent_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function rowFor(id: string): Row {
  const row = getDb().prepare("SELECT * FROM one_taskforces WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new Error("Taskforce not found.");
  return row;
}

function assertExpectedRevision(row: Row, expectedRevision?: number): void {
  if (expectedRevision === undefined) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || row.revision !== expectedRevision) {
    throw new Error("This Taskforce changed on another surface. Reload and try again.");
  }
}

function emitTaskforceChanged(id?: string): void {
  emitDesktopStoreChange({ entity: "one-taskforce", ...(id ? { id } : {}) });
}

export function listOneTaskforces(): OneTaskforce[] {
  return (getDb().prepare(
    `SELECT tf.* FROM one_taskforces tf
     JOIN chats c ON c.id = tf.chat_id
     WHERE c.archived_at IS NULL
     ORDER BY tf.updated_at DESC`,
  ).all() as Row[]).map(toTaskforce);
}

export function createOneTaskforce(input: CreateOneTaskforceInput): OneTaskforce {
  const title = normalizeTitle(input?.title);
  const memberAgentIds = normalizeMemberIds(input?.memberAgentIds, { allowUnavailable: false });
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().transaction(() => {
    const chat = createChat({ title, originSurface: "one", taskMode: "conversation" });
    getDb().prepare(
      `INSERT INTO one_taskforces
       (id, chat_id, title, member_agent_ids_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, chat.id, title, JSON.stringify(memberAgentIds), now, now);
  })();
  emitTaskforceChanged(id);
  return toTaskforce(rowFor(id));
}

export function updateOneTaskforce(input: UpdateOneTaskforceInput): OneTaskforce {
  const id = assertId(input?.id, "id");
  const row = rowFor(id);
  assertExpectedRevision(row, input.expectedRevision);
  const title = normalizeTitle(input.title);
  // Existing members intentionally survive lease expiry, archival, or package
  // removal so the group transcript keeps an honest grey participant row.
  // Only newly-added identities must still be active staff.
  const priorMemberIds = readMemberIds(row.member_agent_ids_json);
  const memberAgentIds = normalizeMemberIds(input.memberAgentIds, { allowUnavailable: true });
  const prior = new Set(priorMemberIds);
  assertMembersAvailable(memberAgentIds.filter((agentId) => !prior.has(agentId)));
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb().prepare(
      `UPDATE one_taskforces
       SET title = ?, member_agent_ids_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    ).run(title, JSON.stringify(memberAgentIds), now, id);
    renameChat(row.chat_id, title);
  })();
  emitTaskforceChanged(id);
  return toTaskforce(rowFor(id));
}

export function removeOneTaskforce(input: RemoveOneTaskforceInput): void {
  const id = assertId(input?.id, "id");
  const row = rowFor(id);
  assertExpectedRevision(row, input.expectedRevision);
  // chats owns the transcript and cascades the Taskforce row. The IPC layer
  // separately refuses this path while the conversation has a live run.
  removeChat(row.chat_id);
  emitTaskforceChanged(id);
}
