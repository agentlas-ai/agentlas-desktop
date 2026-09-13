#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

function verifyProjectFirstAgentLibrary() {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer/app/(shell)/library/agents/page.tsx"), "utf8");
  assert.match(source, /useState<"all" \| "multi" \| "single">\("all"\)/, "the toolbox must open with one explicit All/Teams/Singles type axis");
  assert.match(source, /aria-label=\{locale === "ko" \? "도구 유형" : "Tool type"\}/, "the type switch must expose its purpose to assistive technology");
  assert.match(source, /placeholder=\{locale === "ko" \? "팀·에이전트·역할 검색" : "Search teams, agents, and roles"\}/, "the toolbox must offer recognition-first search across teams, agents, and roles");
  assert.match(source, /firm\.orgChart\.some\(\(node\) =>/, "team search must include bound member roles instead of only top-level team names");
  assert.match(source, /aria-valuenow=\{orgWidth\}/, "the toolbox resizer must expose its current width");
  assert.match(source, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/, "the toolbox resizer must support keyboard arrows");
  // ★ 2026-08-24: 이 방어는 오류 문구에서 **데이터 모양**으로 옮겨졌다. 던질 일이 없으니
  //   문구도 없다. 여기에 "주석이 남아 있는가" 를 단언해 봤지만 그것은 계약이 아니라 문장을
  //   못박는 것이라 뺐다 — 진짜 계약은 아래 rosterSource 단언이 지킨다(팀은 firm.id 로 키를
  //   잡고 releaseId 가 null 이라, 컨트롤러의 릴리스가 팀 릴리스 자리에 들어갈 수 없다).
  assert.match(source, /current\[firm\.id\] \?\? true/, "team trees must start collapsed to avoid an unbounded roster scan");
  assert.match(source, /data-testid="canonical-package-team-detail"/, "standalone team packages must use a team detail instead of generic single-agent tabs");
  assert.match(source, /attachStandaloneTeamToActiveProject/, "standalone team attachment must preserve team entity identity");
  assert.match(source, /Experience Chips 보기/, "team members must backlink to their own Experience Chips instead of copying team-owned experience");
  const rosterSource = fs.readFileSync(path.join(__dirname, "..", "renderer/lib/project-agent-roster.ts"), "utf8");
  assert.match(rosterSource, /targetId: firm\.id,[\s\S]*?releaseId: null/, "project rosters must not promote a controller binding into team identity");
  // ★ 2026-08-24: 차단 기준이 "컨트롤러가 원격이면" 에서 "신원이 없으면" 으로 좁혀졌다.
  //   예전 기준은 컨트롤러가 Cloud/Hub 에서 온 팀을 전부 막았는데, 설치된 팀 대부분이
  //   그렇다. 지금은 slug 도 정의 id 도 없는 행만 거절하고, **막는 이유를 화면에 남긴다.**
  assert.match(
    rosterSource,
    /callable: hasIdentity,[\s\S]{0,240}blockedReason:/,
    "a refused row must remain visibly blocked with a stated reason",
  );
  assert.match(rosterSource, /installedTeamProjectCandidate/, "exact remote team packages must remain available as canonical team candidates");
  const memorySource = fs.readFileSync(path.join(__dirname, "..", "electron/memory/store.ts"), "utf8");
  assert.match(memorySource, /scope = 'agent_repo' AND project_id IS NULL AND project_path IS NULL/, "global agent detail must not leak project-owned memory content");
  const ipcSource = fs.readFileSync(path.join(__dirname, "..", "electron/ipc.ts"), "utf8");
  assert.match(ipcSource, /agentId: projectController\.id/, "new project tasks must bind the project orchestrator explicitly");
  const projectDetailSource = fs.readFileSync(path.join(__dirname, "..", "renderer/app/(shell)/project/detail/page.tsx"), "utf8");
  assert.match(projectDetailSource, /onClick=\{\(\) => setTaskStartOpen\(true\)\}/, "New task must open the start-method chooser before creating anything");
  assert.match(projectDetailSource, /onClick=\{\(\) => setTaskStartOpen\(true\)\}/, "New task must open the explicit start chooser");
  assert.match(projectDetailSource, /aria-haspopup="dialog"[\s\S]*?aria-expanded=\{taskStartOpen\}/, "the task chooser must expose dialog state to assistive technology");
  assert.match(projectDetailSource, /새 채팅[\s\S]*CLI 세션 가져오기/, "the task chooser must offer a new conversation and project-owned CLI import");
  assert.match(projectDetailSource, /event\.key !== "Escape"[\s\S]*?setTaskStartOpen\(false\)/, "the task chooser must provide a keyboard-safe exit");
  assert.match(projectDetailSource, /tasks\.list\(\{ projectId: id, limit: 200, reconcile: false \}\)/, "project detail must request only its own tasks without repeating legacy repair work");
  const taskStoreSource = fs.readFileSync(path.join(__dirname, "..", "electron/store/tasks.ts"), "utf8");
  assert.match(taskStoreSource, /WHERE project_id = \? AND kind <> 'division'/, "project task reconciliation must not scan unrelated chats");
  assert.match(taskStoreSource, /projectId \? "AND project_id = \?"/, "project task queries must use the indexed project boundary");
  assert.match(taskStoreSource, /if \(input\.reconcile !== false\)/, "navigation reads must be able to skip repeated legacy reconciliation");
  const projectSidebarSource = fs.readFileSync(path.join(__dirname, "..", "renderer/components/ProjectSidebar.tsx"), "utf8");
  assert.match(projectSidebarSource, /tasks\.list\(\{ limit: 200, reconcile: false \}\)/, "the shared project sidebar must not rescan legacy chats on every route");
  const chatSource = fs.readFileSync(path.join(__dirname, "..", "electron/store/chats.ts"), "utf8");
  assert.match(chatSource, /repairRootChatSurfaceController/, "already-open root chats must normalize their controller from the owning surface");
  assert.match(chatSource, /DELETE FROM chat_runtime_sessions WHERE chat_id = \?/, "surface repair must delete stale provider sessions durably");
  assert.match(chatSource, /originSurface === "one" \? "agentlas-one" : "agentlas-orchestrator"/, "One and Work must have separate default controller identities");
  const streamSource = fs.readFileSync(path.join(__dirname, "..", "renderer/components/ChatStream.tsx"), "utf8");
  assert.match(streamSource, /가\\s\*생각\\s\*중\|is\\s\+thinking/, "agent-specific thinking labels must not leak into the Work project surface");
  const manifestSource = fs.readFileSync(path.join(__dirname, "..", "electron/architecture/manifest.ts"), "utf8");
  assert.match(manifestSource, /slug: GLOBAL_ORCHESTRATOR_SLUG,[\s\S]*?name: "Agentlas 오케스트레이터"/, "the project controller must not be branded as Agentlas One");
  assert.match(manifestSource, /slug: ONE_AGENT_SLUG,[\s\S]*?name: "Agentlas One"/, "One must keep its own immutable built-in identity");
  const mobileAuthoritySource = fs.readFileSync(path.join(__dirname, "..", "electron/mobile-bridge/authority.ts"), "utf8");
  assert.match(mobileAuthoritySource, /mobileOneConversationTitle[\s\S]*?originSurface: "one"/, "Mobile One must create a One-owned conversation, not a Work chat");
  const invocationSource = fs.readFileSync(path.join(__dirname, "..", "electron/invocation/service.ts"), "utf8");
  assert.match(invocationSource, /incoming\.oneMode === true && chat\.originSurface !== "one"/, "Work chats must fail closed before entering the One execution contract");
  assert.match(invocationSource, /chat\.originSurface === "one" && incoming\.oneMode !== true/, "One chats must fail closed before entering the Work execution contract");
  // 지켜야 할 것은 변수 이름이 아니라 경계다: One 투영은 **조건부로만** 붙고, 그 조건에
  // One 모드가 들어 있어야 한다. 옛 앵커는 이름(runWorkspaceBinding)을 못박고 있어서,
  // 그 이름이 remoteWorkspaceBinding 으로 바뀌자 멀쩡한 코드를 빨간불로 만들었다.
  assert.match(
    invocationSource,
    /if \(requestedOneMode \|\| \w*[Ww]orkspaceBinding\) \{\s*event = attachOneSurfaceProjection/,
    "Desktop Work must not mint One surface state",
  );
  assert.match(ipcSource, /if \(request\.oneMode === true\) \{[\s\S]*?prejudgeOneRequestIntent/, "One intent judges must be gated to explicit One turns");
  const taskCockpitSource = fs.readFileSync(path.join(__dirname, "..", "renderer/components/TaskCockpit.tsx"), "utf8");
  assert.doesNotMatch(taskCockpitSource, /oneAutoRecovery/, "Work runtime failures must not invoke the One recovery controller");
  assert.doesNotMatch(taskCockpitSource, /One이 현재 상태|One can inspect/, "Work runtime failures must use Work-owned recovery copy");
  const errorBoundarySource = fs.readFileSync(path.join(__dirname, "..", "renderer/components/ErrorBoundary.tsx"), "utf8");
  assert.doesNotMatch(errorBoundarySource, /One이 화면|One is restoring|One will continue/, "the shared render boundary must remain product-neutral");
  const rendererIpcSource = fs.readFileSync(path.join(__dirname, "..", "renderer/lib/ipc.ts"), "utf8");
  assert.doesNotMatch(rendererIpcSource, /requestOneOperationalRecovery|recoveryAwareClone/, "ordinary Work IPC failures must not create hidden One recovery turns");
  for (const relative of [
    "../renderer/app/(shell)/project/detail/page.tsx",
    "../renderer/app/(shell)/project/new/page.tsx",
    "../renderer/components/ProjectSidebar.tsx",
    "../renderer/components/WorkspacePanel.tsx",
    "../renderer/components/TaskCockpit.tsx",
    "../renderer/components/ProjectSettingsModal.tsx",
    "../renderer/components/ProjectAgentPicker.tsx",
  ]) {
    const workSurface = fs.readFileSync(path.join(__dirname, relative), "utf8");
    assert.doesNotMatch(workSurface, /requestOneOperationalRecovery|data-one-content-slot/, `${relative} must own its Work failure UX`);
    assert.doesNotMatch(workSurface, /One이 가능한 다음 행동|One can suggest/, `${relative} must not present One as a Work recovery actor`);
  }
}

async function main() {
  verifyProjectFirstAgentLibrary();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-project-first-v84-"));
  const dbPath = path.join(tempRoot, "agentlas.sqlite");
  const legacy = new Database(dbPath);
  legacy.pragma("foreign_keys = OFF");
  legacy.exec(`
    CREATE TABLE active_runtime (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      kind TEXT NOT NULL,
      backend TEXT,
      source TEXT,
      model TEXT,
      long_context INTEGER NOT NULL DEFAULT 0
    );
    -- v83 already had the project owner table in real stores. Keep the
    -- migration fixture aligned with that contract before initStore runs;
    -- later assertions may still use CREATE TABLE IF NOT EXISTS defensively.
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT,
      agent_pool_json TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL,
      source_ref TEXT,
      folder_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- ★ 2026-08-24: 예전에는 여기에 id/title/agent_group_id 만 두었다. 실제 그 시절 chats
    --   에는 소속(project_id·agent_id)과 시각(created_at·updated_at)이 이미 있었고, 뒤에
    --   생긴 좌석 마이그레이션이 그 열들을 읽는다. 가짜 데이터가 현실보다 앙상하면 시험은
    --   **실제로 일어나지 않는 실패**를 재현하고, 진짜 업그레이드 경로는 못 본다.
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      agent_group_id TEXT
    );
    CREATE INDEX idx_chats_agent_group_updated ON chats(agent_group_id);
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    -- 실제 그 시절 DB 에는 installed_agents 가 이미 있었다. 좌석 마이그레이션이 자리 이름을
    -- 여기서 읽으므로, 없는 채로 두면 현실에 없는 실패를 재현하게 된다.
    CREATE TABLE installed_agents (
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
    INSERT INTO installed_agents(id, slug, name, tagline, mcp_servers_json, trust_grade, installed_at, tone)
      VALUES ('agent-1', 'kept-agent', 'Kept agent', 'kept', '[]', 'B', '2026-01-01T00:00:00.000Z', '');
    -- agent_surfaces shipped at v19 and is therefore part of every valid v83
    -- store. v114 intentionally upgrades this table in place; omitting it here
    -- would model a corrupt/partial store rather than the v83 -> current path.
    CREATE TABLE agent_surfaces (
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
    CREATE INDEX idx_agent_surfaces_chat_updated
      ON agent_surfaces(chat_id, updated_at DESC);
    CREATE INDEX idx_agent_surfaces_domain_updated
      ON agent_surfaces(domain, updated_at DESC);
    CREATE INDEX idx_agent_surfaces_project_updated
      ON agent_surfaces(project_id, updated_at DESC);
    -- run_events shipped at v38. v118 reads this append-only ledger to seed
    -- per-run forget epochs, so a valid v83 fixture must retain the table even
    -- when it intentionally contains no historical runs.
    CREATE TABLE run_events (
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
    CREATE INDEX idx_run_events_run_seq ON run_events(run_id, seq);
    CREATE INDEX idx_run_events_ts ON run_events(ts DESC);
    CREATE INDEX idx_run_events_automation ON run_events(automation_id, ts DESC);
    CREATE TABLE telegram_bindings (
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
      updated_at TEXT NOT NULL,
      automation_report_enabled INTEGER NOT NULL DEFAULT 0,
      token_saved INTEGER NOT NULL DEFAULT 0,
      token_fingerprint TEXT
    );
    INSERT INTO chats(id, project_id, agent_id, title, created_at, updated_at, agent_group_id) VALUES
      ('group-ledger', NULL, 'agent-1', 'retired group', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'group-1'),
      ('agent-ledger', NULL, 'agent-1', 'kept agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO agent_groups(id, name) VALUES ('group-1', 'Retired');
    INSERT INTO telegram_bindings(
      id, target_kind, target_id, chat_session_id, status, created_at, updated_at,
      automation_report_enabled, token_saved
    ) VALUES
      ('binding-group', 'group', 'group-1', 'group-ledger', 'ready', 'now', 'now', 0, 0),
      ('binding-agent', 'agent', 'agent-1', 'agent-ledger', 'ready', 'now', 'now', 1, 1);
    PRAGMA user_version = 83;
  `);
  legacy.close();

  process.env.AGENTLAS_STORE_PATH = dbPath;
  app.setPath("userData", path.join(tempRoot, "user-data"));
  await app.whenReady();

  const store = require("../dist/electron/store/db.js");
  const projects = require("../dist/electron/store/projects.js");
  const chats = require("../dist/electron/store/chats.js");
  try {
    store.initStore({ deferPostContinuityRepairs: true });
    const db = store.getDb();
    assert.equal(
      db.pragma("user_version", { simple: true }),
      require("../package.json").agentlasUpdateCompatibility.targetSchemaVersion,
      "the v83 fixture must migrate through the current canonical schema",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='agent_groups'").get().n,
      0,
      "Agent Group storage must be removed",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('chats') WHERE name='agent_group_id'").get().n,
      0,
      "chat ownership must not retain agent_group_id",
    );
    assert.deepEqual(
      db.prepare("SELECT id, target_kind, chat_session_id FROM telegram_bindings ORDER BY id").all(),
      [{ id: "binding-agent", target_kind: "agent", chat_session_id: "agent-ledger" }],
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id='group-ledger'").get().n, 0);
    assert.throws(
      () => db.prepare(`INSERT INTO telegram_bindings(
        id, target_kind, target_id, status, created_at, updated_at
      ) VALUES ('forbidden', 'group', 'g', 'ready', 'now', 'now')`).run(),
      /CHECK constraint failed/,
      "the retired target kind must also be absent from the schema contract",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT,
      agent_pool_json TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL,
      source_ref TEXT,
      folder_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const toolPoolProject = projects.createProject({
      name: "Typed tool pool",
      sourceType: "local",
      agentPool: [
        {
          entityKind: "team",
          targetId: "firm-design",
          agentId: null,
          firmId: "firm-design",
          controllerAgentId: "agent-design-ceo",
          source: "local",
          releaseId: null,
          nameSnapshot: "Design Team",
        },
        {
          entityKind: "agent",
          targetId: "agd_exact_research",
          agentId: "agent-research-local",
          firmId: null,
          controllerAgentId: null,
          source: "hub",
          releaseId: "agr_exact_research_v1",
          nameSnapshot: "Researcher",
        },
      ],
    });
    assert.deepEqual(toolPoolProject.agentPool.map((member) => ({
      entityKind: member.entityKind,
      targetId: member.targetId,
      agentId: member.agentId,
      firmId: member.firmId,
      controllerAgentId: member.controllerAgentId,
      source: member.source,
      releaseId: member.releaseId,
    })), [
      {
        entityKind: "team",
        targetId: "firm-design",
        agentId: null,
        firmId: "firm-design",
        controllerAgentId: "agent-design-ceo",
        source: "local",
        releaseId: null,
      },
      {
        entityKind: "agent",
        targetId: "agd_exact_research",
        agentId: "agent-research-local",
        firmId: null,
        controllerAgentId: null,
        source: "hub",
        releaseId: "agr_exact_research_v1",
      },
    ], "team identity and exact remote agent identity must remain separate");

    db.exec(`CREATE TABLE IF NOT EXISTS installed_agents (
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
    )`);
    const insertAgent = db.prepare(`INSERT OR IGNORE INTO installed_agents(
      id, slug, name, tagline, system_prompt, mcp_servers_json,
      preferred_backend, trust_grade, installed_at, tone
    ) VALUES (?, ?, ?, '', '', '[]', NULL, 'A', 'now', 'green')`);
    insertAgent.run("test-one", "agentlas-one", "Agentlas One");
    insertAgent.run("test-project-controller", "agentlas-orchestrator", "Agentlas Orchestrator");
    const chatColumns = new Set(db.prepare("PRAGMA table_info(chats)").all().map((column) => column.name));
    for (const [name, ddl] of [
      ["project_id", "project_id TEXT"],
      ["firm_id", "firm_id TEXT"],
      ["agent_id", "agent_id TEXT"],
      ["archived_at", "archived_at TEXT"],
      ["created_at", "created_at TEXT"],
      ["updated_at", "updated_at TEXT"],
      ["kind", "kind TEXT"],
      ["parent_chat_id", "parent_chat_id TEXT"],
      ["working_folder", "working_folder TEXT"],
      ["continuous_mode", "continuous_mode INTEGER"],
      ["swarm_mode", "swarm_mode INTEGER"],
      ["origin_surface", "origin_surface TEXT"],
      ["runtime_selection_json", "runtime_selection_json TEXT"],
    ]) {
      if (!chatColumns.has(name)) db.exec(`ALTER TABLE chats ADD COLUMN ${ddl}`);
    }
    db.prepare(`INSERT INTO chats(
      id, project_id, firm_id, agent_id, title, created_at, updated_at, kind,
      continuous_mode, swarm_mode, origin_surface, runtime_selection_json
    ) VALUES ('legacy-work-one', ?, NULL, 'test-one', 'Legacy overlap', 'now', 'now', 'user', 0, 0, 'work', NULL)`).run(toolPoolProject.id);
    db.exec(`CREATE TABLE IF NOT EXISTS chat_runtime_sessions (
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, kind)
    )`);
    const overlapped = chats.getChat("legacy-work-one");
    assert.ok(overlapped, "legacy overlap fixture must be readable");
    db.prepare(`INSERT INTO chat_runtime_sessions(chat_id, kind, session_id, fingerprint, updated_at)
      VALUES ('legacy-work-one', 'codex', 'stale-one-session', 'stale-fingerprint', 'now')`).run();
    const repaired = chats.repairRootChatSurfaceController(overlapped);
    assert.equal(repaired.agentId, "test-project-controller", "Work project tasks must never execute as Agentlas One");
    assert.equal(repaired.originSurface, "work", "controller repair must preserve the owning Work surface");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_runtime_sessions WHERE chat_id='legacy-work-one'").get().n, 0,
      "surface identity repair must not resume the stale One provider session");

    const oneChat = chats.createChat({
      agentId: "test-project-controller",
      title: "One identity fixture",
      taskMode: "conversation",
      originSurface: "one",
    });
    assert.equal(oneChat.agentId, "test-one", "One root chats must bind the dedicated One identity");
    assert.equal(oneChat.originSurface, "one");

    const workChat = chats.createChat({
      agentId: "test-one",
      firmId: "legacy-firm",
      projectId: toolPoolProject.id,
      title: "Project identity fixture",
      taskMode: "task",
      originSurface: "work",
    });
    assert.equal(workChat.agentId, "test-project-controller", "project work must bind the project orchestrator");
    assert.equal(workChat.firmId, null, "project tools must not become the root firm controller");
    const legacyPoolProject = projects.createProject({
      name: "Legacy pool migration",
      sourceType: "local",
      agentPool: [{ agentId: "legacy-agent", source: "local", releaseId: null, nameSnapshot: "Legacy" }],
    });
    assert.deepEqual(legacyPoolProject.agentPool[0], {
      entityKind: "agent",
      targetId: "legacy-agent",
      agentId: "legacy-agent",
      firmId: null,
      controllerAgentId: null,
      source: "local",
      releaseId: null,
      nameSnapshot: "Legacy",
    }, "legacy pool rows must migrate additively instead of disappearing");
    assert.equal(db.pragma("foreign_key_check").length, 0);
    console.log("project-first current-schema migration passed");
  } finally {
    try { store.getDb().close(); } catch {}
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  /*
   * ★ app.quit() + process.exitCode 는 이 검사를 통째로 눈멀게 했다.
   *
   * quit() 은 종료를 시작하고 곧바로 돌아온다. 그 뒤에 exitCode 를 적어도 Electron 은
   * 이미 0 으로 끝나 버려, **어떤 실패도 초록으로 보고됐다.** 실제로 One 투영 경계를
   * 통째로 지우고 돌려도 exit 0 이었다. 검사가 있는 것과 검사가 도는 것은 다르다.
   *
   * app.exit(code) 는 그 코드로 즉시 끝낸다.
   */
  app.exit(1);
});
