import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { getRoute, getRoutesRevision, removeRoute, type AgentRoute } from "../agents/routes";
import { currentUiLocale } from "../ui-locale";

const uiText = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);

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
let localRepairRevision: number | null = null;

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
  if (route?.definitionHash) return `${kind}\u0000hash:${route.definitionHash}`;
  if (route && routeIsLive(route)) return `${kind}\u0000path:${routePathIdentity(route)}`;
  // ★ 여기부터는 "실행할 폴더가 없는" 고아 행이다.
  //
  // 로컬 에이전트의 신원(폴더 경로·지문)은 DB 열이 아니라 사이드카 파일
  // `userData/agent-routes.json` 에만 산다. 그래서 신원이 사라지는 길이 둘이다.
  //   1) 라우트는 있는데 폴더가 사라짐 — 임시 폴더에서 반복 설치된 사본이 그렇다.
  //      실측 2026-08-23: 같은 에이전트 43개가 각각 다른 pytest 임시 경로로 남았다.
  //   2) **라우트 자체가 없음**(사이드카 유실). 예전 수리는 이 자리에서
  //      `if (!route) return null` 로 빠져나가 2번을 통째로 못 봤다.
  //      실측 2026-09-14 오너 DB: 223행 중 141행에 라우트가 없었고, 같은 에이전트가
  //      53행(Founder Studio)·11행(Upload Gate Probe) 쌓였는데도 중복정리는 0건이었다.
  //
  // 두 경우 다 실행 경로가 없다는 점에서 같으므로 내용으로 묶는다. 살아 있는 import 는
  // 위에서 이미 반환됐으므로, 서로 다른 두 **살아 있는** 로컬 패키지가 이 갈래에서
  // 합쳐지는 일은 생기지 않는다.
  return orphanContentIdentity(row);
}

/**
 * 실행 경로를 잃은 행의 내용 신원 — 종류 + 이름 + 시스템 프롬프트 전문 해시.
 *
 * 이름은 표현 메타데이터라 단독으로는 신원이 아니다. 여기서는 프롬프트 전문이
 * 바이트까지 같을 때 마지막으로 한 번 더 가르는 용도로만 쓴다. 중복정리와
 * 가져오기(import)가 **같은 함수**로 같은 판정을 쓰도록 내보낸다.
 */
export function orphanContentIdentity(row: {
  entity_kind?: "agent" | "team" | null;
  name?: string | null;
  slug?: string | null;
  system_prompt?: string | null;
}): string | null {
  const prompt = (row.system_prompt ?? "").trim();
  if (!prompt) return null;
  const kind = row.entity_kind ?? "agent";
  const base = `${kind}\u0000content:${normalizeIdentityPart(row.name)}\u0000${sha256(prompt)}`;
  if (prompt.length >= MIN_CONTENT_IDENTITY_PROMPT) return base;
  // ★ 내용이 약하면 **독립된 증거 하나를 더** 요구한다.
  //
  // 가져오기는 프롬프트 파일을 못 읽으면 `You are <이름>, a locally imported agent.` 를
  // 대신 넣는다. 66자짜리 이 문장은 사실상 이름뿐이라 내용 신원이라 할 수 없고,
  // 그래서 최소 길이(200자)에 걸려 판정이 포기된다 — 실측 2026-09-14 오너 DB 에
  // 이 계열로만 같은 에이전트가 53행 쌓여 있었다.
  //
  // 그렇다고 길이 기준을 낮추면 서로 다른 패키지가 부트스트랩 문구 하나로 합쳐진다.
  // 대신 slug 밑동을 같이 본다. slug 는 폴더 이름에서 만들어지고 중복될 때만
  // `-2`, `-3` … 이 붙으므로, 밑동은 "같은 폴더에서 다시 들어왔다"는 흔적이다.
  // 종류·이름·프롬프트 전문·slug 밑동이 **전부** 같아야 하므로 과합치기 위험은 낮다.
  const slugBase = normalizeIdentityPart(row.slug).replace(/-\d+$/, "");
  if (!slugBase) return null;
  return `${base}\u0000slug:${slugBase}`;
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

/** 표의 유니크 인덱스(암시적 PRIMARY KEY 포함) 열 묶음. */
function uniqueIndexColumnSets(db: Database.Database, table: string): string[][] {
  let indexes: Array<{ name: string; unique: number }> = [];
  try {
    indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as Array<{ name: string; unique: number }>;
  } catch {
    return [];
  }
  const sets: string[][] = [];
  for (const index of indexes) {
    if (!index.unique || !IDENTIFIER.test(index.name)) continue;
    let info: Array<{ name: string | null }> = [];
    try {
      info = db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as Array<{ name: string | null }>;
    } catch {
      continue;
    }
    const columns = info.map((entry) => entry.name).filter((name): name is string => Boolean(name));
    // 식(expression) 인덱스는 열 이름이 null 로 오므로 통째로 건너뛴다.
    if (columns.length !== info.length || columns.length === 0) continue;
    sets.push(columns);
  }
  return sets;
}

/**
 * 옮겨지지 못한 행 중 **정본이 이미 같은 것을 갖고 있어서** 못 옮긴 행만 지운다.
 *
 * 위의 `UPDATE OR IGNORE` 는 유니크 충돌이 나면 행을 조용히 건너뛴다. 건너뛴 이유는
 * 두 가지인데 뜻이 정반대다.
 *   (가) 정본에 같은 유니크 키의 행이 이미 있다 → 그 행은 **중복**이고, 지워도 잃는 정보가 없다.
 *   (나) 그 밖의 이유 → 진짜 손실이므로 병합을 포기해야 한다.
 * 둘을 못 가르면 (가) 하나 때문에 병합 전체가 멈춘다. 실측 2026-09-14 오너 DB:
 * `agent_architecture_migrations` 의 PRIMARY KEY(agent_id, step_id) 충돌 하나로
 * 중복 62행이 **한 건도** 합쳐지지 못했다(정본은 같은 step 4개를 이미 갖고 있었다).
 *
 * 유니크 인덱스 열을 그대로 읽어 정본 쪽 짝을 찾고, 짝이 실제로 있을 때만 지운다.
 * 짝을 못 찾은 행은 그대로 남겨 두어 호출부의 손실 검사가 병합을 중단시킨다.
 */
function dropRedundantStrandedRows(
  db: Database.Database,
  table: string,
  column: string,
  duplicateId: string,
  canonicalId: string,
): void {
  const columnSets = uniqueIndexColumnSets(db, table).filter((columns) => columns.includes(column));
  if (columnSets.length === 0) return;
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  let stranded: Array<Record<string, unknown>>;
  try {
    stranded = db
      .prepare(`SELECT rowid AS __dedupe_rowid, * FROM ${quotedTable} WHERE ${quotedColumn} = ?`)
      .all(duplicateId) as Array<Record<string, unknown>>;
  } catch {
    // WITHOUT ROWID 표는 안전하게 건드리지 않는다.
    return;
  }
  for (const row of stranded) {
    for (const columns of columnSets) {
      const others = columns.filter((name) => name !== column);
      const where = [`${quotedColumn} = ?`, ...others.map((name) => `${quoteIdentifier(name)} IS ?`)].join(" AND ");
      const twin = db
        .prepare(`SELECT 1 FROM ${quotedTable} WHERE ${where} LIMIT 1`)
        .get(canonicalId, ...others.map((name) => row[name] ?? null));
      if (!twin) continue;
      db.prepare(`DELETE FROM ${quotedTable} WHERE rowid = ?`).run(row.__dedupe_rowid);
      break;
    }
  }
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
    // 정본이 이미 같은 유니크 키를 갖고 있어 못 옮긴 행은 손실이 아니라 중복이다.
    dropRedundantStrandedRows(db, reference.table, reference.column, duplicateId, canonicalId);
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
        `agent_merge_would_orphan: ` + uiText(
          `${reference.table}.${reference.column} 에 ${stranded}행이 남아 병합을 중단했습니다 (duplicate=${duplicateId}). 이대로 지우면 그 행들이 함께 사라집니다.`,
          `merge stopped because ${stranded} row(s) remain in ${reference.table}.${reference.column} (duplicate=${duplicateId}); deleting now would lose them.`,
        ),
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
 * 라우트를 잃은 고아 행 되찾기 — 사이드카가 없어도 **가져오기 자체가** 멱등하도록.
 *
 * 가져오기는 "같은 에이전트인가"를 오직 `agent-routes.json` 으로만 판단했다. 그래서
 * 사이드카가 유실되면 같은 폴더를 다시 가져와도 매번 새 행 + 새 slug(`local-…-2`,
 * `-3`, …)가 생겼다. 실측 2026-09-14 오너 DB 에 한 에이전트가 53행까지 쌓였다.
 *
 * 사후 청소(중복정리)만으로는 유입을 못 막으므로 쓰기 쪽도 같은 판정을 쓴다.
 * **살아 있는 라우트를 가진 행은 건드리지 않는다** — 그 행의 신원 권위는 경로다.
 */
export function findAdoptableOrphanAgentId(input: {
  kind: "agent" | "team";
  name: string;
  /** 이번 가져오기가 만들려는 slug 밑동 (폴더 이름에서 유도). */
  slug: string;
  systemPrompt: string;
}): string | null {
  const signature = orphanContentIdentity({
    entity_kind: input.kind,
    name: input.name,
    slug: input.slug,
    system_prompt: input.systemPrompt,
  });
  if (!signature) return null;
  const db = getDb();
  const rows = db.prepare("SELECT * FROM installed_agents ORDER BY installed_at ASC").all() as AgentRow[];
  const candidates = rows.filter((row) => {
    // 팀 구성원 칸은 독립 자산이 아니다 — 팀 등록 경로가 따로 소유한다.
    if (row.parent_team_id) return false;
    const route = getRoute(row.id);
    if (route && routeIsLive(route)) return false;
    return localIdentityKey(row, route) === signature;
  });
  if (candidates.length === 0) return null;
  // 후보가 여럿이면 전부 같은 내용의 고아다. 가장 오래된 정본을 되찾고 나머지는
  // 중복정리가 그 정본으로 합친다.
  return canonicalRow(candidates).id;
}

/**
 * Idempotently collapse legacy local duplicates. This runs at startup and on
 * team.list(), so a stale renderer can never resurrect rows after repair.
 */
export function dedupeLocalInstalledAgents(): DedupeResult {
  const routeRevision = getRoutesRevision();
  if (localRepairComplete && localRepairRevision === routeRevision) {
    return { groups: 0, merged: 0, firmGroups: 0, firmsMerged: 0 };
  }
  localRepairComplete = true;
  try {
    const result = dedupeLocalInstalledAgentsOnce();
    // Route removals during the pass can advance the revision. Record the
    // final generation so an unchanged route map remains idempotent.
    localRepairRevision = getRoutesRevision();
    return result;
  } catch (error) {
    localRepairComplete = false;
    localRepairRevision = null;
    throw error;
  }
}

/**
 * 고아 행은 같은 내용의 **살아 있는** 행에 흡수돼야 한다.
 *
 * 고아는 실행할 폴더가 없으므로 살아 있는 행에 합쳐도 잃을 것이 없다. 반대로 합치지
 * 않으면 "진짜 그 에이전트 1장 + 신원 잃은 사본 1장"이 나란히 남아, 오너 화면에는
 * 여전히 중복으로 보인다. 다만 같은 내용 서명을 가진 살아 있는 행이 **둘 이상**이면
 * 어느 쪽으로 보낼지 확정할 수 없으므로 흡수하지 않는다(모호하면 건드리지 않는다).
 */
function liveIdentityKeyByContent(entries: Array<{ row: AgentRow; route: AgentRoute | null; key: string | null }>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const entry of entries) {
    if (!entry.key || !entry.route || !routeIsLive(entry.route)) continue;
    const signature = orphanContentIdentity(entry.row);
    if (!signature) continue;
    if (!map.has(signature)) map.set(signature, entry.key);
    else if (map.get(signature) !== entry.key) map.set(signature, null);
  }
  return map;
}

function dedupeLocalInstalledAgentsOnce(): DedupeResult {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM installed_agents ORDER BY installed_at ASC").all() as AgentRow[];
  const entries = rows.map((row) => {
    const route = getRoute(row.id);
    return { row, route, key: localIdentityKey(row, route) };
  });
  const liveKeyByContent = liveIdentityKeyByContent(entries);

  const groups = new Map<string, AgentRow[]>();
  for (const entry of entries) {
    let key = entry.key;
    if (!key) continue;
    if (!entry.route || !routeIsLive(entry.route)) {
      const signature = orphanContentIdentity(entry.row);
      const liveKey = signature ? liveKeyByContent.get(signature) : undefined;
      if (liveKey) key = liveKey;
    }
    const group = groups.get(key) ?? [];
    group.push(entry.row);
    groups.set(key, group);
  }

  let merged = 0;
  const changedRoutes: string[] = [];
  // ★ 합치기는 묶음마다 따로 커밋한다. 한 묶음이 `agent_merge_would_orphan` 으로 멈추면
  // 예전에는 트랜잭션 하나가 통째로 되감겨 **나머지 정상 묶음까지 한 건도 안 고쳐졌다**.
  // 수리는 되는 데까지 가고, 못 간 곳은 이유를 남긴다.
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = canonicalRow(group);
    for (const duplicate of group) {
      if (duplicate.id === canonical.id) continue;
      try {
        db.transaction(() => {
          mergeReferences(db, duplicate.id, canonical.id);
          db.prepare("DELETE FROM installed_agents WHERE id = ?").run(duplicate.id);
        })();
      } catch (error) {
        console.warn(
          `[agents] duplicate merge skipped (duplicate=${duplicate.id} canonical=${canonical.id})`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      changedRoutes.push(duplicate.id);
      merged += 1;
    }
  }

  const firmResult = db.transaction(() => dedupeLocalInstalledFirms(db, changedRoutes))();
  for (const id of changedRoutes) removeRoute(id);
  return {
    groups: [...groups.values()].filter((group) => group.length > 1).length,
    merged,
    firmGroups: firmResult.groups,
    firmsMerged: firmResult.merged,
  };
}
