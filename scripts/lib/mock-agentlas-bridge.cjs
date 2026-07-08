// Shared mock preload bridge for renderer UI smokes.
// scripts/test-desktop-feature-surfaces.cjs와 scripts/smoke-renderer-ui.cjs가 공유한다.
// 주의: playwright addInitScript로 직렬화되므로 이 함수는 self-contained여야 한다
// (모듈 스코프 변수/클로저 참조 금지 — 함수 본문 안에서 모든 것을 정의).
function setupMockAgentlasBridge(options) {
  function makeHubCatalog(total) {
    return Array.from({ length: total }, (_, index) => {
      if (index === 0) {
        return {
          slug: "fda-samd-510k-readiness-desk",
          name: "FDA SaMD 510(k) 사전 승인 준비 데스크",
          nameEn: "FDA SaMD 510(k) Pre-market Notification Readiness Desk",
          tagline: "Callable Hub team",
          taglineEn: "Callable Hub team",
          trustGrade: "A",
          installCount: 0,
          manifestUrl: "mock",
          kind: "cloud-callable",
          callable: true,
          source: "hub-index",
          entityKind: "team",
          perCallCredits: 10,
        };
      }
      const n = String(index + 1).padStart(3, "0");
      return {
        slug: `hub-agent-${n}`,
        name: `허브 에이전트 ${n}`,
        nameEn: `Hub Agent ${n}`,
        tagline: "Callable Hub agent",
        taglineEn: "Callable Hub agent",
        trustGrade: "A",
        installCount: total - index,
        manifestUrl: "mock",
        kind: "cloud-callable",
        callable: true,
        source: "hub-profile",
        entityKind: "agent",
        perCallCredits: 3,
      };
    });
  }

  const now = new Date().toISOString();
  const calls = [];
  const eventHandlers = {};
  function readStoredAutomations() {
    try {
      const raw = window.localStorage.getItem("agentlas.qa.automations");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  const automations = readStoredAutomations();
  function saveAutomations() {
    try {
      window.localStorage.setItem("agentlas.qa.automations", JSON.stringify(automations));
    } catch {}
  }
  let runtimeOverrides = [];
  const workspaceFolders = {};
  let lastRunId = 0;
  let createdChatId = 0;
  const pendingConfirmations = Array.from({ length: options?.pendingConfirmations ?? 0 }, (_, index) => ({
    chatId: `confirm-chat-${index + 1}`,
    chatTitle: `QA approval ${index + 1}`,
    question: index === 0 ? "배포 전 공개 여부를 승인해 주세요" : "Approve public visibility before deploy",
    optionCount: 2,
    createdAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
  }));

  function record(name, payload) {
    calls.push({ name, payload });
  }
  function emit(channel, payload) {
    for (const handler of eventHandlers[channel] || []) handler(payload);
  }
  function localized(obj) {
    return obj;
  }

  try {
    window.localStorage.setItem("agentlas.onboarded", "1");
    window.localStorage.setItem("agentlas.shellTour.dismissed.v1", "1");
    window.localStorage.setItem("agentlas.stormbreakerWarningDismissed", "1");
    if (!options.showPageTour) {
      for (const id of ["dashboard", "workspace", "build", "agents", "hub", "automation", "automation-new", "automation-detail", "environment"]) {
        window.localStorage.setItem(`agentlas.pageTour.${id}.dismissed.v2`, "1");
      }
    }
  } catch {}

  const orchestrator = {
    id: "agent-1",
    slug: "agentlas-orchestrator",
    name: "오케스트레이터",
    nameEn: "Orchestrator",
    tagline: "요청을 라우팅합니다.",
    taglineEn: "Routes requests.",
    kind: "agent",
    tone: "blue",
    visibility: "local",
    systemPrompt: "# Orchestrator\n\nRoute work clearly.",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
  };
  const builder = {
    id: "agent-2",
    slug: "builder-agent",
    name: "빌더 에이전트",
    nameEn: "Builder Agent",
    tagline: "빌드 실행 에이전트",
    taglineEn: "Build execution agent",
    kind: "agent",
    tone: "green",
    visibility: "local",
    systemPrompt: "# Builder\n\nBuild Agentlas work clearly.",
    localPath: "/tmp/agentlas-builder",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
  };
  const researcher = {
    id: "agent-3",
    slug: "research-agent",
    name: "리서치 에이전트",
    nameEn: "Research Agent",
    tagline: "자료를 정리합니다.",
    taglineEn: "Organizes research.",
    kind: "agent",
    tone: "purple",
    visibility: "local",
    systemPrompt: "# Research\n\nOrganize findings clearly.",
    localPath: "/tmp/agentlas-research",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
  };
  // teamRoster 옵션 (smoke-renderer-ui): 팀(kind: "team") 엔티티와 background 에이전트를
  // 로스터에 추가해 피커/사이드바가 팀을 살리고 background를 숨기는지 검증한다.
  // v0.7.20~21 실사고: 팀이 피커/사이드바에서 사라지는 회귀가 typecheck를 통과했다.
  const teamAgent = {
    id: "agent-team-1",
    slug: "launch-crew-team",
    name: "런치크루팀",
    nameEn: "LaunchCrewTeam",
    tagline: "멀티에이전트 팀",
    taglineEn: "Multi-agent team",
    kind: "team",
    tone: "amber",
    visibility: "local",
    systemPrompt: "# Launch Crew\n\nTeam of specialists.",
    mcpServers: [],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
  };
  const backgroundAgent = {
    id: "agent-bg-1",
    slug: "background-helper",
    name: "백그라운드 도우미",
    nameEn: "Background Helper",
    tagline: "숨겨진 내부 에이전트",
    taglineEn: "Hidden internal agent",
    kind: "agent",
    tone: "gray",
    visibility: "background",
    systemPrompt: "# Background\n\nStay hidden.",
    mcpServers: [],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
  };
  let importCounter = 0;
  let installedAgents =
    options && options.teamRoster
      ? [orchestrator, builder, researcher, teamAgent, backgroundAgent]
      : [orchestrator, builder, researcher];
  const firm = {
    id: "firm-1",
    slug: "founder-hq",
    name: "Founder HQ",
    nameEn: "Founder HQ",
    tagline: "창업자 작업 팀",
    taglineEn: "Founder work team",
    ceoAgentId: "agent-1",
    installedAt: now,
    orgChart: [
      { agentSlug: "agentlas-orchestrator", agentId: "agent-1", role: "CEO", reportsTo: null },
      { agentSlug: "builder-agent", agentId: "agent-2", role: "Builder", reportsTo: "agentlas-orchestrator" },
    ],
  };
  const project = {
    id: "project-1",
    name: "QA Project",
    description: null,
    defaultAgentId: "agent-2",
    contextNote: "QA project context",
    folderPath: "/tmp/agentlas-qa-project",
    createdAt: now,
    updatedAt: now,
  };
  const resolvedOrg = {
    source: "orgchart",
    firmId: "firm-1",
    ceo: { id: "ceo", name: "Founder HQ", role: "CEO", agentId: "agent-1" },
    divisions: [
      {
        id: "builder-division",
        name: "Build",
        role: "Build",
        agentId: "agent-1",
        specialists: [{ id: "builder-node", name: "Builder Agent", role: "Builder", agentId: "agent-2" }],
      },
    ],
  };
  let activeRuntime = {
    kind: "codex",
    backend: "openai",
    source: "/usr/local/bin/codex",
    version: "mock",
    active: true,
    model: "gpt-5.1-codex",
    efforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    availableModels: ["gpt-5.1-codex", "gpt-5.1"],
  };
  const defaultMemory = [
    "# Memory",
    "",
    "## Decisions",
    "- **Route clearly** - Keep routing explicit.",
    "",
    "## Gotchas",
    "- **No fake data** - Do not show mock state as live.",
    "",
    "## Open Questions",
    "- **Publish target** - Confirm Cloud or Hub.",
  ].join("\n");
  const agentFileContents = {
    "agent-2": {
      "AGENT.md": "# Builder\n\nBuild Agentlas work clearly.",
      "memory.md": defaultMemory,
    },
  };
  function filesForAgent(agentId) {
    agentFileContents[agentId] = agentFileContents[agentId] || {
      "AGENT.md": "# Imported\n\nImported local agent.",
      "memory.md": defaultMemory,
    };
    return agentFileContents[agentId];
  }

  window.__qa = { calls, automations };
  window.agentlasEvents = {
    on: (channel, handler) => {
      eventHandlers[channel] = eventHandlers[channel] || [];
      eventHandlers[channel].push(handler);
      return () => {
        eventHandlers[channel] = (eventHandlers[channel] || []).filter((item) => item !== handler);
      };
    },
    onActiveChats: () => () => {},
    // Browser 승인 바텀시트(BrowserActionApprovalSheet)가 마운트 시 무조건 구독한다 —
    // 없으면 chat 라우트 전체가 client-side exception으로 죽는다.
    onBrowserApproval: () => () => {},
  };
  window.agentlasUpdater = { onState: () => () => {} };
  window.agentlasFiles = { pathForFile: () => "/tmp/agentlas-file.png" };

  window.agentlas = {
    app: {
      getLocale: async () => "ko-KR",
      getVersion: async () => "0.4.0",
    },
    auth: {
      getSession: async () => ({ signedIn: true, account: { email: "qa@example.com" } }),
      signInWithGoogle: async () => ({ signedIn: true, account: { email: "qa@example.com" } }),
      signOut: async () => ({ signedIn: false }),
    },
    updater: {
      getState: async () => ({ status: "idle" }),
      check: async () => ({ status: "idle" }),
      install: async () => {},
    },
    usage: {
      snapshot: async () => ({ providers: [{ label: "Codex", status: "ok", windows: [{ usedPercent: 10 }] }] }),
    },
    confirm: {
      listPending: async () => pendingConfirmations,
    },
    attention: {
      setPendingConfirmations: async (count) => record("attention.setPendingConfirmations", count),
    },
    runtime: {
      listCommands: async () => [{ name: "/hep-build", description: "Build via Hephaestus", source: "codex" }],
      detect: async () => [{ ...activeRuntime }],
      listModels: async () => [
        { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
        { id: "gpt-5.1", label: "GPT-5.1" },
      ],
      setActive: async (selection) => {
        record("runtime.setActive", selection);
        activeRuntime = {
          ...activeRuntime,
          ...selection,
          model: selection.model ?? null,
          effort: selection.effort ?? activeRuntime.effort ?? null,
          active: true,
        };
        return { ...activeRuntime };
      },
    },
    team: {
      list: async () => installedAgents,
      install: async (input) => localized(input),
      importLocalFolder: async (folder) => {
        record("team.importLocalFolder", folder);
        importCounter += 1;
        const imported = {
          id: `imported-agent-${importCounter}`,
          slug: `imported-qa-agent-${importCounter}`,
          name: "가져온 QA 에이전트",
          nameEn: "Imported QA Agent",
          tagline: "로컬에서 가져온 QA 에이전트",
          taglineEn: "Imported local QA agent",
          kind: "agent",
          tone: "amber",
          visibility: "local",
          systemPrompt: "# Imported QA Agent\n\nImported through the folder picker.",
          localPath: folder,
          runtimeLabel: "codex",
          mcpServers: [],
          preferredBackend: "codex",
          trustGrade: "A",
          installedAt: now,
        };
        installedAgents = [imported, ...installedAgents.filter((agent) => agent.id !== imported.id)];
        return imported;
      },
    },
    firms: {
      list: async () => [firm],
      get: async () => firm,
      install: async () => firm,
      getResolvedOrg: async () => resolvedOrg,
    },
    agentGroups: {
      list: async () => [],
      listResolved: async () => [],
      getResolved: async () => null,
      create: async (input) => {
        record("agentGroups.create", input);
        return { id: `group-${Date.now()}`, name: input?.name || "QA Group", members: [], createdAt: now, updatedAt: now };
      },
      update: async (id, patch) => {
        record("agentGroups.update", { id, patch });
        return { id, name: patch?.name || "QA Group", members: [], createdAt: now, updatedAt: now };
      },
      removeMember: async (groupId, memberId) => {
        record("agentGroups.removeMember", { groupId, memberId });
        return { id: groupId, name: "QA Group", members: [], createdAt: now, updatedAt: now };
      },
      remove: async (id) => {
        record("agentGroups.remove", id);
      },
    },
    marketplace: {
      status: async () =>
        options && options.hubOffline
          ? { mode: "mcp", baseUrl: "mock://offline", online: false, usingFallback: false, lastError: "fetch failed", lastCheckedAt: now }
          : { mode: "mcp", baseUrl: "https://agentlas.cloud/api/mcp/v1", online: true, usingFallback: false, lastError: null, lastCheckedAt: now },
      listBundles: async () => [],
      listFirms: async () => [],
      listMine: async () => [],
      bookmarks: async () => [],
      bookmarkAdd: async (listing) => {
        record("marketplace.bookmarkAdd", listing);
        return { slug: listing?.slug ?? "mock-bookmark", listing, bookmarkedAt: now };
      },
      bookmarkRemove: async (slug) => {
        record("marketplace.bookmarkRemove", slug);
      },
      search: async () => makeHubCatalog(267),
    },
    mcpTools: {
      listCatalog: async () => [],
      listInstalled: async () => [],
      status: async () => [],
      install: async () => ({}),
      installCustom: async () => ({}),
      remove: async () => {},
      setEnabled: async () => ({}),
      test: async () => ({ ok: true }),
    },
    skills: {
      listCatalog: async () => [
        { name: "qa-skill", path: "/tmp/qa-skill/SKILL.md", description: "QA helper skill" },
      ],
    },
    hephaestus: {
      status: async () => ({ available: true, version: "mock", reason: null }),
      doctor: async () => ({ ok: true, checks: [] }),
      build: async (payload) => {
        record("hephaestus.build", payload);
        lastRunId += 1;
        return { runId: `build-run-${lastRunId}` };
      },
      buildEventChannel: (runId) => `build:${runId}`,
      buildReady: async (runId) => {
        if (options && options.buildScenario === "slow") {
          window.setTimeout(() => emit(`build:${runId}`, { kind: "stage", stage: "build", text: "QA slow build stage" }), 20);
          return;
        }
        if (options && options.buildScenario === "interview") {
          const askOne = [
            "요구사항을 조금 더 확인해야 합니다.",
            "<<agentlas-ask>>",
            JSON.stringify({
              question: "어떤 산출물이 필요합니까?",
              header: "Output",
              multiSelect: true,
              options: [
                { label: "리포트", description: "문서형 리서치 산출물" },
                { label: "앱", description: "실행 가능한 앱" },
              ],
            }),
            "<</agentlas-ask>>",
          ].join("\n");
          const askTwo = [
            "배포 위치도 확인해야 합니다.",
            "<<agentlas-ask>>",
            JSON.stringify({
              question: "어디에 배포할까요?",
              header: "Deploy",
              multiSelect: true,
              options: [
                { label: "비공개", description: "내 계정에만 저장" },
                { label: "허브 공개", description: "허브 공개 후보로 제출" },
              ],
            }),
            "<</agentlas-ask>>",
          ].join("\n");
          const askBatch = [askOne, askTwo].join("\n\n");
          if (runId === "build-run-1") {
            window.setTimeout(() => emit(`build:${runId}`, { kind: "partial", text: askBatch }), 20);
            window.setTimeout(() => emit(`build:${runId}`, { kind: "done", text: askBatch, result: { workspace: "/tmp/agentlas-qa", securityScan: { findings: [] } } }), 60);
            return;
          }
          window.setTimeout(() => emit(`build:${runId}`, { kind: "stage", stage: "build", text: "QA build stage" }), 20);
          window.setTimeout(
            () =>
              emit(`build:${runId}`, {
                kind: "done",
                text: "BUILD_COMPLETE: qa-agent",
                result: { workspace: "/tmp/agentlas-qa", securityScan: { findings: [] } },
              }),
            60,
          );
          return;
        }
        window.setTimeout(() => emit(`build:${runId}`, { kind: "stage", stage: "build", text: "QA build stage" }), 20);
        window.setTimeout(
          () =>
            emit(`build:${runId}`, {
              kind: "done",
              text: "BUILD_COMPLETE: qa-agent",
              result: { workspace: "/tmp/agentlas-qa", securityScan: { findings: [] } },
            }),
          60,
        );
      },
      cancelBuild: async (runId) => record("hephaestus.cancelBuild", runId),
      publish: async (payload) => {
        record("hephaestus.publish", payload);
        return { ok: true };
      },
      routePreview: async (payload) => {
        record("hephaestus.routePreview", payload);
        if (!options || !options.recommendMode) return null;
        if (options.recommendMode === "single") {
          return {
            mode: "single",
            agents: [{ id: "agent-1", name: "오케스트레이터", source: "local", estCredits: null }],
            totalEstCredits: null,
            estimate: true,
            rawAction: "single",
            query: payload.query,
          };
        }
        if (options.recommendMode === "network") {
          return {
            mode: "network",
            agents: [
              { id: "no-ai-slop-copywriter", name: "No-AI-Slop Copywriter", source: "hub", estCredits: 3 },
              { id: "security-reviewer", name: "Security Reviewer", source: "hub", estCredits: 3 },
            ],
            totalEstCredits: 6,
            estimate: true,
            rawAction: "network",
            query: payload.query,
          };
        }
        if (options.recommendMode === "pipeline") {
          return {
            mode: "pipeline",
            agents: [],
            stages: [
              { order: 1, kind: "plan", agentId: "agent-1", agentName: "Planner" },
              { order: 2, kind: "qa", agentId: "agent-2", agentName: "Builder" },
            ],
            totalEstCredits: null,
            estimate: true,
            rawAction: "pipeline",
            query: payload.query,
          };
        }
        return {
          mode: "none",
          agents: [],
          totalEstCredits: null,
          estimate: true,
          rawAction: "none",
          query: payload.query,
        };
      },
      stormbreaker: async () => ({ ok: true, runId: "storm-run" }),
      getSupervisor: async () => ({ enabled: true }),
      setSupervisor: async () => ({ enabled: true }),
      journal: async () => ({ ok: true, entries: [] }),
      startStudio: async () => ({ ok: true }),
      aoGraph: async () => ({ ok: true, json: {} }),
      search: async () => ({ ok: true, json: {} }),
      network: async () => ({ ok: true, json: {} }),
      localGui: async () => ({ ok: true }),
      package: async () => ({ ok: true }),
      securityScan: async () => ({ ok: true, findings: [] }),
    },
    chats: {
      get: async () => ({
        id: "chat-1",
        projectId: null,
        firmId: null,
        agentId: "agent-2",
        kind: "user",
        title: "QA Chat",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
      // teamRoster: 팀에 바인딩된 채팅 1건 — Sidebar가 agentById(visibleAgents 결과)로
      // 라벨을 찾으므로, 팀이 필터에서 빠지면 이 행의 팀 이름이 사라진다(0.7.21 증상).
      listRecent: async () =>
        options && options.teamRoster
          ? [
              {
                id: "chat-team-1",
                projectId: null,
                firmId: null,
                agentGroupId: null,
                agentId: "agent-team-1",
                kind: "user",
                title: "팀 채팅 스모크",
                archivedAt: null,
                createdAt: now,
                updatedAt: now,
              },
            ]
          : [],
      listArchived: async () => [],
      listByProject: async () => [],
      listByFirm: async () => [],
      create: async (input) => {
        record("chats.create", input);
        createdChatId += 1;
        const id = `chat-created-${createdChatId}`;
        return { id, projectId: input.projectId || null, firmId: input.firmId || null, agentId: input.agentId || "agent-2", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now };
      },
      switchAgent: async (chatId, agentId) => {
        record("chats.switchAgent", { chatId, agentId });
        return { id: "chat-1", projectId: null, firmId: null, agentId, kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now };
      },
      rename: async (_id, title) => ({ id: "chat-1", projectId: null, firmId: null, agentId: "agent-2", kind: "user", title, archivedAt: null, createdAt: now, updatedAt: now }),
      // 에이전트 전환 시 chat 페이지가 동기 호출 — undefined면 TypeError가 그대로 pageerror가 된다.
      recap: async () => null,
      markViewed: async (id) => record("chats.markViewed", id),
      archive: async (id) => ({ id, projectId: null, firmId: null, agentId: "agent-2", kind: "user", title: "QA Chat", archivedAt: now, createdAt: now, updatedAt: now }),
      unarchive: async (id) => ({ id, projectId: null, firmId: null, agentId: "agent-2", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now }),
      setContinuousMode: async (id, enabled) => ({ id, projectId: null, firmId: null, agentId: "agent-2", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now, continuousMode: enabled }),
      setSwarmMode: async (id, enabled) => ({ id, projectId: null, firmId: null, agentId: "agent-2", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now, swarmMode: enabled }),
      remove: async () => {},
      delete: async () => {},
    },
    invoke: {
      history: async () => [],
      attach: async () => null,
      activeChats: async () => [],
      run: async (payload) => {
        record("invoke.run", payload);
        lastRunId += 1;
        const runId = `invoke-run-${lastRunId}`;
        if (options?.longChatInvoke) {
          const n = lastRunId;
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "thinking", status: `same-session turn #${n}` }), 12);
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "tool-use", status: `Network route stable #${n}` }), 24);
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "final", text: `QA final ${n}` }), 48);
        } else if (!options || !options.slowInvoke) {
          const finalDelay = options?.visibleProgressInvoke ? 1400 : 180;
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "thinking", status: "Agentlas orchestrator started" }), 20);
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "tool-use", status: "Hub 에이전트 빌리는 중: qa-agent" }), 70);
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "final", text: "QA final" }), finalDelay);
        }
        return { runId };
      },
      cancel: async (runId) => record("invoke.cancel", runId),
      eventChannel: (runId) => `invoke:${runId}`,
      clearHistory: async () => {},
    },
    projects: {
      list: async () => [project],
      get: async (id) => (id === project.id ? project : null),
    },
    workspace: {
      get: async (chatId) => workspaceFolders[chatId] ?? null,
      // chat 페이지가 미디어 base path 후보 계산에 무조건 호출 — 없으면 chat 라우트가 죽는다.
      defaultRunFolder: async () => "/tmp/agentlas-qa-runs",
      set: async (chatId, folder) => {
        workspaceFolders[chatId] = folder;
        record("workspace.set", { chatId, folder });
        return { chatId, folder };
      },
    },
    env: {
      list: async () => [
        {
          key: "QA_API_KEY",
          hasValue: true,
          preview: "qa_***",
          requiredBy: [],
        },
      ],
      set: async () => ({ ok: true }),
    },
    schedule: {
      defaultTz: async () => "Asia/Seoul",
      validateCron: async (expr) => String(expr || "").trim().split(/\s+/).length >= 5,
      describe: async (spec, locale) => {
        const ko = locale === "ko";
        if (!spec || spec.kind === "manual") return ko ? "수동 실행" : "Manual run";
        if (spec.kind === "once") return ko ? "한 번 실행" : "Run once";
        if (spec.kind === "interval") return ko ? `${Math.round((spec.everyMs || 0) / 60_000)}분마다` : `Every ${Math.round((spec.everyMs || 0) / 60_000)} minutes`;
        return ko ? "매일 09:00" : "Daily at 09:00";
      },
      nextRun: async () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    automations: {
      list: async () => automations,
      get: async (id) => automations.find((item) => item.id === id) || null,
      create: async (payload) => {
        record("automations.create", payload);
        const item = { id: `auto-${automations.length + 1}`, createdAt: now, lastRunAt: null, nextRunAt: now, enabled: true, createdBy: "user", ...payload };
        automations.unshift(item);
        saveAutomations();
        return item;
      },
      toggle: async (id, enabled) => {
        record("automations.toggle", { id, enabled });
        const item = automations.find((a) => a.id === id);
        if (item) item.enabled = enabled;
        saveAutomations();
        return item;
      },
      remove: async (id) => {
        record("automations.remove", id);
        const idx = automations.findIndex((a) => a.id === id);
        if (idx >= 0) automations.splice(idx, 1);
        saveAutomations();
      },
      update: async (id, patch) => {
        record("automations.update", { id, patch });
        const idx = automations.findIndex((a) => a.id === id);
        const item = {
          ...(idx >= 0 ? automations[idx] : { id, createdAt: now, lastRunAt: null, nextRunAt: now, enabled: true, createdBy: "user" }),
          ...patch,
          updatedAt: now,
        };
        if (idx >= 0) automations[idx] = item;
        else automations.unshift(item);
        saveAutomations();
        return item;
      },
      updateGraph: async (id, graph) => {
        record("automations.updateGraph", { id, graph });
        const item = automations.find((a) => a.id === id) || { id, createdAt: now, lastRunAt: null, nextRunAt: now, enabled: true, createdBy: "user" };
        item.graph = graph;
        if (!automations.some((a) => a.id === id)) automations.unshift(item);
        saveAutomations();
        return item;
      },
      runNow: async (id) => record("automations.runNow", id),
      listRuns: async () => [],
      liveRunChannel: (automationId) => `automation:${automationId}`,
      latestRun: async () => null,
      getSession: async (automationId) => ({
        id: `automation-session-${automationId}`,
        projectId: null,
        firmId: null,
        agentId: "agent-2",
        kind: "automation",
        title: "Automation Session",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    },
    agentFiles: {
      list: async (agentId) => ({
        entries: Object.keys(filesForAgent(agentId)).map((filePath) => ({
          kind: "file",
          name: filePath.split("/").pop(),
          path: filePath,
        })),
      }),
      read: async (agentId, filePath) => ({ content: filesForAgent(agentId)[filePath] ?? "" }),
      write: async (agentId, filePath, content) => {
        if (filePath.startsWith("/") || filePath.split("/").includes("..")) {
          throw new Error("Path escapes the agent folder");
        }
        filesForAgent(agentId)[filePath] = content;
        record("agentFiles.write", { agentId, path: filePath, content });
      },
    },
    agentMemory: {
      entries: async () => [],
    },
    agentEvolution: {
      list: async () => [],
      createAndApplyPrompt: async (input) => {
        record("agentEvolution.createAndApplyPrompt", input);
        filesForAgent(input.agentId)[input.targetPath || "AGENT.md"] = input.proposedContent;
        return {
          id: `proposal-${calls.filter((call) => call.name === "agentEvolution.createAndApplyPrompt").length}`,
          agentId: input.agentId,
          proposalType: input.proposalType || "rule",
          summary: input.summary || "Mock prompt evolution",
          targetPath: input.targetPath || "AGENT.md",
          beforeHash: "mock-before",
          afterHash: "mock-after",
          risk: input.risk || "medium",
          status: "applied",
          source: input.source || {},
          decisionNote: input.decisionNote,
          createdAt: now,
          updatedAt: now,
          approvedAt: now,
          appliedAt: now,
        };
      },
      markMeasured: async (proposalId, note) => {
        record("agentEvolution.markMeasured", { proposalId, note });
        return {
          id: proposalId,
          agentId: "agent-2",
          proposalType: "rule",
          summary: "Mock measured proposal",
          targetPath: "AGENT.md",
          beforeHash: "mock-before",
          afterHash: "mock-after",
          risk: "medium",
          status: "measured",
          source: {},
          decisionNote: note,
          createdAt: now,
          updatedAt: now,
          measuredAt: now,
        };
      },
      rollback: async (proposalId) => {
        record("agentEvolution.rollback", proposalId);
        return {
          id: proposalId,
          agentId: "agent-2",
          proposalType: "rule",
          summary: "Mock rolled back proposal",
          targetPath: "AGENT.md",
          beforeHash: "mock-before",
          afterHash: "mock-after",
          risk: "medium",
          status: "rolled_back",
          source: {},
          createdAt: now,
          updatedAt: now,
          rolledBackAt: now,
        };
      },
    },
    agentRuntime: {
      list: async () => runtimeOverrides,
      get: async (scope, targetId) => runtimeOverrides.find((item) => item.scope === scope && item.targetId === targetId) || null,
      set: async (input) => {
        record("agentRuntime.set", input);
        const saved = { ...input, updatedAt: now };
        runtimeOverrides = [saved, ...runtimeOverrides.filter((item) => item.scope !== input.scope || item.targetId !== input.targetId)];
        return saved;
      },
      remove: async (scope, targetId) => {
        record("agentRuntime.remove", { scope, targetId });
        runtimeOverrides = runtimeOverrides.filter((item) => item.scope !== scope || item.targetId !== targetId);
      },
    },
    fs: {
      pickDirectory: async () => {
        record("fs.pickDirectory", null);
        return "/tmp/agentlas-qa";
      },
      listDirectory: async (absPath) => ({
        path: absPath,
        exists: true,
        entries: [
          { kind: "file", name: "AGENTS.md", path: `${absPath}/AGENTS.md`, size: 40, isTextLike: true },
          { kind: "file", name: "README.md", path: `${absPath}/README.md`, size: 64, isTextLike: true },
          { kind: "file", name: "preview.html", path: `${absPath}/preview.html`, size: 112, isTextLike: true },
          { kind: "file", name: "preview.png", path: `${absPath}/preview.png`, size: 128, isTextLike: false },
          { kind: "dir", name: ".agentlas", path: `${absPath}/.agentlas`, size: 0 },
        ],
      }),
      readTextFile: async (absPath) => {
        if (absPath.endsWith(".html")) {
          return {
            path: absPath,
            content: "<!doctype html><html><body><main><h1>Browser smoke frame</h1><p>Rendered inside the panel tab.</p></main></body></html>",
            truncated: false,
            size: 119,
          };
        }
        return {
          path: absPath,
          content: "# Panel viewer smoke file\n\nWorkspace file content rendered in the panel tab.",
          truncated: false,
          size: 73,
        };
      },
    },
    secrets: {
      saveApiKey: async () => {},
      hasApiKey: async () => false,
      deleteApiKey: async () => {},
    },
    config: {
      getCustomBaseUrl: async () => "",
      setCustomBaseUrl: async () => "",
    },
    multimodal: {
      listProviders: async () => [],
      getSettings: async () => ({}),
      saveSettings: async (settings) => settings,
      status: async () => [],
    },
    migration: {
      scan: async () => [],
      import: async () => ({ imported: 0, skipped: 0, errors: [] }),
    },
    surfaces: {
      listSurfaces: async () => [],
      getSurface: async () => null,
      listJobs: async () => [],
      getJobSummary: async () => null,
      updateJob: async () => null,
      updateState: async () => null,
      listEvents: async () => [],
      hasApproval: async () => true,
      approve: async () => {},
      listApprovals: async () => [],
      revokeApproval: async () => {},
    },
    appFactory: {
      listApps: async () => [],
      getApp: async () => null,
      getAppBySurface: async () => null,
      scaffold: async () => null,
      archive: async () => ({}),
      restore: async () => ({}),
      listOperations: async () => [],
      syncCloudManifest: async () => ({ ok: true }),
      runAutopilot: async () => ({}),
      installMcpPlan: async () => ({}),
      runProviderTasks: async () => ({}),
      materializeAssets: async () => ({}),
      activateLocalCommerceStack: async () => ({}),
      openProviderBrowser: async () => ({}),
      captureProviderBrowserSessions: async () => ({}),
      launchProviderBrowserSession: async () => ({}),
      syncProviderBrowserResults: async () => ({}),
      resolveProviderCredentials: async () => ({}),
      approveProviderPayment: async () => ({}),
      runSmoke: async () => ({ ok: true, exitCode: 0 }),
      preparePreview: async () => ({}),
      openLaunchTarget: async () => ({}),
      publishAsTool: async () => ({}),
    },
    toolFactory: {
      scaffold: async () => null,
      runSmoke: async () => ({ ok: true, exitCode: 0 }),
      installMcp: async () => ({}),
      archive: async () => ({}),
      restore: async () => ({}),
      listTools: async () => [],
      getTool: async () => null,
      getToolBySurface: async () => null,
      listOperations: async () => [],
    },
    surfaceAssets: {
      materialize: async () => null,
      archive: async () => ({}),
      restore: async () => ({}),
      listPacks: async () => [],
      getPack: async () => null,
      getPackBySurface: async () => null,
      listOperations: async () => [],
    },
  };

  if (options && options.teamRoster) {
    // teamRoster 스모크는 사이드바 로스터 계약을 명시적으로 검증한다.
    // 기본 mock에도 agentGroups가 있지만, 이 블록은 팀 로스터 옵션의 기존 경계를 유지한다.
    window.agentlas.agentGroups = {
      list: async () => [],
      listResolved: async () => [],
      getResolved: async () => null,
    };
  }
}

module.exports = { setupMockAgentlasBridge };
