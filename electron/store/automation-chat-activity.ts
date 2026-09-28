/*
 * Which automations belong to a conversation, which of them are running right now, and what each run did
 * — read from the durable automation rows and the host's tool ledger (run_events).
 *
 * Owner 2026-09-28 (Thread Marketing): the hourly Threads automation was replying on Threads from its
 * hidden session chat (⟦automation⟧…) while the conversation it reports to showed only a failed turn. The
 * conversation had no live view of the work, because nothing mapped the hidden session back to the chat.
 *
 * A conversation owns an automation when
 *   - the automation was registered from it (trigger_json.monitor.originChatId — where its reports land), or
 *   - the automation is bound to the conversation's goal (automations.goal_id = chats.goal_id).
 * A Work conversation also sees its project's automations (automations.project_id = chats.project_id).
 * A hidden session chat maps to its automation through automation_sessions (node sessions use
 * "<automationId>::a:<ref>" style ids; the part before "::" is the owner automation).
 *
 * "Running" is the scheduler's own answer (getAutomationLiveRunState): a fresh `running` automation_runs row.
 * Every transition already emits store:changed {entity:"automation"}; tool activity already streams on
 * automations:liveRun:<id>. Nothing here polls.
 */
import { digestAutomationRun, type AutomationLedgerToolEvent, type AutomationRunDigest, type AutomationRunRuntime } from "../../shared/automation-activity";
import type { AutomationChatActivityAutomation, AutomationChatActivityRunPage, AutomationChatActivitySnapshot } from "../../shared/automation-activity-ipc";
import { getDb } from "./db";
import { getAutomation, getAutomationLiveRunState } from "./automations";

export type { AutomationChatActivityAutomation, AutomationChatActivityRunPage, AutomationChatActivitySnapshot };

interface LinkRow { id: string; link: "origin" | "goal" | "project" }

function rootAutomationId(sessionAutomationId: string): string {
  const index = sessionAutomationId.indexOf("::");
  return index >= 0 ? sessionAutomationId.slice(0, index) : sessionAutomationId;
}

/** Automations a conversation owns, with how it owns each (origin wins over goal, goal over project). */
export function linkedAutomationsForChat(chatId: string, options: { includeProject?: boolean } = {}): LinkRow[] {
  const db = getDb();
  const chat = db.prepare("SELECT id, goal_id, project_id, origin_surface FROM chats WHERE id = ?")
    .get(chatId) as { id: string; goal_id: string | null; project_id: string | null; origin_surface: string | null } | undefined;
  if (!chat) return [];
  const out = new Map<string, LinkRow["link"]>();
  const origin = db.prepare(
    "SELECT id FROM automations WHERE json_extract(trigger_json, '$.monitor.originChatId') = ? ORDER BY created_at",
  ).all(chatId) as Array<{ id: string }>;
  for (const row of origin) out.set(row.id, "origin");
  if (chat.goal_id) {
    const goal = db.prepare("SELECT id FROM automations WHERE goal_id = ? ORDER BY created_at").all(chat.goal_id) as Array<{ id: string }>;
    for (const row of goal) if (!out.has(row.id)) out.set(row.id, "goal");
  }
  const includeProject = options.includeProject ?? chat.origin_surface === "work";
  if (includeProject && chat.project_id) {
    const project = db.prepare("SELECT id FROM automations WHERE project_id = ? ORDER BY created_at").all(chat.project_id) as Array<{ id: string }>;
    for (const row of project) if (!out.has(row.id)) out.set(row.id, "project");
  }
  return [...out].map(([id, link]) => ({ id, link }));
}

/** Conversations an automation reports to (origin chat + chats bound to its goal). Archived chats are skipped. */
export function ownerChatIdsForAutomation(automationId: string): string[] {
  const db = getDb();
  const row = db.prepare(
    "SELECT json_extract(trigger_json, '$.monitor.originChatId') AS origin, goal_id FROM automations WHERE id = ?",
  ).get(rootAutomationId(automationId)) as { origin: string | null; goal_id: string | null } | undefined;
  if (!row) return [];
  const ids = new Set<string>();
  if (typeof row.origin === "string" && row.origin) {
    const live = db.prepare("SELECT id FROM chats WHERE id = ? AND archived_at IS NULL").get(row.origin) as { id: string } | undefined;
    if (live) ids.add(live.id);
  }
  if (row.goal_id) {
    const chats = db.prepare("SELECT id FROM chats WHERE goal_id = ? AND archived_at IS NULL AND kind != 'division'").all(row.goal_id) as Array<{ id: string }>;
    for (const chat of chats) ids.add(chat.id);
  }
  return [...ids];
}

/** Hidden automation session chat (root or node session) → the conversations it works for. */
export function ownerChatIdsForAutomationSessionChat(ledgerChatId: string): string[] {
  const rows = getDb().prepare("SELECT automation_id FROM automation_sessions WHERE ledger_chat_id = ?")
    .all(ledgerChatId) as Array<{ automation_id: string }>;
  const ids = new Set<string>();
  for (const row of rows) for (const id of ownerChatIdsForAutomation(row.automation_id)) ids.add(id);
  return [...ids];
}

/** Automations with a live (non-simulation) run right now. */
export function runningAutomationIds(now: Date = new Date()): string[] {
  const rows = getDb().prepare(
    "SELECT DISTINCT automation_id AS id FROM automation_runs WHERE status = 'running' AND dry_run = 0 AND automation_id IS NOT NULL",
  ).all() as Array<{ id: string }>;
  return rows.map((row) => row.id).filter((id) => getAutomationLiveRunState(id, now) === "running");
}

/** Conversations whose automation is running — the sidebar comet spins for them too. */
export function automationLiveChatIds(now: Date = new Date()): string[] {
  const ids = new Set<string>();
  for (const automationId of runningAutomationIds(now)) for (const chatId of ownerChatIdsForAutomation(automationId)) ids.add(chatId);
  return [...ids];
}

interface RunRow {
  id: string;
  automation_id: string;
  started_at: string | null;
  last_activity_at: string | null;
  status: string | null;
  node_states_json: string | null;
}

function parseNodeStates(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, state]) => typeof state === "string")) as Record<string, string>;
  } catch {
    return undefined;
  }
}

function ledgerToolEvents(runId: string): AutomationLedgerToolEvent[] {
  const rows = getDb().prepare(
    `SELECT seq, ts, node_id, payload_json FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq`,
  ).all(runId) as Array<{ seq: number; ts: string; node_id: string | null; payload_json: string }>;
  const out: AutomationLedgerToolEvent[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    if (!toolName) continue;
    out.push({
      seq: row.seq,
      ts: row.ts,
      nodeId: row.node_id,
      toolName,
      toolId: typeof payload.toolId === "string" ? payload.toolId : null,
      toolArgs: typeof payload.toolArgs === "string" ? payload.toolArgs : null,
      isError: payload.toolIsError === true,
      failureCode: typeof payload.toolFailureCode === "string" ? payload.toolFailureCode : null,
    });
  }
  return out;
}

function runtimesFor(runId: string): AutomationRunRuntime[] {
  const rows = getDb().prepare(
    "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'runtime_selection' ORDER BY seq LIMIT 16",
  ).all(runId) as Array<{ payload_json: string }>;
  const seen = new Map<string, AutomationRunRuntime>();
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
    const text = (key: string) => typeof payload[key] === "string" && (payload[key] as string).length <= 120 ? payload[key] as string : null;
    const runtime = { kind: text("runtimeKind"), backend: text("runtimeBackend"), model: text("runtimeModel") };
    if (!runtime.kind && !runtime.backend) continue;
    seen.set(`${runtime.kind}|${runtime.backend}|${runtime.model}`, runtime);
  }
  return [...seen.values()];
}

function digestRow(row: RunRow): AutomationRunDigest {
  const running = row.status === "running";
  return digestAutomationRun({
    runId: row.id,
    automationId: row.automation_id,
    status: row.status ?? "unknown",
    startedAt: row.started_at,
    endedAt: running ? null : row.last_activity_at,
    nodeStates: parseNodeStates(row.node_states_json),
    runtimes: runtimesFor(row.id),
    events: ledgerToolEvents(row.id),
  });
}

/** One run's ledger digest. Null for an unknown run. */
export function automationRunDigest(runId: string): AutomationRunDigest | null {
  const row = getDb().prepare(
    "SELECT id, automation_id, started_at, last_activity_at, status, node_states_json FROM automation_runs WHERE id = ?",
  ).get(runId) as RunRow | undefined;
  return row ? digestRow(row) : null;
}

const MAX_RUN_PAGE = 20;

/** Newest-first runs of one automation, `limit` per page, older than the `before` cursor (started_at). */
export function automationRunPage(automationId: string, options: { before?: string | null; limit?: number } = {}): AutomationChatActivityRunPage {
  const limit = Math.max(1, Math.min(MAX_RUN_PAGE, Math.floor(options.limit ?? 5)));
  const before = typeof options.before === "string" && options.before ? options.before : null;
  const rows = getDb().prepare(
    `SELECT id, automation_id, started_at, last_activity_at, status, node_states_json FROM automation_runs
     WHERE automation_id = ? AND dry_run = 0 ${before ? "AND started_at < ?" : ""}
     ORDER BY started_at DESC LIMIT ?`,
  ).all(...(before ? [automationId, before, limit + 1] : [automationId, limit + 1])) as RunRow[];
  const page = rows.slice(0, limit);
  return {
    automationId,
    runs: page.map(digestRow),
    nextCursor: rows.length > limit ? page.at(-1)?.started_at ?? null : null,
  };
}

function ledgerChatIdFor(automationId: string): string | null {
  const row = getDb().prepare("SELECT ledger_chat_id FROM automation_sessions WHERE automation_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(automationId) as { ledger_chat_id: string } | undefined;
  return row?.ledger_chat_id ?? null;
}

/**
 * A conversation's automations with their live run digest. `projectId` alone gives the Work project view.
 * The payload carries ledger facts only: names, schedules, tool names, element labels, hosts.
 */
export function automationChatActivity(scope: { chatId?: string | null; projectId?: string | null; includeProject?: boolean }): AutomationChatActivitySnapshot {
  const chatId = typeof scope.chatId === "string" && scope.chatId ? scope.chatId : null;
  const projectId = typeof scope.projectId === "string" && scope.projectId ? scope.projectId : null;
  let links: LinkRow[] = [];
  if (chatId) links = linkedAutomationsForChat(chatId, { includeProject: scope.includeProject });
  if (projectId) {
    const known = new Set(links.map((link) => link.id));
    const rows = getDb().prepare("SELECT id FROM automations WHERE project_id = ? ORDER BY created_at").all(projectId) as Array<{ id: string }>;
    for (const row of rows) if (!known.has(row.id)) links.push({ id: row.id, link: "project" });
  }
  const now = new Date();
  const automations: AutomationChatActivityAutomation[] = [];
  for (const link of links) {
    const automation = getAutomation(link.id);
    if (!automation) continue;
    const running = getAutomationLiveRunState(automation.id, now) === "running";
    let liveRun: AutomationRunDigest | null = null;
    if (running) {
      const row = getDb().prepare(
        `SELECT id, automation_id, started_at, last_activity_at, status, node_states_json FROM automation_runs
         WHERE automation_id = ? AND status = 'running' AND dry_run = 0
         ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1`,
      ).get(automation.id) as RunRow | undefined;
      liveRun = row ? digestRow(row) : null;
    }
    automations.push({
      id: automation.id,
      name: automation.name,
      enabled: automation.enabled,
      scheduleHuman: automation.scheduleHuman,
      timezone: automation.timezone ?? null,
      nextRunAt: automation.nextRunAt ?? null,
      lastRunAt: automation.lastRunAt ?? null,
      link: link.link,
      ledgerChatId: ledgerChatIdFor(automation.id),
      running: running && liveRun !== null,
      liveRun,
    });
  }
  return { schemaVersion: "agentlas.automation-chat-activity.v1", chatId, projectId, automations };
}
