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
  const missingBridgeCalls = [];
  const eventHandlers = {};
  let hubBookmarks = [];
  try {
    const savedBookmarks = JSON.parse(window.localStorage.getItem("agentlas.qa.hubBookmarks") || "[]");
    if (Array.isArray(savedBookmarks)) hubBookmarks = savedBookmarks;
  } catch {}
  if (hubBookmarks.length === 0 && options?.hubBookmarks) {
    const listing = makeHubCatalog(3)[1];
    hubBookmarks = [{ slug: listing.slug, listing, bookmarkedAt: now }];
  }
  if (hubBookmarks.length === 0 && options?.hubBookmarkScenario === "mixed-callability") {
    const callableOne = makeHubCatalog(4)[1];
    const callableTwo = makeHubCatalog(4)[2];
    const installOnly = {
      slug: "install-only-agent",
      name: "설치 전용 에이전트",
      nameEn: "Install-only Agent",
      tagline: "북마크로 볼 수 있지만 호출할 수 없음",
      taglineEn: "Visible as a bookmark, unavailable for calls",
      trustGrade: "A",
      installCount: 2,
      manifestUrl: "mock",
      kind: "install-only",
      callable: false,
      routingReady: true,
      source: "hub-index",
      entityKind: "agent",
    };
    const localDuplicate = {
      ...callableOne,
      slug: "builder-agent",
      name: "Hub 빌더 중복",
      nameEn: "Hub Builder Duplicate",
    };
    hubBookmarks = [callableOne, installOnly, localDuplicate, callableTwo].map((listing, index) => ({
      slug: listing.slug,
      listing,
      bookmarkedAt: new Date(Date.now() - index * 1000).toISOString(),
    }));
  }
  function saveHubBookmarks() {
    try {
      window.localStorage.setItem("agentlas.qa.hubBookmarks", JSON.stringify(hubBookmarks));
    } catch {}
  }
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
  let chatHiredAgents =
    options && options.hiredRoster
      ? [{ slug: "instagram-uploader", name: "인스타 업로더", source: "hub", hiredAt: now }]
      : [];
  let hiredPersistenceFailuresRemaining = Math.max(0, Number(options?.hiredPersistenceFailures) || 0);
  const workspaceFolders = {};
  const invokeReceipts = {};
  const cancelledInvokeIds = new Set();
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
  const directoryGrant = (grantPath = "/tmp/agentlas-qa") => ({
    path: grantPath,
    kind: "directory",
    durable: true,
    scope: { kind: "capability", token: "00000000-0000-4000-8000-000000000001" },
  });
  const droppedFileGrant = {
    path: "/tmp/agentlas-file.png",
    kind: "file",
    durable: false,
    scope: { kind: "capability", token: "00000000-0000-4000-8000-000000000002" },
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
    "",
    "## Private provenance",
    "Keep this operator-authored section byte-stable across memory card edits.",
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
  const evolutionProposals = [];

  window.__qa = { calls, automations, missingBridgeCalls };
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
  window.agentlasFiles = { grantForFile: async () => ({ ...droppedFileGrant, scope: { ...droppedFileGrant.scope } }) };

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
      install: async () => ({ accepted: false, state: { status: "idle" } }),
      openManualDownload: async () => ({ accepted: true, state: { status: "idle" } }),
      revealRecoveryBackup: async () => ({ accepted: false, state: { status: "idle" } }),
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
      importLocalFolder: async (input) => {
        record("team.importLocalFolder", input);
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
          localPath: input?.path,
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
      bookmarks: async () => {
        // Capture at call time so a delayed pre-add read can arrive after the
        // durable add. OrgTree/HubBorrowRoom must reject this stale snapshot.
        const snapshot = [...hubBookmarks];
        if (snapshot.length === 0 && Number(options?.bookmarkEmptyReadDelayMs) > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, Number(options.bookmarkEmptyReadDelayMs)));
        }
        return snapshot;
      },
      bookmarkAdd: async (listing) => {
        record("marketplace.bookmarkAdd", listing);
        const bookmark = { slug: listing?.slug ?? "mock-bookmark", listing, bookmarkedAt: now };
        hubBookmarks = [bookmark, ...hubBookmarks.filter((item) => item.slug !== bookmark.slug)];
        saveHubBookmarks();
        return bookmark;
      },
      bookmarkRemove: async (slug) => {
        record("marketplace.bookmarkRemove", slug);
        hubBookmarks = hubBookmarks.filter((item) => item.slug !== slug);
        saveHubBookmarks();
      },
      search: async (query) => {
        const catalog = makeHubCatalog(267);
        if (!options?.filterHubSearch) return catalog;
        const q = String(query ?? "").trim().toLowerCase();
        if (!q) return catalog;
        return catalog.filter((listing) =>
          [listing.slug, listing.name, listing.nameEn, listing.tagline, listing.taglineEn]
            .join(" ")
            .toLowerCase()
            .includes(q),
        );
      },
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
        { slug: "qa-skill", name: "qa-skill", description: "QA helper skill" },
      ],
      readCatalog: async (slug) => {
        record("skills.readCatalog", { slug });
        if (slug !== "qa-skill") throw new Error("Unknown mock skill");
        const content = "---\nname: qa-skill\ndescription: QA helper skill\n---\n\n# Exact QA catalog body\n\nRun the full source instructions.\n";
        const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
        const contentHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        return { slug, name: "qa-skill", description: "QA helper skill", content, contentHash, byteLength: new TextEncoder().encode(content).byteLength };
      },
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
                result: { workspace: "/tmp/agentlas-qa/qa-agent", securityScan: { findings: [] } },
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
            result: { workspace: "/tmp/agentlas-qa/qa-agent", securityScan: { findings: [] } },
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
        // hiredRoster 옵션(smoke-renderer-ui): 고용 카드가 붙은 채팅 — 동행 배지/재주입 검증용.
        hiredAgents: [...chatHiredAgents],
      }),
      setHiredAgents: async (id, cards) => {
        record("chats.setHiredAgents", { id, cards });
        if (Number(options?.hiredPersistenceDelayMs) > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, Number(options.hiredPersistenceDelayMs)));
        }
        if (hiredPersistenceFailuresRemaining > 0) {
          hiredPersistenceFailuresRemaining -= 1;
          throw new Error("mock hired-roster persistence failure");
        }
        chatHiredAgents = Array.isArray(cards) ? [...cards] : [];
        return {
          id,
          projectId: null,
          firmId: null,
          agentId: "agent-2",
          kind: "user",
          title: "QA Chat",
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          hiredAgents: [...chatHiredAgents],
        };
      },
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
        return { id: "chat-1", projectId: null, firmId: null, agentId, kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now, hiredAgents: [...chatHiredAgents] };
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
      activeChats: async () => [
        ...new Set(
          Object.values(invokeReceipts)
            .filter((receipt) => receipt.status === "running" || receipt.status === "cancelling")
            .map((receipt) => receipt.chatId),
        ),
      ],
      run: async (payload) => {
        record("invoke.run", payload);
        lastRunId += 1;
        const runId = payload?.runId || `invoke-run-${lastRunId}`;
        invokeReceipts[runId] = {
          runId,
          chatId: payload.chatId,
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          eventCount: 1,
          resultFolder: workspaceFolders[payload.chatId] || "/tmp/agentlas-qa-runs",
          hasImages: Boolean(payload.images?.length),
          borrowAgents: payload.borrowAgents,
        };
        const finish = (text) => {
          if (cancelledInvokeIds.has(runId)) return;
          emit(`invoke:${runId}`, { kind: "final", text });
          invokeReceipts[runId] = {
            ...invokeReceipts[runId],
            status: "completed",
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            eventCount: 2,
          };
        };
        if (options?.longChatInvoke) {
          const n = lastRunId;
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "thinking", status: `same-session turn #${n}` }), 12);
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "tool-use", status: `Network route stable #${n}` }), 24);
          window.setTimeout(() => finish(`QA final ${n}`), 48);
        } else if (!options || !options.slowInvoke) {
          const finalDelay = options?.visibleProgressInvoke ? 1400 : 180;
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "thinking", status: "Agentlas orchestrator started" }), 20);
          window.setTimeout(() => emit(`invoke:${runId}`, { kind: "tool-use", status: "Hub 에이전트 빌리는 중: qa-agent" }), 70);
          window.setTimeout(() => finish("QA final"), finalDelay);
        }
        return { runId };
      },
      cancel: async (runId) => {
        record("invoke.cancel", runId);
        cancelledInvokeIds.add(runId);
        if (invokeReceipts[runId]) {
          invokeReceipts[runId] = {
            ...invokeReceipts[runId],
            status: "cancelling",
            updatedAt: new Date().toISOString(),
          };
          window.setTimeout(() => {
            emit(`invoke:${runId}`, { kind: "error", error: { code: "cancelled", message: "Cancelled" } });
            invokeReceipts[runId] = {
              ...invokeReceipts[runId],
              status: "cancelled",
              updatedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            };
          }, 80);
        }
      },
      eventChannel: (runId) => `invoke:${runId}`,
      receipt: async (runId) => invokeReceipts[runId] || null,
      latestReceipt: async (chatId) =>
        Object.values(invokeReceipts).reverse().find((receipt) => receipt.chatId === chatId) || null,
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
      selectFolder: async () => directoryGrant(),
      set: async (chatId, grant) => {
        const folder = grant?.path ?? null;
        workspaceFolders[chatId] = folder;
        record("workspace.set", { chatId, folder });
      },
      setFromProject: async (chatId, projectId) => {
        if (projectId !== project.id || !project.folderPath) throw new Error("Project folder not found");
        workspaceFolders[chatId] = project.folderPath;
        record("workspace.setFromProject", { chatId, projectId, folder: project.folderPath });
        // Existing renderer smoke assertions observe the resulting workspace assignment.
        record("workspace.set", { chatId, folder: project.folderPath });
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
      promptSource: async (agentId) => {
        const files = filesForAgent(agentId);
        const priority = ["system-prompt.md", "soul.md", "agent.md", "claude.md", "agents.md", "gemini.md", "persona.md", "prompt.md"];
        const relativePath = priority
          .map((wanted) => Object.keys(files).find((filePath) => !filePath.includes("/") && filePath.toLowerCase() === wanted))
          .find(Boolean);
        if (!relativePath) return null;
        return { path: relativePath, relativePath, exists: true, content: files[relativePath], hash: "mock-prompt-hash" };
      },
    },
    agentMemory: {
      entries: async () => [],
    },
    agentEvolution: {
      list: async (agentId) => evolutionProposals.filter((proposal) => proposal.agentId === agentId),
      createProposal: async (input) => {
        record("agentEvolution.createProposal", input);
        const targetPath = input.targetPath || "AGENT.md";
        const targetExisted = Object.prototype.hasOwnProperty.call(filesForAgent(input.agentId), targetPath);
        const proposal = {
          id: `proposal-${evolutionProposals.length + 1}`,
          agentId: input.agentId,
          proposalType: input.proposalType || "rule",
          summary: input.summary || "Mock prompt evolution",
          targetPath,
          beforeHash: "mock-before",
          afterHash: "mock-after",
          beforeContent: input.currentContent,
          afterContent: input.proposedContent,
          risk: input.risk || "medium",
          status: "candidate",
          source: { ...(input.source || {}), _agentlasTargetExisted: targetExisted },
          receipts: [],
          decisionNote: input.decisionNote,
          createdAt: now,
          updatedAt: now,
        };
        evolutionProposals.unshift(proposal);
        return proposal;
      },
      approveAndApply: async (proposalId, note) => {
        record("agentEvolution.approveAndApply", { proposalId, note });
        const proposal = evolutionProposals.find((item) => item.id === proposalId);
        if (!proposal) throw new Error("Proposal not found");
        filesForAgent(proposal.agentId)[proposal.targetPath] = proposal.afterContent;
        proposal.status = "applied";
        proposal.decisionNote = note || proposal.decisionNote;
        proposal.approvedAt = now;
        proposal.appliedAt = now;
        proposal.receipts = [{
          id: `receipt-${proposalId}-apply`,
          proposalId,
          agentId: proposal.agentId,
          action: "apply",
          targetPath: proposal.targetPath,
          versionBefore: 1,
          versionAfter: 2,
          targetHashBefore: proposal.beforeHash,
          targetHashAfter: proposal.afterHash,
          packageHashBefore: "a".repeat(64),
          packageHashAfter: "b".repeat(64),
          governedAssetHashBefore: "a".repeat(64),
          governedAssetHashAfter: "b".repeat(64),
          createdAt: now,
        }];
        return proposal;
      },
      reject: async (proposalId, note) => {
        record("agentEvolution.reject", { proposalId, note });
        const proposal = evolutionProposals.find((item) => item.id === proposalId);
        if (!proposal) throw new Error("Proposal not found");
        proposal.status = "rejected";
        proposal.decisionNote = note;
        return proposal;
      },
      markMeasured: async (proposalId, note) => {
        record("agentEvolution.markMeasured", { proposalId, note });
        const proposal = evolutionProposals.find((item) => item.id === proposalId);
        if (!proposal) throw new Error("Proposal not found");
        proposal.status = "measured";
        proposal.decisionNote = note;
        proposal.measuredAt = now;
        return proposal;
      },
      rollback: async (proposalId) => {
        record("agentEvolution.rollback", proposalId);
        const proposal = evolutionProposals.find((item) => item.id === proposalId);
        if (!proposal) throw new Error("Proposal not found");
        if (proposal.source._agentlasTargetExisted === false) {
          delete filesForAgent(proposal.agentId)[proposal.targetPath];
        } else {
          filesForAgent(proposal.agentId)[proposal.targetPath] = proposal.beforeContent;
        }
        proposal.status = "rolled_back";
        proposal.rolledBackAt = now;
        proposal.receipts.push({
          id: `receipt-${proposalId}-rollback`,
          proposalId,
          agentId: proposal.agentId,
          action: "rollback",
          targetPath: proposal.targetPath,
          versionBefore: 2,
          versionAfter: 3,
          targetHashBefore: proposal.afterHash,
          targetHashAfter: proposal.beforeHash,
          packageHashBefore: "b".repeat(64),
          packageHashAfter: "a".repeat(64),
          governedAssetHashBefore: "b".repeat(64),
          governedAssetHashAfter: "a".repeat(64),
          createdAt: now,
        });
        return proposal;
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
        return directoryGrant();
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
      openPath: async (target) => {
        record("fs.openPath", target);
        return { ok: true };
      },
      showItemInFolder: async (target) => {
        record("fs.showItemInFolder", target);
        return { ok: true };
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

  // 고용(빌림) 로스터 — 렌더러가 api.hired?.list 옵셔널 체이닝으로 부르므로 항상 제공해도
  // 기존 스모크에 영향 없음. 데이터는 hiredRoster 옵션일 때만.
  window.agentlas.hired = {
    list: async () =>
      options && options.hiredRoster
        ? [
            {
              slug: "instagram-uploader",
              name: "Instagram Uploader",
              nameKo: "인스타 업로더",
              leasedUntil: new Date(Date.now() + 23 * 3_600_000).toISOString(),
              leaseActive: true,
              hasMemory: true,
              lastWorkedAt: now,
            },
            {
              slug: "reddit-seeder",
              name: "Reddit Seeder",
              nameKo: "레딧 시더",
              leasedUntil: new Date(Date.now() - 3_600_000).toISOString(),
              leaseActive: false,
              hasMemory: true,
              lastWorkedAt: now,
            },
          ]
        : [],
  };

  // Preload 계약의 모든 leaf method를 물질화한다. 각 smoke가 아직 전용 fixture를 만들지 않은
  // 새 API도 `undefined is not a function`으로 페이지 전체를 죽이지 않고 안전한 빈값을 반환하며,
  // 호출 사실은 missingBridgeCalls에 남겨 다음 fixture 보강 대상을 추적할 수 있다.
  for (const methodPath of options?.preloadMethodPaths ?? []) {
    const parts = String(methodPath).split(".").filter(Boolean);
    if (parts.length < 2) continue;
    let cursor = window.agentlas;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
      cursor = cursor[part];
    }
    const leaf = parts[parts.length - 1];
    if (typeof cursor[leaf] === "function") continue;
    cursor[leaf] = (...args) => {
      missingBridgeCalls.push({ path: methodPath, args });
      if (/Channel$/.test(leaf)) return `mock:${methodPath}:${String(args[0] ?? "")}`;
      if (/^(list|search|events|failures|bookmarks|tastes)/i.test(leaf)) return Promise.resolve([]);
      if (/^(has|validate|is)/i.test(leaf)) return Promise.resolve(false);
      return Promise.resolve(null);
    };
  }
}

function preloadMethodPaths(preloadFile) {
  const fs = require("node:fs");
  const path = require("node:path");
  const ts = require("typescript");
  const file = preloadFile || path.resolve(__dirname, "../../electron/preload.ts");
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let apiObject = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === "api" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) apiObject = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!apiObject) throw new Error("Could not find preload api object");
  const methods = [];
  const walkObject = (object, prefix) => {
    for (const prop of object.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = prop.name.getText(sf).replace(/^['"]|['"]$/g, "");
      const next = [...prefix, name];
      if (ts.isObjectLiteralExpression(prop.initializer)) walkObject(prop.initializer, next);
      else if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) methods.push(next.join("."));
    }
  };
  walkObject(apiObject, []);
  return [...new Set(methods)].sort();
}

function mockBridgeOptions(options) {
  return { ...(options || {}), preloadMethodPaths: preloadMethodPaths() };
}

module.exports = { setupMockAgentlasBridge, preloadMethodPaths, mockBridgeOptions };
