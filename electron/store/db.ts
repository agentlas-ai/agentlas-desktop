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

const SCHEMA_VERSION = 36;

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
        FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
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
  // tool_mode: auto | browser | computer-use. 브라우저 자동화가 Playwright/CUA 중
  // 어느 길로 갈지 조용히 추측하지 않고 사용자가 저장한 선택을 따른다.
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

  _db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error("Store not initialized. Call initStore() in app.whenReady().");
  }
  return _db;
}
