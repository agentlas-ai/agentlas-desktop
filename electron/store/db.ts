// 로컬 영구 저장 — userData/agentlas.sqlite.
// PRD 6.1: better-sqlite3, 동기 API라 IPC 핸들러에서 그대로 호출 가능.
// 채팅 로그는 기본 로컬 — 클라우드 백업은 사용자 명시 토글에만 (PRD 6.3).
//
// 스키마 버전 관리: user_version pragma로 마이그레이션. M0 → projects/chats 도입 시 chat_messages 재구성.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPackagedRuntime, userDataPath } from "../runtime-paths";
import { publicAgentVisibility } from "../agents/policy";
import { MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS } from "../automation-watchdog";
import { materializeTeamMemberCells, type MaterializableFirmNode } from "./team-member-cells";
import { reconcileTaskParticipantsFromRunEventsInDb } from "./task-participant-projection";

let _db: Database.Database | null = null;
let _postContinuityRepairsDeferred = false;

const SCHEMA_VERSION = 112;

/**
 * The schema version this binary's migration ladder produces.
 *
 * Exported because `agentlas.sqlite` is a shared, lock-free multi-writer file and
 * the terminal product must be able to *check* the version without being allowed
 * to *raise* it. See `STORE_MIGRATION_AUTHORITY` below.
 */
export const STORE_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * ★단일 마이그레이션 권위 (Phase 0, docs/DAEMON-ARCHITECTURE-DESIGN-2026-08-18.md §2/§6).
 *
 * `~/Library/Application Support/Agentlas/agentlas.sqlite` has two products opening
 * it: this core (Desktop, and the compiled core the terminal vendors) and the
 * terminal's own light driver (`engine/core/db.cjs`). Until now BOTH could run this
 * ladder against the same file — the terminal's `desktop-core.cjs` shim reports
 * `isPackaged: true`, which by design defeats the dev sandbox guard in
 * `resolveStorePath()`. Two processes interleaving 97 steps of unwrapped DDL is
 * exactly how `run_events` + 4 indexes were corrupted (see the comment above
 * `resolveStorePath`).
 *
 * The rule is now explicit, not accidental:
 *
 *   owner    — may run the ladder and may write `user_version`. The Desktop app
 *              (and any process a human deliberately marks as the owner).
 *   follower — never runs a ladder step, never writes `user_version`. If the file
 *              is older than this binary it REFUSES with an actionable message
 *              instead of migrating or (as before) silently proceeding.
 *
 * Why "follower refuses" instead of "whoever gets there first migrates": absence of
 * the Desktop app is not observable race-free — Desktop can launch in the middle of
 * a terminal-run ladder. Guessing wrong costs a corrupt 117 MB store; refusing costs
 * one launch of the Desktop app. A refusal is recoverable, corruption is not.
 *
 * Escape hatch for a machine that genuinely has no Desktop app: the operator sets
 * `AGENTLAS_STORE_MIGRATION_ROLE=owner` deliberately, with Desktop closed. Explicit
 * beats accidental.
 */
export type StoreMigrationRole = "owner" | "follower";

function resolveMigrationRole(options: StoreInitOptions): StoreMigrationRole {
  if (options.migrationRole) return options.migrationRole;
  const fromEnv = process.env.AGENTLAS_STORE_MIGRATION_ROLE?.trim().toLowerCase();
  if (fromEnv === "follower") return "follower";
  if (fromEnv === "owner") return "owner";
  return "owner";
}

/**
 * Honest, actionable refusal. Names both versions, the file, and the two ways out.
 * Never mutate on this path — the caller is by definition not the migration owner.
 */
export function storeSchemaRefusalMessage(found: number, dbPath: string): string {
  return [
    `Agentlas store schema is v${found}, but this process needs v${SCHEMA_VERSION}.`,
    `Store: ${dbPath}`,
    "This process is not the migration owner, so it will not upgrade the shared database.",
    "Launch (or update) the Agentlas Desktop app once — it owns the migration ladder — then retry.",
    "If this machine has no Desktop app, close every Agentlas process and re-run with AGENTLAS_STORE_MIGRATION_ROLE=owner exactly once.",
  ].join("\n");
}

/**
 * Shared lock wait for `agentlas.sqlite`, in milliseconds.
 *
 * ★Must stay identical to `agentlas_terminal/engine/agentlas-sqlite-policy.cjs`
 * (`SQLITE_BUSY_TIMEOUT_MS`). They were 5000 here vs 15000 there, so under contention
 * the *Desktop* was always the first to give up with SQLITE_BUSY even when the
 * terminal was the slow writer — an asymmetry that made the same contention look
 * like a Desktop-only bug. Aligned upward to 15s because no long-running work holds
 * a transaction on this file (the longest writer is the migration ladder itself), so
 * 15s is a ceiling that is essentially never reached rather than added latency.
 */
const STORE_BUSY_TIMEOUT_MS = 15_000;

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

/**
 * PRD §5.26 — 예전에는 다섯 개의 `ALTER TABLE … ADD COLUMN` 이 **매 기동마다 다시 돌고**
 * 모든 실패를 삼켰다(정상 경로에서도 예외가 나고, 진짜 문제도 같은 자리에서 조용히 사라졌다).
 * 칸이 있는지 먼저 보고, 없을 때만 더한다. 그리고 "이미 있다" 외의 실패는 삼키지 않는다.
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  if (!tableExists(db, table)) return;
  if (schemaColumns(db, table).some((entry) => entry.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    // 경합으로 다른 프로세스가 먼저 더했을 수 있다. 그 외의 실패는 올린다.
    if (!/duplicate column name/i.test(String((error as Error).message))) throw error;
  }
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
    const file = userDataPath("agent-routes.json");
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

function recoveryOwnerProvenDead(row: RecoverableAutomationRunRow): boolean {
  const pid = trustedRecoveryPid(row.lease_owner);
  return pid != null && !recoveryProcessAlive(pid);
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
      recoveryOwnerProvenDead(candidate)
      || (!rowHasFreshActivity(candidate, cutoffMs) && !recoveryOwnerActive(candidate, nowMs))
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
      /*
       * ★목표 재기동 (2026-08-10) — 죽은 런을 error로 "닫기만" 하던 자리에,
       * goal 연속실행(automations.goal_id)만은 다음 tick에 재투입한다.
       * 진행 중이던 목표는 프로세스가 죽었다고 끝난 것이 아니다("에이전트가
       * 죽거나 멈추면 다시 띄워서 계속 진행"). 시계 트리거이고 켜져 있는
       * 자동화에 한해 next_run_at을 지금으로 당긴다 — 예산·정지 판단은
       * 실행 시점에 goal 원장(should_continue)이 다시 내린다.
       * 이 UPDATE가 참조하는 칸(goal_id·enabled·next_run_at·trigger_type) 중
       * 하나라도 없는 옛 스키마에서는 통째로 건너뛴다 — 복구 경로는 어떤
       * 과거 스키마 위에서도 죽어선 안 된다(v52 픽스처가 실측한다).
       */
      const automationColumns = new Set(
        schemaColumns(db, "automations").map((column) => column.name),
      );
      if (["goal_id", "enabled", "next_run_at", "trigger_type"].every((column) => automationColumns.has(column))) {
        db.prepare(
          `UPDATE automations
           SET next_run_at = ?
           WHERE id = ? AND enabled = 1 AND goal_id IS NOT NULL
             AND COALESCE(trigger_type, 'schedule') = 'schedule'
             AND (next_run_at IS NULL OR next_run_at > ?)`,
        ).run(now.toISOString(), candidate.automation_id, now.toISOString());
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

/**
 * 되돌릴 수 없는 마이그레이션 직전에 DB 파일을 복사해 둔다.
 *
 * ★ 왜 (v102 좌석 전환): chats 를 재작성하는 단계는 실패해도 되돌릴 수 없다. SQLite 는
 * 컬럼 제약을 제자리에서 못 바꾸므로 테이블을 새로 만들고 옮기고 지운다. 트랜잭션이
 * 감당 못 하는 실패(디스크 가득, 프로세스 강제 종료, 파일 손상)에서는 이 사본이 유일한
 * 복구 경로다.
 *
 * WAL 을 먼저 합쳐서 복사한다 — 합치지 않으면 사본이 최근 쓰기를 빠뜨린 상태가 된다.
 * 복사에 실패해도 마이그레이션을 막지는 않는다. 다만 그 사실을 오류에 실어 보낸다
 * ("백업을 만들지 못했다") — 조용히 넘어가면 복구할 게 없다는 걸 사고 나서 안다.
 */
/**
 * 닿을 수 없는 개인 기억을 팀 공유 칸으로 되돌린다. 옮기기만 하고 지우지 않는다.
 *
 * 사다리 안에 인라인으로 두면 게이트가 그 판단을 부를 수 없어, 검사가 "사다리를 다시
 * 태우는 시늉"만 하게 된다(이 저장소가 이미 겪은 계열 — 문장 대조 게이트는 이 병을
 * 원리적으로 못 잡는다). 판단을 꺼내 두면 게이트가 값으로 단언할 수 있다.
 *
 * @returns 옮긴 행 수
 */
export function reclaimUnreachableAgentMemory(db: Database.Database): number {
  if (!tableExists(db, "memory_entries") || !tableExists(db, "installed_agents")) return 0;
  const columns = new Set(schemaColumns(db, "memory_entries").map((column) => column.name));
  if (!columns.has("agent_id") || !columns.has("scope")) return 0;
  return db.prepare(`
    UPDATE memory_entries
       SET scope = 'team_memory', agent_id = NULL
     WHERE scope = 'agent_repo'
       AND agent_id IS NOT NULL
       AND (
         agent_id LIKE 'agt\\_team\\_%' ESCAPE '\\'
         OR agent_id NOT IN (SELECT id FROM installed_agents)
       )
  `).run().changes;
}

/**
 * 갈라진 자동 경험 팩을 다시 하나로 모은다. 옮기고 보관할 뿐, 지우지 않는다.
 *
 * ★무엇이 갈라졌나: 자동 팩의 좌표에 `base_package_hash` 가 들어 있었다. 그 해시는
 * 패키지 전체를 덮으므로 에이전트를 한 번 고쳐 다시 올리면 값이 바뀌고, 조회가 어긋나
 * **팩이 하나 더 생긴다**. 그때부터 새 경험은 새 팩에, 옛 경험은 옛 팩에 쌓인다.
 *
 * 사용자에게 보이는 피해는 숨는 것에서 끝나지 않았다. 새 팩에는 같은 기억이 처음부터
 * 다시 들어오므로, **이미 승급한 칩을 또 검토하라고 묻는다.** 실측(이 기기): 좌표 2곳이
 * 팩 6개로 갈렸고, 그 안에서 이미 승급된 기억에 대한 재검토 요청이 18건 있었다.
 *
 * 지킴이는 "가장 오래된 팩"이 아니라 **승급이 가장 많은 팩**이다. 실측에서 승급 12건이
 * 전부 형제 쪽에 있었다 — 오래된 순으로 골랐다면 사용자가 실제로 작업한 팩을 보관함으로
 * 보낼 뻔했다.
 *
 * 행 수는 어느 쪽도 줄지 않는다. `experience_packs` 와 `experience_candidates` 는 둘 다
 * 업데이트 연속성 보호 표라, 행이 하나라도 줄면 다음 업데이트가 fail-closed 로 막힌다
 * (`updater/controller.ts` CONTINUITY_CORE_TABLES). 그래서 합치는 방식은 이동(pack_id)과
 * 보관(status)뿐이고, 신원 해시는 기본키만 덮으므로 둘 다 그 해시를 건드리지 않는다.
 *
 * 옮길 수 없는 행(지킴이에 같은 기억이 이미 있다)은 제자리에 남고 그 팩이 보관된다 —
 * 그것이 바로 중복이므로, 보관은 곧 재검토 요청을 없애는 일이다.
 *
 * @returns 다룬 묶음 수, 옮긴 후보 수, 보관한 팩 수
 */
export function consolidateSplitAutoExperiencePacks(db: Database.Database): {
  groups: number;
  moved: number;
  archived: number;
} {
  const empty = { groups: 0, moved: 0, archived: 0 };
  if (!tableExists(db, "experience_packs") || !tableExists(db, "experience_candidates")) return empty;
  const packColumns = new Set(schemaColumns(db, "experience_packs").map((column) => column.name));
  const candidateColumns = new Set(schemaColumns(db, "experience_candidates").map((column) => column.name));
  for (const required of ["agent_id", "project_scope_key", "environment_key", "auto_managed", "status", "created_at"]) {
    if (!packColumns.has(required)) return empty;
  }
  if (!candidateColumns.has("pack_id") || !candidateColumns.has("source_memory_id")) return empty;

  const groups = db.prepare(`
    SELECT agent_id, project_scope_key, environment_key
      FROM experience_packs
     WHERE auto_managed = 1 AND status = 'active'
     GROUP BY agent_id, project_scope_key, environment_key
    HAVING COUNT(*) > 1
  `).all() as Array<{ agent_id: string; project_scope_key: string; environment_key: string }>;
  if (groups.length === 0) return empty;

  const now = new Date().toISOString();
  let moved = 0;
  let archived = 0;
  for (const group of groups) {
    const packs = db.prepare(`
      SELECT p.id AS id
        FROM experience_packs p
       WHERE p.agent_id = ? AND p.project_scope_key = ? AND p.environment_key = ?
         AND p.auto_managed = 1 AND p.status = 'active'
       ORDER BY (SELECT COUNT(*) FROM experience_candidates c
                  WHERE c.pack_id = p.id AND c.status = 'promoted') DESC,
                p.created_at ASC, p.id ASC
    `).all(group.agent_id, group.project_scope_key, group.environment_key) as Array<{ id: string }>;
    if (packs.length < 2) continue;
    const keeper = packs[0].id;
    const siblings = packs.slice(1).map((pack) => pack.id);

    for (const sibling of siblings) {
      // 한 형제씩 옮긴다. 여러 형제를 한 문장으로 옮기면 "지킴이에 이미 있는가"가
      // 옮기는 도중 바뀌어, 두 형제가 같은 기억을 함께 밀어 넣으려다 UNIQUE 에 걸린다.
      moved += db.prepare(`
        UPDATE experience_candidates
           SET pack_id = ?
         WHERE pack_id = ?
           AND source_memory_id NOT IN
               (SELECT source_memory_id FROM experience_candidates WHERE pack_id = ?)
      `).run(keeper, sibling, keeper).changes;
    }

    // 옮길 수 있었는데 남은 행이 있으면 보관하지 않는다 — 보관은 곧 화면에서 사라지는
    // 일이라, "중복이라서 남았다"가 참일 때만 안전하다. 값으로 확인하고 넘어간다.
    const strandedRow = db.prepare(`
      SELECT COUNT(*) AS n
        FROM experience_candidates c
       WHERE c.pack_id IN (${siblings.map(() => "?").join(", ")})
         AND NOT EXISTS (SELECT 1 FROM experience_candidates k
                          WHERE k.pack_id = ? AND k.source_memory_id = c.source_memory_id)
    `).get(...siblings, keeper) as { n?: number } | undefined;
    if (Number(strandedRow?.n ?? 0) > 0) {
      console.error(
        `[store] auto experience pack consolidation skipped ${group.agent_id} — ` +
          `${strandedRow?.n} candidate(s) could not move into the surviving pack`,
      );
      continue;
    }

    archived += db.prepare(
      `UPDATE experience_packs SET status = 'archived'${packColumns.has("updated_at") ? ", updated_at = ?" : ""}
        WHERE id IN (${siblings.map(() => "?").join(", ")})`,
    ).run(...(packColumns.has("updated_at") ? [now] : []), ...siblings).changes;
  }
  return { groups: groups.length, moved, archived };
}

function backupDatabaseFile(db: Database.Database, tag: string): string | null {
  try {
    const source = db.name;
    if (!source || source === ":memory:") return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${source}.${tag}-${stamp}.bak`;
    // ★ Copy through SQLite, never through fs (2026-09-05). Until this date the
    // backup was `wal_checkpoint(FULL)` + `fs.copyFileSync(source, target)`. On
    // POSIX, closing *any* descriptor a process holds on a file releases every
    // fcntl lock that process holds on it — so the copy's open/close silently
    // dropped this connection's SHARED lock on the main file for the rest of
    // the app's life. From then on any peer that closed (agentlasd, a headless
    // wake, the terminal follower) could take EXCLUSIVE, delete -wal/-shm under
    // our mapping, and the next wal-index touch was EXC_BAD_ACCESS/SIGBUS —
    // every upgrade start re-armed it (crash reports 2026-08-28…09-04, all in
    // walIndexAppend/walFindFrame). `VACUUM INTO` writes a consistent copy of
    // the current content (WAL included) using SQLite's own VFS descriptors,
    // which share this connection's inode bookkeeping, so no lock is lost and
    // no checkpoint is needed. It must not run inside a transaction — callers
    // take the backup before they open theirs. Gate:
    // scripts/store-sidecar-lock-safety-contract.cjs (probes the fcntl locks).
    db.prepare("VACUUM INTO ?").run(target);
    hardenStoreFile(target);
    return target;
  } catch {
    return null;
  }
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
  /**
   * Who may migrate the shared store. Defaults to the `AGENTLAS_STORE_MIGRATION_ROLE`
   * env var, then to "owner" (the Desktop app). Pass "follower" from any process that
   * shares `agentlas.sqlite` but must not be a second migration authority — the
   * terminal's vendored-core path does exactly this. See `StoreMigrationRole`.
   */
  migrationRole?: StoreMigrationRole;
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

  try {
    const repairedTaskParticipants = db.transaction(() =>
      reconcileTaskParticipantsFromRunEventsInDb(db),
    )();
    if (repairedTaskParticipants > 0) {
      console.warn(
        `[task] repaired ${repairedTaskParticipants} runtime participant projection(s)`,
      );
    }
  } catch (error) {
    console.warn(
      `[task] runtime participant repair deferred: ${error instanceof Error ? error.message : "unknown"}`,
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

/**
 * 이 프로세스가 열어도 되는 저장소 경로.
 *
 * ★스크립트로 띄운 Electron 은 사람의 실제 데이터를 열지 않는다(2026-08-11).
 * 게이트 51개가 `userData` 를 격리하지 않은 채 라이브 `agentlas.sqlite` 를 직접 열고
 * 있었고, 앱이 켜진 상태에서 게이트를 돌리자 동시 접근으로 `run_events` 와 그 인덱스
 * 4개가 malformed 가 됐다 — 앱이 아예 시작하지 못했다(복구는 `.recover` 로 손실 0,
 * 사용자 데이터 81개 테이블 중 깨진 것은 그 하나뿐이었다).
 *
 * 패키징되지 않은 Electron은 스크립트와 GUI를 가리지 않고 격리한다. 예전에는
 * `scripts/` 엔트리만 막아서 `electron .`로 띄운 개발 창이 실행 중인 설치 앱의 WAL을
 * 함께 열 수 있었다. 실제 One QA에서 이 경로가 SQLITE_CORRUPT를 만들었다. 명시적
 * 경로가 없으면 **조용히 라이브로 떨어지지 않고** 프로세스별 임시 저장소로 돌린다.
 * 라이브 복제본으로 QA하려면 `AGENTLAS_STORE_PATH`를 별도 복사본에 명시해야 한다 —
 * 실수로 되는 일과 적어서 되는 일은 달라야 한다.
 */
function resolveStorePath(): string {
  const explicit = process.env.AGENTLAS_STORE_PATH?.trim();
  if (explicit) return explicit;

  // The packaged daemon has no importable Electron module. Its injected app
  // user-data directory is the ownership proof used by isPackagedRuntime().
  const packaged = isPackagedRuntime();
  if (!packaged) {
    const entry = process.argv[1] ?? "";
    const sandbox = path.join(
      os.tmpdir(),
      `agentlas-dev-store-${process.pid}`,
      "agentlas.sqlite",
    );
    console.warn(
      `[store] unpackaged run detected (${path.basename(entry) || "electron"}) — using an isolated store at ${sandbox}.\n` +
      "[store] set AGENTLAS_STORE_PATH to open a specific database on purpose.",
    );
    return sandbox;
  }

  return userDataPath("agentlas.sqlite");
}

/**
 * Put the shared store in WAL, tolerating a peer that is doing the same thing.
 *
 * ★`PRAGMA journal_mode = WAL` is not an ordinary write: switching a rollback-journal
 * database to WAL takes an EXCLUSIVE lock on the file, and SQLite reports SQLITE_BUSY
 * for that transition without consulting the busy handler. So on a store that is not
 * WAL yet, two processes opening it at the same time meant one of them died at boot
 * with "database is locked" — reproduced by the cross-product contention test in
 * scripts/test-store-migration-authority.cjs.
 *
 * Two defences: never ask when the file is already WAL (the steady state, so the race
 * window only exists on a brand-new store), and treat a busy transition as "a peer is
 * converting it right now" — re-read, and only fail if it is still not WAL.
 */
function ensureWalJournal(db: Database.Database, dbPath: string): void {
  const mode = (): string => String(db.pragma("journal_mode", { simple: true }) ?? "").toLowerCase();
  if (mode() === "wal") return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      db.pragma("journal_mode = WAL");
    } catch {
      /* a peer holds the exclusive lock for the same conversion — re-read below */
    }
    if (mode() === "wal") return;
  }
  throw new Error(
    `Agentlas could not put the store in WAL mode: ${path.basename(dbPath)} is still in "${mode()}". `
    + "Close every other Agentlas process and retry.",
  );
}

/**
 * 이 프로세스가 실제로 연 DB 파일. **호스트끼리 "우리가 같은 DB 를 보고 있나" 를
 * 물을 수 있어야 한다** — 터미널이 `AGENTLAS_STORE_PATH` 로 사본을 지정해도 그 값은
 * 데몬까지 가지 않으므로, 일을 넘기기 전에 서로 확인하지 않으면 한쪽은 사본에 쓰고
 * 다른 쪽은 라이브에 쓰는 상태가 조용히 성립한다.
 */
export function openedStorePath(): string | null {
  return _openedStorePath;
}
let _openedStorePath: string | null = null;

export function initStore(options: StoreInitOptions = {}): void {
  if (_db) return;
  const migrationRole = resolveMigrationRole(options);
  try {
  const dbPath = resolveStorePath();
  _openedStorePath = dbPath;
  preparePrivateStorePath(dbPath);
  _db = new Database(dbPath);
  // ★busy_timeout 이 journal_mode 보다 **먼저** 와야 한다 (2026-08-18 실측).
  // `journal_mode = WAL` 은 파일에 배타 락을 잡는다. busy_timeout 이 아직 0이면
  // 다른 프로세스가 쓰는 중일 때 대기 없이 즉시 SQLITE_BUSY 로 터진다 — 즉 부팅
  // 자체가 "database is locked" 로 실패했다. 순서를 뒤집으면 같은 경합을 기다린다.
  // (교차 제품 동시 쓰기 테스트가 이 순서로 재현시켰다:
  //  scripts/test-store-migration-authority.cjs)
  //
  // GUI, launchd and the terminal share this WAL. Event-source callbacks must wait
  // for the current writer instead of dropping a filesystem/chain delivery on an
  // immediate SQLITE_BUSY. Long-running work never holds a DB transaction.
  _db.pragma(`busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
  ensureWalJournal(_db, dbPath);
  hardenStoreSidecars(dbPath);
  _db.pragma("foreign_keys = ON");

  const userVersion = (_db.pragma("user_version", { simple: true }) as number) ?? 0;

  // ── 단일 마이그레이션 권위 게이트 ──────────────────────────────────────
  // A follower opens the shared store read/write for ordinary work but is not a
  // migration authority: it runs no ladder step, writes no `user_version`, and runs
  // no boot repair projection (those are owner-side writes). Too old → honest refusal.
  if (migrationRole === "follower") {
    if (userVersion < SCHEMA_VERSION) {
      throw new Error(storeSchemaRefusalMessage(userVersion, dbPath));
    }
    return;
  }

  // ── 아주 오래된 DB 를 위한 안전망 ───────────────────────────────────────
  // 사다리는 90단계이고 `user_version` 은 **맨 마지막에 한 번만** 찍힌다(이 함수 끝).
  // 중간 한 단계가 던지면 앞 단계의 DDL 은 이미 적용됐는데 버전은 옛날 그대로라, 다음
  // 실행이 같은 지점에서 또 던진다 — 앱이 영영 안 열린다. v0.7.0 은 스키마 35 를
  // 출하했으므로 그런 사용자는 68단계를 한 번에 밟는다.
  // 여기서 딱 두 가지를 한다: (1) 밟기 전에 파일 사본을 남긴다 (2) 던지면 어느 버전에서
  // 무엇 때문에 멈췄고 사본이 어디 있는지 말한다. 조용한 영구 실패를 없애는 것이 목적이지
  // 실패 자체를 삼키는 것이 아니다 — 게이트: `npm run test:ancient-schema-ladder`.
  let upgradeBackupPath: string | null = null;
  if (userVersion > 0 && userVersion < SCHEMA_VERSION) {
    upgradeBackupPath = backupDatabaseFile(_db, `pre-upgrade-v${userVersion}`);
  }
  try {

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
    // ★"이 자동화가 무엇을 위한 것인가" — 인터뷰의 blueprint.goal. 예전에는 저장 순간
    //   사라져서, 나중에 AI(architect·검증 설계기)가 "이게 무슨 그래프인지" 알 단서가
    //   노드 라벨뿐이었다. 검증 자동 설계의 선행 조건.
    addAutoCol("goal", "goal TEXT");
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
        resume_of_run_id TEXT,
        dry_run INTEGER NOT NULL DEFAULT 0 CHECK(dry_run IN (0, 1))
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
        -- 2축 좌표. 몸통(코어) 해시가 신원이고 부품 목록 해시는 실행 무결성이다.
        -- axis_version 2 = 옛 한 축 기록, 3 = 두 축을 갖춘 기록. 상세는 REQUIRED_COLUMNS 주석.
        axis_version INTEGER NOT NULL DEFAULT 2,
        base_core_hash TEXT,
        module_set_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_experience_packs_agent_scope
        ON experience_packs(agent_id, project_scope_key, environment_key, updated_at DESC);
      -- 몸통 축 인덱스는 여기서 만들지 않는다. 이 블록은 부팅 때마다 돌지만, 기존 설치에는
      -- base_core_hash 칸이 이 시점에 아직 없다(칸은 아래 REQUIRED_COLUMNS 백스톱이 만든다).
      -- 여기 두면 새 설치에만 인덱스가 생기고 기존 설치는 조용히 빠진다 — 실측으로 확인함.
      -- 생성 지점은 승격 블록 바로 뒤다.

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
        role TEXT PRIMARY KEY CHECK(role IN ('orchestrator','worker','multimodal')),
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
    // 마이그레이션은 자기가 만들지 않은 테이블의 존재를 가정하면 안 된다. 여기서 던지면
    // initStore 전체가 실패해 앱이 열리지 않는다 — 모델 역할 시드는 있으면 좋은 것이지
    // 부팅 전제가 아니다(바로 아래 meta 조회는 이미 같은 방식으로 방어하고 있었다).
    const active = (tableExists(_db, "active_runtime")
      ? _db
        .prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id = 1")
        .get()
      : undefined) as {
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

  // v80: role pools. Each role holds an ordered candidate list; resolution
  // picks the first member that is installed/signed-in and under its usage
  // window, so one exhausted subscription no longer stalls every call. The
  // v79 single-row model_roles table stays as the resolved-head mirror for
  // older Desktop, Mobile, and Terminal readers — pools never replace it.
  // An EMPTY worker pool means "inherit the orchestrator pool" (v79 inherit).
  if (!tableExists(_db, "model_role_members")) {
    _db.exec(`
      CREATE TABLE model_role_members (
        role TEXT NOT NULL CHECK(role IN ('orchestrator','worker','multimodal')),
        position INTEGER NOT NULL CHECK(position >= 1),
        kind TEXT NOT NULL,
        backend TEXT,
        source TEXT,
        model TEXT,
        effort TEXT,
        long_context INTEGER NOT NULL DEFAULT 0 CHECK(long_context IN (0,1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(role, position)
      );
    `);
  }
  if (userVersion < 80) {
    const memberCount = (
      _db.prepare("SELECT COUNT(*) AS n FROM model_role_members").get() as { n: number }
    ).n;
    if (memberCount === 0) {
      const seed = _db.prepare(
        `INSERT OR IGNORE INTO model_role_members
         (role, position, kind, backend, source, model, effort, long_context, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const roleRows = _db
        .prepare("SELECT * FROM model_roles")
        .all() as Array<{
          role: string;
          kind: string;
          backend: string | null;
          source: string | null;
          model: string | null;
          effort: string | null;
          long_context: number;
          inherit: number;
        }>;
      const seededAt = new Date().toISOString();
      for (const row of roleRows) {
        // v79 inherit-worker stays an empty pool — same "follow the
        // orchestrator" meaning, no duplicated member row to drift.
        if (row.role === "worker" && row.inherit) continue;
        seed.run(
          row.role,
          row.kind,
          row.backend,
          row.source,
          row.model,
          row.effort,
          row.long_context ? 1 : 0,
          seededAt,
        );
      }
    }
  }

  // v106: the Desktop added the non-conversational multimodal role after the
  // v79/v80 tables had shipped. The TypeScript role union accepted it, but both
  // durable tables still rejected it with their original two-role CHECK.
  // Rebuild only when the stored CREATE SQL proves the constraint is stale.
  if (userVersion < 106) {
    const modelRolesSql = (_db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_roles'",
    ).get() as { sql?: string } | undefined)?.sql ?? "";
    const modelRoleMembersSql = (_db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_role_members'",
    ).get() as { sql?: string } | undefined)?.sql ?? "";
    const needsRoleRebuild = !modelRolesSql.includes("'multimodal'");
    const needsMemberRebuild = !modelRoleMembersSql.includes("'multimodal'");
    if (needsRoleRebuild || needsMemberRebuild) {
      const roleCount = (_db.prepare("SELECT COUNT(*) AS n FROM model_roles").get() as { n: number }).n;
      const memberCount = (_db.prepare("SELECT COUNT(*) AS n FROM model_role_members").get() as { n: number }).n;
      const widenRuntimeRoles = _db.transaction(() => {
        if (needsRoleRebuild) {
          _db!.exec(`
            DROP TABLE IF EXISTS model_roles_v106;
            CREATE TABLE model_roles_v106 (
              role TEXT PRIMARY KEY CHECK(role IN ('orchestrator','worker','multimodal')),
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
            INSERT INTO model_roles_v106
              (role, kind, backend, source, model, effort, long_context, inherit, updated_at)
              SELECT role, kind, backend, source, model, effort, long_context, inherit, updated_at
              FROM model_roles;
            DROP TABLE model_roles;
            ALTER TABLE model_roles_v106 RENAME TO model_roles;
          `);
        }
        if (needsMemberRebuild) {
          _db!.exec(`
            DROP TABLE IF EXISTS model_role_members_v106;
            CREATE TABLE model_role_members_v106 (
              role TEXT NOT NULL CHECK(role IN ('orchestrator','worker','multimodal')),
              position INTEGER NOT NULL CHECK(position >= 1),
              kind TEXT NOT NULL,
              backend TEXT,
              source TEXT,
              model TEXT,
              effort TEXT,
              long_context INTEGER NOT NULL DEFAULT 0 CHECK(long_context IN (0,1)),
              updated_at TEXT NOT NULL,
              PRIMARY KEY(role, position)
            );
            INSERT INTO model_role_members_v106
              (role, position, kind, backend, source, model, effort, long_context, updated_at)
              SELECT role, position, kind, backend, source, model, effort, long_context, updated_at
              FROM model_role_members;
            DROP TABLE model_role_members;
            ALTER TABLE model_role_members_v106 RENAME TO model_role_members;
          `);
        }
        const nextRoleCount = (_db!.prepare("SELECT COUNT(*) AS n FROM model_roles").get() as { n: number }).n;
        const nextMemberCount = (_db!.prepare("SELECT COUNT(*) AS n FROM model_role_members").get() as { n: number }).n;
        if (nextRoleCount !== roleCount || nextMemberCount !== memberCount) {
          throw new Error(
            `v106 runtime-role widening changed row counts: roles ${roleCount}->${nextRoleCount}, members ${memberCount}->${nextMemberCount}`,
          );
        }
      });
      widenRuntimeRoles();
    }
  }

  // v81: 팀 내부 워커는 선택기에서 팀으로만 보인다. 팀 설치가 멤버 에이전트를
  // visible로 넣어 작업공간 드롭다운이 조직도를 워커 단위로 분해 노출했다
  // (실측: visible 싱글 98명 중 90명이 팀 멤버). 앞으로는 background로 생성하고,
  // 이미 설치된 멤버도 여기서 한 번 소급 정리한다. 팀 엔티티 행은 그대로 보이고,
  // 멤버는 팀 상세에서 계속 단독 호출할 수 있다 — 목록 노출만 바뀐다.
  if (userVersion < 81 && tableExists(_db, "installed_agents")) {
    try {
      _db
        .prepare(
          `UPDATE installed_agents SET visibility = 'background'
            WHERE parent_team_id IS NOT NULL
              AND visibility = 'visible'
              AND (entity_kind IS NULL OR entity_kind != 'team')`,
        )
        .run();
    } catch {
      /* parent_team_id 이전 스키마 — 멤버 개념이 없으므로 정리할 것도 없다 */
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
  // v82: project-first ownership. The new UI no longer reads default_agent_id/context_note.
  // Existing values are converted once into the explicit system prompt and ordered agent pool.
  if (userVersion < 82 && tableExists(_db, "projects")) {
    const projectCols = schemaColumns(_db, "projects");
    if (!projectCols.some((column) => column.name === "system_prompt")) {
      _db.exec("ALTER TABLE projects ADD COLUMN system_prompt TEXT");
    }
    if (!projectCols.some((column) => column.name === "agent_pool_json")) {
      _db.exec("ALTER TABLE projects ADD COLUMN agent_pool_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!projectCols.some((column) => column.name === "source_type")) {
      _db.exec("ALTER TABLE projects ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local'");
    }
    if (!projectCols.some((column) => column.name === "source_ref")) {
      _db.exec("ALTER TABLE projects ADD COLUMN source_ref TEXT");
    }
    _db.exec(`
      UPDATE projects SET system_prompt = context_note
       WHERE system_prompt IS NULL AND context_note IS NOT NULL;
      UPDATE projects
         SET agent_pool_json = json_array(json_object(
           'agentId', default_agent_id,
           'source', 'local',
           'releaseId', NULL,
           'nameSnapshot', COALESCE((SELECT name FROM installed_agents WHERE id = default_agent_id), 'Project agent')
         ))
       WHERE default_agent_id IS NOT NULL AND agent_pool_json = '[]';
    `);
  }

  // v83: automation sessions become first-class owners. The chat row remains
  // an internal invocation ledger and is never projected as a Work task.
  if (userVersion < 83 && tableExists(_db, "chats")) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS automation_sessions (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('host','agent','firm','hub')),
        target_id TEXT NOT NULL,
        ledger_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(automation_id, target_kind, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_automation_sessions_owner
        ON automation_sessions(automation_id, updated_at DESC);
    `);
  }

  // v84: the retired Agent Group product and its chat binding are removed.
  // ProjectAgentPool plus per-task WorkOrder selection own this capability now.
  if (userVersion < 84) {
    if (tableExists(_db, "telegram_bindings")) {
      _db.exec(`
        DELETE FROM chats
         WHERE id IN (SELECT chat_session_id FROM telegram_bindings WHERE target_kind = 'group');
        DELETE FROM telegram_bindings WHERE target_kind = 'group';

        CREATE TABLE telegram_bindings_v84 (
          id TEXT PRIMARY KEY,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('agent','firm')),
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
          updated_at TEXT NOT NULL,
          automation_report_enabled INTEGER NOT NULL DEFAULT 0,
          token_saved INTEGER NOT NULL DEFAULT 0,
          token_fingerprint TEXT
        );
        INSERT INTO telegram_bindings_v84 (
          id, target_kind, target_id, telegram_chat_id, telegram_chat_title,
          bot_user_id, bot_username, bot_display_name, chat_session_id, status,
          enabled, last_update_id, last_error, last_test_at, created_at, updated_at,
          automation_report_enabled, token_saved, token_fingerprint
        )
        SELECT
          id, target_kind, target_id, telegram_chat_id, telegram_chat_title,
          bot_user_id, bot_username, bot_display_name, chat_session_id, status,
          enabled, last_update_id, last_error, last_test_at, created_at, updated_at,
          automation_report_enabled, token_saved, token_fingerprint
        FROM telegram_bindings;
        DROP TABLE telegram_bindings;
        ALTER TABLE telegram_bindings_v84 RENAME TO telegram_bindings;
        CREATE INDEX idx_telegram_bindings_target
          ON telegram_bindings(target_kind, target_id);
        CREATE INDEX idx_telegram_bindings_chat
          ON telegram_bindings(telegram_chat_id);
        CREATE INDEX idx_telegram_bindings_enabled
          ON telegram_bindings(enabled, status);
        CREATE INDEX idx_telegram_bindings_automation_report
          ON telegram_bindings(automation_report_enabled, enabled, telegram_chat_id);
      `);
    }
    if (tableExists(_db, "chats")) {
      const chatColumns = schemaColumns(_db, "chats");
      if (chatColumns.some((column) => column.name === "agent_group_id")) {
        _db.exec("DROP INDEX IF EXISTS idx_chats_agent_group_updated");
        _db.exec("ALTER TABLE chats DROP COLUMN agent_group_id");
      }
    }
    _db.exec("DROP TABLE IF EXISTS agent_groups");
  }

  // v85: persist the project context chosen for an automation. The internal
  // session ledger inherits this binding instead of guessing from global data.
  if (userVersion < 85 && tableExists(_db, "automations")) {
    const columns = schemaColumns(_db, "automations");
    if (!columns.some((column) => column.name === "project_id")) {
      _db.exec("ALTER TABLE automations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
    }
  }

  // v86: persistent chat-hired teams are retired. One remains the sole One
  // controller and Work uses the project's ordered agent pool; additional
  // agents are expressed only by the current turn's structured WorkOrder.
  if (userVersion < 86 && tableExists(_db, "chats")) {
    const columns = schemaColumns(_db, "chats");
    if (columns.some((column) => column.name === "hired_agents")) {
      _db.exec("UPDATE chats SET hired_agents = NULL WHERE hired_agents IS NOT NULL");
    }
  }

  // v94: One이 텔레그램의 단일 창구가 된다. 에이전트별 연결(agent/firm)은 레거시로
  // 남겨 계속 돌지만, 새 연결은 target_kind='one' 하나다. One 바인딩은 부분 유니크
  // 인덱스로 싱글턴을 강제한다 — "One이 둘"은 표현조차 불가능해야 한다.
  // designated_project_id / designated_graph_id 는 텔레그램에서 /project · /graph 로
  // 지정한 대상을 기억한다. graph 쪽에 FK를 걸지 않는 건 의도다: 삭제된 자동화는
  // resolveGraphRef 의 타입 실패(RUN_REQUEST_NOT_FOUND)로 드러나야지, 조용히 NULL이
  // 되어 "지정한 적 없음"처럼 보이면 안 된다.
  if (userVersion < 94 && tableExists(_db, "telegram_bindings")) {
    _db.exec(`
      CREATE TABLE telegram_bindings_v94 (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('agent','firm','one')),
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
        updated_at TEXT NOT NULL,
        automation_report_enabled INTEGER NOT NULL DEFAULT 0,
        token_saved INTEGER NOT NULL DEFAULT 0,
        token_fingerprint TEXT,
        designated_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        designated_graph_id TEXT,
        legacy_notice_at TEXT
      );
      INSERT INTO telegram_bindings_v94 (
        id, target_kind, target_id, telegram_chat_id, telegram_chat_title,
        bot_user_id, bot_username, bot_display_name, chat_session_id, status,
        enabled, last_update_id, last_error, last_test_at, created_at, updated_at,
        automation_report_enabled, token_saved, token_fingerprint
      )
      SELECT
        id, target_kind, target_id, telegram_chat_id, telegram_chat_title,
        bot_user_id, bot_username, bot_display_name, chat_session_id, status,
        enabled, last_update_id, last_error, last_test_at, created_at, updated_at,
        automation_report_enabled, token_saved, token_fingerprint
      FROM telegram_bindings;
      DROP TABLE telegram_bindings;
      ALTER TABLE telegram_bindings_v94 RENAME TO telegram_bindings;
      CREATE INDEX idx_telegram_bindings_target
        ON telegram_bindings(target_kind, target_id);
      CREATE INDEX idx_telegram_bindings_chat
        ON telegram_bindings(telegram_chat_id);
      CREATE INDEX idx_telegram_bindings_enabled
        ON telegram_bindings(enabled, status);
      CREATE INDEX idx_telegram_bindings_automation_report
        ON telegram_bindings(automation_report_enabled, enabled, telegram_chat_id);
      CREATE UNIQUE INDEX idx_telegram_bindings_one_singleton
        ON telegram_bindings(target_kind) WHERE target_kind = 'one';
    `);
  }

  // ── v86 → v87: 노드 승인 브레이크 ──────────────────────────────────────
  // 사람이 "이건 나가도 된다"고 누른 사실은 durable해야 한다. 메모리에만 있으면
  // 앱을 껐다 켜는 순간 승인이 사라져 자동화가 영원히 같은 자리에서 멈춘다.
  // occurrence 단위로 기록해, 승인 하나가 다음 실행까지 조용히 재사용되지 않게 한다
  // (매번 승인 vs 첫 1회만 승인은 노드 설정이 정한다).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS automation_node_approvals (
      automation_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      node_id       TEXT NOT NULL,
      decision      TEXT NOT NULL,
      decided_at    TEXT NOT NULL,
      decided_by    TEXT NOT NULL,
      PRIMARY KEY (automation_id, occurrence_id, node_id)
    )
  `);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_automation_node_approvals_node ON automation_node_approvals(automation_id, node_id, decided_at)",
  );
  // ★판정 교정 — 사람이 "이 판정은 틀렸다"고 한 기록. 그 노드의 이후 판정에 few-shot으로
  //   주입된다(5건이면 유의미하다는 실측 — 사람의 채점 감각이 그래프에 쌓이는 자리).
  //   교정은 그래프(digest 봉인)가 아니라 여기 실행 밖 기록에 산다 — 항상허용과 같은 이유.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS automation_eval_corrections (
      automation_id  TEXT NOT NULL,
      node_id        TEXT NOT NULL,
      subject_preview TEXT NOT NULL,
      corrected_verdict TEXT NOT NULL,
      note           TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      PRIMARY KEY (automation_id, node_id, created_at)
    )
  `);
  // ★"항상 허용"은 **그래프가 아니라 승인 기록에** 남는다.
  //   노드 config의 approval을 ask_once로 바꾸면 graph_json이 달라져 graphDigest가 바뀌고,
  //   바로 그 순간 멈춰 있던 실행의 재개가 거부된다 — 항상 허용을 누른 사람이 그 실행을
  //   잇지 못하는 모양이 된다. 그래서 결정은 그래프 밖에 둔다(additive 컬럼).
  {
    const approvalCols = _db.prepare("PRAGMA table_info(automation_node_approvals)").all() as Array<{ name: string }>;
    if (!approvalCols.some((c) => c.name === "scope")) {
      _db.exec("ALTER TABLE automation_node_approvals ADD COLUMN scope TEXT NOT NULL DEFAULT 'once'");
    }
  }
  // 실패 3요소(코드·사유 원문·지금 누를 행동)를 실행에 함께 남긴다. 예전에는 노드 상태가
  // "failed" 한 단어뿐이라, 화면이 왜 멈췄는지도 무엇을 누르면 되는지도 말할 수 없었다.
  if (tableExists(_db, "automation_runs")) {
    const runColumns = schemaColumns(_db, "automation_runs");
    if (!runColumns.some((column) => column.name === "node_failures_json")) {
      _db.exec("ALTER TABLE automation_runs ADD COLUMN node_failures_json TEXT");
    }
    // 재개 좌표는 한 번만 소비돼야 한다. 같은 체크포인트에서 두 번 재개하면 이미 끝난
    // 단계가 두 번 실행될 수 있다 — 소비 표식을 조건부 UPDATE로 걸어 한쪽만 이기게 한다.
    if (!runColumns.some((column) => column.name === "resume_consumed_at")) {
      _db.exec("ALTER TABLE automation_runs ADD COLUMN resume_consumed_at TEXT");
    }

  }

  // 실행 저널 — 노드 하나가 지나간 자리를 append-only로 남긴다.
  // 체크포인트는 "지금 상태" 하나만 덮어쓰므로, 무엇이 어떤 순서로 일어났는지는 사라진다.
  // 특히 "실행 의도는 기록됐는데 정산이 없다"는 부분 실패 신호는 순서가 있어야만 읽힌다.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS graph_run_journal (
      run_id   TEXT NOT NULL,
      seq      INTEGER NOT NULL,
      ts       TEXT NOT NULL,
      kind     TEXT NOT NULL,
      node_id  TEXT,
      payload_json TEXT,
      PRIMARY KEY (run_id, seq)
    )
  `);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_graph_run_journal_run ON graph_run_journal(run_id, seq)",
  );

  // ★그래프 판 이력 — 저장할 때마다 **직전 판**을 여기 남긴다.
  // 지금까지 저장은 덮어쓰기뿐이라, 말로 고치다 한 번 잘못 저장하면 잘 돌던 그래프가
  // 되돌릴 방법 없이 사라졌다(실측: 캔버스가 반복 상한을 버려 열었다 저장만 해도 죽었다).
  // 실행 저널과 달리 이건 **저작** 이력이다 — 무엇이 언제 바뀌었나가 아니라, 어디로
  // 돌아갈 수 있나를 위해 있다.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS automation_graph_versions (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      saved_at      TEXT NOT NULL,
      note          TEXT,
      node_count    INTEGER NOT NULL DEFAULT 0,
      graph_json    TEXT NOT NULL
    )
  `);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_automation_graph_versions ON automation_graph_versions(automation_id, saved_at DESC)",
  );

  // v88: 입력 트리거 그래프가 사람에게 받은 값이 앉는 자리.
  // 이전에는 이 자리가 없어서, 터미널이 값을 물어보고도 버렸고(사용자에겐 전달된 것처럼 보였다)
  // 데스크탑 "지금 실행"은 아예 묻지 않았다. 그러면 {{topic}} 같은 구멍이 빈 문자열로 메꿔진 채
  // 실행돼, 주제 없이 지어낸 결과가 정상 완료로 기록된다.
  // 한 번만 쓰이도록 소비 표식을 조건부 UPDATE로 건다(재개 좌표와 같은 규율).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS automation_run_inputs (
      id            TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      requested_by  TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      consumed_at   TEXT,
      consumed_run_id TEXT
    )
  `);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_automation_run_inputs_pending "
    + "ON automation_run_inputs(automation_id, consumed_at, created_at)",
  );

  // v89: 실행 기록의 두 답을 두 칸으로 가른다.
  //
  // 지금까지 `status` 한 칸이 서로 다른 두 질문의 답을 번갈아 담았다:
  //   · 커널의 답 — 그래프가 끝까지 돌았는가 (ok/partial/error/skipped)
  //   · 판정의 답 — 나온 결과물이 쓸 만한가 (needs_input/blocked/…)
  // 스케줄러가 커널의 답을 판정 결과로 **덮어써서**, 끝까지 잘 돈 실행이 화면에는
  // "내 확인 필요"로만 보였다. 사용자는 성공인지 실패인지 알 수 없었다.
  //
  // ★옛 행은 고치지 않는다. `needs_input`/`blocked`는 성공 경로와 실패 경로 **양쪽**에서
  //   나올 수 있어서(classifyAutomationOutcome / classifyAutomationFailure 둘 다 그 값을
  //   낼 수 있다) 지금 와서 어느 쪽이었는지 복원할 방법이 없다. 지어내지 않고 NULL로 둔다 —
  //   화면은 NULL을 "옛 기록이라 두 답이 섞여 있음"으로 읽는다.
  if (tableExists(_db, "run_history")) {
    const columns = schemaColumns(_db, "run_history").map((column) => column.name);
    if (!columns.includes("outcome")) {
      _db.exec("ALTER TABLE run_history ADD COLUMN outcome TEXT");
    }
    if (!columns.includes("outcome_reason")) {
      _db.exec("ALTER TABLE run_history ADD COLUMN outcome_reason TEXT");
    }
  }

  // v90: 승인을 **언제부터** 기다렸는가 (커넥터 C43).
  //
  // 승인이 없으면 실행이 그 자리에서 끝나고, 다음 예약이 **새 occurrence**로 다시 물어본다.
  // 그래서 "3일째 기다리는 중"이라는 사실이 실행 안에는 없다 — 매번 처음 묻는 것처럼 보인다.
  // 그 사실을 실행 밖에 남겨야 그래프가 "안 오면 이쪽으로"를 표현할 수 있다.
  //
  // Dify Human Input은 전용 타임아웃 분기를 갖고(기본 3일, 안 이으면 워크플로 종료),
  // Airflow HITL은 response_timeout + defaults로 자동 해소한다. 우리는 만료 시 운영자
  // 알림뿐이라 그래프가 만료를 처리할 방법이 없었다.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS automation_approval_waits (
      automation_id      TEXT NOT NULL,
      node_id            TEXT NOT NULL,
      first_requested_at TEXT NOT NULL,
      PRIMARY KEY (automation_id, node_id)
    )
  `);

  // v91: 명령 트리거가 대기열에 앉을 자리 (커넥터 C47·C48).
  //
  // 오너의 트리거 분류는 셋이다 — 예약(결정론)·명령·입력. 그런데 대기열은 소스가 밀어
  // 넣는 넷(fs/chain/webhook/poll)만 받게 못 박혀 있어서, 코드나 다른 에이전트가 보낸
  // "이 그래프 돌려줘"가 앉을 자리가 없었다. 자리가 없으면 바깥 표면은 둘 중 하나를 한다:
  // 자기 프로세스에서 직접 돌리거나(같은 자동화가 두 곳에서 동시에 돈다), 다른 종류인 척
  // webhook으로 적거나(어디서 온 요청인지 영원히 알 수 없게 된다). 둘 다 사고다.
  //
  // CHECK 제약은 고칠 수 없으므로 표준 재작성(새 표 → 복사 → 교체)으로 넓힌다.
  // 기존 행은 종류·클레임 상태까지 그대로 옮긴다 — 대기 중인 배달을 잃으면 안 된다.
  if (tableExists(_db, "automation_trigger_events")) {
    const ddl = (_db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='automation_trigger_events'",
    ).get() as { sql?: string } | undefined)?.sql ?? "";
    if (!ddl.includes("'command'")) {
      const columns = schemaColumns(_db, "automation_trigger_events").map((column) => column.name);
      const columnList = columns.join(", ");
      const rebuild = _db.transaction(() => {
        _db!.exec(`ALTER TABLE automation_trigger_events RENAME TO automation_trigger_events_v90`);
        _db!.exec(ddl
          .replace(
            "CHECK(trigger_kind IN ('fs','chain','webhook','poll'))",
            "CHECK(trigger_kind IN ('fs','chain','webhook','poll','command'))",
          ));
        _db!.exec(
          `INSERT INTO automation_trigger_events (${columnList}) `
          + `SELECT ${columnList} FROM automation_trigger_events_v90`,
        );
        _db!.exec("DROP TABLE automation_trigger_events_v90");
      });
      rebuild();
      // 인덱스는 옛 표와 함께 사라졌다. v70이 만든 것과 **같은 이름·같은 정의**로 되살린다 —
      // 이름이 달라지면 다음 마이그레이션의 IF NOT EXISTS가 중복 인덱스를 만든다.
      _db.exec(`
        CREATE INDEX IF NOT EXISTS idx_automation_trigger_events_due
          ON automation_trigger_events(status, next_attempt_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_automation_trigger_events_automation
          ON automation_trigger_events(automation_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_automation_trigger_events_run
          ON automation_trigger_events(run_id) WHERE run_id IS NOT NULL;
      `);
    }
  }

  // v92: One과 Work의 실행 신원을 분리한다.
  //
  // 프로젝트 task는 프로젝트가 작업 주체이고 built-in orchestrator가 컨트롤러다.
  // One 대화는 반대로 owner-bound One 신원이 컨트롤러다. 과거에는 두 표면 모두
  // 임의 agent_id/firm_id를 받을 수 있어 상태줄뿐 아니라 실제 시스템 프롬프트·기억
  // 귀속·provider resume 세션까지 겹쳤다. 표시 문구만 바꾸지 않고 양쪽 원장을
  // 정규화하고, 신원이 바뀐 CLI resume 포인터도 함께 폐기한다.
  // This is a migration, not a startup reconciler. Re-running it on every
  // launch rewrites newly created direct One-teammate channels back to the One
  // root before the renderer can reopen them.
  if (userVersion < 92 && tableExists(_db, "chats") && tableExists(_db, "installed_agents")) {
    const db = _db;
    const chatColumns = new Set(schemaColumns(db, "chats").map((column) => column.name));
    const canRepairSurfaceIdentity = chatColumns.has("origin_surface")
      && chatColumns.has("project_id")
      && chatColumns.has("firm_id")
      && chatColumns.has("kind");
    if (canRepairSurfaceIdentity) {
      db.transaction(() => {
        if (tableExists(db, "chat_runtime_sessions")) {
          db.exec(`
            DELETE FROM chat_runtime_sessions
             WHERE chat_id IN (
               SELECT c.id
                 FROM chats c
                WHERE COALESCE(c.kind, 'user') = 'user'
                  AND (
                    (c.origin_surface = 'work' AND c.project_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM installed_agents WHERE slug = 'agentlas-orchestrator') AND (
                      c.agent_id NOT IN (SELECT id FROM installed_agents WHERE slug = 'agentlas-orchestrator')
                      OR c.firm_id IS NOT NULL
                    ))
                    OR
                    (c.origin_surface = 'one'
                      AND EXISTS (SELECT 1 FROM installed_agents WHERE slug = 'agentlas-one') AND (
                      c.agent_id NOT IN (SELECT id FROM installed_agents WHERE slug = 'agentlas-one')
                      OR c.firm_id IS NOT NULL
                    ))
                  )
             )
          `);
        }
        db.exec(`
          UPDATE chats
             SET agent_id = (SELECT id FROM installed_agents WHERE slug = 'agentlas-orchestrator' LIMIT 1),
                 firm_id = NULL
           WHERE origin_surface = 'work'
             AND project_id IS NOT NULL
             AND COALESCE(kind, 'user') = 'user'
             AND EXISTS (SELECT 1 FROM installed_agents WHERE slug = 'agentlas-orchestrator');

          UPDATE chats
             SET agent_id = (SELECT id FROM installed_agents WHERE slug = 'agentlas-one' LIMIT 1),
                 firm_id = NULL
           WHERE origin_surface = 'one'
             AND COALESCE(kind, 'user') = 'user'
             AND EXISTS (SELECT 1 FROM installed_agents WHERE slug = 'agentlas-one');
        `);
      })();
    }
  }

  // v93: run_events를 chat_id로 읽는 핫패스 인덱스.
  //
  // getLatestInvocationRunReceipt류(run-events.ts)가 폴링 틱마다 chat_id 조건으로
  // 최신 invoke_started 행을 찾는데, run_events에는 chat_id 인덱스가 없어 부팅
  // 이후 계속 자라는 원장 전체를 매번 훑었다(태스크 40개 × 5초 틱 = 틱당 풀스캔
  // 40회). IF NOT EXISTS 라 매 부팅 무해하고, 칸이 없는 옛 스키마에서는 건너뛴다.
  if (tableExists(_db, "run_events")) {
    const runEventColumns = new Set(schemaColumns(_db, "run_events").map((column) => column.name));
    if (["chat_id", "kind", "ts"].every((column) => runEventColumns.has(column))) {
      _db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_events_chat_kind_ts
          ON run_events(chat_id, kind, ts DESC);
      `);
    }
  }

  // Codex `exec resume` reports a session-cumulative output counter. Persist
  // the last raw value alongside the runtime session so One can display this
  // turn's delta instead of presenting the whole conversation as one turn.
  if (tableExists(_db, "chat_runtime_sessions")) {
    const runtimeSessionColumns = new Set(schemaColumns(_db, "chat_runtime_sessions").map((column) => column.name));
    if (!runtimeSessionColumns.has("reported_output_tokens")) {
      _db.exec("ALTER TABLE chat_runtime_sessions ADD COLUMN reported_output_tokens INTEGER");
    }
    // 같은 이유로 입력 쪽 카운터도 필요하다: `turn.completed.usage` 는 세 칸이 한 구조체라
    // 입력도 스레드 누적이다. 출력만 보정하고 입력을 날것으로 실으면, 영수증의 usage 가
    // 이 턴이 아니라 대화 전체를 이번 실행 비용으로 보고한다.
    if (!runtimeSessionColumns.has("reported_input_tokens")) {
      _db.exec("ALTER TABLE chat_runtime_sessions ADD COLUMN reported_input_tokens INTEGER");
    }
    if (!runtimeSessionColumns.has("reported_cached_input_tokens")) {
      _db.exec("ALTER TABLE chat_runtime_sessions ADD COLUMN reported_cached_input_tokens INTEGER");
    }
  }

  // v94: Goal's objective and engineering acceptance contract are Desktop
  // state, not an optional projection of an external engine database. The
  // row is append/terminal-only: ordinary chat and steering have no update
  // path, and a conditional first-definition write freezes the objective.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chat_goal_contracts (
      goal_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      objective TEXT,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','blocked','completed','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_goal_contracts_active_chat
      ON chat_goal_contracts(chat_id)
      WHERE status = 'active';
  `);

  // v95: user-sent screenshots belong to the durable conversation, not to a
  // renderer blob URL. Only bounded, Main-validated image bytes are stored;
  // the renderer receives opaque agentlas://chat-attachment capabilities.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chat_message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
      sha256 TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_message
      ON chat_message_attachments(message_id, created_at, id);
  `);

  /*
   * ★사다리 뒤 백스톱 — **버전과 무관하게** 있어야 할 칸이 있는지 매 부팅 확인한다.
   *
   * 배경(실측 2026-08-06): `automations.goal`이 `userVersion < 33` 블록 안에 추가돼
   * 있었다. 새 DB는 0에서 시작하니 33을 밟아 칸이 생기고 게이트도 통과했지만,
   * **이미 33을 지난 기존 설치는 그 블록을 영원히 건너뛴다.** 결과: 저장이
   * "no such column: goal"로 죽었는데, 그 예외가 INSERT **뒤에** 나는 바람에
   * 자동화는 켜진 채 남고 화면에는 "저장하지 못했습니다"가 떴다.
   *
   * 이 병은 사다리 규율만으로는 반복된다 — 새 칸을 옛 단계에 끼워 넣는 것은
   * 리뷰에서 눈으로 잡아야 하는 종류의 실수다. 그래서 선언한 칸을 매번 대조한다.
   * 이미 있으면 아무 일도 하지 않으므로 부팅 비용은 PRAGMA 몇 번뿐이다.
   */
  const REQUIRED_COLUMNS: Record<string, Array<[string, string]>> = {
    /*
     * ★persistent-goal 루프의 조인 축 (2026-08-10).
     *
     * goal_id는 세 조각(goalMode 칩 · workforce goal_binding · Stormbreaker
     * 연속실행)을 잇는 단 하나의 축이다. chats.goal_id = 이 채팅이 추진 중인
     * 목표(NULL=목표 없음, 칩 OFF), automations.goal_id = 이 자동화가 어느
     * 목표의 연속실행인가(마커 문자열 검색 대신 1급 컬럼). 원장 자체는
     * ~/.agentlas/networking/workforce-goals.sqlite3 (goal_ledger 테이블)에 산다.
     */
    chats: [["goal_id", "goal_id TEXT"]],
    automations: [
      ["goal", "goal TEXT"],
      ["goal_id", "goal_id TEXT"],
      /*
       * 확인 요구를 "여기까지 다 봤다"고 닫은 시각.
       *
       * ★막다른 길을 없애기 위한 칸이다(2026-08-09). 확인 카드는 두 가지 근거로 뜬다:
       * run_history 의 미해소 행, 그리고 **마지막 실행 스냅샷의 error**. 예전 닫기는
       * 앞의 것만 닫을 수 있어서, 스냅샷으로 떠 있는 카드는 눌러도 그대로였다 —
       * 사용자에게는 끌 수 없는 카드가 남는다. 이 시각 이전에 시작된 실행의 요구는
       * 종류와 무관하게 닫힌 것으로 본다. 기록 자체는 지우지 않는다(감사 가능).
       */
      ["attention_cleared_at", "attention_cleared_at TEXT"],
    ],
    // 확인필요 카드의 "해소" 기록 — 기록 자체는 지우지 않고(감사 가능), "지금
    // 조치하라"는 요구만 닫는다. 사용자가 닫기 전에는 NULL.
    run_history: [["acknowledged_at", "acknowledged_at TEXT"]],
    /*
     * ★2축 좌표 — 경험이 부품 교체에 살아남게 하는 자리 (SL-02).
     *
     * 오늘 경험 조회는 `base_package_hash` 정확 일치다(experience/store.ts
     * ensureAutoExperiencePack). 그 해시는 패키지 **전체**를 덮으므로, 스킬 같은
     * 부품을 하나 붙이는 순간 값이 바뀌고 조회가 어긋나 **쌓인 경험이 조용히 사라진다**.
     * 에러도 경고도 없이 새 팩이 하나 더 생길 뿐이라 사용자는 알 수 없다.
     *
     * 그래서 좌표를 둘로 나눈다:
     *   base_core_hash   몸통(코어)만의 해시 — 신원. 부품을 붙여도 안 변한다.
     *   module_set_hash  붙인 부품 목록의 해시 — 실행 무결성.
     * 조회를 몸통 축으로 옮기면 부품 교체가 경험을 끊지 못한다.
     *
     * axis_version 은 그 이행을 **관찰 가능하게** 만드는 장치다. 2 = 옛 한 축 기록,
     * 3 = 두 축을 갖춘 기록. 좌표계를 실제로 바꾸기 전에 `axis_version < 3` 이
     * 0인지 세면, 순서를 지켰는지를 문장이 아니라 숫자로 확인할 수 있다.
     *
     * 이 칸들을 사다리 단계가 아니라 버전 무관 백스톱에 두는 이유: 새 칸을 이미
     * 지나간 단계에 끼워 넣으면 그 단계를 지난 기존 설치에는 영원히 안 생긴다
     * (바로 위 주석의 automations.goal 사고). 새 설치는 아래 CREATE TABLE이,
     * 기존 설치는 이 백스톱이 책임진다.
     */
    experience_packs: [
      ["axis_version", "axis_version INTEGER NOT NULL DEFAULT 2"],
      ["base_core_hash", "base_core_hash TEXT"],
      ["module_set_hash", "module_set_hash TEXT"],
    ],
    experience_candidates: [
      ["axis_version", "axis_version INTEGER NOT NULL DEFAULT 2"],
      ["base_core_hash", "base_core_hash TEXT"],
      ["module_set_hash", "module_set_hash TEXT"],
    ],
    // Durable tool consent identity columns are additive: existing global,
    // agent, and chat grants remain legacy rows instead of being rewritten or
    // silently widened. New exact rows set binding_version=1 and all fields.
    capability_grants: [
      ["binding_version", "binding_version INTEGER NOT NULL DEFAULT 0"],
      ["user_identity", "user_identity TEXT"],
      ["workspace_identity", "workspace_identity TEXT"],
      ["requester_identity", "requester_identity TEXT"],
      ["resource_identity", "resource_identity TEXT"],
      ["permission_scope", "permission_scope TEXT"],
      ["tool_identity", "tool_identity TEXT"],
    ],
  };
  /*
   * ★잔존 금지 트리거 — 버전 무관으로 매 부팅 제거한다.
   *
   * 실측(2026-08-06): 터미널 bootstrap-schema.sql이 심은 agentlas_auto_cua_social_*
   * 트리거가 소셜 키워드 목록("twitter/인스타/댓글/게시/로그인"…)으로 tool_mode를
   * computer-use로 강제 되돌리고 있었다 — 코드의 단어목록 판정을 LLM 판정으로 대체할 때
   * 이 DB 트리거만 살아남아, 코드 리뷰가 볼 수 없는 곳에서 toolMode 도출 규칙(P2)을
   * 무효화했다(UPDATE tool_mode='auto'가 같은 연결에서 즉시 되돌아왔다). 판정은
   * 코드·게이트가 보는 곳에만 산다 — DB 트리거로 만들지 않는다.
   */
  for (const legacyTrigger of ["agentlas_auto_cua_social_insert", "agentlas_auto_cua_social_update"]) {
    _db.exec(`DROP TRIGGER IF EXISTS ${legacyTrigger}`);
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tableExists(_db, table)) continue;
    const present = new Set(
      (_db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [name, ddl] of columns) {
      if (!present.has(name)) _db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
  if (tableExists(_db, "capability_grants")) {
    const grantColumns = new Set(schemaColumns(_db, "capability_grants").map((column) => column.name));
    if ([
      "binding_version",
      "user_identity",
      "workspace_identity",
      "requester_identity",
      "resource_identity",
      "permission_scope",
    ].every((column) => grantColumns.has(column))) {
      _db.exec(`
        CREATE INDEX IF NOT EXISTS idx_capability_grants_exact_binding
          ON capability_grants(
            binding_version, user_identity, workspace_identity,
            requester_identity, resource_identity, permission_scope
          );
      `);
    }
  }

  /*
   * ★경험 레코드 v3 승격 — 부품을 붙이기 전에 몸통 축을 먼저 심는다 (SL-02).
   *
   * 오늘은 부품이 아직 없으므로 패키지 전체 = 몸통이다. 그래서 몸통 축의 올바른
   * 초기값은 지금의 base_package_hash 그 자체이고, 부품 목록은 비어 있다.
   * 지금 심어 두면, 나중에 조회를 몸통 축으로 옮길 때 옮길 값이 이미 자리에 있다.
   * 반대 순서로 하면 — 좌표계를 먼저 바꾸면 — 그 순간 조회가 어긋나 쌓인 경험이
   * 조용히 사라진다. 이 블록이 그 순서를 강제한다.
   *
   * 승격은 재실행 가능하고, 실패한 레코드를 삭제하지 않는다. 몸통 축을 정할 수 없는
   * 레코드(base_package_hash가 비었다)는 axis_version 2로 남겨 두고, 아래 카운터가
   * 그 수를 드러낸다. 0이 아니면 좌표계 전환을 착수해서는 안 된다 —
   * 조용히 버리는 것보다 세는 편이 낫다.
   */
  /*
   * ★쓸 것이 있을 때만 쓴다.
   *
   * 이 블록은 매 부팅마다 지나간다. 조건 없이 UPDATE를 던지면 맞는 행이 0건이어도
   * SQLite는 쓰기 잠금을 잡으려 하고, 다른 프로세스가 WAL 쓰기 중이면 부팅이
   * "database is locked"로 죽는다 — 마이그레이션 한 줄이 앱을 못 켜게 만든다
   * (test:v52-automation-run-recovery가 정확히 이 상황을 재현한다).
   * 읽기는 WAL에서 쓰기 잠금과 경합하지 않으므로, 먼저 세고 필요할 때만 쓴다.
   */
  const dbForPromotion = _db;
  const pendingPromotion = (table: string, extraWhere: string): number => {
    if (!tableExists(dbForPromotion, table)) return 0;
    const columns = new Set(schemaColumns(dbForPromotion, table).map((column) => column.name));
    if (!columns.has("axis_version")) return 0;
    const row = dbForPromotion
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE axis_version < 3 ${extraWhere}`)
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };

  if (pendingPromotion("experience_packs", "AND base_package_hash IS NOT NULL AND base_package_hash != ''") > 0) {
    _db.exec(`
      UPDATE experience_packs
         SET base_core_hash = base_package_hash,
             module_set_hash = COALESCE(module_set_hash, ''),
             axis_version = 3
       WHERE axis_version < 3 AND base_package_hash IS NOT NULL AND base_package_hash != ''`);
  }
  if (pendingPromotion("experience_candidates", "") > 0) {
    const candidateColumns = new Set(schemaColumns(_db, "experience_candidates").map((column) => column.name));
    if (candidateColumns.has("base_package_hash")) {
      _db.exec(`
        UPDATE experience_candidates
           SET base_core_hash = base_package_hash,
               module_set_hash = COALESCE(module_set_hash, ''),
               axis_version = 3
         WHERE axis_version < 3 AND base_package_hash IS NOT NULL AND base_package_hash != ''`);
    } else {
      // 후보는 팩을 통해 몸통 축을 물려받는다. 자기 칸이 없는 스키마에서는 팩과 조인한다.
      _db.exec(`
        UPDATE experience_candidates
           SET base_core_hash = (SELECT p.base_core_hash FROM experience_packs p WHERE p.id = experience_candidates.pack_id),
               module_set_hash = COALESCE(module_set_hash, ''),
               axis_version = 3
         WHERE axis_version < 3
           AND (SELECT p.base_core_hash FROM experience_packs p WHERE p.id = experience_candidates.pack_id) IS NOT NULL`);
    }
  }
  // 몸통 축 인덱스는 칸이 확실히 존재하는 여기서 만든다. 위쪽 CREATE TABLE 블록에 두면
  // 기존 설치에는 아직 칸이 없어 새 설치에만 생긴다 — "새 DB만 초록"이 되는 자리다.
  if (tableExists(_db, "experience_packs")) {
    // `CREATE INDEX IF NOT EXISTS`도 쓰기 잠금을 잡는다. 이미 있으면 읽기로 확인하고 건너뛴다
    // (위 승격 블록과 같은 이유 — 부팅이 남의 WAL 쓰기에 막히면 안 된다).
    const indexPresent = _db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_experience_packs_core_axis'")
      .get();
    const hasCoreAxis = schemaColumns(_db, "experience_packs").some((column) => column.name === "base_core_hash");
    if (!indexPresent && hasCoreAxis) {
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_experience_packs_core_axis
                  ON experience_packs(agent_id, project_scope_key, environment_key, base_core_hash)`);
    }
  }

  // ★판정 영수증 영속 — 세션 메모리 LRU 하나뿐이라 앱을 껐다 켜면 같은 질문을 모델에게
  //   처음부터 다시 물었다(실측: 대화 한 턴에 판정 2회, 재시작 시 전부 미스).
  //   판정은 같은 입력에 같은 답이어야 하므로 캐시가 아니라 **기록**이다.
  //   사다리 중간이 아니라 끝에 둔다 — 이미 지나간 단계에 끼우면 기존 설치가 못 받는다.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS judgment_verdicts (
      kind          TEXT NOT NULL,
      signature     TEXT NOT NULL,
      verdict       TEXT NOT NULL,
      confidence    REAL NOT NULL DEFAULT 0,
      reason        TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      last_hit_at   TEXT NOT NULL,
      hits          INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, signature)
    )
  `);
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_judgment_verdicts_recency ON judgment_verdicts(last_hit_at)",
  );

  /*
   * v96 — 에이전트 아키텍처 마이그레이션 원장.
   *
   * 업데이트는 새 아키텍처를 가져오지만, 이미 등록된 에이전트는 옛 상태로 남는다. 그래서
   * "이 에이전트에게 이 단계를 적용했는가"를 (에이전트 × 단계)로 기록한다. 새 버전이 단계를
   * 하나 추가하면 그 단계는 기존에 등록된 **모든** 에이전트에게 자동으로 한 번씩 돈다.
   *
   * 원장에 남는 것은 결과이지 내용이 아니다 — 무엇을 몇 건 바꿨는지와 사유 코드만.
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agent_architecture_migrations (
      agent_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      architecture_version TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('applied','noop','failed')),
      changed INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_architecture_migrations_step
      ON agent_architecture_migrations(step_id, outcome);
  `);

  /*
   * v97 — 프로젝트별 Hub 에이전트 렌트 허용(작업당 과금 자동 고용 동의).
   *
   * 오너 결정 2026-08-18: 24시간 자동 리스 폐지. RENT는 작업(work order)당 과금이고,
   * 이 표는 "이 프로젝트에서 이 Hub 에이전트를 고지 없이 작업당 자동 고용해도 된다"는
   * 사용자의 명시적 허용을 (projectId × slug)로 기록한다. 행이 없으면 기본 OFF —
   * 그 에이전트는 이 프로젝트의 네트워크 자동 고용 후보에서 제외된다.
   * 사다리 끝에 append — 이미 지나간 단계에 끼우면 기존 설치가 못 받는다.
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS project_agent_rent_allow (
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, slug)
    );
  `);

  /*
   * v98 — 통합 능력 승인(capability grants). 오너 결정 2026-08-20:
   * 에이전트 능력을 정적 권한으로 제한하지 않는다. 행동 시점에 칩으로 묻고,
   * "항상 허용"은 여기 영구 기록되어 다시는 묻지 않는다.
   *
   * capability — 능력 클래스(execute|edit|delete|network|other), 도구 규칙(tool:<name>),
   *              또는 '*'(그 스코프의 모든 승인 채널 통과 — 기존 대화 단위 "항상 승인"의 이관처).
   * pattern/scope — 레거시 행은 선택적 인자 프리픽스와 global/agent/chat 의미를 유지한다.
   *                 binding_version=1 행은 Main이 만든 exact consent digest scope를 쓴다.
   *                 user/workspace/requester/resource/permission 칸이 모두 맞아야 매치된다.
   *                 새 행은 토큰 wildcard를 만들지 않는다.
   * 레거시 우선순위는 구체성 chat > agent > global, 같은 스코프 deny > allow.
   * 결제·브라우저 위험코드는 이 표로 뚫리지 않는다(각 채널이 매번 확인 — 기존 예외 유지).
   * 사다리 끝 append — 이미 지나간 단계에 끼우면 기존 설치가 못 받는다.
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS capability_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT NOT NULL,
      pattern TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
      scope TEXT NOT NULL DEFAULT 'global',
      source TEXT NOT NULL DEFAULT 'chip',
      created_at TEXT NOT NULL,
      -- v1 exact durable-consent binding. Legacy rows stay NULL/0 and keep
      -- their historical scope semantics; new allow-always rows must carry
      -- every identity component so an old grant cannot broaden a new one.
      binding_version INTEGER NOT NULL DEFAULT 0,
      user_identity TEXT,
      workspace_identity TEXT,
      requester_identity TEXT,
      resource_identity TEXT,
      permission_scope TEXT CHECK(permission_scope IS NULL OR permission_scope IN ('read','write','full')),
      tool_identity TEXT,
      UNIQUE(capability, pattern, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_capability_grants_scope ON capability_grants(scope);
    CREATE INDEX IF NOT EXISTS idx_capability_grants_exact_binding
      ON capability_grants(
        binding_version, user_identity, workspace_identity,
        requester_identity, resource_identity, permission_scope
      );
  `);

  /*
   * v99 — One Team durable organisation bindings.
   *
   * This is deliberately separate from Work's firm/org-spec tables.  A One
   * row is a user-facing lease/identity binding; Work tasks still own the
   * execution participants and receipts.  installed_agent_id + revision make
   * replacement and stale renderer writes explicit instead of silently
   * changing somebody else's row.
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS one_org_members (
      id TEXT PRIMARY KEY,
      agent_slug TEXT NOT NULL,
      installed_agent_id TEXT NOT NULL,
      display_name TEXT,
      icon TEXT NOT NULL DEFAULT 'one-puppy',
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL CHECK(source IN ('local','cloud','hub')),
      lease_expires_at TEXT,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      status_kind TEXT NOT NULL DEFAULT 'new',
      -- PRD §4.33 — 스키마에 사람이 읽는 문구(그것도 한 언어)를 박지 않는다.
      -- 빈 값이면 투영이 로케일 표에서 "아직 맡은 일 없음 / No work assigned yet"을 만든다.
      status_line TEXT NOT NULL DEFAULT '',
      last_activity_at TEXT,
      pending_count INTEGER NOT NULL DEFAULT 0,
      pending_kind TEXT NOT NULL DEFAULT 'approval' CHECK(pending_kind IN ('approval','review','input')),
      unread_count INTEGER NOT NULL DEFAULT 0,
      unread_generation INTEGER NOT NULL DEFAULT 0,
      credit_state TEXT NOT NULL DEFAULT 'unknown' CHECK(credit_state IN ('ok','insufficient','unknown')),
      auto_select_tools INTEGER NOT NULL DEFAULT 1 CHECK(auto_select_tools IN (0,1)),
      collaboration_style TEXT NOT NULL DEFAULT 'default' CHECK(collaboration_style IN ('default','concise','warm','direct')),
      handover_note TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS one_org_completion_cache (
      installed_agent_id TEXT PRIMARY KEY,
      run_id TEXT,
      summary_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS one_taskforces (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      member_agent_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_one_org_members_order
      ON one_org_members(archived_at, sort_order, added_at);
    CREATE INDEX IF NOT EXISTS idx_one_org_members_agent
      ON one_org_members(installed_agent_id);
    CREATE INDEX IF NOT EXISTS idx_one_taskforces_updated
      ON one_taskforces(updated_at DESC);
  `);
  // v99 was already shipped before the pending-kind/cache columns existed.
  // Keep the schema version stable while making the append-only table upgrade
  // safe for existing stores (SQLite has no IF NOT EXISTS for ADD COLUMN).
  // pending_kind 의 CHECK 는 ALTER 로 붙일 수 없다(SQLite 제약). 새 설치와 업그레이드 설치의
  // 제약이 갈리므로, 값의 정당성은 쓰기 경로(setOneOrgMemberStatus)가 함께 지킨다.
  addColumnIfMissing(_db, "one_org_members", "pending_kind", "pending_kind TEXT NOT NULL DEFAULT 'approval'");
  addColumnIfMissing(_db, "one_org_members", "auto_select_tools", "auto_select_tools INTEGER NOT NULL DEFAULT 1 CHECK(auto_select_tools IN (0,1))");
  addColumnIfMissing(_db, "one_org_members", "collaboration_style", "collaboration_style TEXT NOT NULL DEFAULT 'default' CHECK(collaboration_style IN ('default','concise','warm','direct'))");
  addColumnIfMissing(_db, "one_org_members", "handover_note", "handover_note TEXT");
  addColumnIfMissing(_db, "one_org_members", "unread_generation", "unread_generation INTEGER NOT NULL DEFAULT 0");
  _db.prepare(
    "UPDATE one_org_members SET unread_generation = 1 WHERE unread_count > 0 AND unread_generation = 0",
  ).run();
  addColumnIfMissing(_db, "one_taskforces", "description", "description TEXT NOT NULL DEFAULT ''");

  // v105 — exact queued steering survives renderer/app restarts. The request
  // stays in the private local store; hashes and run bindings are queryable
  // without parsing user text.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS invocation_steers (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      original_run_id TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      workspace_binding_json TEXT,
      execution_context_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','draining','started','cancelled','failed')),
      drained_run_id TEXT,
      queued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invocation_steers_queue
      ON invocation_steers(status, queued_at, id);
    CREATE INDEX IF NOT EXISTS idx_invocation_steers_chat
      ON invocation_steers(chat_id, queued_at, id);

    -- Prompt Store creates the durable chat before the renderer can navigate.
    -- The stable renderer intent makes an IPC response loss replay the exact
    -- same chat instead of creating a second empty conversation. This table is
    -- intentionally not cascaded when a chat is deleted: an old pending intent
    -- must fail closed rather than silently manufacture a replacement chat.
    CREATE TABLE IF NOT EXISTS prompt_chat_start_intents (
      intent_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      prompt_digest TEXT NOT NULL,
      seed_only INTEGER NOT NULL CHECK(seed_only IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_chat_start_chat
      ON prompt_chat_start_intents(chat_id);
  `);

  // v107 — Science is a first-class projection of the durable Desktop
  // invocation runtime. Every redacted Science runtime event enters this
  // append-only delivery ledger before Main publishes it to the extension.
  // Science acknowledges only after its own SQLite transaction commits, so a
  // crash between the two databases replays the same delivery identity rather
  // than losing or duplicating a Lab/tool event.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS science_runtime_event_outbox (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      source_run_event_id TEXT NOT NULL UNIQUE,
      source_sequence INTEGER NOT NULL CHECK(source_sequence >= 1),
      source_kind TEXT NOT NULL,
      source_event_sha256 TEXT NOT NULL CHECK(length(source_event_sha256) = 64),
      event_json TEXT NOT NULL CHECK(length(event_json) BETWEEN 2 AND 262144),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(run_id, source_sequence),
      CHECK((status = 'pending' AND delivered_at IS NULL) OR (status = 'delivered' AND delivered_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_science_runtime_event_outbox_pending
      ON science_runtime_event_outbox(status, created_at, delivery_id);
    CREATE INDEX IF NOT EXISTS idx_science_runtime_event_outbox_run
      ON science_runtime_event_outbox(run_id, source_sequence);

    CREATE TRIGGER IF NOT EXISTS trg_science_runtime_event_outbox_identity_update
    BEFORE UPDATE ON science_runtime_event_outbox
    BEGIN
      SELECT CASE WHEN NEW.delivery_id != OLD.delivery_id OR NEW.run_id != OLD.run_id OR NEW.chat_id != OLD.chat_id
        OR NEW.source_run_event_id != OLD.source_run_event_id OR NEW.source_sequence != OLD.source_sequence
        OR NEW.source_kind != OLD.source_kind OR NEW.source_event_sha256 != OLD.source_event_sha256
        OR NEW.event_json != OLD.event_json OR NEW.created_at != OLD.created_at
        THEN RAISE(ABORT, 'science-runtime-outbox-identity-immutable') END;
      SELECT CASE WHEN NOT (NEW.status = OLD.status OR (OLD.status = 'pending' AND NEW.status = 'delivered'))
        THEN RAISE(ABORT, 'science-runtime-outbox-state-invalid') END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_science_runtime_event_outbox_delete
    BEFORE DELETE ON science_runtime_event_outbox
    BEGIN
      SELECT RAISE(ABORT, 'science-runtime-outbox-append-only');
    END;
  `);

  // PRD §5.25 — 산출물 바인딩 표가 마이그레이션 사다리 **밖에서**(첫 사용 시 지연 생성)
  // 만들어져 스키마 게이트가 그 존재를 보지 못했다. 사다리 안으로 옮긴다. 버전 가드 밖에
  // 두는 것은 의도적이다: 이미 100 을 지난 설치본도 이 경로를 지나야 표를 얻는다(멱등).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS one_artifact_bindings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      bound_task_version INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      source_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_dev TEXT NOT NULL,
      file_ino TEXT NOT NULL,
      file_mtime_ns TEXT NOT NULL,
      file_ctime_ns TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, chat_id, run_id, manifest_id, artifact_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_one_artifact_binding_exact
      ON one_artifact_bindings(task_id, chat_id, run_id, manifest_id, artifact_ref);
    CREATE INDEX IF NOT EXISTS idx_one_artifact_binding_chat
      ON one_artifact_bindings(chat_id, created_at);
  `);
  // 지우는 코드가 없어 영원히 쌓였다. 사라진 대화의 바인딩과 아주 오래된 행은 거둔다
  // (바인딩은 미리보기 발급용 색인이지 사용자 기록이 아니다).
  try {
    _db.exec(`
      DELETE FROM one_artifact_bindings
       WHERE chat_id NOT IN (SELECT id FROM chats)
          OR created_at < datetime('now', '-90 days');
    `);
  } catch {
    // 정리는 베스트에포트다 — 기동을 막지 않는다.
  }

  // v100 — durable in-app plugin builder drafts.  The seed is retained so an
  // agent-offer can be enforced once per conversation even after a restart or
  // an abandoned draft.
  if (userVersion < 100 || !tableExists(_db, "plugin_builder_sessions")) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_builder_sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        slug TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('interview','draft','verify','install','prove','discarded')),
        staging_dir TEXT,
        answers_json TEXT,
        gate_report_json TEXT,
        seed_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_builder_sessions_chat_updated
        ON plugin_builder_sessions(chat_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plugin_builder_sessions_slug_phase
        ON plugin_builder_sessions(slug, phase);
    `);
  }

  // v101: One 텔레그램 연결의 싱글턴을 **방 단위**로 옮긴다.
  //
  // v94는 "One이 둘"을 막으려고 target_kind 하나에만 유니크를 걸었는데, 그 인덱스는
  // 두 가지 다른 것을 한꺼번에 금지했다 — (1) One이라는 대상이 둘인 것, (2) One이
  // 여러 방(=여러 봇)에 있는 것. 막아야 할 것은 (1)뿐이다. (2)까지 막혀 있었기 때문에
  // 봇을 하나 더 붙이는 길이 아예 없었고, 텔레그램에서 오는 일은 전부 대화 하나에
  // 쌓였다("세션이 하나밖에 안 나오는 구조").
  //
  // 대상 단일성은 targetId(TELEGRAM_ONE_TARGET_ID) 상수가 이미 보장한다. 여기서는
  // 방 하나에 One 포트가 둘이 되는 것만 막는다 — 같은 방에서 두 봇이 같은 메시지에
  // 각자 답하는 것이 진짜 막아야 할 상태다. 아직 방을 못 잡은 행(telegram_chat_id
  // NULL)은 여러 개 있어도 된다: 그게 "봇은 만들었고 방 연결을 기다리는 중"이다.
  if (userVersion < 101 && tableExists(_db, "telegram_bindings")) {
    _db.exec(`
      DROP INDEX IF EXISTS idx_telegram_bindings_one_singleton;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_bindings_one_room
        ON telegram_bindings(telegram_chat_id)
        WHERE target_kind = 'one' AND telegram_chat_id IS NOT NULL;
    `);
  }

  // v102: 좌석·세션 모델 (오너 결정 2026-08-23).
  //
  // ★ 무엇이 문제였나
  // `chats.agent_id` 가 `installed_agents(id) ON DELETE CASCADE` 였다. 즉 **봇을 지우면
  // 그 봇과 나눈 대화가 통째로 사라졌다.** 사람 입장에서 봇은 갈아탈 수 있는 담당자인데,
  // 담당자를 바꾸면 지난 대화가 없어지는 셈이다.
  //
  // ★ 무엇으로 바꾸나
  //   좌석(seat)   = 사람이 보는 고정 자리. 절대 자동 삭제되지 않는다.
  //   세션         = 그 좌석에서 오간 대화 한 판. 좌석 1 : 세션 N.
  //   점유자        = 그 좌석에 지금 앉아 있는 봇. 갈아탈 수 있고 비어 있을 수도 있다.
  // 봇 삭제 = **좌석을 비우는 일**이지 좌석·세션을 없애는 일이 아니다.
  //
  // ★ 되돌릴 수 없는 단계다
  // chats 를 재작성한다(SQLite 는 컬럼 제약을 제자리에서 못 바꾼다). 그래서 시작 전에
  // DB 파일을 복사해 둔다. 실패하면 그 파일이 유일한 복구 경로다.
  if (userVersion < 102) {
    const seatBackup = backupDatabaseFile(_db, "v102-seats");
    // 지금 이미 깨져 있는 참조를 먼저 적어 둔다. 그래야 "내가 만든 위반"만 가려낼 수 있다.
    const existingViolations = new Set(
      (_db.pragma("foreign_key_check") as Array<{
        table: string;
        rowid: number | null;
        parent: string;
        fkid: number;
      }>).map((row) => `${row.table}:${row.rowid ?? "null"}:${row.parent}:${row.fkid}`),
    );

    _db.exec(`
      CREATE TABLE IF NOT EXISTS one_seats (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK(kind IN ('solo','group')),
        title       TEXT NOT NULL DEFAULT '',
        project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_one_seats_updated ON one_seats(updated_at DESC);

      -- agent_id 에 FK 를 걸지 않는다. 봇이 삭제돼도 "그때 누가 앉아 있었나" 는 남아야 한다.
      -- 지워진 봇은 표시명 스냅샷으로 보여준다(display_name).
      CREATE TABLE IF NOT EXISTS one_seat_occupants (
        seat_id      TEXT NOT NULL REFERENCES one_seats(id) ON DELETE CASCADE,
        slot         INTEGER NOT NULL DEFAULT 0,
        agent_id     TEXT,
        display_name TEXT NOT NULL DEFAULT '',
        since        TEXT NOT NULL,
        until        TEXT,
        PRIMARY KEY (seat_id, slot, since)
      );
      -- ★ UNIQUE 여야 한다. 그냥 INDEX 면 "한 슬롯에 현재 점유자 하나" 를 아무것도 막지
      -- 않는다. 부분 인덱스라 과거 이력은 얼마든지 쌓이고 현재 점유만 하나로 강제된다.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_occupants_current
        ON one_seat_occupants(seat_id, slot) WHERE until IS NULL;
      CREATE INDEX IF NOT EXISTS idx_seat_occupants_agent
        ON one_seat_occupants(agent_id) WHERE agent_id IS NOT NULL;
    `);

    _db.pragma("foreign_keys = OFF");
    try {
      const migrateSeats = _db.transaction(() => {
        // Some legitimate legacy/minimal stores never created a chat surface.
        // There is nothing to rebuild in that case; generating an empty dynamic
        // column list would produce `CREATE TABLE (..., seat_id ...)` and abort
        // the entire upgrade with a syntax error.
        if (!tableExists(_db!, "chats")) return;
        // ① chats 재작성 — seat_id 추가, agent_id 를 NULL 허용 + SET NULL 로 강등.
        //
        // ★ 열 이름을 손으로 나열하지 않는다 (2026-08-23 실측으로 잡은 사고).
        // chats 는 사다리를 지나며 열이 12개 더 붙었다(kind, parent_chat_id, working_folder,
        // hired_agents, runtime_selection_json …). 처음에 기본 6개만 적어 옮겼다가 시험에서
        // "no such column: kind" 로 드러났다 — 실제 사용자 DB 였다면 **하위 세션 사슬과
        // 작업 폴더가 통째로 사라졌다.** 그리고 다음에 열이 하나 더 붙으면 같은 일이 또 난다.
        //
        // 그래서 **실행 시점에 실제 열을 읽어** 그대로 옮긴다. 우리가 의미를 바꾸는 두
        // 열(agent_id 제약, seat_id 신설)만 손으로 다루고 나머지는 있는 그대로 따라간다.
        const chatColumns = (_db!.pragma("table_info(chats)") as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>);
        const carried = chatColumns.filter((column) => column.name !== "agent_id" && column.name !== "seat_id");
        const columnSql = carried.map((column) => {
          // 옮겨오는 열은 정의를 그대로 유지한다 — 기본값·NOT NULL 을 잃으면 나중 코드가 깨진다.
          const notNull = column.notnull ? " NOT NULL" : "";
          const dflt = column.dflt_value === null ? "" : ` DEFAULT ${column.dflt_value}`;
          const pk = column.pk ? " PRIMARY KEY" : "";
          return `${column.name} ${column.type || "TEXT"}${pk}${notNull}${dflt}`;
        }).join(",\n            ");
        const carriedNames = carried.map((column) => column.name).join(", ");
        /*
         * ★ 외래키도 "실제 있는 열" 로만 건다 (2026-08-24 실측으로 잡은 사고).
         *   열 목록은 실행 시점에 읽으면서 **외래키 절과 INSERT 는 이름을 손으로 박아** 뒀다.
         *   아주 오래된 스키마에서 올라오는 DB 의 chats 에는 `project_id` 도 `agent_id` 도
         *   아직 없어서, 그 사람들의 업데이트가 `unknown column "project_id" in foreign key
         *   definition` 으로 **여기서 통째로 멈췄다.** 오래 안 쓰다 켠 사람만 맞는 종류다.
         */
        // ★ 원본 chats 의 열 목록으로 확인한다. `carried` 는 우리가 의미를 바꾸는 두 열
        //   (agent_id·seat_id)을 **빼 둔** 목록이라, 거기서 agent_id 를 찾으면 언제나 없다 —
        //   그러면 좌석 만들기가 통째로 건너뛰어진다(내가 처음에 그렇게 썼다).
        const carriedHas = (name: string): boolean => chatColumns.some((column) => column.name === name);
        const foreignKeys = [
          ...(carriedHas("project_id") ? ["FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL"] : []),
          "FOREIGN KEY(seat_id) REFERENCES one_seats(id) ON DELETE CASCADE",
          "FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL",
        ].join(",\n            ");
        // 옛 chats 에 agent_id 가 없으면 옮겨올 값도 없다 — NULL 로 시작하고, 그 뒤 사다리가
        // 채운다. (agent_id 는 이 단계에서 NULL 허용으로 강등되므로 안전하다.)
        const carriedAgentId = carriedHas("agent_id") ? "agent_id" : "NULL";
        _db!.exec(`
          DROP TABLE IF EXISTS chats_v102;
          CREATE TABLE chats_v102 (
            ${columnSql},
            seat_id TEXT,
            agent_id TEXT,
            ${foreignKeys}
          );
          INSERT INTO chats_v102 (${carriedNames}, seat_id, agent_id)
            SELECT ${carriedNames}, NULL, ${carriedAgentId} FROM chats;
        `);
        // 옮긴 행 수가 다르면 여기서 멈춘다 — 데이터가 줄어든 채로 교체하면 되돌릴 수 없다.
        const beforeCount = (_db!.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n;
        const afterCount = (_db!.prepare("SELECT COUNT(*) AS n FROM chats_v102").get() as { n: number }).n;
        if (beforeCount !== afterCount) {
          throw new Error(`v102 seat migration lost rows: chats ${beforeCount} -> ${afterCount}`);
        }

        // ② 봇 하나당 solo 좌석 하나. 표시 이름은 지금 이름을 스냅샷으로 남긴다 —
        //    나중에 봇이 지워져도 "누구 자리였는지" 를 말할 수 있어야 한다.
        /*
         * 좌석은 "그 대화가 어느 봇의 것이었나" 에서 만들어진다. 아주 오래된 스키마의 chats
         * 에는 `agent_id` 자체가 없어 만들 원천이 없다 — 그때는 이 시딩을 통째로 건너뛴다.
         * (건너뛰어도 chats_v102.agent_id 는 전부 NULL 이므로 아래 UPDATE 도 할 일이 없다.)
         */
        if (carriedHas("agent_id")) {
        const seatProjectExpr = carriedHas("project_id")
          ? `(SELECT c2.project_id FROM chats c2
              WHERE c2.agent_id = c.agent_id AND c2.project_id IS NOT NULL
              ORDER BY c2.created_at ASC LIMIT 1)`
          : "NULL";
        _db!.exec(`
          INSERT OR IGNORE INTO one_seats (id, kind, title, project_id, created_at, updated_at)
          SELECT
            'seat_' || c.agent_id,
            'solo',
            '',
            ${seatProjectExpr},
            MIN(c.created_at),
            MAX(c.updated_at)
          FROM chats c
          WHERE c.agent_id IS NOT NULL
          GROUP BY c.agent_id;

          INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until)
          SELECT
            'seat_' || c.agent_id,
            0,
            c.agent_id,
            COALESCE((SELECT a.name FROM installed_agents a WHERE a.id = c.agent_id), ''),
            MIN(c.created_at),
            NULL
          FROM chats c
          WHERE c.agent_id IS NOT NULL
          GROUP BY c.agent_id;

          UPDATE chats_v102
             SET seat_id = 'seat_' || agent_id
           WHERE agent_id IS NOT NULL;
        `);
        }

        // ③ 하위 실행 세션(division)은 좌석을 새로 만들지 않고 뿌리의 좌석을 물려받는다.
        //    사슬이 깊을 수 있어 더 이상 바뀌지 않을 때까지 올려 붙인다. 뿌리를 못 찾는
        //    고아는 좌석 없이 둔다 — 지금도 목록에 안 나온다.
        // 하위 세션 사슬은 `parent_chat_id` 로만 알 수 있다. 그 열이 없던 시절의 DB 에는
        // 사슬 자체가 없으므로 물려줄 것도 없다 — 있을 때만 돈다.
        if (carriedHas("parent_chat_id")) {
          const inheritSeat = _db!.prepare(`
            UPDATE chats_v102
               SET seat_id = (
                 SELECT p.seat_id FROM chats_v102 p
                  WHERE p.id = (SELECT c.parent_chat_id FROM chats c WHERE c.id = chats_v102.id)
               )
             WHERE seat_id IS NULL
               AND (SELECT c.parent_chat_id FROM chats c WHERE c.id = chats_v102.id) IS NOT NULL
          `);
          for (let pass = 0; pass < 32; pass += 1) {
            if (inheritSeat.run().changes === 0) break;
          }
        }

        // ④ 교체. 인덱스는 재작성 뒤에 다시 만든다(테이블과 함께 사라진다).
        // 인덱스도 이름을 나열하지 않는다. 테이블을 지우면 그 인덱스가 함께 사라지므로,
        // **지우기 전에** 실제 정의를 읽어 두었다가 그대로 되살린다. 사다리 뒤쪽에서 추가된
        // 인덱스를 빠뜨리면 조회가 조용히 느려진다 — 화면은 정상이라 아무도 모른다.
        const chatIndexes = (_db!.prepare(
          `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='chats' AND sql IS NOT NULL`,
        ).all() as Array<{ sql: string }>).map((row) => row.sql);
        _db!.exec(`
          DROP TABLE chats;
          ALTER TABLE chats_v102 RENAME TO chats;
        `);
        for (const indexSql of chatIndexes) {
          _db!.exec(`${indexSql.replace(/^CREATE (UNIQUE )?INDEX /i, (m) => `${m}IF NOT EXISTS `)};`);
        }
        _db!.exec(`CREATE INDEX IF NOT EXISTS idx_chats_seat_updated ON chats(seat_id, updated_at DESC);`);

        // ⑤ 내가 만든 위반만 가려낸다. 특히 telegram_bindings.chat_session_id 가 chats(id)
        //    를 참조하므로 이 교체에서 끊기면 안 된다.
        const newViolations = (_db!.pragma("foreign_key_check") as Array<{
          table: string;
          rowid: number | null;
          parent: string;
          fkid: number;
        }>).filter(
          (row) => !existingViolations.has(`${row.table}:${row.rowid ?? "null"}:${row.parent}:${row.fkid}`),
        );
        if (newViolations.length > 0) {
          throw new Error(
            `v102 seat migration introduced ${newViolations.length} integrity violation(s): `
            + newViolations.slice(0, 5).map((row) => `${row.table}->${row.parent}`).join(", "),
          );
        }
      });
      migrateSeats();
    } catch (error) {
      // 백업 경로를 오류에 실어 보낸다. 이 단계는 되돌릴 수 없으므로 그 파일이 유일한 길이다.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + (seatBackup ? ` — 이 단계 직전 백업: ${seatBackup}` : " — 백업을 만들지 못했다"),
      );
    } finally {
      _db.pragma("foreign_keys = ON");
    }
  }

  // v103: 좌석-세션 상호참조 (SEAT-SESSION-PLAN-v2 §3.2 사다리).
  //
  // v102 는 좌석 원장을 만들고 시딩까지 했지만 **그 뒤에 태어난 대화는 좌석이 없다**
  // (createChat 이 seat_id 를 안 넣었다 — 원장 동결). 이 단계는:
  //   ① 스키마 증분 — 전부 ADD COLUMN / IF NOT EXISTS. chats 재작성 없음(v102 와 다르다).
  //   ② solo 좌석 재시딩(멱등 backfill) — v102 이후 생긴 seat_id NULL 대화 흡수.
  //   ③ 단톡(one_taskforces) → group 좌석 이관. 방 삭제가 대화를 지우지 않는 보존
  //      계약(I3)의 원장 기반. one_taskforces 테이블 자체는 호환 창구로 남긴다.
  //   ④ 세션 표시 스냅샷(seat_label·seat_kind·participants_json) — 좌석이 소멸해도
  //      세션이 스스로를 설명한다(I2). 쓰는 시점 기록 원칙(I9)의 backfill 판.
  //   ⑤ 런타임 세션 키에 agent_id — 점유자 교체 시 두 봇이 서로의 CLI 세션 행을
  //      덮어쓰지 않는다(I5). 소형 테이블이라 단순 재작성.
  // 마지막에 스스로 검증하고, 실패하면 백업 경로를 오류에 실어 말한다(I10).
  if (userVersion < 103) {
    const seatSessionBackup = backupDatabaseFile(_db, "v103-seat-session");
    try {
      const migrateSeatSession = _db.transaction(() => {
        // ① 스키마 증분 — 재실행 안전(열 존재 확인 뒤 ALTER).
        const seatColumns = new Set(schemaColumns(_db!, "one_seats").map((column) => column.name));
        if (!seatColumns.has("dissolved_at")) {
          _db!.exec("ALTER TABLE one_seats ADD COLUMN dissolved_at TEXT");
        }
        const chatColumns = new Set(schemaColumns(_db!, "chats").map((column) => column.name));
        if (!chatColumns.has("seat_label")) _db!.exec("ALTER TABLE chats ADD COLUMN seat_label TEXT");
        if (!chatColumns.has("seat_kind")) _db!.exec("ALTER TABLE chats ADD COLUMN seat_kind TEXT");
        if (!chatColumns.has("participants_json")) _db!.exec("ALTER TABLE chats ADD COLUMN participants_json TEXT");
        _db!.exec("CREATE INDEX IF NOT EXISTS idx_occupants_seat_time ON one_seat_occupants(seat_id, since)");
        // 텔레그램 방 = 좌석(원기획 §2.4). 방의 자리를 원장에 적어 두면 `/new` 로 세션을
        // 새로 열어도 방의 지난 대화들과 같은 자리에 모인다.
        if (tableExists(_db!, "telegram_bindings")) {
          const telegramColumns = new Set(schemaColumns(_db!, "telegram_bindings").map((column) => column.name));
          if (!telegramColumns.has("seat_id")) {
            _db!.exec("ALTER TABLE telegram_bindings ADD COLUMN seat_id TEXT");
          }
        }

        // ② solo 좌석 재시딩 — v102 의 시딩 규칙 그대로, seat_id NULL 행만 대상.
        //    자연 키(seat_id, slot, since)와 부분 유니크(현재 점유 ≤1)가 멱등을 보장한다.
        // ★열 존재를 가드한다 (v102 와 같은 이유). 아주 오래된 스키마에서 올라오는 DB 의
        //   chats 에는 agent_id·parent_chat_id 가 아예 없다 — v102 재작성은 "있는 열만"
        //   옮기므로 여기서도 없는 열을 참조하면 사다리가 통째로 멈춘다(v84 픽스처 실측).
        const chatHas = (name: string): boolean => chatColumns.has(name) || schemaColumns(_db!, "chats").some((column) => column.name === name);
        if (chatHas("agent_id")) {
        _db!.exec(`
          INSERT OR IGNORE INTO one_seats (id, kind, title, project_id, created_at, updated_at)
          SELECT
            'seat_' || c.agent_id, 'solo', '',
            ${chatHas("project_id") ? `(SELECT c2.project_id FROM chats c2
              WHERE c2.agent_id = c.agent_id AND c2.project_id IS NOT NULL
              ORDER BY c2.created_at ASC LIMIT 1)` : "NULL"},
            MIN(c.created_at), MAX(c.updated_at)
          FROM chats c
          WHERE c.agent_id IS NOT NULL AND c.seat_id IS NULL
          GROUP BY c.agent_id;

          INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until)
          SELECT
            'seat_' || c.agent_id, 0, c.agent_id,
            COALESCE((SELECT a.name FROM installed_agents a WHERE a.id = c.agent_id), ''),
            MIN(c.created_at), NULL
          FROM chats c
          WHERE c.agent_id IS NOT NULL AND c.seat_id IS NULL
          GROUP BY c.agent_id;

          UPDATE chats SET seat_id = 'seat_' || agent_id
           WHERE seat_id IS NULL AND agent_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM one_seats s WHERE s.id = 'seat_' || chats.agent_id);
        `);
        }
        // 하위 실행 세션(division)은 뿌리 좌석을 물려받는다 — v102 ③ 과 같은 규칙.
        if (chatHas("parent_chat_id")) {
          const inheritSeatV103 = _db!.prepare(`
            UPDATE chats
               SET seat_id = (SELECT p.seat_id FROM chats p WHERE p.id = chats.parent_chat_id)
             WHERE seat_id IS NULL AND parent_chat_id IS NOT NULL
               AND (SELECT p.seat_id FROM chats p WHERE p.id = chats.parent_chat_id) IS NOT NULL
          `);
          for (let pass = 0; pass < 32; pass += 1) {
            if (inheritSeatV103.run().changes === 0) break;
          }
        }

        // ③ 단톡 → group 좌석 이관. member 목록은 JSON 이라 JS 에서 푼다.
        let taskforceSeatCount = 0;
        if (tableExists(_db!, "one_taskforces")) {
          const taskforceRows = _db!.prepare(
            "SELECT id, chat_id, title, member_agent_ids_json, created_at, updated_at FROM one_taskforces",
          ).all() as Array<{ id: string; chat_id: string; title: string; member_agent_ids_json: string; created_at: string; updated_at: string }>;
          const insertSeat = _db!.prepare(
            "INSERT OR IGNORE INTO one_seats (id, kind, title, project_id, created_at, updated_at) VALUES (?, 'group', ?, NULL, ?, ?)",
          );
          const insertOccupant = _db!.prepare(
            `INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until)
             VALUES (?, ?, ?, COALESCE((SELECT a.name FROM installed_agents a WHERE a.id = ?), ''), ?, NULL)`,
          );
          const bindChat = _db!.prepare("UPDATE chats SET seat_id = ? WHERE id = ?");
          for (const tf of taskforceRows) {
            const seatId = `seat_tf_${tf.id}`;
            insertSeat.run(seatId, tf.title ?? "", tf.created_at, tf.updated_at);
            let memberIds: string[] = [];
            try {
              const parsed = JSON.parse(tf.member_agent_ids_json);
              if (Array.isArray(parsed)) memberIds = parsed.filter((value): value is string => typeof value === "string");
            } catch { /* 손상된 멤버 목록 — 빈 좌석으로 이관 */ }
            memberIds.forEach((agentId, slot) => {
              insertOccupant.run(seatId, slot, agentId, agentId, tf.created_at);
            });
            // 단톡 대화의 좌석은 그 단톡의 group 좌석이다 — v102 가 agent_id(=One 루트)로
            // 잘못 붙인 solo 좌석이 있어도 여기서 바로잡는다.
            bindChat.run(seatId, tf.chat_id);
            taskforceSeatCount += 1;
          }
        }

        // ④ 표시 스냅샷 backfill. 라벨을 만들 수 없는 행(빈 제목 + 점유자 없음)은
        //    NULL 로 둔다 — 렌더는 그 칸을 그리지 않는다(I9, 지어낸 값 금지).
        _db!.exec(`
          UPDATE chats SET
            seat_kind = (SELECT s.kind FROM one_seats s WHERE s.id = chats.seat_id),
            seat_label = (
              SELECT NULLIF(
                CASE WHEN s.title <> '' THEN s.title ELSE COALESCE((
                  SELECT o.display_name FROM one_seat_occupants o
                   WHERE o.seat_id = s.id AND o.until IS NULL AND o.display_name <> ''
                   ORDER BY o.slot LIMIT 1
                ), '') END, '')
              FROM one_seats s WHERE s.id = chats.seat_id)
          WHERE seat_id IS NOT NULL AND (seat_kind IS NULL OR seat_label IS NULL);
        `);
        const seatIdsNeedingParticipants = _db!.prepare(
          "SELECT DISTINCT seat_id FROM chats WHERE seat_id IS NOT NULL AND participants_json IS NULL",
        ).all() as Array<{ seat_id: string }>;
        const readOccupants = _db!.prepare(
          "SELECT slot, agent_id, display_name FROM one_seat_occupants WHERE seat_id = ? AND until IS NULL ORDER BY slot",
        );
        const writeParticipants = _db!.prepare(
          "UPDATE chats SET participants_json = ? WHERE seat_id = ? AND participants_json IS NULL",
        );
        for (const { seat_id } of seatIdsNeedingParticipants) {
          const occupants = readOccupants.all(seat_id) as Array<{ slot: number; agent_id: string | null; display_name: string }>;
          writeParticipants.run(
            JSON.stringify(occupants.map((row) => ({ slot: row.slot, agentId: row.agent_id, displayName: row.display_name }))),
            seat_id,
          );
        }

        // ⑤ 런타임 세션 키에 agent_id — (chat_id, kind) → (chat_id, kind, agent_id).
        //    기존 행은 agent_id='' 레거시 키로 남기고, 읽기 쪽이 지문 검증 하에 승계한다.
        if (tableExists(_db!, "chat_runtime_sessions")) {
          const runtimeColumns = new Set(schemaColumns(_db!, "chat_runtime_sessions").map((column) => column.name));
          if (!runtimeColumns.has("agent_id")) {
            _db!.exec(`
              DROP TABLE IF EXISTS chat_runtime_sessions_v103;
              CREATE TABLE chat_runtime_sessions_v103 (
                chat_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                reported_output_tokens INTEGER,
                reported_input_tokens INTEGER,
                reported_cached_input_tokens INTEGER,
                PRIMARY KEY (chat_id, kind, agent_id),
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
              );
              INSERT INTO chat_runtime_sessions_v103
                (chat_id, kind, agent_id, session_id, fingerprint, updated_at,
                 reported_output_tokens, reported_input_tokens, reported_cached_input_tokens)
                SELECT chat_id, kind, '', session_id, fingerprint, updated_at,
                       reported_output_tokens, reported_input_tokens, reported_cached_input_tokens
                FROM chat_runtime_sessions;
              DROP TABLE chat_runtime_sessions;
              ALTER TABLE chat_runtime_sessions_v103 RENAME TO chat_runtime_sessions;
            `);
          }
        }

        // ⑥ 자기 검증 — 초록은 "실패 없음"이 아니라 "이만큼 검사했다"여야 한다.
        //    (agent_id·kind 가 없던 고대 스키마는 시딩 원천 자체가 없으므로 검사 대상 0.)
        const orphanUserChats = chatHas("agent_id") && chatHas("kind")
          ? (_db!.prepare(
              "SELECT COUNT(*) AS n FROM chats WHERE seat_id IS NULL AND kind = 'user' AND agent_id IS NOT NULL",
            ).get() as { n: number }).n
          : 0;
        if (orphanUserChats > 0) {
          throw new Error(`v103 seat-session migration left ${orphanUserChats} user chat(s) without a seat`);
        }
        const seatTotal = (_db!.prepare("SELECT COUNT(*) AS n FROM one_seats").get() as { n: number }).n;
        console.log(
          `[store] v103 seat-session: checks=orphan-user-chats(0), seats=${seatTotal}, taskforce-seats=${taskforceSeatCount}`,
        );
      });
      migrateSeatSession();
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`
        + (seatSessionBackup ? ` — 이 단계 직전 백업: ${seatSessionBackup}` : " — 백업을 만들지 못했다"),
      );
    }
  }

  // ── v104: 에이전트 신원 대응표 (얹기만 한다, 아무것도 옮기지 않는다) ──────────
  // `agentId`(`agt_<32hex>`)는 이미 빌드가 발급해 패키지 `agentlas.json` 에 박아 두는
  // 불변 신원이다(오너 결정 2026-08-08 R5). 그런데 이 앱은 그 값을 읽는 곳이 한 곳도
  // 없었고, 로컬은 네 갈래 id 로 일해 왔다 — uuid / id==slug / team-member:<sha> / builtin-*.
  //
  // ★ `installed_agents.id` 는 절대 바꾸지 않는다. 그 id 를 부모로 삼는 FK 가 16곳이고
  //   그중 12곳이 ON DELETE CASCADE 다(경험칩·후보·승급영수증·자동수집영수증).
  //   런타임은 foreign_keys=ON 이라 제자리 UPDATE 는 실패하지만, 이 사다리가 표 재작성을
  //   위해 이미 foreign_keys=OFF 창을 세 번 연다 — 그 안에서라면 조용히 성공하고 자식이
  //   전부 고아가 된다. 그래서 신원은 **옆에 얹는다**.
  //
  // 양방향(옛→새, 새→옛)을 모두 답할 수 있어야 한다. 한 방향만 두면 쓰기를 새 id 로 돌린
  // 시점부터 되돌릴 수 없어진다.
  if (userVersion < 104) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_identity_map (
        -- CASCADE 다. 대응표는 **파생 데이터**이고 정본은 패키지의 agentId 다.
        -- RESTRICT 로 두면 에이전트 삭제가 6곳에서 막힌다 — 사용자 삭제, 중복정리 2곳,
        -- 설치 실패 롤백, One 멤버 생성 실패 롤백, 터미널 삭제. 롤백이 막히면
        -- "설치 실패"가 "설치 실패 + 복구 실패 + 유령 행"이 된다.
        local_id            TEXT PRIMARY KEY REFERENCES installed_agents(id) ON DELETE CASCADE,
        -- 이름을 agent_id 로 두면 agent-dedupe 의 컬럼명 스윕에 걸린다. 값이 달라
        -- 지금은 매칭이 0건이지만, 이름 우연에 기대는 구조 자체가 지뢰다.
        immutable_agent_id  TEXT NOT NULL,
        agent_version       INTEGER NOT NULL DEFAULT 1,
        -- package: 패키지 agentlas.json 에서 읽음 (정본)
        -- builtin-reserved: 앱에 구워진 에이전트 — 패키지가 없어 예약 네임스페이스를 쓴다
        -- minted-local: 출처가 없어 이 기기에서 발급 (다음에 패키지를 받으면 package 가 이긴다)
        mapping_source      TEXT NOT NULL,
        bound_at            TEXT NOT NULL
      );
      -- agent_id 에 UNIQUE 를 걸지 않는다: 같은 패키지가 두 행으로 깔린 사용자가 실존한다
      -- (실측: local-vibecoder / vibecoder). UNIQUE 면 그 사용자의 승급이 통째로 실패한다.
      CREATE INDEX IF NOT EXISTS idx_agent_identity_map_agent ON agent_identity_map(immutable_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_identity_map_source ON agent_identity_map(mapping_source);
    `);

    // 이미 쌓인 고아 개인 기억을 팀 공유 칸으로 되돌린다.
    //
    // 조직도 노드에 실체 에이전트 행이 없으면 실행 층이 노드 id 를 그대로 기억 주인으로
    // 썼다(`mcp/firm-orchestrator.ts`). `memory_entries.agent_id` 에는 FK 가 없어 그 값이
    // 그냥 들어갔고, 그러면 그 기억은 어느 에이전트로도 조회되지 않는다 — 삭제된 것이
    // 아니라 **닿을 수 없는** 상태다. 새로 생기는 것은 큐레이터 sink 가 막지만
    // (`shared/memory-ownership.ts`), 이미 들어간 줄은 여기서 되돌린다.
    //
    // 옮기는 것뿐이고 지우지 않는다. 개인 칸을 가질 수 없는 주인(설치본이 없거나
    // `agt_team_` 낙인)만 대상이고, 멀쩡한 개인 기억은 건드리지 않는다.
    const reclaimed = reclaimUnreachableAgentMemory(_db);
    if (reclaimed > 0) console.log(`[store] v104 reclaimed ${reclaimed} unreachable agent memory row(s) into team memory`);

    // 판 해시 때문에 갈라진 자동 경험 팩을 다시 하나로 모은다.
    //
    // 조회 좌표에서 해시를 뺀 것(`experience/store.ts` ensureAutoExperiencePack)은 앞으로
    // 갈라지지 않게 할 뿐, 이미 갈라진 것은 그대로다. 갈라진 채로 두면 사용자는 이미
    // 승급한 칩을 다시 검토하라는 요청을 계속 받는다.
    const consolidated = consolidateSplitAutoExperiencePacks(_db);
    if (consolidated.groups > 0) {
      console.log(
        `[store] v104 consolidated ${consolidated.groups} split auto experience coordinate(s) — ` +
          `moved ${consolidated.moved} candidate(s), archived ${consolidated.archived} duplicate pack(s)`,
      );
    }
  }

  // v107: Desktop-owned long-running work. These records are the local
  // authority for One, Work, and Science campaigns; no Agentlas OS plugin or
  // provider session is required to read, pause, recover, or verify them.
  // The state tables are projections. long_run_events and verification
  // receipts retain the append-only evidence needed to rebuild those views.
  // v1.1.1 stamped user_version=107 before these projection tables shipped.
  // Treat that historical shape like an incomplete v107 migration so the
  // next fixed Desktop upgrade creates the whole projection before v108 rewrites it.
  const longRunProjectionTables = [
    "long_runs",
    "long_run_tasks",
    "long_run_workers",
    "long_run_worker_attempts",
    "long_run_messages",
    "long_run_verification_receipts",
    "long_run_events",
  ];
  // If a pre-release v108 stopped after renaming the attempts table, restore
  // that pending table before the v107 CREATE IF NOT EXISTS block runs. This
  // keeps its rows visible to the v108 rebuild instead of creating an empty
  // sibling and silently discarding the partial migration's data.
  if (
    !tableExists(_db!, "long_run_worker_attempts")
    && tableExists(_db!, "long_run_worker_attempts_v108")
  ) {
    _db.exec("ALTER TABLE long_run_worker_attempts_v108 RENAME TO long_run_worker_attempts");
  }
  const needsLongRunProjectionBootstrap = !longRunProjectionTables.every((table) => tableExists(_db!, table));
  if (userVersion < 107 || needsLongRunProjectionBootstrap) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS long_runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        surface TEXT NOT NULL CHECK(surface IN ('one','work','science')),
        execution_location TEXT NOT NULL DEFAULT 'desktop-local'
          CHECK(execution_location IN ('desktop-local','web-hosted')),
        root_chat_id TEXT,
        project_id TEXT,
        science_job_id TEXT,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN (
          'draft','queued','running','waiting_worker','waiting_tool','waiting_user',
          'verifying','pausing','paused','blocked','completed','failed','cancelling','cancelled'
        )),
        pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN (
          'user','app_closed','budget','runtime_unavailable','approval_required','crash_recovery'
        )),
        runtime_fallback_policy TEXT NOT NULL DEFAULT 'locked'
          CHECK(runtime_fallback_policy IN ('locked','preapproved_safe')),
        max_cycles INTEGER CHECK(max_cycles IS NULL OR max_cycles > 0),
        max_cost_usd REAL CHECK(max_cost_usd IS NULL OR max_cost_usd >= 0),
        wallclock_deadline TEXT,
        max_workers INTEGER CHECK(max_workers IS NULL OR max_workers > 0),
        cycle_count INTEGER NOT NULL DEFAULT 0 CHECK(cycle_count >= 0),
        cost_used_usd REAL NOT NULL DEFAULT 0 CHECK(cost_used_usd >= 0),
        last_progress_key TEXT,
        stall_streak INTEGER NOT NULL DEFAULT 0 CHECK(stall_streak >= 0),
        stall_window INTEGER NOT NULL DEFAULT 3 CHECK(stall_window > 0),
        blocked_reason TEXT,
        app_instance_id TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        paused_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(root_chat_id) REFERENCES chats(id) ON DELETE SET NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_runs_status_updated
        ON long_runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_long_runs_surface_updated
        ON long_runs(surface, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_long_runs_chat
        ON long_runs(root_chat_id, updated_at DESC) WHERE root_chat_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_long_runs_project
        ON long_runs(project_id, updated_at DESC) WHERE project_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS long_run_tasks (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_task_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        dependency_ids_json TEXT NOT NULL DEFAULT '[]',
        criterion_indices_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN (
          'todo','doing','waiting_worker','waiting_tool','waiting_user',
          'verifying','blocked','completed','failed','cancelled'
        )),
        assigned_worker_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        attempt_limit INTEGER CHECK(attempt_limit IS NULL OR attempt_limit > 0),
        evidence_ref TEXT,
        blocked_reason TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(run_id, id),
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_tasks_state
        ON long_run_tasks(run_id, state, sort_order, created_at);
      CREATE INDEX IF NOT EXISTS idx_long_run_tasks_worker
        ON long_run_tasks(run_id, assigned_worker_id, state)
        WHERE assigned_worker_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS long_run_workers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_worker_id TEXT,
        task_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('controller','specialist','verifier','executor','multimodal')),
        agent_definition_id TEXT,
        agent_release_json TEXT,
        runtime_selection_json TEXT NOT NULL,
        capability_descriptor_id TEXT,
        workspace_binding_json TEXT NOT NULL,
        permission_profile TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'provisioning','idle','running','waiting','blocked','completed',
          'failed','interrupted','cancelled'
        )),
        current_attempt INTEGER NOT NULL DEFAULT 0 CHECK(current_attempt >= 0),
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_worker_id) REFERENCES long_run_workers(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_workers_run_state
        ON long_run_workers(run_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_long_run_workers_parent
        ON long_run_workers(parent_worker_id, created_at)
        WHERE parent_worker_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS long_run_worker_attempts (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT,
        invocation_run_id TEXT,
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        state TEXT NOT NULL CHECK(state IN (
          'running','completed','failed','interrupted','cancelled','uncertain'
        )),
        runtime_selection_json TEXT NOT NULL,
        native_coordinate_json TEXT,
        continuity_capsule_json TEXT,
        app_instance_id TEXT,
        side_effect_state TEXT NOT NULL DEFAULT 'none'
          CHECK(side_effect_state IN ('none','committed','uncertain')),
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(worker_id) REFERENCES long_run_workers(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE,
        UNIQUE(worker_id, attempt),
        UNIQUE(invocation_run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_attempts_run_state
        ON long_run_worker_attempts(run_id, state, started_at DESC);

      CREATE TABLE IF NOT EXISTS long_run_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        from_worker_id TEXT NOT NULL,
        to_worker_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('task','result','question','steer','cancel','receipt')),
        body_ref TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'queued'
          CHECK(state IN ('queued','delivered','acknowledged','failed','cancelled')),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT,
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(from_worker_id) REFERENCES long_run_workers(id) ON DELETE CASCADE,
        FOREIGN KEY(to_worker_id) REFERENCES long_run_workers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_messages_delivery
        ON long_run_messages(to_worker_id, state, created_at);

      CREATE TABLE IF NOT EXISTS long_run_verification_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        criterion_index INTEGER NOT NULL CHECK(criterion_index >= 0),
        verifier_worker_id TEXT,
        verdict TEXT NOT NULL CHECK(verdict IN ('passed','failed','inconclusive')),
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(verifier_worker_id) REFERENCES long_run_workers(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_verification_criterion
        ON long_run_verification_receipts(run_id, criterion_index, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_long_run_verification_task
        ON long_run_verification_receipts(run_id, task_id, created_at DESC)
        WHERE task_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS long_run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK(seq > 0),
        kind TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('host','user','worker','runtime','tool','system')),
        actor_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL,
        PRIMARY KEY(run_id, seq),
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_events_kind
        ON long_run_events(run_id, kind, seq DESC);
    `);
  }

  // v108: one provider invocation may contain a controller plus multiple
  // projected child workers. The v107 UNIQUE(invocation_run_id) constraint
  // accidentally made that actual mixed-runtime tree impossible. Preserve
  // uniqueness per logical worker attempt while allowing every child attempt
  // to link to the same durable invocation receipt.
  if (userVersion < 108 || needsLongRunProjectionBootstrap) {
    _db.transaction(() => {
      // A pre-release v108 attempt could have stopped between DDL statements.
      // Recover the only safe shape, otherwise rebuild the temporary table
      // inside one SQLite transaction so retries never see a half migration.
      const hasOriginal = tableExists(_db!, "long_run_worker_attempts");
      const hasTemporary = tableExists(_db!, "long_run_worker_attempts_v108");
      if (!hasOriginal && hasTemporary) {
        _db!.exec("ALTER TABLE long_run_worker_attempts_v108 RENAME TO long_run_worker_attempts");
      } else {
        // A historical v107 store can report user_version=107 without ever
        // having materialized this table (the older ladder stamped the version
        // before the long-run projection was added). In that shape there is no
        // source table to copy; create the canonical v108 shape directly so a
        // retry can continue through v109-v112.
        if (hasTemporary) _db!.exec("DROP TABLE long_run_worker_attempts_v108");
        _db!.exec(`
      CREATE TABLE long_run_worker_attempts_v108 (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT,
        invocation_run_id TEXT,
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        state TEXT NOT NULL CHECK(state IN (
          'running','completed','failed','interrupted','cancelled','uncertain'
        )),
        runtime_selection_json TEXT NOT NULL,
        native_coordinate_json TEXT,
        continuity_capsule_json TEXT,
        app_instance_id TEXT,
        side_effect_state TEXT NOT NULL DEFAULT 'none'
          CHECK(side_effect_state IN ('none','committed','uncertain')),
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(worker_id) REFERENCES long_run_workers(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES long_runs(id) ON DELETE CASCADE,
        UNIQUE(worker_id, attempt)
      );
        `);
        if (hasOriginal) {
          _db!.exec(`
      INSERT INTO long_run_worker_attempts_v108 (
        id, worker_id, run_id, task_id, invocation_run_id, attempt, state,
        runtime_selection_json, native_coordinate_json, continuity_capsule_json,
        app_instance_id, side_effect_state, error_code, error_message,
        started_at, updated_at, completed_at
      )
      SELECT
        id, worker_id, run_id, task_id, invocation_run_id, attempt, state,
        runtime_selection_json, native_coordinate_json, continuity_capsule_json,
        app_instance_id, side_effect_state, error_code, error_message,
        started_at, updated_at, completed_at
      FROM long_run_worker_attempts;
      DROP TABLE long_run_worker_attempts;
          `);
        }
        _db!.exec(`
      ALTER TABLE long_run_worker_attempts_v108 RENAME TO long_run_worker_attempts;
        `);
      }
      _db!.exec(`
      CREATE INDEX IF NOT EXISTS idx_long_run_attempts_run_state
        ON long_run_worker_attempts(run_id, state, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_long_run_attempts_invocation
        ON long_run_worker_attempts(invocation_run_id, worker_id, attempt)
        WHERE invocation_run_id IS NOT NULL;
      `);
    })();
  }

  // v109: external domain stores (initially Science) remain canonical while
  // long_runs provides one inspectable Desktop projection. Version/hash/cursor
  // coordinates make replay idempotent and expose stale or forked projections
  // instead of silently letting two SQLite owners diverge.
  if (userVersion < 109) {
    _db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_long_runs_science_job
        ON long_runs(science_job_id)
        WHERE surface = 'science' AND science_job_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS long_run_domain_bindings (
        long_run_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL CHECK(domain IN ('science')),
        object_type TEXT NOT NULL CHECK(object_type IN ('loop_session')),
        object_id TEXT NOT NULL,
        external_project_id TEXT NOT NULL,
        contract_id TEXT,
        contract_version INTEGER CHECK(contract_version IS NULL OR contract_version > 0),
        contract_content_sha256 TEXT,
        object_version INTEGER NOT NULL CHECK(object_version > 0),
        state_sha256 TEXT NOT NULL,
        event_cursor INTEGER NOT NULL DEFAULT 0 CHECK(event_cursor >= 0),
        projection_status TEXT NOT NULL DEFAULT 'current'
          CHECK(projection_status IN ('current','stale','error')),
        last_error TEXT,
        synced_at TEXT NOT NULL,
        FOREIGN KEY(long_run_id) REFERENCES long_runs(id) ON DELETE CASCADE,
        UNIQUE(domain, object_type, object_id)
      );
      CREATE INDEX IF NOT EXISTS idx_long_run_domain_bindings_status
        ON long_run_domain_bindings(domain, projection_status, synced_at DESC);
    `);
  }

  // v110: simulation/live is part of the durable graph-run identity. Without
  // this bit, reconciling an interrupted simulation resumed it as a live run,
  // and a later live click could also inherit a simulation checkpoint. Keep the
  // default live for historical rows because their original mode is unknowable;
  // all newly-created rows are explicit and mode-matched before resume.
  if (userVersion < 110 && tableExists(_db, "automation_runs")) {
    const runColumns = new Set(schemaColumns(_db, "automation_runs").map((column) => column.name));
    if (!runColumns.has("dry_run")) {
      _db.exec(
        "ALTER TABLE automation_runs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0 CHECK(dry_run IN (0, 1))",
      );
    }
  }

  // v111: append-only goal amendments; the v94 original remains unchanged.
  // No backfill: old requests cannot acquire invented message provenance.
  if (userVersion < 111) {
    _db.transaction(() => {
      _db!.exec(`
        CREATE TABLE IF NOT EXISTS chat_goal_revisions (
          goal_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0),
          source_message_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(goal_id, revision),
          UNIQUE(goal_id, source_message_id),
          FOREIGN KEY(goal_id) REFERENCES chat_goal_contracts(goal_id) ON DELETE CASCADE
        );
      `);
    })();
  }

  // v112: exact durable tool-consent identity columns.  The columns are also
  // checked in the version-independent REQUIRED_COLUMNS backstop above so a
  // partially upgraded v111 store cannot be queried without them.
  if (userVersion < 112 && tableExists(_db, "capability_grants")) {
    // No additional DDL is needed here; the backstop has already added every
    // column before this ladder reaches the version marker.
  }

  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `store_upgrade_failed: 스키마 ${userVersion} → ${SCHEMA_VERSION} 승급이 멈췄습니다 — ${reason}` +
        (upgradeBackupPath ? ` (승급 직전 사본: ${upgradeBackupPath})` : "") +
        " · user_version 은 그대로라 다음 실행도 같은 지점에서 멈춥니다. 사본으로 되돌린 뒤 보고해 주세요.",
      { cause: error instanceof Error ? error : undefined },
    );
  }

  if (userVersion < SCHEMA_VERSION) _db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } catch (error) {
    try { _db?.close(); } catch {}
    _db = null;
    _postContinuityRepairsDeferred = false;
    throw error;
  }
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

/**
 * Release this process's SQLite handles during a normal host shutdown. This
 * does not touch WAL/SHM files: another authorized process may still own read
 * marks, and SQLite alone decides when those sidecars can be retired.
 */
export function closeStore(): void {
  const db = _db;
  _db = null;
  _postContinuityRepairsDeferred = false;
  if (!db) return;
  db.close();
}
