import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { getRoute, removeRoute, type AgentRoute } from "../agents/routes";

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  system_prompt: string;
  mcp_servers_json: string;
  env_requirements_json: string;
  preferred_backend: string | null;
  trust_grade: string;
  installed_at: string;
  tone: string;
  builtin: number;
  role: string | null;
  visibility: string;
  entity_kind: "agent" | "team" | null;
  local_display_name?: string | null;
  parent_team_id?: string | null;
};

type DedupeResult = {
  groups: number;
  merged: number;
  firmGroups: number;
  firmsMerged: number;
};

let localRepairComplete = false;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function normalizeIdentityPart(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function routeIsLocal(route: AgentRoute | null): boolean {
  return !route || route.source === "local-import";
}

function routeIsLive(route: AgentRoute | null): boolean {
  if (!route) return false;
  try {
    return fs.existsSync(route.path);
  } catch {
    return false;
  }
}

/**
 * A route path is only a legacy fallback identity. Resolve symlinks when the
 * folder exists so two route records for one folder collapse, but never use
 * presentation metadata (name/tagline) as a substitute for content identity.
 */
function routePathIdentity(route: AgentRoute): string {
  const resolved = path.resolve(route.path);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * A local import is one user-owned identity, not one UUID per import attempt.
 * Older releases had no stable identity and generated `slug-2`, `slug-3`, …
 * for the same folder/package. We repair only local rows with the same kind,
 * definition hash, or the exact source path for legacy routes that have not
 * been fingerprinted yet. Presentation metadata is deliberately excluded:
 * two unrelated local packages can share a boilerplate name/tagline/prompt.
 * Hub/Cloud rows are never merged here.
 */
function localIdentityKey(row: AgentRow, route: AgentRoute | null): string | null {
  if (row.builtin) return null;
  if (!routeIsLocal(route)) return null;
  const kind = row.entity_kind ?? route?.kind ?? "agent";
  if (!route) return null;
  if (route.definitionHash) return `${kind}\u0000hash:${route.definitionHash}`;
  // 원본 폴더가 사라진 행은 경로로 묶을 수 없다. 임시 폴더에서 반복 설치된 사본이 그렇다 —
  // 실측 2026-08-23: 같은 에이전트 43개가 각각 다른 pytest 임시 경로를 들고 남아 목록을 뒤덮었다.
  // 죽은 경로에 한해 내용(종류·이름·시스템 프롬프트 전문)으로 묶는다. 살아 있는 import 는
  // 절대 이 갈래로 오지 않으므로, 서로 다른 두 로컬 패키지가 합쳐질 위험은 생기지 않는다.
  if (!routeIsLive(route)) {
    const prompt = (row.system_prompt ?? "").trim();
    if (prompt.length >= MIN_CONTENT_IDENTITY_PROMPT) {
      return `${kind}\u0000dead-content:${row.name}\u0000${sha256(prompt)}`;
    }
    return null;
  }
  return `${kind}\u0000path:${routePathIdentity(route)}`;
}

/** 부트스트랩 문구 하나로 서로 다른 패키지가 합쳐지지 않도록 최소 길이를 둔다. */
const MIN_CONTENT_IDENTITY_PROMPT = 200;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type FirmRow = {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  ceo_agent_id: string;
  org_chart_json: string;
  installed_at: string;
};

function firmIsLocal(firm: FirmRow): boolean {
  const route = getRoute(firm.ceo_agent_id);
  return Boolean(route) && routeIsLocal(route);
}

function localFirmIdentityKey(firm: FirmRow): string | null {
  if (!firmIsLocal(firm)) return null;
  const route = getRoute(firm.ceo_agent_id);
  if (!route) return null;
  if (route.definitionHash) return `team\u0000hash:${route.definitionHash}`;
  return `team\u0000path:${routePathIdentity(route)}`;
}

function firmCanonicalRow(rows: FirmRow[]): FirmRow {
  return [...rows].sort((a, b) => {
    const aRoute = getRoute(a.ceo_agent_id);
    const bRoute = getRoute(b.ceo_agent_id);
    const liveDelta = Number(routeIsLive(bRoute)) - Number(routeIsLive(aRoute));
    if (liveDelta !== 0) return liveDelta;
    const aDate = Date.parse(a.installed_at);
    const bDate = Date.parse(b.installed_at);
    if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) return aDate - bDate;
    return a.id.localeCompare(b.id);
  })[0];
}

function referencedFirmTables(db: Database.Database): Array<{ table: string; column: string }> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string | null }>;
  const result: Array<{ table: string; column: string }> = [];
  for (const table of rows) {
    if (table.name === "firms" || !table.sql) continue;
    let columns: Array<{ name: string }> = [];
    try {
      columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{ name: string }>;
    } catch {
      continue;
    }
    for (const column of columns) {
      if (column.name === "firm_id") result.push({ table: table.name, column: column.name });
    }
  }
  return result;
}

function mergeFirmReferences(db: Database.Database, duplicateId: string, canonicalId: string): void {
  for (const reference of referencedFirmTables(db)) {
    db.prepare(
      `UPDATE OR IGNORE ${quoteIdentifier(reference.table)} SET ${quoteIdentifier(reference.column)} = ? WHERE ${quoteIdentifier(reference.column)} = ?`,
    ).run(canonicalId, duplicateId);
  }
}

function parseFirmChart(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function nodeIdentity(node: Record<string, unknown>): string {
  return `${normalizeIdentityPart(String(node.role ?? ""))}\u0000${normalizeIdentityPart(String(node.reportsTo ?? ""))}`;
}

function mergeDuplicateFirm(db: Database.Database, canonical: FirmRow, duplicate: FirmRow, changedRoutes: string[]): void {
  const canonicalChart = parseFirmChart(canonical.org_chart_json);
  const duplicateChart = parseFirmChart(duplicate.org_chart_json);
  const canonicalByIdentity = new Map(canonicalChart.map((node) => [nodeIdentity(node), node]));
  const deleteMembers: Array<{ duplicateId: string; canonicalId: string }> = [];

  for (const node of duplicateChart) {
    const duplicateId = typeof node.agentId === "string" ? node.agentId : "";
    const match = canonicalByIdentity.get(nodeIdentity(node));
    const canonicalId = match && typeof match.agentId === "string" ? match.agentId : "";
    if (duplicateId && canonicalId && duplicateId !== canonicalId) {
      const duplicateAgent = db
        .prepare("SELECT parent_team_id, system_prompt FROM installed_agents WHERE id = ?")
        .get(duplicateId) as { parent_team_id: string | null; system_prompt: string } | undefined;
      // Only collapse synthetic member cells. A separately installed worker
      // with its own prompt remains a real asset and is retained in the chart.
      if (duplicateAgent?.parent_team_id === duplicate.id && !duplicateAgent.system_prompt.trim()) {
        mergeReferences(db, duplicateId, canonicalId);
        deleteMembers.push({ duplicateId, canonicalId });
      }
    } else if (duplicateId && !match) {
      const member = db
        .prepare("SELECT parent_team_id FROM installed_agents WHERE id = ?")
        .get(duplicateId) as { parent_team_id: string | null } | undefined;
      if (member?.parent_team_id === duplicate.id) {
        db.prepare("UPDATE installed_agents SET parent_team_id = ? WHERE id = ?").run(canonical.id, duplicateId);
        canonicalChart.push(node);
        canonicalByIdentity.set(nodeIdentity(node), node);
      }
    }
  }

  mergeFirmReferences(db, duplicate.id, canonical.id);
  db.prepare("UPDATE firms SET org_chart_json = ? WHERE id = ?").run(JSON.stringify(canonicalChart), canonical.id);
  db.prepare("DELETE FROM firms WHERE id = ?").run(duplicate.id);
  for (const member of deleteMembers) {
    db.prepare("DELETE FROM installed_agents WHERE id = ? AND parent_team_id = ?").run(member.duplicateId, duplicate.id);
    changedRoutes.push(member.duplicateId);
  }
}

function dedupeLocalInstalledFirms(db: Database.Database, changedRoutes: string[]): { groups: number; merged: number } {
  const rows = db.prepare("SELECT * FROM firms ORDER BY installed_at ASC").all() as FirmRow[];
  const groups = new Map<string, FirmRow[]>();
  for (const row of rows) {
    const key = localFirmIdentityKey(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = firmCanonicalRow(group);
    for (const duplicate of group) {
      if (duplicate.id === canonical.id) continue;
      mergeDuplicateFirm(db, canonical, duplicate, changedRoutes);
      merged += 1;
    }
  }
  return { groups: [...groups.values()].filter((group) => group.length > 1).length, merged };
}

function referencedTables(db: Database.Database): Array<{ table: string; column: string }> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string | null }>;
  const result: Array<{ table: string; column: string }> = [];
  for (const table of rows) {
    if (table.name === "installed_agents" || !table.sql) continue;
    let columns: Array<{ name: string }> = [];
    try {
      columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{ name: string }>;
    } catch {
      continue;
    }
    for (const column of columns) {
      if (["agent_id", "installed_agent_id", "default_agent_id"].includes(column.name)) {
        result.push({ table: table.name, column: column.name });
      }
    }
  }
  return result;
}

function updateFirmReferences(db: Database.Database, duplicateId: string, canonicalId: string): void {
  const firms = db
    .prepare("SELECT id, ceo_agent_id, org_chart_json FROM firms")
    .all() as Array<{ id: string; ceo_agent_id: string; org_chart_json: string }>;
  const update = db.prepare("UPDATE firms SET ceo_agent_id = ?, org_chart_json = ? WHERE id = ?");
  for (const firm of firms) {
    let changed = firm.ceo_agent_id === duplicateId;
    let chart = firm.org_chart_json;
    try {
      const parsed = JSON.parse(chart) as Array<{ agentId?: string }>;
      for (const node of parsed) {
        if (node.agentId === duplicateId) {
          node.agentId = canonicalId;
          changed = true;
        }
      }
      if (changed) chart = JSON.stringify(parsed);
    } catch {
      // Keep malformed legacy JSON untouched; the firm resolver will report it.
    }
    if (changed) update.run(firm.ceo_agent_id === duplicateId ? canonicalId : firm.ceo_agent_id, chart, firm.id);
  }
}

/**
 * 좌석은 옮기기 전에 겹치는지 본다.
 *
 * ★ 왜. 아래 재지정은 `UPDATE OR IGNORE` 라, 표에 유일 제약이 있으면 겹치는 행을 조용히
 * 건너뛴다. 그런데 One 조직 멤버 표에는 그 제약이 없다 — 같은 봇이 두 번 앉는 것은
 * 코드가 막고 있고, 이 합치기 경로는 그 코드를 지나지 않는다. 그래서 겹치는 봇을 합칠 때
 * 좌석까지 그대로 옮기면 **같은 봇이 두 자리에 앉은 상태**가 만들어진다.
 *
 * 살아남는 쪽이 이미 앉아 있으면 사라지는 쪽의 좌석 행을 지운다. 앉아 있지 않으면
 * 아래 재지정이 그 자리를 그대로 물려받는다 — 자리는 사라지지 않는다.
 */
function mergeOneOrgSeats(db: Database.Database, duplicateId: string, canonicalId: string): void {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'one_org_members'")
    .get();
  if (!hasTable) return;
  const canonicalSeated = db
    .prepare("SELECT 1 FROM one_org_members WHERE installed_agent_id = ? LIMIT 1")
    .get(canonicalId);
  if (!canonicalSeated) return;
  db.prepare("DELETE FROM one_org_members WHERE installed_agent_id = ?").run(duplicateId);
}

function mergeReferences(db: Database.Database, duplicateId: string, canonicalId: string): void {
  updateFirmReferences(db, duplicateId, canonicalId);
  mergeOneOrgSeats(db, duplicateId, canonicalId);
  for (const reference of referencedTables(db)) {
    const table = quoteIdentifier(reference.table);
    const column = quoteIdentifier(reference.column);
    // OR IGNORE handles per-agent singleton rows (for example an exact
    // binding/asset version) without aborting the whole repair transaction.
    db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(canonicalId, duplicateId);
    // ★ 건너뛴 행이 남으면 **삭제하면 안 된다.** 바로 다음 단계가
    // `DELETE FROM installed_agents` 이고, 그 표들 중 12곳이 ON DELETE CASCADE 다
    // (경험칩·후보·승급영수증·자동수집영수증·대화). OR IGNORE 가 유니크 충돌로
    // 조용히 건너뛴 행은 옮겨지지 못한 채 **삭제에 딸려간다** — 사용자에게 확인도,
    // 오류도 없이. 남은 게 있으면 이 병합을 통째로 포기하는 편이 낫다.
    const stranded = (db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(duplicateId) as { n: number }).n;
    if (stranded > 0) {
      throw new Error(
        `agent_merge_would_orphan: ${reference.table}.${reference.column} 에 ${stranded}행이 남아 ` +
          `병합을 중단했습니다 (duplicate=${duplicateId}). 이대로 지우면 그 행들이 함께 사라집니다.`,
      );
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_overrides'").get()) {
    db.prepare("UPDATE OR IGNORE agent_runtime_overrides SET target_id = ? WHERE scope = 'agent' AND target_id = ?")
      .run(canonicalId, duplicateId);
  }
}

function canonicalRow(rows: AgentRow[]): AgentRow {
  return [...rows].sort((a, b) => {
    const aRoute = getRoute(a.id);
    const bRoute = getRoute(b.id);
    const liveDelta = Number(routeIsLive(bRoute)) - Number(routeIsLive(aRoute));
    if (liveDelta !== 0) return liveDelta;
    const aDate = Date.parse(a.installed_at);
    const bDate = Date.parse(b.installed_at);
    if (Number.isFinite(aDate) && Number.isFinite(bDate) && aDate !== bDate) return aDate - bDate;
    return a.id.localeCompare(b.id);
  })[0];
}

/**
 * Idempotently collapse legacy local duplicates. This runs at startup and on
 * team.list(), so a stale renderer can never resurrect rows after repair.
 */
export function dedupeLocalInstalledAgents(): DedupeResult {
  if (localRepairComplete) return { groups: 0, merged: 0, firmGroups: 0, firmsMerged: 0 };
  localRepairComplete = true;
  try {
    return dedupeLocalInstalledAgentsOnce();
  } catch (error) {
    localRepairComplete = false;
    throw error;
  }
}

function dedupeLocalInstalledAgentsOnce(): DedupeResult {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM installed_agents ORDER BY installed_at ASC").all() as AgentRow[];
  const groups = new Map<string, AgentRow[]>();
  for (const row of rows) {
    const key = localIdentityKey(row, getRoute(row.id));
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let merged = 0;
  const changedRoutes: string[] = [];
  const tx = db.transaction(() => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const canonical = canonicalRow(group);
      for (const duplicate of group) {
        if (duplicate.id === canonical.id) continue;
        mergeReferences(db, duplicate.id, canonical.id);
        db.prepare("DELETE FROM installed_agents WHERE id = ?").run(duplicate.id);
        changedRoutes.push(duplicate.id);
        merged += 1;
      }
    }
  });
  tx();

  const firmResult = db.transaction(() => dedupeLocalInstalledFirms(db, changedRoutes))();
  for (const id of changedRoutes) removeRoute(id);
  return {
    groups: [...groups.values()].filter((group) => group.length > 1).length,
    merged,
    firmGroups: firmResult.groups,
    firmsMerged: firmResult.merged,
  };
}
