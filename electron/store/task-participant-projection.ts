import type Database from "better-sqlite3";

interface ChatLinkRow {
  id: string;
  kind: string | null;
  parent_chat_id: string | null;
}

interface TaskRow {
  id: string;
  updated_at: string;
}

interface InstalledAgentRow {
  id: string;
  slug: string;
}

export interface ObservedTaskParticipantInput {
  chatId: string;
  observedAgentIdentity: string;
  seenAt: string;
}

export interface ObservedTaskParticipantProjection {
  taskId: string | null;
  changed: boolean;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name),
  );
}

function resolveRootChatId(db: Database.Database, startChatId: string): string | null {
  const seen = new Set<string>();
  let currentId: string | null = startChatId;
  for (let depth = 0; currentId && depth < 64; depth += 1) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const row = db
      .prepare("SELECT id, kind, parent_chat_id FROM chats WHERE id = ? LIMIT 1")
      .get(currentId) as ChatLinkRow | undefined;
    if (!row) return null;
    if (row.kind !== "division") return row.id;
    currentId = row.parent_chat_id;
  }
  return null;
}

function resolveExactAgentIdentity(
  db: Database.Database,
  observedIdentity: string,
): { agentId: string | null; agentSlug: string } | null {
  const identity = observedIdentity.trim();
  if (!identity) return null;
  const installed = db
    .prepare(
      `SELECT id, slug
       FROM installed_agents
       WHERE id = ? OR slug = ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(identity, identity, identity) as InstalledAgentRow | undefined;
  if (installed) return { agentId: installed.id, agentSlug: installed.slug };

  // Preserve the exact runtime identity even when its package is no longer
  // installed. Never replace it with a default agent or infer from words.
  return { agentId: null, agentSlug: identity };
}

function monotonicTimestamp(previous: string, candidate: string): string {
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  const nextMs = Number.isFinite(candidateMs) ? candidateMs : Date.now();
  if (!Number.isFinite(previousMs)) return new Date(nextMs).toISOString();
  return new Date(nextMs > previousMs ? nextMs : previousMs + 1).toISOString();
}

/**
 * Project one runtime-attributed worker into the already-existing canonical
 * Task for its chat lineage. The projection is exact-identity only: an
 * installed id or slug can bind to its package, while an unknown identity is
 * retained verbatim with a null FK. It never manufactures a Task for a One
 * conversation and never changes an existing owner/hired role.
 */
export function projectObservedTaskParticipantInDb(
  db: Database.Database,
  input: ObservedTaskParticipantInput,
): ObservedTaskParticipantProjection {
  if (
    !tableExists(db, "chats") ||
    !tableExists(db, "tasks") ||
    !tableExists(db, "task_agent_participants") ||
    !tableExists(db, "installed_agents")
  ) {
    return { taskId: null, changed: false };
  }
  const rootChatId = resolveRootChatId(db, input.chatId);
  if (!rootChatId) return { taskId: null, changed: false };
  const task = db
    .prepare("SELECT id, updated_at FROM tasks WHERE origin_chat_id = ? LIMIT 1")
    .get(rootChatId) as TaskRow | undefined;
  if (!task) return { taskId: null, changed: false };
  const agent = resolveExactAgentIdentity(db, input.observedAgentIdentity);
  if (!agent) return { taskId: task.id, changed: false };
  const seenAt = Number.isFinite(Date.parse(input.seenAt))
    ? new Date(Date.parse(input.seenAt)).toISOString()
    : new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO task_agent_participants
         (task_id, agent_id, agent_slug, role, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'worker', ?, ?)
       ON CONFLICT(task_id, agent_slug) DO UPDATE SET
         agent_id = COALESCE(task_agent_participants.agent_id, excluded.agent_id),
         last_seen_at = CASE
           WHEN excluded.last_seen_at > task_agent_participants.last_seen_at
             THEN excluded.last_seen_at
           ELSE task_agent_participants.last_seen_at
         END
       WHERE
         (task_agent_participants.agent_id IS NULL AND excluded.agent_id IS NOT NULL)
         OR excluded.last_seen_at > task_agent_participants.last_seen_at`,
    )
    .run(task.id, agent.agentId, agent.agentSlug, seenAt, seenAt);
  if (result.changes === 0) return { taskId: task.id, changed: false };
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(
    monotonicTimestamp(task.updated_at, seenAt),
    task.id,
  );
  return { taskId: task.id, changed: true };
}

/** Repair the same projection from durable historical events on ordinary boot. */
export function reconcileTaskParticipantsFromRunEventsInDb(db: Database.Database): number {
  if (!tableExists(db, "run_events")) return 0;
  const observations = db
    .prepare(
      `SELECT chat_id, agent_id, MAX(ts) AS seen_at
       FROM run_events
       WHERE chat_id IS NOT NULL AND agent_id IS NOT NULL
       GROUP BY chat_id, agent_id
       ORDER BY MAX(ts), chat_id, agent_id`,
    )
    .all() as Array<{ chat_id: string; agent_id: string; seen_at: string }>;
  let changes = 0;
  for (const observation of observations) {
    const projected = projectObservedTaskParticipantInDb(db, {
      chatId: observation.chat_id,
      observedAgentIdentity: observation.agent_id,
      seenAt: observation.seen_at,
    });
    if (projected.changed) changes += 1;
  }
  return changes;
}
