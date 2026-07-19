import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { tryRecordOneDomainEvent } from "../one/domain-events";
import type {
  CanonicalTask,
  CanonicalTaskParticipant,
  CanonicalTaskResultAcceptance,
  CanonicalTaskStatus,
  InvocationRunReceipt,
} from "../../shared/types";

interface TaskRow {
  id: string;
  title: string;
  project_id: string | null;
  firm_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  origin_chat_id: string | null;
}

interface TaskChatRow {
  id: string;
  title: string;
  project_id: string | null;
  firm_id: string | null;
  agent_id: string | null;
  kind: string | null;
  parent_chat_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  hired_agents: string | null;
}

interface ParticipantRow {
  task_id: string;
  agent_id: string | null;
  agent_slug: string;
  role: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

const TASK_STATUSES = new Set<CanonicalTaskStatus>([
  "open",
  "running",
  "waiting-decision",
  "partial",
  "completed",
  "failed",
  "archived",
]);

function tableExists(name: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(name),
  );
}

function normalizeStatus(value: string): CanonicalTaskStatus {
  return TASK_STATUSES.has(value as CanonicalTaskStatus)
    ? (value as CanonicalTaskStatus)
    : "open";
}

function canonicalVersion(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Task v1 exposes the authoritative ISO timestamp as its numeric version. Every
 * material mutation therefore has to advance the timestamp even when two
 * writes land in the same millisecond or the wall clock moves backwards.
 */
function monotonicUpdatedAt(previous: string | null, ...candidates: string[]): string {
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  const candidateMs = candidates
    .map((value) => Date.parse(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  let nextMs = candidateMs.length > 0 ? Math.max(...candidateMs) : Date.now();
  if (Number.isSafeInteger(previousMs) && previousMs > 0 && nextMs <= previousMs) {
    nextMs = previousMs + 1;
  }
  return new Date(nextMs).toISOString();
}

function taskIdForRootChat(chatId: string): string {
  return `task_${chatId}`;
}

function pairingTaskId(hostId: string, deviceId?: string): string {
  const hostSuffix = hostId.replace(/^host_/, "");
  if (!deviceId) return `task_pairing_${hostSuffix}`;
  if (!/^device_[a-f0-9]{32}$/.test(deviceId)) throw new Error("Invalid pairing device id");
  return `task_pairing_${hostSuffix}_${deviceId.replace(/^device_/, "")}`;
}

function chatRow(id: string): TaskChatRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, title, project_id, firm_id, agent_id, kind, parent_chat_id,
                archived_at, created_at, updated_at, hired_agents
         FROM chats WHERE id = ? LIMIT 1`,
      )
      .get(id) as TaskChatRow | undefined) ?? null
  );
}

function rootUserChat(startChatId: string): TaskChatRow | null {
  const seen = new Set<string>();
  let currentId: string | null = startChatId;
  for (let depth = 0; currentId && depth < 64; depth += 1) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const row = chatRow(currentId);
    if (!row) return null;
    if (row.kind !== "division") return row;
    currentId = row.parent_chat_id;
  }
  return null;
}

function participantRows(taskId: string): ParticipantRow[] {
  if (!tableExists("task_agent_participants")) return [];
  return getDb()
    .prepare(
      `SELECT task_id, agent_id, agent_slug, role, first_seen_at, last_seen_at
       FROM task_agent_participants
       WHERE task_id = ?
       ORDER BY first_seen_at, agent_slug`,
    )
    .all(taskId) as ParticipantRow[];
}

function toParticipant(row: ParticipantRow): CanonicalTaskParticipant {
  return {
    taskId: row.task_id,
    agentId: row.agent_id,
    agentSlug: row.agent_slug,
    role: row.role,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function participantNeedsUpsert(
  taskId: string,
  input: { agentId: string | null; agentSlug: string; role: string | null; seenAt: string },
): boolean {
  if (!tableExists("task_agent_participants")) return false;
  const row = getDb()
    .prepare(
      `SELECT task_id, agent_id, agent_slug, role, first_seen_at, last_seen_at
       FROM task_agent_participants
       WHERE task_id = ? AND agent_slug = ? LIMIT 1`,
    )
    .get(taskId, input.agentSlug) as ParticipantRow | undefined;
  if (!row) return true;
  return (
    (input.agentId !== null && input.agentId !== row.agent_id) ||
    (input.role !== null && input.role !== row.role) ||
    input.seenAt > row.last_seen_at
  );
}

function toTask(row: TaskRow): CanonicalTask {
  return {
    id: row.id,
    version: canonicalVersion(row.updated_at),
    title: row.title,
    projectId: row.project_id,
    firmId: row.firm_id,
    status: normalizeStatus(row.status),
    originChatId: row.origin_chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    participants: participantRows(row.id).map(toParticipant),
  };
}

function resolveAgentSlug(agentId: string): string {
  if (!tableExists("installed_agents")) return `agent:${agentId}`;
  const row = getDb()
    .prepare("SELECT slug FROM installed_agents WHERE id = ? LIMIT 1")
    .get(agentId) as { slug: string | null } | undefined;
  return row?.slug?.trim() || `agent:${agentId}`;
}

function hiredAgentSlugs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .map((item) =>
            item && typeof item === "object" && "slug" in item && typeof item.slug === "string"
              ? item.slug.trim()
              : "",
          )
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function upsertParticipant(
  taskId: string,
  input: { agentId: string | null; agentSlug: string; role: string | null; seenAt: string },
): void {
  if (!tableExists("task_agent_participants")) return;
  getDb()
    .prepare(
      `INSERT INTO task_agent_participants
         (task_id, agent_id, agent_slug, role, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, agent_slug) DO UPDATE SET
         agent_id = COALESCE(excluded.agent_id, task_agent_participants.agent_id),
         role = COALESCE(excluded.role, task_agent_participants.role),
         last_seen_at = CASE
           WHEN excluded.last_seen_at > task_agent_participants.last_seen_at
             THEN excluded.last_seen_at
           ELSE task_agent_participants.last_seen_at
         END
       WHERE
         (excluded.agent_id IS NOT NULL AND excluded.agent_id IS NOT task_agent_participants.agent_id)
         OR (excluded.role IS NOT NULL AND excluded.role IS NOT task_agent_participants.role)
         OR excluded.last_seen_at > task_agent_participants.last_seen_at`,
    )
    .run(
      taskId,
      input.agentId,
      input.agentSlug,
      input.role,
      input.seenAt,
      input.seenAt,
    );
}

/**
 * Materialize the durable Task for a user chat, or attach a division chat to
 * its root Task. This is deliberately idempotent so chat creation, projection,
 * and recovery can all call it without manufacturing duplicate work.
 */
export function ensureCanonicalTaskForChat(chatId: string): CanonicalTask | null {
  if (!tableExists("tasks") || !tableExists("chats")) return null;
  const root = rootUserChat(chatId);
  if (!root) return null;
  const current = chatRow(chatId);
  if (!current) return null;
  const taskId = taskIdForRootChat(root.id);
  const db = getDb();
  const rootUpdatedAt =
    root.archived_at && root.archived_at > root.updated_at
      ? root.archived_at
      : root.updated_at;
  const desiredParticipants: Array<{
    agentId: string | null;
    agentSlug: string;
    role: string | null;
    seenAt: string;
  }> = [];
  if (current.agent_id) {
    desiredParticipants.push({
      agentId: current.agent_id,
      agentSlug: resolveAgentSlug(current.agent_id),
      role: current.kind === "division" ? "worker" : "owner",
      seenAt: current.updated_at,
    });
  }
  for (const slug of hiredAgentSlugs(current.hired_agents)) {
    desiredParticipants.push({
      agentId: null,
      agentSlug: slug,
      role: "hired",
      seenAt: current.updated_at,
    });
  }
  const reconcile = db.transaction(() => {
    const prior = db
      .prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1")
      .get(taskId) as TaskRow | undefined;
    const status: CanonicalTaskStatus = root.archived_at
      ? "archived"
      : prior?.status === "archived"
        ? "open"
        : normalizeStatus(prior?.status ?? "open");
    const coreChanged =
      !prior ||
      prior.title !== root.title ||
      prior.project_id !== root.project_id ||
      prior.firm_id !== root.firm_id ||
      normalizeStatus(prior.status) !== status ||
      prior.archived_at !== root.archived_at ||
      prior.origin_chat_id !== root.id;
    const participantsChanged =
      Boolean(prior) && desiredParticipants.some((input) => participantNeedsUpsert(taskId, input));
    const updatedAt = prior
      ? coreChanged || participantsChanged
        ? monotonicUpdatedAt(prior.updated_at, rootUpdatedAt, current.updated_at)
        : prior.updated_at
      : monotonicUpdatedAt(null, rootUpdatedAt, current.updated_at);
    db.prepare(
      `INSERT INTO tasks
         (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         project_id = excluded.project_id,
         firm_id = excluded.firm_id,
         status = excluded.status,
         updated_at = excluded.updated_at,
         archived_at = excluded.archived_at,
         origin_chat_id = excluded.origin_chat_id`,
    ).run(
      taskId,
      root.title,
      root.project_id,
      root.firm_id,
      status,
      root.created_at,
      updatedAt,
      root.archived_at,
      root.id,
    );

    for (const input of desiredParticipants) upsertParticipant(taskId, input);
  });
  reconcile();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1").get(taskId) as
    | TaskRow
    | undefined;
  return row ? toTask(row) : null;
}

function reconcileAllUserChats(): void {
  if (!tableExists("chats") || !tableExists("tasks")) return;
  const rows = getDb()
    .prepare("SELECT id FROM chats WHERE kind <> 'division' ORDER BY updated_at DESC LIMIT 200")
    .all() as Array<{ id: string }>;
  for (const row of rows) {
    // New Work chats materialize at creation. General One conversations are
    // intentionally absent and a list/read must never promote them.
    if (findCanonicalTaskForChat(row.id)) ensureCanonicalTaskForChat(row.id);
  }
}

export function listCanonicalTasks(input: {
  limit?: number;
  includeArchived?: boolean;
} = {}): CanonicalTask[] {
  if (!tableExists("tasks")) return [];
  reconcileAllUserChats();
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE id NOT LIKE 'task_pairing_%'
         ${input.includeArchived ? "" : "AND status <> 'archived'"}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as TaskRow[];
  return rows.map(toTask);
}

/**
 * System-only canonical Task used to prove that one exact host projection
 * crossed the authenticated pair boundary. It never appears in One/Work task
 * lists and contains no user content.
 */
export function ensurePairingVerificationTask(
  hostId: string,
  issuedAt: string,
  deviceId?: string,
): CanonicalTask {
  if (!/^host_[a-f0-9]{32}$/.test(hostId)) throw new Error("Invalid pairing host id");
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error("Invalid pairing issue timestamp");
  if (!tableExists("tasks")) throw new Error("Canonical Task store is unavailable");
  const id = pairingTaskId(hostId, deviceId);
  const db = getDb();
  const prior = db
    .prepare("SELECT updated_at FROM tasks WHERE id = ? LIMIT 1")
    .get(id) as { updated_at: string } | undefined;
  const updatedAt = prior ? monotonicUpdatedAt(prior.updated_at, issuedAt) : issuedAt;
  db.prepare(
      `INSERT INTO tasks
         (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
       VALUES (?, 'Device connection verification', NULL, NULL, 'open', ?, ?, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         status = 'open',
         updated_at = excluded.updated_at,
         archived_at = NULL`,
    )
    .run(id, issuedAt, updatedAt);
  emitDesktopStoreChange({ entity: "task", id });
  return getCanonicalTask(id) as CanonicalTask;
}

export function getPairingVerificationTask(hostId: string): CanonicalTask | null {
  if (!/^host_[a-f0-9]{32}$/.test(hostId)) return null;
  return listPairingVerificationTasks(hostId)[0] ?? null;
}

/**
 * Keep independent receipts for concurrently paired devices. The snapshot is
 * bounded, while exact taskId/version matching lets each phone ignore receipts
 * created for another exchange.
 */
export function listPairingVerificationTasks(hostId: string): CanonicalTask[] {
  if (!/^host_[a-f0-9]{32}$/.test(hostId) || !tableExists("tasks")) return [];
  const legacyId = pairingTaskId(hostId);
  const devicePrefix = `${legacyId}_`;
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE id = ? OR substr(id, 1, ?) = ?
       ORDER BY updated_at DESC
       LIMIT 64`,
    )
    .all(legacyId, devicePrefix.length, devicePrefix) as TaskRow[];
  return rows.map(toTask);
}

export function getCanonicalTask(taskId: string): CanonicalTask | null {
  if (!tableExists("tasks")) return null;
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

/** Read the Task already bound to a chat without manufacturing one. */
export function findCanonicalTaskForChat(chatId: string): CanonicalTask | null {
  if (!tableExists("tasks") || !tableExists("chats")) return null;
  const root = rootUserChat(chatId);
  if (!root) return null;
  const row = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1")
    .get(taskIdForRootChat(root.id)) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function getCanonicalTaskForChat(chatId: string): CanonicalTask | null {
  return ensureCanonicalTaskForChat(chatId);
}

export function setCanonicalTaskStatus(
  taskId: string,
  status: CanonicalTaskStatus,
): CanonicalTask {
  if (!TASK_STATUSES.has(status)) throw new Error(`Unsupported Task status: ${status}`);
  const db = getDb();
  const update = db.transaction(() => {
    const prior = db
      .prepare("SELECT updated_at FROM tasks WHERE id = ? LIMIT 1")
      .get(taskId) as { updated_at: string } | undefined;
    if (!prior) throw new Error(`Task ${taskId} not found`);
    const now = monotonicUpdatedAt(prior.updated_at, new Date().toISOString());
    db.prepare(
      `UPDATE tasks
       SET status = ?, updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END
       WHERE id = ?`,
    ).run(status, now, status, now, taskId);
  });
  update();
  emitDesktopStoreChange({ entity: "task", id: taskId });
  return getCanonicalTask(taskId) as CanonicalTask;
}

export function acceptCanonicalTaskResult(
  input: CanonicalTaskResultAcceptance,
  receipt: InvocationRunReceipt | null,
): CanonicalTask {
  const db = getDb();
  const accept = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1")
      .get(input.taskId) as TaskRow | undefined;
    if (!row || !row.origin_chat_id) throw new Error("Canonical Task is unavailable");
    const version = canonicalVersion(row.updated_at);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== version) {
      throw new Error("Task changed before result acceptance; review the current Task state");
    }
    if (normalizeStatus(row.status) !== "partial") {
      throw new Error("Only a result-ready partial Task can be accepted as complete");
    }
    if (
      !receipt ||
      receipt.runId !== input.expectedRunId ||
      receipt.chatId !== row.origin_chat_id ||
      receipt.status !== "completed"
    ) {
      throw new Error("A matching completed run receipt is required");
    }
    const nextUpdatedAt = monotonicUpdatedAt(row.updated_at, new Date().toISOString());
    const result = db.prepare(
      `UPDATE tasks
       SET status = 'completed', updated_at = ?, archived_at = NULL
       WHERE id = ? AND status = 'partial' AND updated_at = ?`,
    ).run(nextUpdatedAt, input.taskId, row.updated_at);
    if (result.changes !== 1) {
      throw new Error("Task changed before result acceptance; review the current Task state");
    }
  });
  accept();
  emitDesktopStoreChange({ entity: "task", id: input.taskId });
  const completed = getCanonicalTask(input.taskId) as CanonicalTask;
  tryRecordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: completed.updatedAt,
    actor: "user",
    entityId: completed.id,
    ...(completed.projectId ? { projectId: completed.projectId } : {}),
    taskId: completed.id,
    version: completed.version,
    visibility: completed.projectId ? "project" : "personal",
    entries: [
      { name: "from", value: "partial" },
      { name: "to", value: "completed" },
      { name: "reason", value: "explicit user acceptance of a matching completed run receipt" },
    ],
  });
  return completed;
}

export function removeCanonicalTaskForOriginChat(chatId: string): void {
  if (!tableExists("tasks")) return;
  const row = getDb()
    .prepare("SELECT id FROM tasks WHERE origin_chat_id = ? LIMIT 1")
    .get(chatId) as { id: string } | undefined;
  if (!row) return;
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(row.id);
  emitDesktopStoreChange({ entity: "task", id: row.id });
}
