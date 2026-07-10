// 로컬 영구 저장 — userData/agentlas.sqlite.
// PRD 6.1: better-sqlite3, 동기 API라 IPC 핸들러에서 그대로 호출 가능.
// 채팅 로그는 기본 로컬 — 클라우드 백업은 사용자 명시 토글에만 (PRD 6.3).
//
// 스키마 버전 관리: user_version pragma로 마이그레이션. M0 → projects/chats 도입 시 chat_messages 재구성.
import Database from "better-sqlite3";
import path from "node:path";
import { app } from "electron";
import { publicAgentVisibility } from "../agents/policy";

let _db: Database.Database | null = null;

const SCHEMA_VERSION = 50;

type SchemaColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
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

export function initStore(): void {
  if (_db) return;
  const dbPath = process.env.AGENTLAS_STORE_PATH || path.join(app.getPath("userData"), "agentlas.sqlite");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
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
        title TEXT NOT NULL DEFAULT '새 채팅',
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
  //   fingerprint: 시스템 프롬프트/권한/표면 모드/모델/effort가 바뀌면 새 세션을 시작하기 위한 해시.
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
        status TEXT,
        node_states_json TEXT
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

  _db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error("Store not initialized. Call initStore() in app.whenReady().");
  }
  return _db;
}
