// 로컬 영구 저장 — userData/agentlas.sqlite.
// PRD 6.1: better-sqlite3, 동기 API라 IPC 핸들러에서 그대로 호출 가능.
// 채팅 로그는 기본 로컬 — 클라우드 백업은 사용자 명시 토글에만 (PRD 6.3).
//
// 스키마 버전 관리: user_version pragma로 마이그레이션. M0 → projects/chats 도입 시 chat_messages 재구성.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { publicAgentVisibility } from "../agents/policy";
import { MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS } from "../automation-watchdog";
import { materializeTeamMemberCells, type MaterializableFirmNode } from "./team-member-cells";

let _db: Database.Database | null = null;
let _postContinuityRepairsDeferred = false;

const SCHEMA_VERSION = 79;

function hardenStoreFile(file: string): void {
  if (process.platform === "win32" || !fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Agentlas store path must be a regular private file: ${path.basename(file)}`);
  }
  fs.chmodSync(file, 0o600);
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new Error(`Agentlas could not make ${path.basename(file)} private.`);
  }
}

function preparePrivateStorePath(dbPath: string): void {
  if (process.platform === "win32" || dbPath === ":memory:" || dbPath.startsWith("file:")) return;
  const parent = path.dirname(dbPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(dbPath)) {
    const descriptor = fs.openSync(dbPath, "wx", 0o600);
    fs.closeSync(descriptor);
  }
  hardenStoreFile(dbPath);
}

function hardenStoreSidecars(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) return;
  hardenStoreFile(dbPath);
  hardenStoreFile(`${dbPath}-wal`);
  hardenStoreFile(`${dbPath}-shm`);
}

// The scheduler checks an active tool every 30s and then gives a cancelled
// runner 10s to settle. Two extra minutes keep recovery safely outside both
// boundaries while still repairing abandoned rows on the next periodic tick.
export const AUTOMATION_RUN_STALE_AFTER_MS =
  MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS + 2 * 60 * 1000;

type SchemaColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

type OrphanChatRow = Record<string, unknown> & {
  id: string;
  agent_id: string;
  title?: string | null;
  kind?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function schemaColumns(db: Database.Database, table: string): SchemaColumn[] {
  return db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all() as SchemaColumn[];
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}

/**
 * Read the persisted agent-route source map (userData/agent-routes.json) without
 * importing the routes module — the migration must stay self-contained and must
 * not pull the full agent registry into the schema-bootstrap path. A missing or
 * unreadable file means "no cloud/hub provenance recorded" → treated as local.
 */
function readAgentRouteSourcesForMigration(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const file = path.join(app.getPath("userData"), "agent-routes.json");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { source?: unknown }>;
    if (parsed && typeof parsed === "object") {
      for (const [agentId, route] of Object.entries(parsed)) {
        const source = route && typeof route === "object" ? (route as { source?: unknown }).source : undefined;
        if (typeof source === "string") out.set(agentId, source);
      }
    }
  } catch {
    // No routes file (fresh install / test fixture) → every firm is local-owned.
  }
  return out;
}

/**
 * Reconcile durable member cells for every locally owned team.
 *
 * v75 originally ran this only during one schema transition. That left every
 * team imported after the transition with display-only children. The writer
 * now materializes members transactionally, and this boot projection repairs
 * rows produced by older binaries or interrupted restores. Hub-borrowed teams
 * remain excluded because their workers need Hub asset/release identities, not
 * locally minted installed-agent ownership.
 */
function reconcileLocalTeamMemberCells(db: Database.Database): void {
  if (!tableExists(db, "firms") || !tableExists(db, "installed_agents")) return;
  const agentColumns = new Set(schemaColumns(db, "installed_agents").map((column) => column.name));
  if (!agentColumns.has("parent_team_id")) return;

  const routeSources = readAgentRouteSourcesForMigration();
  const isBorrowedCeo = (ceoAgentId: string): boolean => {
    const source = routeSources.get(ceoAgentId);
    return source === "hub" || source === "agent-cloud";
  };

  const firms = db
    .prepare("SELECT id, slug, ceo_agent_id, org_chart_json, installed_at FROM firms")
    .all() as Array<{
      id: string;
      slug: string;
      ceo_agent_id: string;
      org_chart_json: string;
      installed_at: string;
    }>;
  if (firms.length === 0) return;

  const updateFirmChart = db.prepare("UPDATE firms SET org_chart_json = ? WHERE id = ?");

  for (const firm of firms) {
    if (isBorrowedCeo(firm.ceo_agent_id)) continue;

    let chart: MaterializableFirmNode[];
    try {
      const parsed = JSON.parse(firm.org_chart_json);
      if (!Array.isArray(parsed)) continue;
      chart = parsed as MaterializableFirmNode[];
    } catch {
      continue;
    }

    const repaired = materializeTeamMemberCells(db, {
      firmId: firm.id,
      firmSlug: firm.slug,
      ceoAgentId: firm.ceo_agent_id,
      installedAt: firm.installed_at,
      orgChart: chart,
      preserveLegacySlugIds: true,
    });
    const serialized = JSON.stringify(repaired);
    if (serialized !== firm.org_chart_json) updateFirmChart.run(serialized, firm.id);
  }
}

type RecoverableAutomationRunRow = {
  id: string;
  automation_id: string;
  started_at: string | null;
  last_activity_at: string | null;
  node_states_json: string | null;
  occurrence_id: string | null;
  graph_digest: string | null;
  checkpoint_json: string | null;
  claimed_at: string | null;
  lease_owner: string | null;
  latest_run_event_at: string | null;
  latest_failure_event_at: string | null;
};

type RecoverableTriggerEventRow = {
  id: string;
  run_outcome: string | null;
};

function failRunningWorkflowNodes(raw: string | null): string | null {
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    let changed = false;
    for (const [nodeId, state] of Object.entries(parsed)) {
      if (state === "running") {
        parsed[nodeId] = "failed";
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : raw;
  } catch {
    return raw;
  }
}

const AUTOMATION_RECOVERY_LEASE_TTL_MS = 15 * 60 * 1000;

function trustedRecoveryPid(owner: string | null): number | null {
  const match = owner?.match(/^([1-9][0-9]*):(gui|headless)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid <= 2_147_483_647 ? pid : null;
}

function recoveryProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function finiteTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recoveryOwnerActive(row: RecoverableAutomationRunRow, nowMs: number): boolean {
  const claimedAt = finiteTimestamp(row.claimed_at);
  if (claimedAt == null) return false;
  const age = nowMs - claimedAt;
  if (age <= AUTOMATION_RECOVERY_LEASE_TTL_MS) return true;
  const pid = trustedRecoveryPid(row.lease_owner);
  return pid != null && age <= AUTOMATION_RUN_STALE_AFTER_MS && recoveryProcessAlive(pid);
}

function rowHasFreshActivity(row: RecoverableAutomationRunRow, cutoffMs: number): boolean {
  const times = [
    row.last_activity_at,
    row.started_at,
    row.latest_run_event_at,
    row.latest_failure_event_at,
  ].map(finiteTimestamp).filter((value): value is number => value != null);
  return times.length > 0 && Math.max(...times) > cutoffMs;
}

function canonicalRecoveryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRecoveryValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalRecoveryValue(child)]),
    );
  }
  return value;
}

function sealedRecoveryCheckpointIsReplaySafe(row: RecoverableAutomationRunRow): boolean {
  if (!row.checkpoint_json || !row.occurrence_id || !row.graph_digest) return false;
  try {
    const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
    if (
      !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) ||
      checkpoint.schemaVersion !== "agentlas.automation-graph-checkpoint.v3" ||
      checkpoint.occurrenceId !== row.occurrence_id || checkpoint.graphDigest !== row.graph_digest ||
      !Array.isArray(checkpoint.ambiguousNodeIds) || !Array.isArray(checkpoint.inFlightNodeIds) ||
      checkpoint.ambiguousNodeIds.some((id) => typeof id !== "string") ||
      checkpoint.inFlightNodeIds.some((id) => typeof id !== "string") ||
      typeof checkpoint.checkpointDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(checkpoint.checkpointDigest)
    ) return false;
    const payload = { ...checkpoint };
    delete payload.checkpointDigest;
    const digest = `sha256:${createHash("sha256")
      .update(JSON.stringify(canonicalRecoveryValue(payload)))
      .digest("hex")}`;
    return digest === checkpoint.checkpointDigest &&
      checkpoint.ambiguousNodeIds.length === 0 && checkpoint.inFlightNodeIds.length === 0;
  } catch {
    return false;
  }
}

function recoverStaleAutomationRunsInDb(db: Database.Database, now: Date): number {
  if (!tableExists(db, "automation_runs") || !tableExists(db, "automations")) return 0;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("automation_recovery_time_invalid");
  const cutoffMs = nowMs - AUTOMATION_RUN_STALE_AFTER_MS;
  const hasRunEvents = tableExists(db, "run_events");
  const hasFailureEvents = tableExists(db, "failure_events");
  const hasTriggerEvents = tableExists(db, "automation_trigger_events");

  const recover = db.transaction(() => {
    // Guarded inserts prevent this in the normal path, but a peer running an
    // older binary may still commit a child just after parent deletion.
    db.exec(`
      DELETE FROM automation_runs
      WHERE automation_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id);
      DELETE FROM run_history
      WHERE automation_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM automations a WHERE a.id = run_history.automation_id);
    `);
    const candidates = db.prepare(
      `SELECT r.id, r.automation_id, r.started_at, r.last_activity_at,
              r.node_states_json, r.occurrence_id, r.graph_digest, r.checkpoint_json,
              a.claimed_at, a.lease_owner,
              ${hasRunEvents ? "(SELECT MAX(e.ts) FROM run_events e WHERE e.run_id = r.id)" : "NULL"} AS latest_run_event_at,
              ${hasFailureEvents ? "(SELECT MAX(f.ts) FROM failure_events f WHERE f.run_id = r.id)" : "NULL"} AS latest_failure_event_at
       FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.status = 'running'`,
    ).all() as RecoverableAutomationRunRow[];
    const staleCandidates = candidates.filter((candidate) =>
      !rowHasFreshActivity(candidate, cutoffMs) && !recoveryOwnerActive(candidate, nowMs)
    );
    if (staleCandidates.length === 0) return 0;

    // The IMMEDIATE transaction already prevents a peer writer from entering
    // between the scan and this update. Keep an explicit snapshot CAS as well:
    // it makes that safety property local to the mutation and prevents a future
    // refactor (or a same-transaction recovery hook) from overwriting a newly
    // renewed lease, heartbeat, checkpoint, or run/failure event.
    const update = db.prepare(
      `UPDATE automation_runs
       SET status = 'error', node_states_json = ?, last_activity_at = ?
       WHERE id = ? AND automation_id = ? AND status = 'running'
         AND started_at IS ?
         AND last_activity_at IS ?
         AND node_states_json IS ?
         AND occurrence_id IS ?
         AND graph_digest IS ?
         AND checkpoint_json IS ?
         AND EXISTS (
           SELECT 1 FROM automations a
           WHERE a.id = automation_runs.automation_id
             AND a.claimed_at IS ?
             AND a.lease_owner IS ?
         )
         ${hasRunEvents
           ? "AND (SELECT MAX(e.ts) FROM run_events e WHERE e.run_id = automation_runs.id) IS ?"
           : ""}
         ${hasFailureEvents
           ? "AND (SELECT MAX(f.ts) FROM failure_events f WHERE f.run_id = automation_runs.id) IS ?"
           : ""}`,
    );
    let recovered = 0;
    for (const candidate of staleCandidates) {
      const result = update.run(
        failRunningWorkflowNodes(candidate.node_states_json),
        now.toISOString(),
        candidate.id,
        candidate.automation_id,
        candidate.started_at,
        candidate.last_activity_at,
        candidate.node_states_json,
        candidate.occurrence_id,
        candidate.graph_digest,
        candidate.checkpoint_json,
        candidate.claimed_at,
        candidate.lease_owner,
        ...(hasRunEvents ? [candidate.latest_run_event_at] : []),
        ...(hasFailureEvents ? [candidate.latest_failure_event_at] : []),
      );
      if (result.changes !== 1) continue;
      recovered += result.changes;

      if (hasTriggerEvents) {
        const triggerRows = db.prepare(
          `SELECT id, run_outcome
           FROM automation_trigger_events
           WHERE automation_id = ? AND status = 'claimed'
             AND (run_id = ? OR ('trigger-event:' || id) = ?)`,
        ).all(candidate.automation_id, candidate.id, candidate.occurrence_id) as RecoverableTriggerEventRow[];
        const replaySafe = sealedRecoveryCheckpointIsReplaySafe(candidate);
        for (const event of triggerRows) {
          if (event.run_outcome === "ok" || event.run_outcome === "skipped") {
            db.prepare(
              `UPDATE automation_trigger_events
               SET status = 'delivered', claim_owner = NULL, claimed_until = NULL,
                   delivered_at = ?, last_error = NULL, updated_at = ?
               WHERE id = ? AND status = 'claimed'`,
            ).run(now.toISOString(), now.toISOString(), event.id);
          } else if (replaySafe) {
            db.prepare(
              `UPDATE automation_trigger_events
               SET status = 'pending', claim_owner = NULL, claimed_until = NULL,
                   run_id = NULL, run_outcome = NULL, next_attempt_at = ?,
                   last_error = NULL, updated_at = ?
               WHERE id = ? AND status = 'claimed'`,
            ).run(now.toISOString(), now.toISOString(), event.id);
          } else {
            db.prepare(
              `UPDATE automation_trigger_events
               SET status = 'parked', claim_owner = NULL, claimed_until = NULL,
                   run_id = ?, last_error = ?, updated_at = ?
               WHERE id = ? AND status = 'claimed'`,
            ).run(
              candidate.id,
              "trigger_event_stale_run_reconciliation_required",
              now.toISOString(),
              event.id,
            );
          }
        }
      }
      if (hasRunEvents) {
        const seq = Number((db.prepare(
          "SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM run_events WHERE run_id = ?",
        ).get(candidate.id) as { seq?: number } | undefined)?.seq ?? 0);
        db.prepare(
          `INSERT INTO run_events
             (id, run_id, seq, ts, kind, automation_id, payload_json)
           VALUES (?, ?, ?, ?, 'automation_stale_run_recovered', ?, ?)`,
        ).run(
          `evt_${randomUUID()}`,
          candidate.id,
          seq,
          now.toISOString(),
          candidate.automation_id,
          JSON.stringify({ replaySafeCheckpoint: sealedRecoveryCheckpointIsReplaySafe(candidate) }),
        );
      }
    }
    return recovered;
  });
  const previousBusyTimeout = Number(db.pragma("busy_timeout", { simple: true }) ?? 0);
  db.pragma("busy_timeout = 0");
  try {
    return recover.immediate();
  } finally {
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(previousBusyTimeout))}`);
  }
}

function hasMeaningfulHiredAgents(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "[]" && normalized !== "null";
}

function isDisposableUnusedTitle(value: unknown): boolean {
  const title = String(value ?? "").trim().toLowerCase();
  return title === "" || title === "새 채팅" || title === "new chat" || title.endsWith(" operations");
}

/**
 * Finds any textual reference to a chat id outside chats.id itself. This is
 * deliberately conservative: named FK columns, JSON payloads, metadata, and
 * future TEXT reference columns all keep the chat on the recovery path.
 */
function firstChatReference(db: Database.Database, chatId: string): string | null {
  const tables = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  for (const { name: table } of tables) {
    const columns = schemaColumns(db, table).filter((column) => {
      if (table === "chats" && column.name === "id") return false;
      const declared = String(column.type ?? "").toUpperCase();
      return declared.includes("TEXT") || declared.includes("CHAR") || declared.includes("CLOB") || declared.includes("JSON");
    });
    if (columns.length === 0) continue;
    const clauses = columns.map((column) => `instr(CAST(${quoteSqlIdentifier(column.name)} AS TEXT), ?) > 0`);
    const found = db
      .prepare(
        `SELECT 1 AS found
         FROM ${quoteSqlIdentifier(table)}
         WHERE ${clauses.join(" OR ")}
         LIMIT 1`,
      )
      .get(...columns.map(() => chatId)) as { found: number } | undefined;
    if (found) return table;
  }
  return null;
}

const V50_REQUIRED_CHAT_COLUMNS = [
  "id",
  "agent_id",
  "title",
  "kind",
  "project_id",
  "firm_id",
  "agent_group_id",
  "parent_chat_id",
  "created_at",
  "updated_at",
  "used_at",
  "last_viewed_at",
  "archived_at",
  "working_folder",
  "continuous_mode",
  "swarm_mode",
  "hired_agents",
] as const;

function orphanChatPreservationReasons(
  db: Database.Database,
  row: OrphanChatRow,
  hasCanonicalChatShape: boolean,
): string[] {
  if (!hasCanonicalChatShape) return ["unknown-chat-schema"];
  const reasons: string[] = [];
  if (String(row.kind ?? "user") !== "user") reasons.push("non-standalone-kind");
  for (const column of [
    "project_id",
    "firm_id",
    "agent_group_id",
    "parent_chat_id",
    "used_at",
    "last_viewed_at",
    "archived_at",
    "working_folder",
  ] as const) {
    const value = row[column];
    if (value !== null && value !== undefined && String(value).trim() !== "") reasons.push(column);
  }
  if (Number(row.continuous_mode ?? 0) !== 0) reasons.push("continuous_mode");
  if (Number(row.swarm_mode ?? 0) !== 0) reasons.push("swarm_mode");
  if (hasMeaningfulHiredAgents(row.hired_agents)) reasons.push("hired_agents");
  if (
    typeof row.created_at === "string" && typeof row.updated_at === "string" &&
    row.created_at !== row.updated_at
  ) {
    reasons.push("updated-after-create");
  }
  if (!isDisposableUnusedTitle(row.title)) reasons.push("custom-title");
  const reference = firstChatReference(db, row.id);
  if (reference) reasons.push(`referenced:${reference}`);
  return [...new Set(reasons)];
}

function recoverySlug(db: Database.Database, missingAgentId: string): string {
  const base = `recovered-orphan-${Buffer.from(missingAgentId, "utf8").toString("hex")}`;
  let candidate = base;
  let suffix = 1;
  while (
    db.prepare("SELECT 1 FROM installed_agents WHERE slug = ? AND id <> ? LIMIT 1").get(candidate, missingAgentId)
  ) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

function insertRecoveryAgent(
  db: Database.Database,
  missingAgentId: string,
  earliestChatAt: string | null,
): void {
  const columns = new Set(schemaColumns(db, "installed_agents").map((column) => column.name));
  if (!columns.has("id")) throw new Error("v50 recovery cannot repair installed_agents without an id column");
  const shortId = missingAgentId.slice(0, 12) || "unknown";
  const values: Record<string, unknown> = {
    id: missingAgentId,
    slug: columns.has("slug") ? recoverySlug(db, missingAgentId) : undefined,
    name: `Recovered deleted agent ${shortId}`,
    name_en: `Recovered deleted agent ${shortId}`,
    tagline: "Preserved because local chat history or references still exist.",
    tagline_en: "Preserved because local chat history or references still exist.",
    system_prompt: "This is a read-only recovery placeholder for a deleted agent. Preserve the local chat history; do not perform autonomous actions.",
    mcp_servers_json: "[]",
    preferred_backend: null,
    trust_grade: "unknown",
    installed_at: earliestChatAt || new Date().toISOString(),
    tone: "blue",
    env_requirements_json: "[]",
    builtin: 0,
    role: "recovery-placeholder",
    visibility: "private",
    entity_kind: "agent",
  };
  const insertColumns = Object.keys(values).filter((column) => columns.has(column));
  db.prepare(
    `INSERT INTO installed_agents (${insertColumns.map(quoteSqlIdentifier).join(", ")})
     VALUES (${insertColumns.map(() => "?").join(", ")})`,
  ).run(...insertColumns.map((column) => values[column]));
}

function repairOrphanChatsV50(db: Database.Database): void {
  if (!tableExists(db, "chats") || !tableExists(db, "installed_agents")) return;
  const chatColumns = schemaColumns(db, "chats");
  const chatColumnNames = new Set(chatColumns.map((column) => column.name));
  if (!chatColumnNames.has("id") || !chatColumnNames.has("agent_id")) return;
  const hasCanonicalChatShape = V50_REQUIRED_CHAT_COLUMNS.every((column) => chatColumnNames.has(column));
  const orphanRows = db
    .prepare(
      `SELECT c.*
       FROM chats c
       LEFT JOIN installed_agents a ON a.id = c.agent_id
       WHERE a.id IS NULL
       ORDER BY c.rowid`,
    )
    .all() as OrphanChatRow[];
  if (orphanRows.length === 0) return;

  // Decide every row before mutating anything, so two orphan chats that refer
  // to each other cannot become accidentally deletable based on iteration order.
  const decisions = orphanRows.map((row) => ({
    row,
    reasons: orphanChatPreservationReasons(db, row, hasCanonicalChatShape),
  }));
  const deleted = decisions.filter((decision) => decision.reasons.length === 0);
  const preserved = decisions.filter((decision) => decision.reasons.length > 0);
  const recoveredAgentIds = [...new Set(preserved.map((decision) => decision.row.agent_id))];
  const baselineOtherViolations = new Set(
    (db.pragma("foreign_key_check") as Array<{ table: string; rowid: number | null; parent: string; fkid: number }>)
      .filter((violation) => !(violation.table === "chats" && violation.parent === "installed_agents"))
      .map((violation) => `${violation.table}:${violation.rowid ?? "null"}:${violation.parent}:${violation.fkid}`),
  );

  const migrate = db.transaction(() => {
    for (const decision of deleted) {
      db.prepare("DELETE FROM chats WHERE id = ?").run(decision.row.id);
    }
    for (const missingAgentId of recoveredAgentIds) {
      const earliest = preserved
        .filter((decision) => decision.row.agent_id === missingAgentId)
        .map((decision) => decision.row.created_at)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .sort()[0] ?? null;
      insertRecoveryAgent(db, missingAgentId, earliest);
    }

    const remainingChatAgentViolations = (
      db.pragma("foreign_key_check") as Array<{ table: string; rowid: number | null; parent: string; fkid: number }>
    ).filter((violation) => violation.table === "chats" && violation.parent === "installed_agents");
    if (remainingChatAgentViolations.length > 0) {
      throw new Error(`v50 orphan-chat repair left ${remainingChatAgentViolations.length} chat agent violation(s)`);
    }
    const newOtherViolations = (
      db.pragma("foreign_key_check") as Array<{ table: string; rowid: number | null; parent: string; fkid: number }>
    ).filter(
      (violation) =>
        !(violation.table === "chats" && violation.parent === "installed_agents") &&
        !baselineOtherViolations.has(`${violation.table}:${violation.rowid ?? "null"}:${violation.parent}:${violation.fkid}`),
    );
    if (newOtherViolations.length > 0) {
      throw new Error(`v50 orphan-chat repair introduced ${newOtherViolations.length} integrity violation(s)`);
    }

    if (tableExists(db, "meta")) {
      const metaColumns = new Set(schemaColumns(db, "meta").map((column) => column.name));
      if (metaColumns.has("key") && metaColumns.has("value")) {
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "migration:v50:orphan-chat-repair",
          JSON.stringify({
            version: 50,
            policy: "delete-only-contentless-unused-unreferenced-standalone; recover-placeholder-otherwise",
            deleted: deleted.map((decision) => ({
              chatId: decision.row.id,
              missingAgentId: decision.row.agent_id,
              title: decision.row.title ?? "",
              createdAt: decision.row.created_at ?? null,
            })),
            preserved: preserved.map((decision) => ({
              chatId: decision.row.id,
              missingAgentId: decision.row.agent_id,
              reasons: decision.reasons,
            })),
            recoveredAgentIds,
          }),
        );
      }
    }
  });
  migrate();
}

// ── v71/v72 Task 정본화 백필 헬퍼 (릴리스 A: 가산적·무손실) ─────────────
// 이 단계는 chats를 재건축하지 않는다. tasks / task_agent_participants만 추가하고
// 기존 chats에서 결정적으로 백필한다. chats.task_id 컬럼과 파괴적 재건축은 v73
// (릴리스 B)에서 별도로 수행하며, 그때 아래와 같은 재귀 부모 해석으로 task_id를
// 채운다. Release A와 B 사이에 생성된 chat도 v73 진입 시 같은 백필을 재실행한다.

/** 결정적 Task ID — chat id에서 파생(멱등: 재실행해도 같은 id). */
function taskIdForChat(chatId: string): string {
  return `task_${chatId}`;
}

/** parent_chat_id 사슬을 루트까지 걷는다. 루트가 kind='user'면 그 chat id를,
 *  아니면(고아 division 등) null을 반환한다. 사이클/과도한 깊이는 안전하게 끊는다. */
function resolveRootUserChatId(
  db: Database.Database,
  startChatId: string,
  rowByIdCache: Map<string, { kind: string | null; parent_chat_id: string | null } | null>,
): string | null {
  const getRow = (id: string) => {
    if (rowByIdCache.has(id)) return rowByIdCache.get(id) ?? null;
    const row = db
      .prepare("SELECT kind, parent_chat_id FROM chats WHERE id = ? LIMIT 1")
      .get(id) as { kind: string | null; parent_chat_id: string | null } | undefined;
    const value = row ?? null;
    rowByIdCache.set(id, value);
    return value;
  };

  const seen = new Set<string>();
  let currentId: string | null = startChatId;
  let depth = 0;
  while (currentId && depth < 64) {
    if (seen.has(currentId)) return null; // 사이클 방어
    seen.add(currentId);
    const row = getRow(currentId);
    if (!row) return null; // dangling 부모
    if (row.kind !== "division") {
      // kind='user' 또는 legacy NULL(=user로 취급) → 루트 사용자 chat
      return currentId;
    }
    if (!row.parent_chat_id) return null; // 부모 없는 division = 고아 → task 없음
    currentId = row.parent_chat_id;
    depth += 1;
  }
  return null;
}

/** v71: 최상위 사용자 chat 1개당 durable Task 1개. 멱등(origin_chat_id 가드). */
function backfillTasksV71(db: Database.Database): void {
  if (!tableExists(db, "chats") || !tableExists(db, "tasks")) return;
  const chatColumnNames = new Set(schemaColumns(db, "chats").map((column) => column.name));
  if (!chatColumnNames.has("kind")) return; // kind 이전(v13 미만) DB에는 사용자/division 구분 없음
  db.exec(`
    INSERT INTO tasks (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
    SELECT
      'task_' || c.id,
      c.title,
      c.project_id,
      c.firm_id,
      CASE WHEN c.archived_at IS NOT NULL THEN 'archived' ELSE 'open' END,
      c.created_at,
      c.updated_at,
      c.archived_at,
      c.id
    FROM chats c
    WHERE c.kind <> 'division'
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.origin_chat_id = c.id);
  `);
}

/** v72: 각 chat의 루트 Task에 참여 에이전트를 기록. 재귀 부모 해석 + hired_agents 병합.
 *  agent_slug는 NOT NULL(미해석 시 센티널 'agent:<id>'), upsert로 중복 병합. */
function backfillTaskParticipantsV72(db: Database.Database): void {
  if (
    !tableExists(db, "chats") ||
    !tableExists(db, "tasks") ||
    !tableExists(db, "task_agent_participants")
  ) {
    return;
  }
  const chatColumnNames = new Set(schemaColumns(db, "chats").map((column) => column.name));
  if (!chatColumnNames.has("kind") || !chatColumnNames.has("agent_id")) return;
  const hasHired = chatColumnNames.has("hired_agents");

  const chats = db
    .prepare(
      `SELECT id, agent_id, updated_at${hasHired ? ", hired_agents" : ""} FROM chats ORDER BY rowid`,
    )
    .all() as Array<{ id: string; agent_id: string | null; updated_at: string | null; hired_agents?: string | null }>;

  const slugByAgentId = new Map<string, string | null>();
  const resolveSlug = (agentId: string | null): string => {
    if (!agentId) return "agent:__none__";
    if (!slugByAgentId.has(agentId)) {
      const row = db
        .prepare("SELECT slug FROM installed_agents WHERE id = ? LIMIT 1")
        .get(agentId) as { slug: string | null } | undefined;
      slugByAgentId.set(agentId, row?.slug ?? null);
    }
    const slug = slugByAgentId.get(agentId);
    return slug && slug.length > 0 ? slug : `agent:${agentId}`;
  };

  const upsert = db.prepare(`
    INSERT INTO task_agent_participants
      (task_id, agent_id, agent_slug, role, first_seen_at, last_seen_at)
    VALUES (@task_id, @agent_id, @agent_slug, @role, @seen_at, @seen_at)
    ON CONFLICT(task_id, agent_slug) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      agent_id = COALESCE(excluded.agent_id, task_agent_participants.agent_id)
  `);

  const rootCache = new Map<string, { kind: string | null; parent_chat_id: string | null } | null>();
  const nowIso = new Date().toISOString();

  const run = db.transaction(() => {
    for (const chat of chats) {
      const rootChatId = resolveRootUserChatId(db, chat.id, rootCache);
      if (!rootChatId) continue; // 고아 division 등 → Task 없음
      const taskId = taskIdForChat(rootChatId);
      // 루트 task가 실제 존재할 때만(빈 shell 등 제외 대비)
      const taskExists = db.prepare("SELECT 1 FROM tasks WHERE id = ? LIMIT 1").get(taskId);
      if (!taskExists) continue;
      const seenAt = chat.updated_at ?? nowIso;

      if (chat.agent_id) {
        upsert.run({
          task_id: taskId,
          agent_id: chat.agent_id,
          agent_slug: resolveSlug(chat.agent_id),
          role: null,
          seen_at: seenAt,
        });
      }

      if (hasHired && chat.hired_agents) {
        try {
          const parsed = JSON.parse(chat.hired_agents);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const slug = item && typeof item === "object" && typeof item.slug === "string" ? item.slug.trim() : "";
              if (!slug) continue;
              upsert.run({
                task_id: taskId,
                agent_id: null,
                agent_slug: slug,
                role: "hired",
                seen_at: seenAt,
              });
            }
          }
        } catch {
          // 손상된 hired_agents JSON은 조용히 건너뛴다(백필은 best-effort).
        }
      }
    }
  });
  run();
}

export interface StoreInitOptions {
  /**
   * A just-installed binary must verify the pre-update recovery snapshot before
   * any boot repair mutates protected rows. Schema migrations still run here;
   * repair projections resume only after the updater continuity gate passes.
   */
  deferPostContinuityRepairs?: boolean;
}

function runStoreRepairProjections(db: Database.Database): void {
  // The local-team writer now materializes members in the same transaction as
  // the firm. Reconcile on ordinary boots as a repair projection so teams
  // created by older binaries, restores, or interrupted imports cannot remain
  // display-only forever. A pending update defers this until continuity passes.
  try {
    db.transaction(() => reconcileLocalTeamMemberCells(db))();
  } catch (error) {
    console.warn(
      `[migration] v77 member-cell reconciliation deferred: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // Run on every ordinary boot as well as the v52 upgrade. During a pending
  // update this is deferred because terminalizing a stale run is a legitimate
  // write that must not race the pre-update continuity snapshot.
  try {
    const recoveredAutomationRuns = recoverStaleAutomationRunsInDb(db, new Date());
    if (recoveredAutomationRuns > 0) {
      console.warn(`[automation] recovered ${recoveredAutomationRuns} abandoned run snapshot(s)`);
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "busy")
      : "busy";
    console.warn(`[automation] boot run recovery deferred (${code})`);
  }
}

export function runPostContinuityStoreRepairs(): void {
  if (!_db) {
    throw new Error("Store not initialized. Call initStore() before post-continuity repairs.");
  }
  if (!_postContinuityRepairsDeferred) return;
  runStoreRepairProjections(_db);
  _postContinuityRepairsDeferred = false;
}

export function initStore(options: StoreInitOptions = {}): void {
  if (_db) return;
  const dbPath = process.env.AGENTLAS_STORE_PATH || path.join(app.getPath("userData"), "agentlas.sqlite");
  preparePrivateStorePath(dbPath);
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  // GUI and launchd share this WAL. Event-source callbacks must wait briefly
  // for the current writer instead of dropping a filesystem/chain delivery on
  // an immediate SQLITE_BUSY. Long-running work never holds a DB transaction.
  _db.pragma("busy_timeout = 5000");
  hardenStoreSidecars(dbPath);
  _db.pragma("foreign_keys = ON");

  const userVersion = (_db.pragma("user_version", { simple: true }) as number) ?? 0;

  // ── v0 → v1: 초기 스키마 (active_runtime, installed_agents) ─
  if (userVersion < 1) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS active_runtime (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        kind TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installed_agents (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        mcp_servers_json TEXT NOT NULL,
        preferred_backend TEXT,
        trust_grade TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        tone TEXT NOT NULL
      );
    `);

    // 이전 v0 dev DB에 system_prompt 없으면 추가
    const cols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "system_prompt")) {
      _db.exec(
        "ALTER TABLE installed_agents ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  // ── v1 → v2: projects, chats 도입. chat_messages는 chat_id FK ─
  if (userVersion < 2) {
    // 이전 v1 dev DB의 chat_messages(agent_id 기반)는 버린다 — M0 dev 데이터.
    _db.exec(`
      DROP TABLE IF EXISTS chat_messages;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_agent_id TEXT,
        context_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(default_agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New chat',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chats_project_updated
        ON chats(project_id, updated_at DESC);

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_chat_messages_chat_created
        ON chat_messages(chat_id, created_at);
    `);
  }

  // ── v2 → v3: firms 테이블 + chats.firm_id + automations.target_type/id ─
  if (userVersion < 3) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS firms (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        persona TEXT NOT NULL,
        ceo_agent_id TEXT NOT NULL,
        org_chart_json TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_firms_installed ON firms(installed_at DESC);
    `);

    // chats.firm_id 추가
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "firm_id")) {
      _db.exec("ALTER TABLE chats ADD COLUMN firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL");
      _db.exec("CREATE INDEX IF NOT EXISTS idx_chats_firm_updated ON chats(firm_id, updated_at DESC)");
    }

    // automations는 메모리 stub이라 스키마 변경 불필요 — 새 구조로 그냥 시작
  }

  // ── v3 → v4: chats.archived_at (보관함) ───────────────────
  if (userVersion < 4) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "archived_at")) {
      _db.exec("ALTER TABLE chats ADD COLUMN archived_at TEXT");
      _db.exec(
        "CREATE INDEX IF NOT EXISTS idx_chats_archived_updated ON chats(archived_at, updated_at DESC)",
      );
    }
  }

  // ── v5 → v6: installed_agents.env_requirements_json ─────
  if (userVersion < 6) {
    const cols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "env_requirements_json")) {
      _db.exec(
        "ALTER TABLE installed_agents ADD COLUMN env_requirements_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
  }

  // ── v4 → v5: installed_agents/firms 다국어 (name_en, tagline_en) ─
  if (userVersion < 5) {
    const agentCols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === "name_en")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN name_en TEXT NOT NULL DEFAULT ''");
    }
    if (!agentCols.some((c) => c.name === "tagline_en")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN tagline_en TEXT NOT NULL DEFAULT ''");
    }
    const firmCols = _db
      .prepare("PRAGMA table_info(firms)")
      .all() as Array<{ name: string }>;
    if (!firmCols.some((c) => c.name === "name_en")) {
      _db.exec("ALTER TABLE firms ADD COLUMN name_en TEXT NOT NULL DEFAULT ''");
    }
    if (!firmCols.some((c) => c.name === "tagline_en")) {
      _db.exec("ALTER TABLE firms ADD COLUMN tagline_en TEXT NOT NULL DEFAULT ''");
    }
  }

  // ── v6 → v7: active_runtime distinguishes BYOK backends ──
  if (userVersion < 7) {
    const runtimeCols = _db
      .prepare("PRAGMA table_info(active_runtime)")
      .all() as Array<{ name: string }>;
    if (!runtimeCols.some((c) => c.name === "backend")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN backend TEXT");
    }
    if (!runtimeCols.some((c) => c.name === "source")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN source TEXT");
    }
  }

  // ── v7 → v8: chats.working_folder (워킹 폴더 패널) ───────
  if (userVersion < 8) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "working_folder")) {
      _db.exec("ALTER TABLE chats ADD COLUMN working_folder TEXT");
    }
  }

  // ── v8 → v9: active_runtime.model (Ollama 등 로컬 LLM의 활성 모델) ─
  if (userVersion < 9) {
    const runtimeCols = _db
      .prepare("PRAGMA table_info(active_runtime)")
      .all() as Array<{ name: string }>;
    if (!runtimeCols.some((c) => c.name === "model")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN model TEXT");
    }
  }

  // ── v9 → v10: 외부 MCP 툴 서버 + 에이전트별 연결 ────────
  if (userVersion < 10) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        catalog_id TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env_keys_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_mcp_servers (
        agent_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, server_id),
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_mcp_agent ON agent_mcp_servers(agent_id);
    `);
  }

  // ── v10 → v11: active_runtime.long_context (BYOK 1M 컨텍스트 토글) ─
  if (userVersion < 11) {
    const runtimeCols = _db
      .prepare("PRAGMA table_info(active_runtime)")
      .all() as Array<{ name: string }>;
    if (!runtimeCols.some((c) => c.name === "long_context")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN long_context INTEGER NOT NULL DEFAULT 0");
    }
  }

  // ── v11 → v12: Agentlas Architecture — built-in agents + curated memory ──
  //   installed_agents.builtin/role : marks baked-in background architecture agents.
  //   meta                          : key/value (e.g. architecture_version) for upgrade gating.
  //   memory_entries                : the Memory Curator's durable store.
  //   folder_activity               : repeated-work detection → auto-activates PM Soul + sitemap.
  if (userVersion < 12) {
    const agentCols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === "builtin")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0");
    }
    if (!agentCols.some((c) => c.name === "role")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN role TEXT");
    }

    _db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        project_id TEXT,
        project_path TEXT,
        agent_id TEXT,
        chat_id TEXT,
        confidence TEXT NOT NULL DEFAULT 'medium',
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        superseded_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_entries(project_path, superseded_at);
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope, superseded_at);
      CREATE INDEX IF NOT EXISTS idx_memory_chat ON memory_entries(chat_id);

      CREATE TABLE IF NOT EXISTS folder_activity (
        path TEXT PRIMARY KEY,
        visits INTEGER NOT NULL DEFAULT 0,
        activated_at TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `);
  }

  // ── v12 → v13: 멀티 에이전트 — 숨김 본부 세션(sub-chat) + per-agent 메모리 인덱스 ──
  //   chats.kind          : 'user'(일반, 사이드바 노출) | 'division'(백그라운드 본부 세션, 숨김)
  //   chats.parent_chat_id: 본부 세션 → 부모 firm 채팅 링크
  if (userVersion < 13) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "kind")) {
      _db.exec("ALTER TABLE chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
    }
    if (!chatCols.some((c) => c.name === "parent_chat_id")) {
      _db.exec("ALTER TABLE chats ADD COLUMN parent_chat_id TEXT");
    }
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats(parent_chat_id);" +
        "CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_id, superseded_at);",
    );
  }

  // ── v13 → v14: 프로젝트에 작업 폴더(folder_path) 추가 ─
  if (userVersion < 14) {
    const projCols = _db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    if (!projCols.some((c) => c.name === "folder_path")) {
      _db.exec("ALTER TABLE projects ADD COLUMN folder_path TEXT");
    }
  }

  // ── v14 → v15: 자동화 영속화 (in-memory stub → SQLite) + 스케줄러 ─
  if (userVersion < 15) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL DEFAULT 'user',
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);
    `);
  }

  // ── v15 → v16: memory_entries request-context capsule ─
  // Stores a curated, redacted provenance summary for contextual recall. This is
  // not a raw user prompt or transcript.
  if (userVersion < 16) {
    const memoryCols = _db
      .prepare("PRAGMA table_info(memory_entries)")
      .all() as Array<{ name: string }>;
    if (memoryCols.length > 0 && !memoryCols.some((c) => c.name === "context_json")) {
      _db.exec("ALTER TABLE memory_entries ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  // ── v16 → v17: Agent-made service-app registry + operation history ─
  if (userVersion < 17) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_apps (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        app_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        layout TEXT NOT NULL,
        root_path TEXT NOT NULL,
        preview_path TEXT NOT NULL,
        setup_path TEXT NOT NULL,
        smoke_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scaffolded',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_apps_chat_updated
        ON agent_apps(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_apps_surface
        ON agent_apps(chat_id, surface_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_apps_root
        ON agent_apps(root_path);

      CREATE TABLE IF NOT EXISTS agent_app_operations (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(app_id) REFERENCES agent_apps(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_app_ops_app_created
        ON agent_app_operations(app_id, created_at DESC);
    `);
  }

  // ── v17 → v18: Agent-made local-tool registry + MCP install history ─
  if (userVersion < 18) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tools (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        requested_tool_id TEXT NOT NULL,
        generated_tool_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        kind TEXT NOT NULL,
        root_path TEXT NOT NULL,
        config_path TEXT NOT NULL,
        tool_path TEXT NOT NULL,
        mcp_path TEXT NOT NULL,
        smoke_path TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scaffolded',
        installed_server_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(installed_server_id) REFERENCES mcp_servers(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tools_chat_updated
        ON agent_tools(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_tools_surface
        ON agent_tools(chat_id, surface_id, requested_tool_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tools_root
        ON agent_tools(root_path);

      CREATE TABLE IF NOT EXISTS agent_tool_operations (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(tool_id) REFERENCES agent_tools(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tool_ops_tool_created
        ON agent_tool_operations(tool_id, created_at DESC);
    `);
  }

  // ── v18 → v19: Agent-made interactive surface registry ─
  if (userVersion < 19) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_surfaces (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        domain TEXT NOT NULL,
        layout TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        state_json TEXT NOT NULL DEFAULT '{}',
        provenance_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_surfaces_chat_updated
        ON agent_surfaces(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surfaces_domain_updated
        ON agent_surfaces(domain, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surfaces_project_updated
        ON agent_surfaces(project_id, updated_at DESC);
    `);
  }

  // ── v19 → v20: Surface asset packs materialized from agent manifests ─
  if (userVersion < 20) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_surface_asset_packs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        pack_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        layout TEXT NOT NULL,
        root_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        index_path TEXT NOT NULL,
        assets_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'materialized',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_surface_asset_packs_chat_updated
        ON agent_surface_asset_packs(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surface_asset_packs_surface_updated
        ON agent_surface_asset_packs(chat_id, surface_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_surface_asset_packs_root
        ON agent_surface_asset_packs(root_path);

      CREATE TABLE IF NOT EXISTS agent_surface_asset_pack_operations (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES agent_surface_asset_packs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_surface_asset_pack_ops_pack_created
        ON agent_surface_asset_pack_operations(pack_id, created_at DESC);
    `);
  }

  // ── v20 → v21: Durable surface job/cost ledger ─────────
  if (userVersion < 21) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_surface_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        cost_estimate REAL,
        cost_spent REAL,
        currency TEXT,
        resumable INTEGER NOT NULL DEFAULT 0,
        manifest_job_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE,
        UNIQUE(surface_id, job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_surface_jobs_chat_updated
        ON agent_surface_jobs(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surface_jobs_surface_updated
        ON agent_surface_jobs(surface_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surface_jobs_status_updated
        ON agent_surface_jobs(status, updated_at DESC);
    `);
  }

  // ── v21 → v22: Surface state event log ─────────────────
  if (userVersion < 22) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_surface_events (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        path TEXT NOT NULL,
        value_json TEXT NOT NULL,
        previous_value_json TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_surface_events_surface_created
        ON agent_surface_events(surface_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surface_events_chat_created
        ON agent_surface_events(chat_id, created_at DESC);
    `);
  }

  // ── v22 → v23: installed_agents.visibility contract ─────
  // Every agent row must classify as visible | background | private. Renderer lists
  // hide background agents from user-facing pickers and main-process policy blocks
  // private web-only agents from desktop install/list surfaces.
  if (userVersion < 23) {
    const agentCols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === "visibility")) {
      _db.exec(
        "ALTER TABLE installed_agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','background','private'))",
      );
    }
    const rows = _db
      .prepare(
        "SELECT id, slug, name, name_en, tagline, tagline_en, builtin, role, visibility FROM installed_agents",
      )
      .all() as Array<{
        id: string;
        slug: string;
        name: string;
        name_en: string;
        tagline: string;
        tagline_en: string;
        builtin: number;
        role: string | null;
        visibility: string | null;
      }>;
    const update = _db.prepare("UPDATE installed_agents SET visibility = ? WHERE id = ?");
    const tx = _db.transaction(() => {
      for (const row of rows) update.run(publicAgentVisibility(row), row.id);
    });
    tx();
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_installed_agents_visibility ON installed_agents(visibility, installed_at DESC)",
    );
  }

  // ── v23 → v24: Durable surface approval ledger ─────────
  // Approval is an OS event, not renderer-local state. Capability, budget,
  // credential, browser, and payment approvals are auditable and survive
  // reopening the same generated app/surface. Secret values and card details
  // are never stored here; only the explicit user-approved scope is recorded.
  if (userVersion < 24) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_surface_approvals (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        action_id TEXT,
        action_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(surface_id) REFERENCES agent_surfaces(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_surface_approvals_surface_created
        ON agent_surface_approvals(surface_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_surface_approvals_scope_active
        ON agent_surface_approvals(surface_id, scope_key, revoked_at, created_at DESC);
    `);
  }

  // ── v24 → v25: CLI 런타임 세션 매핑 (chat × backend별 세션 id) ──
  //   세션 resume(Claude Code/Codex 등)로 시스템 프롬프트/히스토리를 매 턴 재전송하지 않게 한다.
  //   fingerprint: 호출 표면이 정한 안정 세션 정체성 해시. 정체성이 바뀔 때만 새 세션을 시작한다.
  if (userVersion < 25) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS chat_runtime_sessions (
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, kind),
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
    `);
  }

  // ── v25 → v26: Agent/Firm/Division runtime overrides ─────
  // Users can pin a CLI/BYOK/Ollama model per agent, for a whole firm, or for
  // a division branch. Invocation falls back to the global active runtime when
  // no override is available.
  if (userVersion < 26) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runtime_overrides (
        scope TEXT NOT NULL CHECK(scope IN ('agent','firm','division')),
        target_id TEXT NOT NULL,
        label TEXT,
        kind TEXT NOT NULL,
        backend TEXT,
        source TEXT,
        model TEXT,
        effort TEXT,
        long_context INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_overrides_updated
        ON agent_runtime_overrides(updated_at DESC);
    `);
  }

  // v27 was reserved during the Stormbreaker Loop Engineering work. Keep the
  // version number monotonic for already-migrated local databases; no new table
  // is required because loop state lives in chat/tool evidence.

  // ── v27 → v28: chats.used_at ──────────────────────────────
  // Empty draft chats stay hidden, but once the user sends the first message the
  // chat remains navigable even if /clear removes all chat_messages.
  if (userVersion < 28) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "used_at")) {
      _db.exec("ALTER TABLE chats ADD COLUMN used_at TEXT");
      _db.exec(
        `UPDATE chats
         SET used_at = updated_at
         WHERE EXISTS (SELECT 1 FROM chat_messages WHERE chat_messages.chat_id = chats.id)`,
      );
      _db.exec("CREATE INDEX IF NOT EXISTS idx_chats_used_updated ON chats(used_at, updated_at DESC)");
    }
  }

  // ── v28 → v29: Agent Groups ────────────────────────────
  // A group is a user-made orchestration layer above firm/division routes. It
  // stores routing references only; display and execution metadata are resolved
  // from the latest installed agents, org charts, and live Hub catalog.
  if (userVersion < 29) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        orchestrator_name TEXT NOT NULL,
        members_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_groups_updated
        ON agent_groups(updated_at DESC);
    `);
  }

  // ── v29 → v30: chats.agent_group_id ───────────────────
  // Agent Group chats are a user-made orchestration layer above firm/division.
  // They keep the fallback local orchestrator agent in agent_id for FK/runtime
  // compatibility, while agent_group_id points to the live routing roster.
  if (userVersion < 30) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "agent_group_id")) {
      _db.exec("ALTER TABLE chats ADD COLUMN agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL");
      _db.exec("CREATE INDEX IF NOT EXISTS idx_chats_agent_group_updated ON chats(agent_group_id, updated_at DESC)");
    }
  }

  // ── v30 → v31: chats.continuous_mode ───────────────────
  // "계속 라이브로" 모드 — Stormbreaker 연속실행이 짧은 상한(면대면 몇 턴)에 닿아도
  // 백그라운드 30분 간격 자동화로 넘기지 않고, 같은 채팅에서 라이브 스트리밍을 계속 이어간다.
  if (userVersion < 31) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "continuous_mode")) {
      _db.exec("ALTER TABLE chats ADD COLUMN continuous_mode INTEGER NOT NULL DEFAULT 0");
    }
  }

  // ── v31 → v32: chats.swarm_mode ────────────────────────
  // 스웜 모드 — 켜면 이 채팅이 목표를 작업 그래프로 분해해 여러 워커가 병렬 협업(emergent A2A)한다.
  if (userVersion < 32) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "swarm_mode")) {
      _db.exec("ALTER TABLE chats ADD COLUMN swarm_mode INTEGER NOT NULL DEFAULT 0");
    }
  }

  // ── v32 → v33: 자동화 워크플로우 그래프 + cron/tz 스케줄 + 실행 이력 ─
  // graph_json: nullable(null=오늘의 단일 프롬프트, 있으면 그래프 러너로 실행).
  // schedule_json: 구조화 ScheduleSpec(있으면 레거시 schedule 토큰보다 우선).
  // timezone/end_at/max_runs/run_count: cron tz 해석 + "N회 실행"·"~까지" 종료 정책.
  // run_history: 놓친 실행/스킵 가시화(설계 §2.7). 모든 컬럼 추가는 table_info 가드.
  if (userVersion < 33) {
    const db = _db;
    const autoCols = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    const addAutoCol = (name: string, ddl: string): void => {
      if (!autoCols.some((c) => c.name === name)) {
        db.exec(`ALTER TABLE automations ADD COLUMN ${ddl}`);
      }
    };
    addAutoCol("graph_json", "graph_json TEXT");
    addAutoCol("schedule_json", "schedule_json TEXT");
    addAutoCol("timezone", "timezone TEXT");
    addAutoCol("end_at", "end_at TEXT");
    addAutoCol("max_runs", "max_runs INTEGER");
    addAutoCol("run_count", "run_count INTEGER NOT NULL DEFAULT 0");

    db.exec(`
      CREATE TABLE IF NOT EXISTS run_history (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        scheduled_for TEXT,
        ran_at TEXT,
        status TEXT,
        skipped_count INTEGER DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_history_automation ON run_history(automation_id);
    `);
  }

  // ── v33 → v34: 조건 트리거 + 크로스프로세스 리스(설계 §3.5, §2.6) ─
  // trigger_type/trigger_json: fs/chain/webhook/poll 트리거(기본 'schedule'로 하위호환).
  // claimed_at/lease_owner: 헤드리스 launchd 러너와 열린 GUI가 같은 due 행을 이중 실행하지
  //   않도록 원자적 UPDATE로 클레임하는 DB 리스(설계 §2.6 "단일 라이터 안전장치").
  if (userVersion < 34) {
    const db = _db;
    const autoCols = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    const addAutoCol = (name: string, ddl: string): void => {
      if (!autoCols.some((c) => c.name === name)) {
        db.exec(`ALTER TABLE automations ADD COLUMN ${ddl}`);
      }
    };
    addAutoCol("trigger_type", "trigger_type TEXT NOT NULL DEFAULT 'schedule'");
    addAutoCol("trigger_json", "trigger_json TEXT");
    addAutoCol("claimed_at", "claimed_at TEXT");
    addAutoCol("lease_owner", "lease_owner TEXT");
  }

  // ── v34 → v35: 그래프 라이브 실행 per-node 상태(설계 §5 P2) ─────────
  // automation_runs: 그래프 러너 1회 실행의 per-node 상태 스냅샷(node_states_json).
  //   run_history(누적 시계열, §2.7)와 별개 — 이쪽은 캔버스 라이브 오버레이의 재하이드레이트용.
  //   latestRun IPC가 이 테이블의 최신 행을 읽어 새로고침 후에도 마지막 실행 상태를 복원한다.
  if (userVersion < 35) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT,
        started_at TEXT,
        last_activity_at TEXT,
        status TEXT,
        node_states_json TEXT,
        occurrence_id TEXT,
        graph_digest TEXT,
        checkpoint_json TEXT,
        resume_of_run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_automation_runs_auto
      ON automation_runs(automation_id, started_at);
    `);
  }

  // ── v35 → v36: 자동화 실행 도구 + Hub 사용 정책 ───────────────
  // tool_mode: auto | browser | computer-use. 명시 선택을 우선하고, 웹/소셜 조작 자동화는
  // 생성 정책에서 computer-use로 승격해 Playwright fingerprint 차단을 기본 회피한다.
  // hub_mode: hub-allowed | hub-first | local-only. 로컬 카탈로그 밖 Hub 후보까지 빌려 쓸지
  // 자동화별로 명시한다.
  if (userVersion < 36) {
    const db = _db; // 클로저에서 mutable 모듈 변수의 non-null 내로잉이 풀리지 않게 고정
    const autoCols = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    const addAutoCol = (name: string, ddl: string): void => {
      if (!autoCols.some((c) => c.name === name)) {
        db.exec(`ALTER TABLE automations ADD COLUMN ${ddl}`);
      }
    };
    addAutoCol("tool_mode", "tool_mode TEXT NOT NULL DEFAULT 'auto'");
    addAutoCol("hub_mode", "hub_mode TEXT NOT NULL DEFAULT 'hub-allowed'");
  }

  // ── v36 → v37: 에이전트 자가진화 proposal 원장 ─────────────────────
  // 화면의 "승인 및 적용" 버튼을 단순 파일 write가 아니라
  // candidate → approved → applied / measured / rolled_back 상태 흐름으로 남긴다.
  if (userVersion < 37) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_evolution_proposals (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        target_path TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        source_json TEXT NOT NULL DEFAULT '{}',
        decision_note TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        measured_at TEXT,
        rolled_back_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_evolution_agent_status
        ON agent_evolution_proposals(agent_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_evolution_created
        ON agent_evolution_proposals(created_at DESC);
    `);
  }

  // ── v37 → v38: 실행 이벤트 + 실패 원장 ─────────────────────────────
  // run_history는 자동화 스케줄 이력, automation_runs는 그래프 라이브 스냅샷이다.
  // 이 테이블들은 런타임/그래프/스웜 실패를 재현 가능한 최소 메타데이터로 남기는 append-only 원장이다.
  if (userVersion < 38) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        chat_id TEXT,
        automation_id TEXT,
        node_id TEXT,
        agent_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_seq
        ON run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_run_events_ts
        ON run_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_run_events_automation
        ON run_events(automation_id, ts DESC);

      CREATE TABLE IF NOT EXISTS failure_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        chat_id TEXT,
        automation_id TEXT,
        node_id TEXT,
        agent_id TEXT,
        error_code TEXT,
        error_message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_failure_events_ts
        ON failure_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_failure_events_run
        ON failure_events(run_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_failure_events_automation
        ON failure_events(automation_id, ts DESC);
    `);
  }

  // ── v38 → v39: Telegram Connect bindings ─────────────────────────────
  // Secrets stay in Keychain; this table stores only routing metadata, state,
  // and Telegram ids needed to resume polling after app restart.
  if (userVersion < 39) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_bindings (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('agent','firm','group')),
        target_id TEXT NOT NULL,
        telegram_chat_id TEXT,
        telegram_chat_title TEXT,
        bot_user_id INTEGER,
        bot_username TEXT,
        bot_display_name TEXT,
        chat_session_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_update_id INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_test_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_bindings_target
        ON telegram_bindings(target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_telegram_bindings_chat
        ON telegram_bindings(telegram_chat_id);
      CREATE INDEX IF NOT EXISTS idx_telegram_bindings_enabled
        ON telegram_bindings(enabled, status);
    `);
  }

  // ── v39 → v40: Hub agent bookmarks ─────────────────────────────
  // Hub bookmarks are routing references, not local installs. Store the last
  // seen marketplace card so bookmarked agents remain visible while offline.
  if (userVersion < 40) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS hub_agent_bookmarks (
        slug TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL DEFAULT 'agent',
        listing_json TEXT NOT NULL,
        bookmarked_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hub_agent_bookmarks_time
        ON hub_agent_bookmarks(bookmarked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hub_agent_bookmarks_kind
        ON hub_agent_bookmarks(entity_kind, bookmarked_at DESC);
    `);
  }

  // ── v40 → v41: Telegram automation report destination ────────────────
  // A connected Telegram chat can opt in to receive completion reports for
  // background automations. The bot token remains in Keychain; this flag only
  // marks the paired chat as a notification destination.
  if (userVersion < 41) {
    const telegramCols = _db
      .prepare("PRAGMA table_info(telegram_bindings)")
      .all() as Array<{ name: string }>;
    if (!telegramCols.some((c) => c.name === "automation_report_enabled")) {
      _db.exec("ALTER TABLE telegram_bindings ADD COLUMN automation_report_enabled INTEGER NOT NULL DEFAULT 0");
    }
    _db.exec(`
      CREATE INDEX IF NOT EXISTS idx_telegram_bindings_automation_report
        ON telegram_bindings(automation_report_enabled, enabled, telegram_chat_id);
    `);
  }

  // ── v41 → v42: installed_agents.entity_kind ──────────────
  // Persist whether an installed agent is a single agent or a multi-agent team,
  // captured from the marketplace listing (entityKind / agentCount) at install
  // time. Previously "team-ness" was only derivable from the local-import route
  // file, so Hub/cloud-installed teams were misclassified as single agents.
  // Backfill for existing rows runs at boot (registry.backfillEntityKinds).
  if (userVersion < 42) {
    const cols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "entity_kind")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN entity_kind TEXT");
    }
  }

  // ── v42 → v43: Telegram token presence metadata ──────────────
  // Listing/badging must not read Keychain. This flag only says "a bot secret
  // was saved for this binding"; the secret itself stays outside SQLite.
  if (userVersion < 43) {
    const cols = _db
      .prepare("PRAGMA table_info(telegram_bindings)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "token_saved")) {
      _db.exec("ALTER TABLE telegram_bindings ADD COLUMN token_saved INTEGER NOT NULL DEFAULT 0");
      _db
        .prepare("UPDATE telegram_bindings SET token_saved = 1 WHERE bot_user_id IS NOT NULL OR bot_username IS NOT NULL")
        .run();
    }
    if (!cols.some((c) => c.name === "token_fingerprint")) {
      _db.exec("ALTER TABLE telegram_bindings ADD COLUMN token_fingerprint TEXT");
    }
  }

  // ── v43 → v44: clean stale Telegram missing-token flags ─────────────
  // v43 prevents future list/refresh Keychain reads, but older rows may still
  // say token_saved=1 after a previous "missing Keychain" failure. Correct the
  // metadata so the UI does not show those ports as credential-ready.
  if (userVersion < 44) {
    const cols = _db
      .prepare("PRAGMA table_info(telegram_bindings)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "token_saved")) {
      _db
        .prepare(
          `UPDATE telegram_bindings
           SET token_saved = 0
           WHERE status = 'failed'
             AND last_error IS NOT NULL
             AND (
               lower(last_error) LIKE '%keychain%'
               OR last_error LIKE '%비밀 금고%'
               OR last_error LIKE '%비밀문자%'
             )`,
        )
        .run();
    }
  }

  // ── v44 → v45: hide old Telegram missing-token wording ─────────────
  // The UI now treats token absence as local port state. Drop older persisted
  // error copy so stale rows do not keep showing implementation details.
  if (userVersion < 45) {
    const cols = _db
      .prepare("PRAGMA table_info(telegram_bindings)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "last_error")) {
      _db
        .prepare(
          `UPDATE telegram_bindings
           SET last_error = NULL
           WHERE status = 'failed'
             AND last_error IS NOT NULL
             AND (
               lower(last_error) LIKE '%keychain%'
               OR last_error LIKE '%비밀 금고%'
               OR last_error LIKE '%비밀문자%'
             )`,
        )
        .run();
    }
  }

  // ── v45 → v46: chats.last_viewed_at ────────────────────
  // 세션 recap용 — 사용자가 이 채팅을 마지막으로 본 시각. 이후 도착한 에이전트 메시지가
  // 있으면 돌아왔을 때 "그동안 뭐 했는지" 한 줄 요약(recap)을 띄운다.
  if (userVersion < 46) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "last_viewed_at")) {
      _db.exec("ALTER TABLE chats ADD COLUMN last_viewed_at TEXT");
    }
  }

  // ── v46 → v47: Browser 자격증명 볼트 · 세션 · 권한 · 사용로그 ──────
  // 범용 브라우저 조작(agentlas-browser CDP)을 위한 로컬 저장소.
  //  - browser_sites: 사이트별 카드(전용 프로필 재사용). 비번은 여기 없음 → keytar(secret:browser.cred:<site>).
  //  - browser_sessions: 캡처된 로그인 세션 상태(쿠키 자체는 크롬 프로필에, 여기엔 상태만).
  //  - browser_permissions: 되돌릴 수 없는 행동 승인 기억(always만 영속). 결제는 저장 안 함.
  //  - browser_action_logs: 날짜별 사용 로그(감사·신뢰).
  if (userVersion < 47) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS browser_sites (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL UNIQUE,
        label TEXT,
        username TEXT,
        has_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'none',
        captured_at TEXT,
        note TEXT,
        FOREIGN KEY(site) REFERENCES browser_sites(site) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_sessions_site ON browser_sessions(site);

      CREATE TABLE IF NOT EXISTS browser_permissions (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        action_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_perm_site_action
        ON browser_permissions(site, action_type);

      CREATE TABLE IF NOT EXISTS browser_action_logs (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        site TEXT,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT,
        approval TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_browser_logs_ts ON browser_action_logs(ts DESC);
    `);
  }

  // v48: 빌린(고용한) 허브 에이전트를 채팅에 영속 — 추천 시트에서 고른 borrow가
  // 다음 턴에 조용히 증발하던 문제(일회성 파라미터)의 저장 계층.
  // JSON 배열: [{ slug, name?, source?, routeLabel?, hiredAt }]. 패키지 내용은 절대
  // 저장하지 않는다(복사 방지 설계) — 메타데이터 카드만.
  if (userVersion < 48) {
    // 이전 실행이 ALTER 뒤 user_version 갱신 전에 종료됐어도 재부팅이 가능해야 한다.
    const chatColumns = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatColumns.some((column) => column.name === "hired_agents")) {
      _db.exec(`ALTER TABLE chats ADD COLUMN hired_agents TEXT`);
    }
  }

  // v49: deleting a firm's CEO must never cascade through the firm into chat
  // history. Rebuild the table because SQLite cannot alter an FK action in
  // place. Chat rows continue to reference the replacement `firms` table and
  // keep their existing ON DELETE SET NULL behavior.
  if (userVersion < 49) {
    const ceoFk = (_db.prepare("PRAGMA foreign_key_list(firms)").all() as Array<{
      from: string;
      on_delete: string;
    }>).find((fk) => fk.from === "ceo_agent_id");

    if (ceoFk?.on_delete.toUpperCase() !== "RESTRICT") {
      const existingViolations = new Set(
        (_db.pragma("foreign_key_check") as Array<{
          table: string;
          rowid: number | null;
          parent: string;
          fkid: number;
        }>).map((row) => `${row.table}:${row.rowid ?? "null"}:${row.parent}:${row.fkid}`),
      );
      _db.pragma("foreign_keys = OFF");
      try {
        const migrateFirmDeletePolicy = _db.transaction(() => {
          _db!.exec(`
            DROP TABLE IF EXISTS firms_v49;
            CREATE TABLE firms_v49 (
              id TEXT PRIMARY KEY,
              slug TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              name_en TEXT NOT NULL DEFAULT '',
              tagline TEXT NOT NULL,
              tagline_en TEXT NOT NULL DEFAULT '',
              persona TEXT NOT NULL,
              ceo_agent_id TEXT NOT NULL,
              org_chart_json TEXT NOT NULL,
              installed_at TEXT NOT NULL,
              FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE RESTRICT
            );
            INSERT INTO firms_v49
              (id, slug, name, name_en, tagline, tagline_en, persona,
               ceo_agent_id, org_chart_json, installed_at)
            SELECT id, slug, name, name_en, tagline, tagline_en, persona,
                   ceo_agent_id, org_chart_json, installed_at
            FROM firms;
            DROP TABLE firms;
            ALTER TABLE firms_v49 RENAME TO firms;
            CREATE INDEX idx_firms_installed ON firms(installed_at DESC);
          `);

          const newViolations = (_db!.pragma("foreign_key_check") as Array<{
            table: string;
            rowid: number | null;
            parent: string;
            fkid: number;
          }>).filter(
            (row) => !existingViolations.has(`${row.table}:${row.rowid ?? "null"}:${row.parent}:${row.fkid}`),
          );
          if (newViolations.length > 0) {
            throw new Error(`v49 firm FK migration introduced ${newViolations.length} integrity violation(s)`);
          }
        });
        migrateFirmDeletePolicy();
      } finally {
        _db.pragma("foreign_keys = ON");
      }
    }
  }

  // v50: repair chats whose agent was deleted while foreign-key enforcement
  // was unavailable or interrupted. Deletion is intentionally narrow: only a
  // pristine standalone shell with no use state and no textual reference in
  // any table is removed. Anything ambiguous is retained under a private,
  // non-operating recovery agent with the original missing id.
  if (userVersion < 50) {
    repairOrphanChatsV50(_db);
  }

  // v51: governed agent evolution receipts + monotonic local asset versions.
  // A candidate never changes package files. Every approved apply/rollback gets
  // an append-only receipt containing target and package hashes before/after.
  if (userVersion < 51) {
    const evolutionCols = _db
      .prepare("PRAGMA table_info(agent_evolution_proposals)")
      .all() as Array<{ name: string }>;
    if (evolutionCols.length === 0) {
      // Defensive repair for historical/partially migrated stores.
      _db.exec(`
        CREATE TABLE agent_evolution_proposals (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          proposal_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          target_path TEXT NOT NULL,
          before_hash TEXT NOT NULL,
          after_hash TEXT NOT NULL,
          before_content TEXT NOT NULL,
          after_content TEXT NOT NULL,
          risk TEXT NOT NULL,
          status TEXT NOT NULL,
          source_json TEXT NOT NULL DEFAULT '{}',
          operation_json TEXT,
          decision_note TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          applied_at TEXT,
          measured_at TEXT,
          rolled_back_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_evolution_agent_status
          ON agent_evolution_proposals(agent_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_evolution_created
          ON agent_evolution_proposals(created_at DESC);
      `);
    } else if (!evolutionCols.some((column) => column.name === "operation_json")) {
      _db.exec("ALTER TABLE agent_evolution_proposals ADD COLUMN operation_json TEXT");
    }
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_asset_versions (
        agent_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        package_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_evolution_receipts (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_path TEXT NOT NULL,
        version_before INTEGER NOT NULL,
        version_after INTEGER NOT NULL,
        target_hash_before TEXT NOT NULL,
        target_hash_after TEXT NOT NULL,
        package_hash_before TEXT NOT NULL,
        package_hash_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES agent_evolution_proposals(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(proposal_id, action)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_evolution_receipts_agent
        ON agent_evolution_receipts(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_evolution_receipts_proposal
        ON agent_evolution_receipts(proposal_id, created_at ASC);
    `);
  }

  // v52: automation live snapshots are projections of an existing automation,
  // not an append-only audit ledger. Historical schemas had no FK cascade, so
  // deleting a parent left both canvas snapshots and run history unreachable.
  if (userVersion < 52) {
    const repairAutomationHistory = _db.transaction(() => {
      if (tableExists(_db!, "automation_runs") && tableExists(_db!, "automations")) {
        const automationRunColumns = schemaColumns(_db!, "automation_runs");
        if (!automationRunColumns.some((column) => column.name === "last_activity_at")) {
          _db!.exec("ALTER TABLE automation_runs ADD COLUMN last_activity_at TEXT");
        }
        _db!.exec("UPDATE automation_runs SET last_activity_at = started_at WHERE last_activity_at IS NULL");
        _db!.exec(`
          DELETE FROM automation_runs
          WHERE automation_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id
             );
        `);
      }
      if (tableExists(_db!, "run_history") && tableExists(_db!, "automations")) {
        _db!.exec(`
          DELETE FROM run_history
          WHERE automation_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM automations a WHERE a.id = run_history.automation_id
             );
        `);
      }
    });
    repairAutomationHistory();
  }

  // v53: Hub bookmarks become account-scoped durable cache + local outbox.
  // Legacy slug-PK rows are preserved in device scope and claimed by the first
  // successfully signed-in workspace; no auth state is consulted in migration.
  if (userVersion < 53) {
    const migrateHubBookmarks = _db.transaction(() => {
      const requiredColumns = new Set([
        "workspace_id",
        "slug",
        "entity_kind",
        "listing_json",
        "bookmarked_at",
        "server_updated_at",
        "sync_state",
        "last_sync_error",
        "claim_workspace_id",
      ]);
      const existingSchema = tableExists(_db!, "hub_agent_bookmarks")
        ? schemaColumns(_db!, "hub_agent_bookmarks")
        : [];
      const existingColumns = new Set(existingSchema.map((column) => column.name));
      const existingPrimaryKey = existingSchema
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      const alreadyV53 =
        [...requiredColumns].every((column) => existingColumns.has(column)) &&
        existingPrimaryKey.join("\u0000") === ["workspace_id", "entity_kind", "slug"].join("\u0000");

      if (!alreadyV53) {
        _db!.exec(`
          DROP INDEX IF EXISTS idx_hub_agent_bookmarks_time;
          DROP INDEX IF EXISTS idx_hub_agent_bookmarks_kind;
          DROP INDEX IF EXISTS idx_hub_agent_bookmarks_workspace_time;
          DROP INDEX IF EXISTS idx_hub_agent_bookmarks_outbox;
          DROP TABLE IF EXISTS hub_agent_bookmarks_v52;
        `);
        if (tableExists(_db!, "hub_agent_bookmarks")) {
          _db!.exec("ALTER TABLE hub_agent_bookmarks RENAME TO hub_agent_bookmarks_v52");
        }
        _db!.exec(`
          CREATE TABLE hub_agent_bookmarks (
            workspace_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            entity_kind TEXT NOT NULL DEFAULT 'agent',
            listing_json TEXT NOT NULL,
            bookmarked_at TEXT NOT NULL,
            server_updated_at TEXT,
            sync_state TEXT NOT NULL DEFAULT 'clean'
              CHECK(sync_state IN ('clean','pending_upsert','pending_delete')),
            last_sync_error TEXT,
            claim_workspace_id TEXT,
            PRIMARY KEY(workspace_id, entity_kind, slug)
          );
        `);
        if (tableExists(_db!, "hub_agent_bookmarks_v52")) {
          const legacyColumns = new Set(
            schemaColumns(_db!, "hub_agent_bookmarks_v52").map((column) => column.name),
          );
          const hasV53Columns = [...requiredColumns].every((column) => legacyColumns.has(column));
          if (hasV53Columns) {
            _db!.exec(`
              INSERT OR REPLACE INTO hub_agent_bookmarks (
                workspace_id, slug, entity_kind, listing_json, bookmarked_at,
                server_updated_at, sync_state, last_sync_error, claim_workspace_id
              )
              SELECT
                workspace_id, slug,
                CASE
                  WHEN lower(trim(entity_kind)) = 'team' THEN 'team'
                  WHEN lower(trim(entity_kind)) = 'plugin' THEN 'plugin'
                  ELSE 'agent'
                END,
                listing_json, bookmarked_at, server_updated_at,
                CASE
                  WHEN sync_state IN ('clean','pending_upsert','pending_delete') THEN sync_state
                  ELSE 'clean'
                END,
                last_sync_error, claim_workspace_id
              FROM hub_agent_bookmarks_v52
              ORDER BY bookmarked_at ASC, rowid ASC;
            `);
          } else if (
            legacyColumns.has("slug") &&
            legacyColumns.has("entity_kind") &&
            legacyColumns.has("listing_json") &&
            legacyColumns.has("bookmarked_at")
          ) {
            _db!.exec(`
              INSERT INTO hub_agent_bookmarks (
                workspace_id, slug, entity_kind, listing_json, bookmarked_at,
                server_updated_at, sync_state, last_sync_error, claim_workspace_id
              )
              SELECT
                '__device__', slug,
                CASE
                  WHEN lower(trim(entity_kind)) = 'team' THEN 'team'
                  WHEN lower(trim(entity_kind)) = 'plugin' THEN 'plugin'
                  ELSE 'agent'
                END,
                listing_json, bookmarked_at,
                NULL, 'clean', NULL, NULL
              FROM hub_agent_bookmarks_v52;
            `);
          }
          _db!.exec("DROP TABLE hub_agent_bookmarks_v52");
        }
      }

      _db!.exec(`
        CREATE INDEX IF NOT EXISTS idx_hub_agent_bookmarks_workspace_time
          ON hub_agent_bookmarks(workspace_id, bookmarked_at DESC);
        CREATE INDEX IF NOT EXISTS idx_hub_agent_bookmarks_outbox
          ON hub_agent_bookmarks(workspace_id, sync_state, bookmarked_at ASC);
      `);
    });
    migrateHubBookmarks();
  }

  // v54: host-local Experience assets. An Experience Pack references a base
  // agent/package hash but never copies or mutates package bytes. Candidates
  // can only be projected from curated Memory rows; promotion and export intent
  // are explicit, append-only local receipts. At v54 no Cloud exchange existed;
  // v56 adds it as a separate asset transaction without mutating these rows.
  if (userVersion < 54) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS experience_packs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        project_path TEXT,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        base_package_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_experience_packs_agent_scope
        ON experience_packs(agent_id, project_scope_key, environment_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS experience_candidates (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        task_terms_json TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL
          CHECK(sensitivity IN ('public','internal','private')),
        confidence TEXT NOT NULL
          CHECK(confidence IN ('high','medium','low')),
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK(status IN ('candidate','promoted','rejected')),
        outcome_status TEXT NOT NULL DEFAULT 'unverified'
          CHECK(outcome_status IN ('unverified','attested','verified','failed')),
        public_safe INTEGER NOT NULL DEFAULT 0 CHECK(public_safe IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        promoted_at TEXT,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(pack_id, source_memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_experience_candidates_retrieval
        ON experience_candidates(agent_id, project_scope_key, environment_key, status, outcome_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_experience_candidates_pack
        ON experience_candidates(pack_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS experience_promotion_receipts (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action = 'promote'),
        explicit_consent INTEGER NOT NULL CHECK(explicit_consent = 1),
        verification_status TEXT NOT NULL CHECK(verification_status IN ('attested','verified')),
        verification_method TEXT NOT NULL
          CHECK(verification_method IN ('user-attested','local-run-receipt','local-test-receipt')),
        evidence_hash TEXT NOT NULL,
        public_safe INTEGER NOT NULL CHECK(public_safe IN (0,1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(candidate_id) REFERENCES experience_candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(candidate_id, action)
      );
      CREATE INDEX IF NOT EXISTS idx_experience_receipts_pack
        ON experience_promotion_receipts(pack_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS experience_export_intents (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
        status TEXT NOT NULL DEFAULT 'local_intent' CHECK(status = 'local_intent'),
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_experience_export_intents_pack
        ON experience_export_intents(pack_id, created_at DESC);
    `);
  }

  // v55: Experience relation lineage + derived relation index. The lineage
  // table is a value-free, append-only source projection. Nodes/edges/state are
  // disposable and rebuilt in the shared Desktop SQLite database. The later
  // per-slug experience.sqlite is only a private cross-project query cache,
  // never an ownership or entitlement database.
  if (userVersion < 55) {
    const packCols = _db
      .prepare("PRAGMA table_info(experience_packs)")
      .all() as Array<{ name: string }>;
    if (!packCols.some((column) => column.name === "mcp_requirements_json")) {
      _db.exec(
        "ALTER TABLE experience_packs ADD COLUMN mcp_requirements_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    _db.exec(`
      CREATE TABLE IF NOT EXISTS experience_lineage_events (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('promotion','export-intent')),
        base_package_hash TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        item_ids_json TEXT NOT NULL DEFAULT '[]',
        task_bindings_json TEXT NOT NULL DEFAULT '[]',
        mcp_requirements_json TEXT NOT NULL DEFAULT '[]',
        evidence_bindings_json TEXT NOT NULL DEFAULT '[]',
        supersedes_release_id TEXT,
        source_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        UNIQUE(pack_id, release_id, event_type)
      );
      CREATE INDEX IF NOT EXISTS idx_experience_lineage_pack_created
        ON experience_lineage_events(pack_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS experience_relation_nodes (
        node_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        node_type TEXT NOT NULL
          CHECK(node_type IN ('Pack','Release','Item','TaskTag','Environment','MCPRequirement','EvidenceReceipt')),
        entity_ref TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        base_package_hash TEXT NOT NULL,
        normalized_value TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_fingerprint TEXT NOT NULL,
        rebuilt_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        UNIQUE(pack_id, node_type, entity_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_experience_relation_nodes_scope
        ON experience_relation_nodes(project_scope_key, environment_key, base_package_hash, node_type);
      CREATE INDEX IF NOT EXISTS idx_experience_relation_nodes_pack_type
        ON experience_relation_nodes(pack_id, node_type, normalized_value);

      CREATE TABLE IF NOT EXISTS experience_relation_edges (
        edge_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        edge_type TEXT NOT NULL
          CHECK(edge_type IN (
            'has_release','exact_base_binding','contains','applies_to_task',
            'applies_in_environment','requires_mcp','supports_mcp',
            'alternative_mcp','supported_by','supersedes','similar_by_tag'
          )),
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        base_package_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_fingerprint TEXT NOT NULL,
        rebuilt_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(from_node) REFERENCES experience_relation_nodes(node_id) ON DELETE CASCADE,
        FOREIGN KEY(to_node) REFERENCES experience_relation_nodes(node_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_experience_relation_edges_scope
        ON experience_relation_edges(project_scope_key, environment_key, base_package_hash, edge_type);
      CREATE INDEX IF NOT EXISTS idx_experience_relation_edges_from
        ON experience_relation_edges(pack_id, from_node, edge_type);
      CREATE INDEX IF NOT EXISTS idx_experience_relation_edges_to
        ON experience_relation_edges(pack_id, to_node, edge_type);

      CREATE TABLE IF NOT EXISTS experience_relation_index_state (
        scope_key TEXT PRIMARY KEY CHECK(scope_key = 'shared'),
        source_fingerprint TEXT NOT NULL,
        rebuilt_at TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL
      );
    `);
  }

  // v56: portable Experience Cloud exchange. Exact server-authoritative base
  // ids live on the local Pack, while each content/visibility upload gets its
  // own durable idempotency, canonical bundle, optimistic revision and receipt.
  // Local Memory source ids, project paths and raw evidence never enter this
  // table. Existing v54/v55 rows remain valid with unresolved nullable base ids.
  if (userVersion < 56) {
    const packCols = _db
      .prepare("PRAGMA table_info(experience_packs)")
      .all() as Array<{ name: string }>;
    const packColumnNames = new Set(packCols.map((column) => column.name));
    if (!packColumnNames.has("base_agent_definition_id")) {
      _db.exec("ALTER TABLE experience_packs ADD COLUMN base_agent_definition_id TEXT");
    }
    if (!packColumnNames.has("base_agent_release_id")) {
      _db.exec("ALTER TABLE experience_packs ADD COLUMN base_agent_release_id TEXT");
    }
    if (!packColumnNames.has("base_package_hash_version")) {
      _db.exec("ALTER TABLE experience_packs ADD COLUMN base_package_hash_version TEXT");
    }
    _db.exec(`
      CREATE TABLE IF NOT EXISTS experience_cloud_uploads (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        requested_visibility TEXT NOT NULL
          CHECK(requested_visibility IN ('private','public')),
        bundle_id TEXT NOT NULL,
        bundle_hash TEXT NOT NULL,
        canonical_bundle_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        remote_upload_id TEXT,
        remote_revision TEXT,
        remote_status TEXT NOT NULL
          CHECK(remote_status IN (
            'local-ready','saving-private','private-saved','requesting-verification',
            'verification-requested','verification-pending','verified-private',
            'public-active','conflict','offline','error','withdrawn','rejected'
          )),
        remote_error_code TEXT,
        remote_error_message TEXT,
        remote_receipt_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        UNIQUE(pack_id, bundle_hash, requested_visibility)
      );
      CREATE INDEX IF NOT EXISTS idx_experience_cloud_uploads_pack
        ON experience_cloud_uploads(pack_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_cloud_uploads_remote
        ON experience_cloud_uploads(remote_upload_id)
        WHERE remote_upload_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_experience_cloud_uploads_recovery
        ON experience_cloud_uploads(remote_status, updated_at ASC);
    `);
  }

  // v57: Desktop-owned agent aliases, canonical Experience environment
  // profiles, auto-intake receipts, and agent-attributed activity indexes.
  // Existing v56 rows are intentionally not inferred or rewritten: a null
  // environment profile remains legacy/non-canonical until the owner creates a
  // new pack, and historical run rows without agent_id stay unattributed.
  if (userVersion < 57) {
    const agentCols = new Set(
      (_db.prepare("PRAGMA table_info(installed_agents)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!agentCols.has("local_display_name")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN local_display_name TEXT");
    }

    const packCols = new Set(
      (_db.prepare("PRAGMA table_info(experience_packs)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!packCols.has("environment_profile_json")) {
      _db.exec("ALTER TABLE experience_packs ADD COLUMN environment_profile_json TEXT");
    }
    if (!packCols.has("auto_managed")) {
      _db.exec("ALTER TABLE experience_packs ADD COLUMN auto_managed INTEGER NOT NULL DEFAULT 0 CHECK(auto_managed IN (0,1))");
    }

    const candidateCols = new Set(
      (_db.prepare("PRAGMA table_info(experience_candidates)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!candidateCols.has("auto_managed")) {
      _db.exec("ALTER TABLE experience_candidates ADD COLUMN auto_managed INTEGER NOT NULL DEFAULT 0 CHECK(auto_managed IN (0,1))");
    }

    _db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_auto_pack_exact
        ON experience_packs(agent_id, project_scope_key, environment_key, base_package_hash)
        WHERE auto_managed = 1 AND status = 'active';

      CREATE TABLE IF NOT EXISTS experience_auto_intake_receipts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        pack_id TEXT,
        candidate_id TEXT,
        source_memory_hash TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('candidate-created','blocked','skipped')),
        memory_kind TEXT NOT NULL,
        reason_codes_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE SET NULL,
        FOREIGN KEY(candidate_id) REFERENCES experience_candidates(id) ON DELETE SET NULL,
        UNIQUE(agent_id, source_memory_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_experience_auto_intake_agent_status
        ON experience_auto_intake_receipts(agent_id, status, created_at DESC);
    `);

    // Interrupted/minimal legacy fixtures can legitimately carry a later
    // user_version while one of the append-only ledgers is absent, and early
    // v38 previews did not yet have agent_id. Repair only the tables that
    // exist, then create indexes only when their columns are authoritative.
    for (const table of ["run_events", "failure_events"] as const) {
      if (!tableExists(_db, table)) continue;
      const columns = new Set(schemaColumns(_db, table).map((column) => column.name));
      if (!columns.has("agent_id")) {
        _db.exec(`ALTER TABLE ${table} ADD COLUMN agent_id TEXT`);
        columns.add("agent_id");
      }
      if (columns.has("agent_id") && columns.has("ts")) {
        _db.exec(
          table === "run_events"
            ? "CREATE INDEX IF NOT EXISTS idx_run_events_agent_ts ON run_events(agent_id, ts DESC)"
            : "CREATE INDEX IF NOT EXISTS idx_failure_events_agent_ts ON failure_events(agent_id, ts DESC)",
        );
      }
    }
  }

  // v58: content-free per-turn Memory Curator receipts are queried by exact
  // installed agent and event kind. The index keeps My Agents summaries
  // bounded as the shared run ledger grows; no historical content is inferred
  // or rewritten.
  if (userVersion < 58) {
    const runEventColumns = new Set(schemaColumns(_db, "run_events").map((column) => column.name));
    if (["agent_id", "kind", "ts"].every((column) => runEventColumns.has(column))) {
      _db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_events_agent_kind_ts
          ON run_events(agent_id, kind, ts DESC);
      `);
    }
  }

  // v59: explicit immutable Hub agent-release bindings for Ontology projection.
  // There is deliberately no legacy backfill: local ids, slugs, package hashes,
  // and "latest" are not equivalent to a server-issued definition + release.
  // A partial-crash rerun is safe because the table and index are idempotent.
  if (userVersion < 59) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS installed_agent_hub_bindings (
        installed_agent_id TEXT PRIMARY KEY,
        agent_definition_id TEXT NOT NULL,
        agent_release_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('hub-install','agent-cloud-restore')),
        bound_at TEXT NOT NULL,
        FOREIGN KEY(installed_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(agent_definition_id, agent_release_id, installed_agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_installed_agent_hub_binding_exact
        ON installed_agent_hub_bindings(agent_definition_id, agent_release_id);
    `);
  }

  // v60: private per-agent Taste observations. These rows are intentionally
  // separate from operational Experience candidates: a preference is not an
  // execution success and cannot be promoted/exported by the Experience flow.
  // A row remains a local review draft until Hub creates a distinct
  // Taste/Style release from randomized explicit human pairwise evidence.
  if (userVersion < 60) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS taste_draft_candidates (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_memory_id TEXT NOT NULL,
        source_memory_hash TEXT NOT NULL,
        project_scope_key TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        base_package_hash TEXT NOT NULL
          CHECK(length(base_package_hash) = 64 AND base_package_hash NOT GLOB '*[^0-9a-f]*'),
        base_agent_definition_id TEXT,
        base_agent_release_id TEXT,
        sensitivity TEXT NOT NULL
          CHECK(sensitivity IN ('public','internal','private')),
        confidence TEXT NOT NULL
          CHECK(confidence IN ('high','medium','low')),
        axis_candidates_json TEXT NOT NULL DEFAULT '[]',
        task_signatures_json TEXT NOT NULL DEFAULT '[]',
        evidence_state TEXT NOT NULL DEFAULT 'pairwise-required'
          CHECK(evidence_state = 'pairwise-required'),
        status TEXT NOT NULL DEFAULT 'observation'
          CHECK(status IN ('observation','rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        UNIQUE(agent_id, source_memory_hash, base_package_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_taste_drafts_agent_status
        ON taste_draft_candidates(agent_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_taste_drafts_exact_base
        ON taste_draft_candidates(agent_id, base_package_hash, project_scope_key, environment_key);
    `);
  }

  // v61: owner-reviewed Taste generalizations. Raw observations remain in
  // taste_draft_candidates; this table stores only the user-edited portable
  // proposal, local preview capabilities, and redacted Hub identifiers.
  if (userVersion < 61) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS taste_chip_workflows (
        workflow_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        base_package_hash TEXT NOT NULL,
        base_agent_definition_id TEXT NOT NULL,
        base_agent_release_id TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        taste_style_id TEXT NOT NULL,
        release_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        rule_statement TEXT NOT NULL,
        axis TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        contexts_json TEXT NOT NULL,
        generalization_hash TEXT NOT NULL,
        privacy_issue_codes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('proposal','confirmed','moderation-pending','ab-ready','error')),
        confirmed_at TEXT,
        preview_grants_json TEXT,
        preview_names_json TEXT,
        preview_digests_json TEXT,
        preview_rights TEXT,
        remote_preview_asset_ids_json TEXT,
        remote_revision TEXT,
        remote_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES taste_draft_candidates(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_taste_chip_workflows_agent_status
        ON taste_chip_workflows(agent_id, status, updated_at DESC);
    `);
  }

  // v62: owner-reviewed public projections for Operational Experience. The
  // immutable private candidate and its Memory source stay in the existing
  // tables. This table stores only generalized portable text plus content
  // hashes that bind it to exact promoted sources and one exact base release.
  if (userVersion < 62) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS experience_public_projections (
        projection_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        base_package_hash TEXT NOT NULL
          CHECK(length(base_package_hash) = 64 AND base_package_hash NOT GLOB '*[^0-9a-f]*'),
        base_agent_definition_id TEXT NOT NULL,
        base_agent_release_id TEXT NOT NULL,
        environment_key TEXT NOT NULL,
        source_bindings_json TEXT NOT NULL,
        source_snapshot_hash TEXT NOT NULL
          CHECK(length(source_snapshot_hash) = 64 AND source_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
        title TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        task_signatures_json TEXT NOT NULL,
        environment_constraints_json TEXT NOT NULL,
        proposal_hash TEXT NOT NULL
          CHECK(length(proposal_hash) = 64 AND proposal_hash NOT GLOB '*[^0-9a-f]*'),
        privacy_issue_codes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('proposal','confirmed')),
        confirmation_hash TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        CHECK(
          (status = 'proposal' AND confirmation_hash IS NULL AND confirmed_at IS NULL) OR
          (status = 'confirmed' AND length(confirmation_hash) = 64
            AND confirmation_hash NOT GLOB '*[^0-9a-f]*' AND confirmed_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_experience_public_projection_agent_status
        ON experience_public_projections(agent_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_experience_public_projection_exact_base
        ON experience_public_projections(
          base_agent_definition_id, base_agent_release_id, base_package_hash, environment_key
        );
    `);
  }

  // v63: hashed chip-on/control generation provenance. This contains no raw
  // prompt, output bytes, provider credential, or local path.
  if (userVersion < 63) {
    const columns = _db.prepare("PRAGMA table_info(taste_chip_workflows)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "preview_provenance_json")) {
      _db.exec("ALTER TABLE taste_chip_workflows ADD COLUMN preview_provenance_json TEXT");
    }
  }

  // v64: durable least-privilege authority for scheduled automation runs.
  // Existing rows and UI clients that omit the new field deliberately retain
  // their historical write behavior. The CHECK prevents any scheduler row
  // from persisting interactive-only `full` authority.
  if (userVersion < 64) {
    if (tableExists(_db, "automations")) {
      const columns = _db.prepare("PRAGMA table_info(automations)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "execution_permission")) {
        _db.exec(
          "ALTER TABLE automations ADD COLUMN execution_permission TEXT NOT NULL DEFAULT 'write' " +
          "CHECK(execution_permission IN ('read','write'))",
        );
      }
      // Rerunnable after a hard exit between ALTER and user_version. A partial
      // pre-release column without the final constraint is normalized as well.
      _db.exec(`
        UPDATE automations
        SET execution_permission = 'write'
        WHERE execution_permission IS NULL;
        UPDATE automations
        SET execution_permission = 'read'
        WHERE execution_permission NOT IN ('read', 'write');
      `);
    }
  }

  // v65: local-only hybrid memory retrieval. Embeddings are additive and
  // nullable so an existing store opens immediately; read paths lazily
  // backfill deterministic hash-96 vectors. The relation table keeps the
  // legacy tag edge readable while new rebuilds write semantic `similar_to`.
  // supersedes/contradicts remain explicit governance edges only.
  if (userVersion < 65) {
    if (tableExists(_db, "memory_entries")) {
      const columns = new Set(schemaColumns(_db, "memory_entries").map((column) => column.name));
      if (!columns.has("embedding_model")) {
        _db.exec("ALTER TABLE memory_entries ADD COLUMN embedding_model TEXT");
      }
      if (!columns.has("embedding_adapter")) {
        _db.exec("ALTER TABLE memory_entries ADD COLUMN embedding_adapter TEXT");
      }
      if (!columns.has("embedding_model_sha256")) {
        _db.exec("ALTER TABLE memory_entries ADD COLUMN embedding_model_sha256 TEXT");
      }
      if (!columns.has("embedding_content_hash")) {
        _db.exec("ALTER TABLE memory_entries ADD COLUMN embedding_content_hash TEXT");
      }
      if (!columns.has("embedding_dimensions")) {
        _db.exec("ALTER TABLE memory_entries ADD COLUMN embedding_dimensions INTEGER");
      }
      if (!columns.has("embedding_json")) {
        _db.exec("ALTER TABLE memory_entries ADD COLUMN embedding_json TEXT");
      }
    }
    if (tableExists(_db, "experience_candidates")) {
      const columns = new Set(schemaColumns(_db, "experience_candidates").map((column) => column.name));
      if (!columns.has("embedding_model")) {
        _db.exec("ALTER TABLE experience_candidates ADD COLUMN embedding_model TEXT");
      }
      if (!columns.has("embedding_adapter")) {
        _db.exec("ALTER TABLE experience_candidates ADD COLUMN embedding_adapter TEXT");
      }
      if (!columns.has("embedding_model_sha256")) {
        _db.exec("ALTER TABLE experience_candidates ADD COLUMN embedding_model_sha256 TEXT");
      }
      if (!columns.has("embedding_content_hash")) {
        _db.exec("ALTER TABLE experience_candidates ADD COLUMN embedding_content_hash TEXT");
      }
      if (!columns.has("embedding_dimensions")) {
        _db.exec("ALTER TABLE experience_candidates ADD COLUMN embedding_dimensions INTEGER");
      }
      if (!columns.has("embedding_json")) {
        _db.exec("ALTER TABLE experience_candidates ADD COLUMN embedding_json TEXT");
      }
      _db.exec(`
        CREATE TABLE IF NOT EXISTS experience_governance_relations (
          relation_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          from_candidate_id TEXT NOT NULL,
          to_candidate_id TEXT NOT NULL,
          relation_type TEXT NOT NULL CHECK(relation_type IN ('supersedes','contradicts')),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
          FOREIGN KEY(from_candidate_id) REFERENCES experience_candidates(id) ON DELETE CASCADE,
          FOREIGN KEY(to_candidate_id) REFERENCES experience_candidates(id) ON DELETE CASCADE,
          UNIQUE(from_candidate_id, to_candidate_id, relation_type)
        );
        CREATE INDEX IF NOT EXISTS idx_experience_governance_pack
          ON experience_governance_relations(pack_id, relation_type, created_at ASC);
      `);
    }
    if (tableExists(_db, "experience_relation_edges")) {
      const definition = (_db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'experience_relation_edges'",
      ).get() as { sql?: string } | undefined)?.sql ?? "";
      if (!definition.includes("'similar_to'")) {
        _db.pragma("foreign_keys = OFF");
        try {
          _db.transaction(() => {
            _db!.exec(`
              DROP TABLE IF EXISTS experience_relation_edges_v65;
              CREATE TABLE experience_relation_edges_v65 (
                edge_id TEXT PRIMARY KEY,
                pack_id TEXT NOT NULL,
                from_node TEXT NOT NULL,
                to_node TEXT NOT NULL,
                edge_type TEXT NOT NULL
                  CHECK(edge_type IN (
                    'has_release','exact_base_binding','contains','applies_to_task',
                    'applies_in_environment','requires_mcp','supports_mcp',
                    'alternative_mcp','supported_by','supersedes','contradicts',
                    'similar_to','similar_by_tag'
                  )),
                project_scope_key TEXT NOT NULL,
                environment_key TEXT NOT NULL,
                base_package_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                source_fingerprint TEXT NOT NULL,
                rebuilt_at TEXT NOT NULL,
                FOREIGN KEY(pack_id) REFERENCES experience_packs(id) ON DELETE CASCADE,
                FOREIGN KEY(from_node) REFERENCES experience_relation_nodes(node_id) ON DELETE CASCADE,
                FOREIGN KEY(to_node) REFERENCES experience_relation_nodes(node_id) ON DELETE CASCADE
              );
              INSERT INTO experience_relation_edges_v65
                SELECT * FROM experience_relation_edges;
              DROP TABLE experience_relation_edges;
              ALTER TABLE experience_relation_edges_v65 RENAME TO experience_relation_edges;
              CREATE INDEX idx_experience_relation_edges_scope
                ON experience_relation_edges(project_scope_key, environment_key, base_package_hash, edge_type);
              CREATE INDEX idx_experience_relation_edges_from
                ON experience_relation_edges(pack_id, from_node, edge_type);
              CREATE INDEX idx_experience_relation_edges_to
                ON experience_relation_edges(pack_id, to_node, edge_type);
            `);
          }).immediate();
        } finally {
          _db.pragma("foreign_keys = ON");
        }
      }
    }
  }

  if (userVersion < 66) {
    // Hub 자동화는 매 실행 fresh hepCall을 하는데 버전을 못 실어 늘 latest였다. 작성자가
    // 재게시하면 어젯밤과 다른 지시문으로 조용히 돌아간다. NULL = latest(기존 동작 유지),
    // packageHash = 그 버전이 맞을 때만 실행(서버가 version_mismatch로 거절 → drift가 보인다).
    if (tableExists(_db, "automations")) {
      const columns = new Set(schemaColumns(_db, "automations").map((column) => column.name));
      if (!columns.has("target_version")) {
        _db.exec("ALTER TABLE automations ADD COLUMN target_version TEXT");
      }
    }
  }

  if (userVersion < 67 && tableExists(_db, "automations")) {
    const columns = new Set(schemaColumns(_db, "automations").map((column) => column.name));
    if (!columns.has("runtime_selection_json")) {
      _db.exec("ALTER TABLE automations ADD COLUMN runtime_selection_json TEXT");
    }
  }

  // v68: every completed, failed, or cancelled model turn gets one
  // content-bounded Memory Ticket.
  // The ticket/episode ledger observes every turn; only candidate decisions
  // approved by the Curator can become durable memory_entries. Relation edges
  // are local embedding projections and never create new memory content.
  if (userVersion < 68) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS memory_tickets (
        ticket_id TEXT PRIMARY KEY,
        turn_key TEXT NOT NULL UNIQUE,
        turn_id TEXT,
        run_id TEXT,
        node_id TEXT,
        chat_id TEXT,
        agent_id TEXT,
        project_id TEXT,
        project_path_hash TEXT,
        emitter_status TEXT NOT NULL
          CHECK(emitter_status IN ('valid','empty','missing','malformed','read_only')),
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
        state TEXT NOT NULL DEFAULT 'received'
          CHECK(state IN ('received','completed','read_only','failed')),
        curator_mode TEXT NOT NULL DEFAULT 'policy'
          CHECK(curator_mode IN ('semantic','policy','policy_fallback','read_only')),
        curation_outcome TEXT NOT NULL DEFAULT 'no_candidates'
          CHECK(curation_outcome IN ('decided','no_candidates','malformed_output','curator_failed','read_only')),
        written_count INTEGER NOT NULL DEFAULT 0 CHECK(written_count >= 0),
        deduped_count INTEGER NOT NULL DEFAULT 0 CHECK(deduped_count >= 0),
        redacted_count INTEGER NOT NULL DEFAULT 0 CHECK(redacted_count >= 0),
        session_count INTEGER NOT NULL DEFAULT 0 CHECK(session_count >= 0),
        discarded_count INTEGER NOT NULL DEFAULT 0 CHECK(discarded_count >= 0),
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_tickets_project_created
        ON memory_tickets(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_tickets_agent_created
        ON memory_tickets(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_tickets_status_created
        ON memory_tickets(emitter_status, state, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_decisions (
        decision_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        candidate_index INTEGER NOT NULL CHECK(candidate_index >= 0),
        content_hash TEXT NOT NULL
          CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
        memory_kind TEXT NOT NULL,
        proposed_scope TEXT NOT NULL,
        resolved_scope TEXT NOT NULL,
        action TEXT NOT NULL
          CHECK(action IN ('written','deduped','redacted','session','discarded','deferred')),
        reason_code TEXT NOT NULL,
        target_memory_id TEXT,
        confidence TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        curator_mode TEXT NOT NULL
          CHECK(curator_mode IN ('semantic','policy','policy_fallback','read_only')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES memory_tickets(ticket_id) ON DELETE CASCADE,
        FOREIGN KEY(target_memory_id) REFERENCES memory_entries(id) ON DELETE SET NULL,
        UNIQUE(ticket_id, candidate_index)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_decisions_ticket_action
        ON memory_decisions(ticket_id, action, candidate_index);

      CREATE TABLE IF NOT EXISTS memory_relation_edges (
        relation_id TEXT PRIMARY KEY,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        relation_type TEXT NOT NULL
          CHECK(relation_type IN ('similar_to','supersedes','contradicts')),
        score REAL,
        owner_scope_key TEXT NOT NULL,
        embedding_model TEXT,
        embedding_adapter TEXT,
        embedding_model_sha256 TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(from_memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
        FOREIGN KEY(to_memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
        CHECK(from_memory_id <> to_memory_id),
        CHECK(score IS NULL OR (score >= -1.0 AND score <= 1.0)),
        UNIQUE(from_memory_id, to_memory_id, relation_type)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_relation_from
        ON memory_relation_edges(from_memory_id, relation_type, score DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_relation_to
        ON memory_relation_edges(to_memory_id, relation_type, score DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_relation_owner
        ON memory_relation_edges(owner_scope_key, relation_type, score DESC);

      CREATE TABLE IF NOT EXISTS memory_episodes (
        episode_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        project_id TEXT,
        project_path_hash TEXT,
        agent_id TEXT,
        chat_id TEXT,
        summary TEXT,
        summary_hash TEXT,
        embedding_model TEXT,
        embedding_adapter TEXT,
        embedding_model_sha256 TEXT,
        embedding_content_hash TEXT,
        embedding_dimensions INTEGER,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES memory_tickets(ticket_id) ON DELETE CASCADE,
        CHECK(project_path_hash IS NULL OR
          (length(project_path_hash) = 64 AND project_path_hash NOT GLOB '*[^0-9a-f]*')),
        CHECK(summary_hash IS NULL OR
          (length(summary_hash) = 64 AND summary_hash NOT GLOB '*[^0-9a-f]*'))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_project_created
        ON memory_episodes(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_project_path_created
        ON memory_episodes(project_path_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_episodes_agent_created
        ON memory_episodes(agent_id, created_at DESC);
    `);
  }

  // Development builds may already have created the v68 table before the
  // folder-hash timeline key was added. Keep that local state upgradeable.
  if (tableExists(_db, "memory_episodes")) {
    const episodeColumns = new Set(schemaColumns(_db, "memory_episodes").map((column) => column.name));
    if (!episodeColumns.has("project_path_hash")) {
      _db.exec("ALTER TABLE memory_episodes ADD COLUMN project_path_hash TEXT");
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_episodes_project_path_created
      ON memory_episodes(project_path_hash, created_at DESC)`);
  }

  // v69: resumable workflow occurrences. A later node failure must not replay
  // an already committed side-effect node (for example, post a second comment).
  // The checkpoint is local-only and digest-bound to the exact graph/runtime
  // policy; ambiguous in-flight side effects remain blocked for reconciliation.
  if (userVersion < 69 && tableExists(_db, "automation_runs")) {
    const runColumns = new Set(schemaColumns(_db, "automation_runs").map((column) => column.name));
    if (!runColumns.has("occurrence_id")) {
      _db.exec("ALTER TABLE automation_runs ADD COLUMN occurrence_id TEXT");
    }
    if (!runColumns.has("graph_digest")) {
      _db.exec("ALTER TABLE automation_runs ADD COLUMN graph_digest TEXT");
    }
    if (!runColumns.has("checkpoint_json")) {
      _db.exec("ALTER TABLE automation_runs ADD COLUMN checkpoint_json TEXT");
    }
    if (!runColumns.has("resume_of_run_id")) {
      _db.exec("ALTER TABLE automation_runs ADD COLUMN resume_of_run_id TEXT");
    }
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_occurrence
      ON automation_runs(automation_id, occurrence_id, started_at)`);
  }

  // v70: durable event-trigger outbox. Source events are inserted here before
  // webhook acknowledgement or poll cursor advancement. A DB claim lease and
  // bound graph run receipt prevent GUI/headless peers from executing the same
  // delivery twice, while finite backoff parks a poison event without turning
  // the automation off or discarding the original payload.
  if (userVersion < 70) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS automation_trigger_events (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('fs','chain','webhook','poll')),
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','claimed','delivered','parked')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        next_attempt_at TEXT NOT NULL,
        claim_owner TEXT,
        claimed_until TEXT,
        run_id TEXT,
        run_outcome TEXT CHECK(run_outcome IS NULL OR run_outcome IN
          ('ok','partial','error','skipped','blocked','needs_input')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE CASCADE,
        UNIQUE(automation_id, trigger_kind, dedupe_key),
        CHECK(
          (status = 'claimed' AND claim_owner IS NOT NULL AND claimed_until IS NOT NULL) OR
          (status <> 'claimed' AND claim_owner IS NULL AND claimed_until IS NULL)
        ),
        CHECK((status = 'delivered' AND delivered_at IS NOT NULL) OR status <> 'delivered')
      );
      CREATE INDEX IF NOT EXISTS idx_automation_trigger_events_due
        ON automation_trigger_events(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_automation_trigger_events_automation
        ON automation_trigger_events(automation_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_automation_trigger_events_run
        ON automation_trigger_events(run_id) WHERE run_id IS NOT NULL;
    `);
  }
  // A development build may have opened the first v70 draft before the
  // scheduler-level outcome receipt was added. Keep that local DB upgradeable
  // without spending a second public schema number.
  if (tableExists(_db, "automation_trigger_events")) {
    const eventColumns = new Set(schemaColumns(_db, "automation_trigger_events").map((column) => column.name));
    if (!eventColumns.has("run_outcome")) {
      _db.exec("ALTER TABLE automation_trigger_events ADD COLUMN run_outcome TEXT");
    }
  }

  // v71: canonical durable Task. A chat today is agent-owned (chats.agent_id
  // NOT NULL + ON DELETE CASCADE), so deleting an agent destroys its chats. The
  // durable Task is the object One/Work/Mobile all project. This release (A) is
  // purely additive — it introduces `tasks` and backfills one task per top-level
  // user chat. The destructive `chats` rebuild that decouples agent_id and adds
  // chats.task_id is deferred to v73 (release B), so this additive backfill can
  // be validated in production first. Idempotent: rerunnable after a hard exit
  // between this gate and the single end-of-ladder user_version write.
  // Guarded on the parent tables tasks FK-references. A real v70 DB always has
  // projects (v2) and firms (v3); a partial dev/test fixture may not, and the
  // tasks FK check would otherwise raise "no such table" on backfill.
  if (
    userVersion < 71 &&
    tableExists(_db, "chats") &&
    tableExists(_db, "projects") &&
    tableExists(_db, "firms")
  ) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        project_id TEXT,
        firm_id TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        origin_chat_id TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(firm_id)    REFERENCES firms(id)    ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_firm_updated ON tasks(firm_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_origin_chat ON tasks(origin_chat_id);
    `);
    backfillTasksV71(_db);
  }

  // v72: which agents participated in a task. agent_id is nullable with
  // ON DELETE SET NULL (the key inversion vs chats' current CASCADE) so an agent
  // can be freely deleted while participation history survives via agent_slug.
  // agent_slug is NOT NULL: SQLite permits NULL in non-INTEGER PK columns and
  // treats NULLs as distinct, so a nullable slug PK would never dedupe. Backfill
  // resolves each chat's root user task via a cycle-guarded parent walk and
  // upserts (parent chat + its division sessions collapse to one task/one slug).
  // Guarded on `tasks` (created by v71 above; absent if v71 was skipped on a
  // partial fixture) and installed_agents (the participant FK parent).
  if (userVersion < 72 && tableExists(_db, "tasks") && tableExists(_db, "installed_agents")) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS task_agent_participants (
        task_id TEXT NOT NULL,
        agent_id TEXT,
        agent_slug TEXT NOT NULL,
        role TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(task_id, agent_slug),
        FOREIGN KEY(task_id)  REFERENCES tasks(id)            ON DELETE CASCADE,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_participants_agent ON task_agent_participants(agent_id);
    `);
    backfillTaskParticipantsV72(_db);
  }

  // v73: One(초개인화 개인 비서 표면)과 Work(전역 작업 표면)의 durable 분리.
  // 어느 표면이 이 대화를 시작했는지 기록한다. 기존 대화는 전부 'work'로 남아
  // One 홈이 전역 Work 작업으로 오염되지 않는다.
  if (userVersion < 73 && tableExists(_db, "chats")) {
    const chatColumnNamesV73 = new Set(schemaColumns(_db, "chats").map((column) => column.name));
    if (!chatColumnNamesV73.has("origin_surface")) {
      _db.exec("ALTER TABLE chats ADD COLUMN origin_surface TEXT NOT NULL DEFAULT 'work'");
    }
  }

  // ── v73 → v74: agent usage ledger + bookmark + intake receipt run linkage ──
  //   agent_usage                : per-agent run participation aggregate,
  //                                backfilled from run_events and kept live by
  //                                recordRunEvent.
  //   installed_agents.bookmarked_at : owner bookmark timestamp.
  //   experience_auto_intake_receipts.run_id / redaction_count :
  //                                links auto-intake receipts to the durable
  //                                run that created them (interactive
  //                                outcome promotion) and records how many
  //                                privacy spans were redacted on admit.
  if (userVersion < 74) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage (
        agent_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (tableExists(_db, "installed_agents")) {
      const agentColumns = new Set(schemaColumns(_db, "installed_agents").map((column) => column.name));
      if (!agentColumns.has("bookmarked_at")) {
        _db.exec("ALTER TABLE installed_agents ADD COLUMN bookmarked_at TEXT NULL");
      }
    }
    if (tableExists(_db, "experience_auto_intake_receipts")) {
      const receiptColumns = new Set(
        schemaColumns(_db, "experience_auto_intake_receipts").map((column) => column.name),
      );
      if (!receiptColumns.has("run_id")) {
        _db.exec("ALTER TABLE experience_auto_intake_receipts ADD COLUMN run_id TEXT NULL");
      }
      if (!receiptColumns.has("redaction_count")) {
        _db.exec("ALTER TABLE experience_auto_intake_receipts ADD COLUMN redaction_count INTEGER NOT NULL DEFAULT 0");
      }
      _db.exec(`
        CREATE INDEX IF NOT EXISTS idx_experience_auto_intake_run
          ON experience_auto_intake_receipts(agent_id, run_id)
          WHERE run_id IS NOT NULL;
      `);
    }
    if (tableExists(_db, "run_events")) {
      // Deterministic backfill: one use per distinct run an agent appeared in.
      _db.exec(`
        INSERT INTO agent_usage (agent_key, kind, first_used_at, last_used_at, use_count)
        SELECT agent_id, 'agent', MIN(ts), MAX(ts), COUNT(DISTINCT run_id)
          FROM run_events
         WHERE agent_id IS NOT NULL
         GROUP BY agent_id
        ON CONFLICT(agent_key) DO UPDATE SET
          first_used_at = MIN(agent_usage.first_used_at, excluded.first_used_at),
          last_used_at = MAX(agent_usage.last_used_at, excluded.last_used_at),
          use_count = excluded.use_count;
      `);

    }
  }

  // ── v74 → v75: unified team-member cell materialization ──────────────────
  //   installed_agents.parent_team_id : the firm/team a materialized member
  //     belongs to (NULL for standalone agents). Roster hides members from the
  //     top-level single/multi lists; they surface only inside their org chart.
  //   Materialization: every LOCAL-OWNED team's empty-agentId org members become
  //     first-class installed_agents rows (id = agentSlug, key-preserved) so
  //     Experience/chips can attach per member. Additive · idempotent · fail-
  //     closed · borrowed teams excluded · no retroactive experience move.
  if (userVersion < 75) {
    if (tableExists(_db, "installed_agents")) {
      const agentColumns = new Set(schemaColumns(_db, "installed_agents").map((column) => column.name));
      if (!agentColumns.has("parent_team_id")) {
        _db.exec("ALTER TABLE installed_agents ADD COLUMN parent_team_id TEXT NULL");
      }
      _db.exec(
        "CREATE INDEX IF NOT EXISTS idx_installed_agents_parent_team ON installed_agents(parent_team_id) WHERE parent_team_id IS NOT NULL",
      );
    }
  }

  // v76: Hub-borrowed agents are not installed assets. Keep only the current
  // Agentlas owner's private career facts (usage + last actual runtime) in a
  // separate owner partition. Pre-owner v74 usage is quarantined as
  // device-local and is never silently claimed by a later login.
  if (userVersion < 76) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS borrowed_agent_careers (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        slug TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
        latest_runtime_json TEXT,
        name_en TEXT,
        name_ko TEXT,
        tagline_en TEXT,
        tagline_ko TEXT,
        PRIMARY KEY(owner_scope_key, entity_kind, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_borrowed_agent_careers_owner_recent
        ON borrowed_agent_careers(owner_scope_key, last_used_at DESC);

      CREATE TABLE IF NOT EXISTS borrowed_agent_career_runs (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        slug TEXT NOT NULL,
        run_id_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(owner_scope_key, entity_kind, slug, run_id_hash),
        FOREIGN KEY(owner_scope_key, entity_kind, slug)
          REFERENCES borrowed_agent_careers(owner_scope_key, entity_kind, slug)
          ON DELETE CASCADE
      );
    `);

    if (tableExists(_db, "agent_usage") && tableExists(_db, "installed_agents")) {
      _db.exec(`
        INSERT OR IGNORE INTO borrowed_agent_careers (
          owner_scope_key, entity_kind, slug, first_used_at, last_used_at,
          use_count, latest_runtime_json
        )
        SELECT 'borrowed-owner:device-local', 'agent', usage.agent_key,
               usage.first_used_at, usage.last_used_at, usage.use_count, NULL
          FROM agent_usage usage
          LEFT JOIN installed_agents installed ON installed.id = usage.agent_key
         WHERE installed.id IS NULL
           AND usage.agent_key <> ''
           AND length(usage.agent_key) <= 120;
      `);
    }
  }

  // v77: borrowed careers are keyed by immutable Hub definition + release, not
  // a mutable slug. v76 rows cannot prove either identity, so preserve them in
  // explicitly quarantined legacy tables instead of silently assigning them to
  // a current package release.
  if (userVersion < 77) {
    const careerColumns = tableExists(_db, "borrowed_agent_careers")
      ? new Set(schemaColumns(_db, "borrowed_agent_careers").map((column) => column.name))
      : new Set<string>();
    if (careerColumns.size > 0 && !careerColumns.has("agent_definition_id")) {
      _db.exec(`
        DROP INDEX IF EXISTS idx_borrowed_agent_careers_owner_recent;
        DROP TABLE IF EXISTS borrowed_agent_career_runs_v76_legacy;
        DROP TABLE IF EXISTS borrowed_agent_careers_v76_legacy;
        ALTER TABLE borrowed_agent_careers RENAME TO borrowed_agent_careers_v76_legacy;
        ALTER TABLE borrowed_agent_career_runs RENAME TO borrowed_agent_career_runs_v76_legacy;
      `);
    }
    _db.exec(`
      CREATE TABLE IF NOT EXISTS borrowed_agent_careers (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        agent_definition_id TEXT NOT NULL,
        agent_release_id TEXT NOT NULL,
        component_id TEXT NOT NULL DEFAULT '',
        slug TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        first_used_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
        latest_runtime_json TEXT,
        name_en TEXT,
        name_ko TEXT,
        tagline_en TEXT,
        tagline_ko TEXT,
        PRIMARY KEY(
          owner_scope_key, entity_kind, agent_definition_id,
          agent_release_id, component_id
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_borrowed_agent_careers_owner_memory
        ON borrowed_agent_careers(owner_scope_key, memory_key);
      CREATE INDEX IF NOT EXISTS idx_borrowed_agent_careers_owner_recent
        ON borrowed_agent_careers(owner_scope_key, last_used_at DESC);

      CREATE TABLE IF NOT EXISTS borrowed_agent_career_runs (
        owner_scope_key TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('agent','team')),
        agent_definition_id TEXT NOT NULL,
        agent_release_id TEXT NOT NULL,
        component_id TEXT NOT NULL DEFAULT '',
        run_id_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(
          owner_scope_key, entity_kind, agent_definition_id,
          agent_release_id, component_id, run_id_hash
        ),
        FOREIGN KEY(
          owner_scope_key, entity_kind, agent_definition_id,
          agent_release_id, component_id
        )
          REFERENCES borrowed_agent_careers(
            owner_scope_key, entity_kind, agent_definition_id,
            agent_release_id, component_id
          )
          ON DELETE CASCADE
      );
    `);
  }

  // v78: exact Hub runtime bundles carry their validated bilingual display
  // snapshot into the owner-scoped career row. A just-completed run therefore
  // has a real name immediately, without inventing one from the slug or waiting
  // for the next bookmark synchronization.
  if (userVersion < 78 && tableExists(_db, "borrowed_agent_careers")) {
    const columns = new Set(schemaColumns(_db, "borrowed_agent_careers").map((column) => column.name));
    if (!columns.has("name_en")) _db.exec("ALTER TABLE borrowed_agent_careers ADD COLUMN name_en TEXT");
    if (!columns.has("name_ko")) _db.exec("ALTER TABLE borrowed_agent_careers ADD COLUMN name_ko TEXT");
    if (!columns.has("tagline_en")) _db.exec("ALTER TABLE borrowed_agent_careers ADD COLUMN tagline_en TEXT");
    if (!columns.has("tagline_ko")) _db.exec("ALTER TABLE borrowed_agent_careers ADD COLUMN tagline_ko TEXT");
  }

  // v79: a chat picker owns an exact chat-scoped orchestrator pin. Keep this
  // idempotent outside the version branch so an interim v79 development DB
  // created before this column landed repairs itself on the next boot.
  if (tableExists(_db, "chats")) {
    const chatColumnsV79 = new Set(schemaColumns(_db, "chats").map((column) => column.name));
    if (!chatColumnsV79.has("runtime_selection_json")) {
      _db.exec("ALTER TABLE chats ADD COLUMN runtime_selection_json TEXT");
    }
  }

  // v79: replace the single global runtime default with two role defaults.
  // active_runtime remains the orchestrator compatibility mirror for older
  // Desktop, Mobile, and Terminal builds. A missing worker always inherits the
  // orchestrator so an upgrade cannot silently lower quality. Keep the table
  // and two seed rows self-repairing for interim v79 development databases,
  // but avoid an ordinary-boot write when the complete contract already exists.
  if (!tableExists(_db, "model_roles")) {
    _db.exec(`
      CREATE TABLE model_roles (
        role TEXT PRIMARY KEY CHECK(role IN ('orchestrator','worker')),
        kind TEXT NOT NULL,
        backend TEXT,
        source TEXT,
        model TEXT,
        effort TEXT,
        long_context INTEGER NOT NULL DEFAULT 0 CHECK(long_context IN (0,1)),
        inherit INTEGER NOT NULL DEFAULT 0 CHECK(inherit IN (0,1)),
        updated_at TEXT NOT NULL,
        CHECK(role = 'worker' OR inherit = 0)
      );
    `);
  }
  const storedModelRoles = new Set(
    (_db.prepare("SELECT role FROM model_roles").all() as Array<{ role: string }>).map(
      (row) => row.role,
    ),
  );
  if (
    userVersion < 79 ||
    !storedModelRoles.has("orchestrator") ||
    !storedModelRoles.has("worker")
  ) {
    const active = _db
      .prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id = 1")
      .get() as {
        kind: string;
        backend: string | null;
        source: string | null;
        model: string | null;
        long_context: number;
      } | undefined;
    if (active) {
      const effort = tableExists(_db, "meta")
        ? (_db.prepare("SELECT value FROM meta WHERE key = 'claude_effort'").get() as
            | { value: string }
            | undefined)?.value ?? null
        : null;
      const updatedAt = new Date().toISOString();
      const insert = _db.prepare(
        `INSERT OR IGNORE INTO model_roles
         (role, kind, backend, source, model, effort, long_context, inherit, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        "orchestrator",
        active.kind,
        active.backend,
        active.source,
        active.model,
        effort,
        active.long_context ? 1 : 0,
        0,
        updatedAt,
      );
      insert.run(
        "worker",
        active.kind,
        active.backend,
        active.source,
        active.model,
        effort,
        active.long_context ? 1 : 0,
        1,
        updatedAt,
      );
    }
  }

  if (options.deferPostContinuityRepairs) {
    _postContinuityRepairsDeferred = true;
  } else {
    runStoreRepairProjections(_db);
  }

  // Never rewrite the version marker on an ordinary boot (avoids taking a WAL
  // writer lock while a healthy peer is executing), and never downgrade a DB
  // created by a newer binary.
  if (userVersion < SCHEMA_VERSION) _db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Periodic counterpart to boot recovery. This lets a crash-recent row age out
 * without requiring another restart, while the silence/event checks protect a
 * healthy run owned by the GUI or headless peer process.
 */
export function recoverStaleAutomationRuns(now: Date = new Date()): number {
  return recoverStaleAutomationRunsInDb(getDb(), now);
}

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error("Store not initialized. Call initStore() in app.whenReady().");
  }
  return _db;
}
