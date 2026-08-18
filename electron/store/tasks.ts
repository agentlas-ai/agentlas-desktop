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
  "cancelled",
  "archived",
]);

// 존재 확인이 스트리밍 이벤트마다 sqlite_master를 다시 읽지 않도록 양성 결과만
// 캐시한다. 테이블은 프로세스 수명 동안 사라지지 않지만, 마이그레이션 전에 물은
// 음성 결과를 캐시하면 영영 없는 것으로 굳으므로 음성은 매번 다시 확인한다.
const tableExistsCache = new Set<string>();

function tableExists(name: string): boolean {
  if (tableExistsCache.has(name)) return true;
  const exists = Boolean(
    getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(name),
  );
  if (exists) tableExistsCache.add(name);
  return exists;
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
                archived_at, created_at, updated_at
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
  // 변경 판정은 읽기만으로 끝낸다. 폴링 표면이 이 함수를 틱마다 수백 번 부르는데,
  // 무변경 태스크가 WAL 쓰기 트랜잭션을 커밋하면 그 비용이 메인 스레드 전체를 막는다.
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
  if (prior && !coreChanged && !participantsChanged) return toTask(prior);
  const reconcile = db.transaction(() => {
    const updatedAt = prior
      ? monotonicUpdatedAt(prior.updated_at, rootUpdatedAt, current.updated_at)
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

// 읽기측 스윕은 안전망이지 전파 경로가 아니다: 생성·개명·아카이브는 쓰기 시점에
// 원장을 갱신한다(chats.ts). 폴링 표면 여러 개가 한 틱 안에서 list API를 중복
// 호출하므로, 전체 스윕은 이 간격 안에서 한 번이면 충분하다.
const RECONCILE_SWEEP_MIN_INTERVAL_MS = 15_000;
let lastFullReconcileSweepAt = 0;
const lastProjectReconcileSweepAt = new Map<string, number>();

function reconcileAllUserChats(): void {
  if (!tableExists("chats") || !tableExists("tasks")) return;
  const now = Date.now();
  if (now - lastFullReconcileSweepAt < RECONCILE_SWEEP_MIN_INTERVAL_MS) return;
  lastFullReconcileSweepAt = now;
  const rows = getDb()
    .prepare("SELECT id FROM chats WHERE kind <> 'division' ORDER BY updated_at DESC LIMIT 200")
    .all() as Array<{ id: string }>;
  for (const row of rows) {
    // New Work chats materialize at creation. General One conversations are
    // intentionally absent and a list/read must never promote them.
    if (findCanonicalTaskForChat(row.id)) ensureCanonicalTaskForChat(row.id);
  }
}

function reconcileProjectUserChats(projectId: string): void {
  if (!tableExists("chats") || !tableExists("tasks")) return;
  const now = Date.now();
  const last = lastProjectReconcileSweepAt.get(projectId) ?? 0;
  if (now - last < RECONCILE_SWEEP_MIN_INTERVAL_MS) return;
  lastProjectReconcileSweepAt.set(projectId, now);
  const rows = getDb()
    .prepare("SELECT id FROM chats WHERE project_id = ? AND kind <> 'division' ORDER BY updated_at DESC LIMIT 200")
    .all(projectId) as Array<{ id: string }>;
  for (const row of rows) {
    if (findCanonicalTaskForChat(row.id)) ensureCanonicalTaskForChat(row.id);
  }
}

export function listCanonicalTasks(input: {
  projectId?: string;
  limit?: number;
  includeArchived?: boolean;
  reconcile?: boolean;
} = {}): CanonicalTask[] {
  if (!tableExists("tasks")) return [];
  const projectId = typeof input.projectId === "string" && input.projectId.trim()
    ? input.projectId.trim()
    : null;
  // New project chats materialize their canonical Task at creation. Navigation
  // surfaces can therefore read the indexed task ledger directly; legacy
  // reconciliation remains opt-out for migrations and explicit repair flows.
  if (input.reconcile !== false) {
    if (projectId) reconcileProjectUserChats(projectId);
    else reconcileAllUserChats();
  }
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const statement = getDb().prepare(
      `SELECT * FROM tasks
       WHERE id NOT LIKE 'task_pairing_%'
         ${input.includeArchived ? "" : "AND status <> 'archived'"}
         ${projectId ? "AND project_id = ?" : ""}
       ORDER BY updated_at DESC
       LIMIT ?`,
    );
  const rows = (projectId ? statement.all(projectId, limit) : statement.all(limit)) as TaskRow[];
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

/**
 * ★부팅 시점의 `running`은 정의상 전부 고아다 — 앱이 방금 시작했으므로 살아 있는
 * 실행이 있을 수 없다. 실행 권위는 프로세스 안의 activeRuns이고, 그 맵은 지금 비어 있다.
 *
 * 정산하는 코드가 없으면 중단된 Task가 며칠씩 `running`으로 남는다 — 그 사이 앱이 몇 번
 * 재시작되든 마찬가지다. 즉 재시작으로도 "진행 중" 표시가 사라지지 않는다. 실행이
 * 끝나지 못한 사실과, 화면이 영원히 진행 중을 말하는 것은 다른 문제다. 후자는 거짓말이다.
 *
 * 조용히 completed로 덮지 않는다(거짓 성공). `failed`로 정산하고 사유를 원장에 남긴다 —
 * 사용자는 "끝나지 않았다"를 알아야 이어서 할지 다시 할지 정할 수 있다.
 * `waiting-decision`은 사람의 답을 기다리는 정당한 상태이므로 건드리지 않는다.
 */
export function settleInterruptedTasksOnBoot(): { settled: number; taskIds: string[] } {
  if (!tableExists("tasks")) return { settled: 0, taskIds: [] };
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM tasks WHERE status = 'running'")
    .all() as { id: string }[];
  const taskIds: string[] = [];
  for (const row of rows) {
    try {
      setCanonicalTaskStatus(row.id, "failed");
      taskIds.push(row.id);
    } catch {
      // 한 건의 정산 실패가 나머지 고아를 진행 중으로 남겨두게 두지 않는다.
    }
  }
  return { settled: taskIds.length, taskIds };
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
