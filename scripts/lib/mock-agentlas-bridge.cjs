// Shared mock preload bridge for renderer UI smokes.
// scripts/test-desktop-feature-surfaces.cjs와 scripts/smoke-renderer-ui.cjs가 공유한다.
// 주의: playwright addInitScript로 직렬화되므로 이 함수는 self-contained여야 한다
// (모듈 스코프 변수/클로저 참조 금지 — 함수 본문 안에서 모든 것을 정의).
function setupMockAgentlasBridge(options) {
  let engineToggles = {
    stormbreakerAuto: options?.recommendMode === "pipeline",
    networkAuto: true,
  };

  function makeHubCatalog(total) {
    const catalog = Array.from({ length: total }, (_, index) => {
      if (options?.includeInstallOnlyListing && index === total - 1) {
        return {
          slug: "install-only-agent",
          name: "설치 전용 에이전트",
          nameEn: "Install-only Agent",
          tagline: "로컬에 설치한 뒤 실행하는 공개 패키지",
          taglineEn: "A public package that runs after local installation",
          trustGrade: "B",
          installCount: 2,
          verifiedInvocations: 0,
          manifestUrl: "mock",
          kind: "install-only",
          callable: false,
          routingReady: true,
          source: "hub-index",
          entityKind: "agent",
          installCli: "npx agentlas@latest install install-only-agent",
        };
      }
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
          verifiedInvocations: 14,
          totalBorrows: 19,
          lastRoutingSuccessAt: "2026-07-10T12:00:00.000Z",
          recentFailureRate: 0,
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
        verifiedInvocations: Math.max(1, total - index),
        totalBorrows: Math.max(1, total - index + 4),
        lastRoutingSuccessAt: "2026-07-10T12:00:00.000Z",
        recentFailureRate: index === 1 ? 0.04 : 0,
      };
    });
    if (options?.includeSameSlugEntityCollision) {
      const base = {
        slug: "same-slug-bookmark",
        tagline: "Composite Hub bookmark identity fixture",
        taglineEn: "Composite Hub bookmark identity fixture",
        trustGrade: "A",
        installCount: 1,
        manifestUrl: "mock",
        kind: "cloud-callable",
        callable: true,
        routingReady: true,
        source: "hub-profile",
        verifiedInvocations: 9,
      };
      catalog.push(
        { ...base, name: "동일 슬러그 에이전트", nameEn: "Same Slug Agent", entityKind: "agent", perCallCredits: 3 },
        { ...base, name: "동일 슬러그 팀", nameEn: "Same Slug Team", entityKind: "team", perCallCredits: 10, agentCount: 3 },
      );
    }
    return catalog;
  }

  const now = new Date().toISOString();
  // Keep the mobile pairing IPC modeled rather than letting the generic
  // missing-method proxy return undefined. Settings consumes the status shape
  // immediately, so a neutral proxy would turn a mock drift into a renderer
  // exception instead of exercising the real contract.
  let mobileBridgeRunning = options?.mobileBridgeRunning !== false;
  let mobileBridgeDevices = [];
  const mobileBridgeStatus = () => ({
    running: mobileBridgeRunning,
    endpoint: mobileBridgeRunning ? "wss://127.0.0.1:43123/v1/mobile" : null,
    secure: mobileBridgeRunning,
    hostId: mobileBridgeRunning ? "host_1234567890abcdef1234567890abcdef" : null,
    devices: mobileBridgeDevices.map((device) => ({ ...device })),
    error: mobileBridgeRunning ? null : "Agentlas Mobile Bridge is unavailable",
  });
  let hubAttachmentDecision = null;
  const calls = [];
  const missingBridgeCalls = [];
  const eventHandlers = {};
  const hubBookmarkSnapshotHandlers = [];
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
  function hubBookmarkIdentity(item) {
    const listing = item?.listing || item || {};
    const entityKind = String(listing.entityKind || "agent").trim().toLowerCase() || "agent";
    const slug = String(item?.slug || listing.slug || "").trim().toLowerCase();
    return `${entityKind}:${slug}`;
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
    if (!options?.showFeatureUpdate) {
      window.localStorage.setItem("agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack", "qa-suppressed");
    }
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
    visibility: "background",
    systemPrompt: "# Orchestrator\n\nRoute work clearly.",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
  };
  const neutralOntologyFixture = options?.hubOntologyNeutralFixture === true;
  const purchasedPendingOnly = options?.hubOntologyPurchasedPendingOnly === true;
  const builder = {
    id: "agent-2",
    slug: neutralOntologyFixture ? "research-analyst-agent" : "builder-agent",
    name: neutralOntologyFixture ? "리서치 분석 에이전트" : "빌더 에이전트",
    nameEn: options?.badEnglishAgentMetadata
      ? (neutralOntologyFixture ? "리서치 분석 에이전트" : "빌더 에이전트")
      : neutralOntologyFixture ? "Research Analyst Agent" : "Builder Agent",
    tagline: neutralOntologyFixture ? "근거 조사와 분석을 수행합니다." : "빌드 실행 에이전트",
    taglineEn: neutralOntologyFixture ? "Researches and analyzes evidence." : "Build execution agent",
    kind: "agent",
    tone: "green",
    visibility: "local",
    systemPrompt: neutralOntologyFixture ? "# Research Analyst\n\nAnalyze evidence clearly." : "# Builder\n\nBuild Agentlas work clearly.",
    localPath: "/tmp/agentlas-builder",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
    installedAt: now,
    ...(options?.experienceScenario ? { packageHash: "a".repeat(64), assetSource: "local-import" } : {}),
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
      {
        agentSlug: neutralOntologyFixture ? "research-analyst-agent" : "builder-agent",
        agentId: "agent-2",
        role: neutralOntologyFixture ? "Research Analyst" : "Builder",
        reportsTo: "agentlas-orchestrator",
      },
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
        id: neutralOntologyFixture ? "research-division" : "builder-division",
        name: neutralOntologyFixture ? "Research" : "Build",
        role: neutralOntologyFixture ? "Research" : "Build",
        agentId: "agent-1",
        specialists: [{
          id: neutralOntologyFixture ? "research-node" : "builder-node",
          name: neutralOntologyFixture ? "Research Analyst Agent" : "Builder Agent",
          role: neutralOntologyFixture ? "Research Analyst" : "Builder",
          agentId: "agent-2",
        }],
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
  const experiencePacks = [];
  const experienceCandidates = [];
  const operationalPublicProjections = [];
  const tasteWorkflows = [];
  const experienceReceipts = [];
  const experienceIntents = [];
  const experienceCloudUploads = [];

  window.__qa = {
    calls,
    automations,
    missingBridgeCalls,
    emitHubBookmarkSnapshot: (bookmarks) => {
      hubBookmarks = Array.isArray(bookmarks) ? [...bookmarks] : [];
      saveHubBookmarks();
      const event = { bookmarks: [...hubBookmarks], syncedAt: new Date().toISOString() };
      for (const handler of [...hubBookmarkSnapshotHandlers]) handler(event);
    },
  };
  window.agentlasEvents = {
    on: (channel, handler) => {
      eventHandlers[channel] = eventHandlers[channel] || [];
      eventHandlers[channel].push(handler);
      return () => {
        eventHandlers[channel] = (eventHandlers[channel] || []).filter((item) => item !== handler);
      };
    },
    onActiveChats: () => () => {},
    onMobileBridgeChanged: () => () => {},
    // Browser 승인 바텀시트(BrowserActionApprovalSheet)가 마운트 시 무조건 구독한다 —
    // 없으면 chat 라우트 전체가 client-side exception으로 죽는다.
    onBrowserApproval: () => () => {},
  };
  window.agentlasUpdater = { onState: () => () => {} };
  window.agentlasFiles = { grantForFile: async () => ({ ...droppedFileGrant, scope: { ...droppedFileGrant.scope } }) };

  window.agentlas = {
    app: {
      getLocale: async () => "ko-KR",
      getVersion: async () => options?.appVersion || "0.0.0",
    },
    // Renderer judgment bridge: the mock never has a model, so it returns the
    // caller's deterministic fallback labeled source:"fallback" — the exact
    // no-model contract of the real Main handler.
    judgment: {
      judge: async (spec) => ({
        verdict: String(spec?.fallback ?? ""),
        source: "fallback",
        confidence: 0,
        reason: "mock bridge has no connected model",
      }),
      judgeSubset: async () => ({
        selected: [],
        source: "fallback",
        confidence: 0,
        reason: "mock bridge has no connected model",
      }),
    },
    mobileBridge: {
      status: async () => mobileBridgeStatus(),
      issuePairing: async () => {
        if (!mobileBridgeRunning) throw new Error("Agentlas Mobile Bridge is not running");
        return {
          version: 1,
          hostId: "host_1234567890abcdef1234567890abcdef",
          displayName: "QA Desktop",
          endpoint: "wss://127.0.0.1:43123/v1/mobile",
          pairExchangeEndpoint: "https://127.0.0.1:43123/v1/mobile/pair/exchange",
          code: "A".repeat(22),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          certificateFingerprint: "a".repeat(64),
          // Mirrors the real payload: the fingerprint pins the connection, the
          // certificate never rides in the QR.
          certificateDer: null,
        };
      },
      listDevices: async () => mobileBridgeDevices.map((device) => ({ ...device })),
      retry: async () => {
        mobileBridgeRunning = true;
        return mobileBridgeStatus();
      },
      revokeDevice: async (deviceId) => {
        const index = mobileBridgeDevices.findIndex((device) => device.deviceId === deviceId && device.revokedAt === null);
        if (index < 0) return { ok: false };
        mobileBridgeDevices[index] = { ...mobileBridgeDevices[index], revokedAt: new Date().toISOString() };
        return { ok: true };
      },
      revealLog: async () => ({ ok: true }),
    },
    auth: {
      getSession: async () => ({ signedIn: true, account: { email: "qa@example.com" } }),
      signInWithGoogle: async () => ({ signedIn: true, account: { email: "qa@example.com" } }),
      signOut: async () => ({ signedIn: false }),
      onSessionChanged: () => () => {},
    },
    updater: {
      getState: async () => ({ status: "idle" }),
      check: async () => ({ status: "idle" }),
      install: async () => ({ accepted: false, state: { status: "idle" } }),
      openManualDownload: async () => ({ accepted: false, state: { status: "idle" } }),
      revealRecoveryBackup: async () => ({ accepted: false, state: { status: "idle" } }),
    },
    usage: {
      snapshot: async () => ({ providers: [{ label: "Codex", status: "ok", windows: [{ usedPercent: 10 }] }] }),
      retry: async () => ({
        snapshot: { providers: [{ label: "Codex", status: "ok", windows: [{ usedPercent: 10 }] }] },
        attempted: true,
        retryAfterMs: 10_000,
      }),
    },
    confirm: {
      listPending: async () => pendingConfirmations,
      commitAnswer: async (input) => {
        record("confirm.commitAnswer", input);
        return { chatId: input?.chatId ?? "", sourceMessageId: "mock-question-message" };
      },
      committedAnswers: async () => [],
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
      setLocalDisplayName: async (id, value) => {
        record("team.setLocalDisplayName", { id, value });
        const index = installedAgents.findIndex((agent) => agent.id === id);
        if (index < 0) throw new Error("Mock installed agent not found");
        const normalized = String(value || "").trim();
        installedAgents[index] = {
          ...installedAgents[index],
          ...(normalized ? { localDisplayName: normalized } : {}),
        };
        if (!normalized) delete installedAgents[index].localDisplayName;
        return { ...installedAgents[index] };
      },
      importLocalFolder: async (input) => {
        record("team.importLocalFolder", input);
        const importDelayMs = Math.max(0, Number(options?.importDelayMs) || 0);
        if (importDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, importDelayMs));
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
      syncBookmarks: async () => {
        record("marketplace.syncBookmarks");
        return [...hubBookmarks];
      },
      onBookmarksSnapshot: (handler) => {
        hubBookmarkSnapshotHandlers.push(handler);
        return () => {
          const index = hubBookmarkSnapshotHandlers.indexOf(handler);
          if (index >= 0) hubBookmarkSnapshotHandlers.splice(index, 1);
        };
      },
      bookmarkAdd: async (listing) => {
        record("marketplace.bookmarkAdd", listing);
        const bookmark = { slug: listing?.slug ?? "mock-bookmark", listing, bookmarkedAt: now };
        const identity = hubBookmarkIdentity(bookmark);
        hubBookmarks = [bookmark, ...hubBookmarks.filter((item) => hubBookmarkIdentity(item) !== identity)];
        saveHubBookmarks();
        return bookmark;
      },
      bookmarkRemove: async (slug, entityKind) => {
        record("marketplace.bookmarkRemove", { slug, entityKind });
        const normalizedSlug = String(slug || "").trim().toLowerCase();
        const identity = entityKind ? `${String(entityKind).trim().toLowerCase()}:${normalizedSlug}` : null;
        hubBookmarks = hubBookmarks.filter((item) =>
          identity ? hubBookmarkIdentity(item) !== identity : String(item.slug || "").trim().toLowerCase() !== normalizedSlug
        );
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
      // 실행 전 키 요청 시트 완료 신호 — 스모크에선 활성 요청이 없으므로 멱등 no-op.
      supplyRunKeys: async (runId, outcome) => {
        record("mcpTools.supplyRunKeys", { runId, outcome });
        return { ok: false };
      },
      recommendForBuild: async (input) => {
        record("mcpTools.recommendForBuild", input);
        if (options?.mcpBuildScenario === "recommendation-failure") {
          throw new Error("mock MCP recommendation subsystem outage");
        }
        const candidates = options?.mcpBuildScenario
          ? [
              {
                id: "mcp-browser-primary", catalogId: "agentlas-browser", name: "Agentlas Browser", capability: "browser",
                reason: "request-match", recommendationReasonCode: "browser-interaction", requiresKey: false,
                minimumPermission: "full", minimumScopes: ["approved-browser-session"], permissionBasis: "host-inferred",
                permissionEnforced: false, source: "catalog", installed: false, enabled: true, keyState: "not-required",
                readiness: "available", defaultSelected: true, fallbackGroup: "browser", priority: 100,
              },
              {
                id: "mcp-browser-fallback", catalogId: "playwright", name: "Playwright", capability: "browser",
                reason: "installed-match", recommendationReasonCode: "browser-interaction", requiresKey: false,
                minimumPermission: "full", minimumScopes: ["approved-browser-session"], permissionBasis: "host-inferred",
                permissionEnforced: false, source: "system-registry", installed: true, enabled: true, keyState: "not-required",
                readiness: "ready", defaultSelected: true, fallbackGroup: "browser", priority: 80,
              },
              {
                id: "mcp-github", catalogId: "github", name: "GitHub", capability: "github",
                reason: "installed-match", recommendationReasonCode: "repository-work", requiresKey: true,
                minimumPermission: "write", minimumScopes: ["selected-repository"], permissionBasis: "host-inferred",
                permissionEnforced: false, source: "system-registry", installed: true, enabled: true, keyState: "present",
                readiness: "ready", defaultSelected: true, fallbackGroup: "github", priority: 100,
              },
              {
                id: "mcp-slack", catalogId: "slack", name: "Slack", capability: "slack",
                reason: "request-match", recommendationReasonCode: "slack-work", requiresKey: true,
                minimumPermission: "full", minimumScopes: ["selected-workspace-channels"], permissionBasis: "host-inferred",
                permissionEnforced: false, source: "catalog", installed: false, enabled: true, keyState: "missing",
                readiness: "missing-key", defaultSelected: false, fallbackGroup: "slack", priority: 100,
              },
            ]
          : [];
        return {
          id: "mock-mcp-plan",
          createdAt: now,
          expiresAt: new Date(Date.parse(now) + 20 * 60 * 1000).toISOString(),
          runtimeKind: input?.runtime?.kind ?? "codex",
          status: "ready",
          warningCode: null,
          candidates,
        };
      },
    },
    openCrab: {
      readiness: async () =>
        options?.openCrabReady
          ? { state: "ready", installed: true, enabled: true, configured: true, connected: true }
          : { state: "absent", installed: false, enabled: false, configured: false, connected: false, reason: "not_installed" },
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
    billing: {
      // 자동 라우팅 크레딧 게이트가 조회 — 기본은 넉넉한 잔액(페이월 미발동).
      getCredits: async () => {
        record("billing.getCredits", {});
        return { authenticated: true, plan: "pro", remainingCredits: 1000, earningsCredits: 0 };
      },
      transferEarnings: async (credits) => {
        record("billing.transferEarnings", credits);
        return { ok: true, moved: credits, earningsCredits: 0, remainingCredits: 1000 };
      },
    },
    hephaestus: {
      status: async () => ({ available: true, version: "mock", reason: null }),
      doctor: async () => ({ ok: true, checks: [] }),
      previewAllocation: async (payload) => {
        record("hephaestus.previewAllocation", payload);
        // Mock never escalates: UI gates must be exercised deliberately, not by
        // a fixture that silently swaps the user's model.
        return { current: { kind: "claude-code" }, allocated: { kind: "claude-code" }, escalated: false };
      },
      build: async (payload) => {
        record("hephaestus.build", payload);
        lastRunId += 1;
        const receiptItem = (candidateId, catalogId, name, capability, status, reason, fallbackGroup) => ({
          candidateId, catalogId, name, capability, status, reason, fallbackGroup,
        });
        const mixed = options?.mcpBuildScenario === "mixed";
        const empty = options?.mcpBuildScenario === "empty";
        const browserFailure = receiptItem("mcp-browser-primary", "agentlas-browser", "Agentlas Browser", "browser", "failed", "connection_failed", "browser");
        const browserFallback = receiptItem("mcp-browser-fallback", "playwright", "Playwright", "browser", "attached", "attached", "browser");
        const githubAttached = receiptItem("mcp-github", "github", "GitHub", "github", "attached", "attached", "github");
        return {
          runId: `build-run-${lastRunId}`,
          mcpReceipt: {
            planId: payload?.mcpConsent?.planId ?? "mock-mcp-plan",
            resolvedAt: now,
            attached: mixed ? [browserFallback, githubAttached] : [],
            skipped: empty ? [receiptItem("mcp-github", "github", "GitHub", "github", "skipped", "not_selected", "github")] : [],
            missingKey: [],
            failed: mixed || empty ? [browserFailure, ...(empty ? [receiptItem("mcp-browser-fallback", "playwright", "Playwright", "browser", "failed", "connection_failed", "browser")] : [])] : [],
            degraded: [],
            fallback: mixed ? [{ group: "browser", fromCandidateId: "mcp-browser-primary", toCandidateId: "mcp-browser-fallback", reason: "fallback_used" }] : [],
            emptyMode: !mixed,
            hostReceiptStored: !mixed,
            hostReceiptWarning: mixed ? "receipt_storage_failed" : null,
          },
        };
      },
      buildEventChannel: (runId) => `build:${runId}`,
      buildReady: async (runId) => {
        if (options && options.buildScenario === "slow") {
          window.setTimeout(() => emit(`build:${runId}`, { kind: "stage", stage: "build", text: "QA slow build stage" }), 20);
          return;
        }
        if (options && (options.buildScenario === "interview" || options.buildScenario === "opencrab-interview")) {
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
            const supplementalQuestion = options.buildScenario === "opencrab-interview"
              ? {
                  kind: "opencrab-ontology",
                  question: "연결된 OpenCrab에서 이 빌드 요청과 관련된 지식이 있는지 확인할까요?",
                  options: [
                    { label: "관련성 확인하기", description: "온톨로지 원문 없이 관련성 신호만 사용" },
                    { label: "사용하지 않기", description: "기존 빌드 흐름 유지" },
                  ],
                }
              : undefined;
            window.setTimeout(() => emit(`build:${runId}`, {
              kind: "done",
              text: askBatch,
              result: {
                workspace: "/tmp/agentlas-qa",
                securityScan: { findings: [] },
                ...(supplementalQuestion ? { supplementalQuestion } : {}),
              },
            }), 60);
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
            agents: [{
              id: "agent-1",
              name: "오케스트레이터",
              source: "local",
              estCredits: null,
              target: { source: "local", entityKind: "agent", agentId: "agent-1" },
            }],
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
              {
                id: "no-ai-slop-copywriter",
                name: "No-AI-Slop Copywriter",
                source: "hub",
                estCredits: 3,
                target: { source: "hub", entityKind: "agent", slug: "no-ai-slop-copywriter" },
              },
              {
                id: "security-reviewer",
                name: "Security Reviewer",
                source: "hub",
                estCredits: 3,
                target: { source: "hub", entityKind: "agent", slug: "security-reviewer" },
              },
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
      // Product parity: fresh installs default Network Workforce ON while
      // Stormbreaker remains opt-in (pipeline fixtures enable it explicitly).
      getEngineToggles: async () => ({ ...engineToggles }),
      setEngineToggle: async (payload) => {
        record("hephaestus.setEngineToggle", payload);
        engineToggles = payload.id === "stormbreaker"
          ? { ...engineToggles, stormbreakerAuto: payload.enabled === true }
          : { ...engineToggles, networkAuto: payload.enabled === true };
        return { ...engineToggles };
      },
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
        return { id, projectId: input.projectId || null, firmId: input.firmId || null, agentId: input.agentId || "agent-2", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now, originSurface: input.originSurface === "one" ? "one" : "work" };
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
          const stormbreaker = /^stormbreaker\b/i.test(String(payload?.userPrompt || "").trim());
          if (stormbreaker) {
            const storm = (status, phase, done = false) => emit(`invoke:${runId}`, {
              kind: "thinking",
              status,
              agentId: "stormbreaker-supervisor",
              agentName: "Stormbreaker",
              role: "Goal · UltraCode",
              phase,
              done,
            });
            window.setTimeout(() => storm("Stormbreaker · 목표와 완료 조건을 잠그고 실행 범위를 정리합니다.", "plan"), 20);
            window.setTimeout(() => storm("Stormbreaker · 부모 플래너가 목표를 독립 작업으로 나누고 런타임·모델·effort를 선택합니다.", "plan"), 90);
            window.setTimeout(() => storm("Stormbreaker · 코드 검증에 Codex · gpt-5.6-luna · effort high를 배정했습니다.", "delegate"), 170);
            window.setTimeout(() => storm("Stormbreaker · UX 검증에 Claude Code · claude-sonnet-4-6 · effort medium을 배정했습니다.", "delegate"), 250);
            window.setTimeout(() => storm("Stormbreaker · 작업 증거를 서로 대조하고 최종 완료 게이트를 판정합니다.", "synthesize"), 430);
            window.setTimeout(() => storm("Stormbreaker · 최종 게이트 판정과 결과 종합을 마쳤습니다.", "synthesize", true), 900);
          } else {
            window.setTimeout(() => emit(`invoke:${runId}`, { kind: "thinking", status: "Agentlas orchestrator started" }), 20);
            window.setTimeout(() => emit(`invoke:${runId}`, { kind: "tool-use", status: "Hub 에이전트 빌리는 중: qa-agent" }), 70);
          }
          const finalText = String(payload?.userPrompt || "").trim() === "그중 소음이 가장 낮은 건 뭐야?"
            ? "세 제품 중에서는 위닉스 타워 프라임이 가장 조용한 편이에요. 다만 25평 거실 전체 정화 성능까지 함께 보면 LG가 더 안정적이고, 침실 중심이면 위닉스가 더 잘 맞습니다."
            : "QA final";
          window.setTimeout(() => finish(finalText), finalDelay);
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
      entries: async (agentId) => options?.technicalMemoryScenario && agentId === "agent-2"
        ? [{
            id: "memory-browser-connection-failure",
            scope: "agent_repo",
            kind: "risk",
            content: "no-slop-seeder 2026-07-06: playwright-core connectOverCDP가 Browser.setDownloadBehavior 설정에서 실패했습니다. curl로 원격 디버깅 주소를 확인하고 Node 네이티브 WebSocket으로 다시 연결해 해결했습니다.",
            confidence: "high",
            sensitivity: "internal",
            evidence: [],
            chatId: null,
            projectPath: null,
            createdAt: now,
          }]
        : options?.experienceScenario && agentId === "agent-2"
          ? [{
            id: "memory-browser-workflow",
            scope: "agent_repo",
            kind: "procedure",
            content: "브라우저 게시 전 보이는 계정과 최종 화면을 확인한다.",
            confidence: "high",
            sensitivity: "internal",
            evidence: [],
            chatId: null,
            projectPath: "/tmp/agentlas-qa",
            createdAt: now,
          }]
          : [],
      importPreview: async (agentId, sourcePath) => {
        record("agentMemory.importPreview", agentId, sourcePath);
        return {
          sourcePath: sourcePath || "/tmp/legacy-memory",
          targetAgentId: agentId,
          targetKind: "agent",
          rows: [],
          summary: { total: 0, newCount: 0, duplicateCount: 0, redactedCount: 0, byOwner: {}, byKind: {} },
        };
      },
      importApply: async (agentId, sourcePath) => {
        record("agentMemory.importApply", agentId, sourcePath);
        return {
          sourcePath: sourcePath || "/tmp/legacy-memory",
          targetAgentId: agentId,
          imported: 0,
          skippedDuplicate: 0,
          redacted: 0,
          embedded: 0,
          intakeAttempted: 0,
          byOwner: {},
        };
      },
    },
    agentLearning: {
      summary: async (agentId) => {
        record("agentLearning.summary", agentId);
        const files = Object.keys(filesForAgent(agentId));
        const proposals = evolutionProposals.filter((proposal) => proposal.agentId === agentId);
        return {
          agentId,
          runCount: agentId === "agent-2" ? 7 : 2,
          lastRunAt: now,
          legacyChatLinkedRunCount: agentId === "agent-2" ? 3 : 1,
          legacyChatLinkedLastRunAt: now,
          legacyChatLinkedFailureCount: agentId === "agent-2" ? 1 : 0,
          durableMemoryCount: agentId === "agent-2" ? 4 : 1,
          curationTurnCount: agentId === "agent-2" ? 7 : 2,
          noNewMemoryTurnCount: agentId === "agent-2" ? 3 : 1,
          memoryEventCount: agentId === "agent-2" ? 9 : 2,
          memoryWrittenCount: agentId === "agent-2" ? 4 : 1,
          memoryDedupedCount: agentId === "agent-2" ? 2 : 1,
          memoryRedactedCount: agentId === "agent-2" ? 1 : 0,
          memorySessionOnlyCount: agentId === "agent-2" ? 1 : 0,
          memoryDiscardedCount: agentId === "agent-2" ? 1 : 0,
          memoryMarkdownCount: files.includes("memory.md") ? 3 : 0,
          failureCount: agentId === "agent-2" ? 1 : 0,
          evolutionProposalCount: proposals.length,
          legacyUnattributedCount: 2,
          localFileCount: files.length,
          localReceiptCount: proposals.reduce((count, proposal) => count + (proposal.receipts?.length || 0), 0),
        };
      },
    },
    // v74 사용 원장 + 북마크 — 로스터 섹션/배지 표면의 fixture.
    agents: {
      usageSummary: async () => {
        record("agents.usageSummary");
        if (!options?.experienceScenario) return [];
        return [
          {
            agentId: "agent-2",
            kind: "agent",
            firstUsedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
            lastUsedAt: now,
            useCount: 9,
            bookmarkedAt: null,
            installed: true,
          },
          {
            agentId: "hub-borrowed-researcher",
            kind: "agent",
            firstUsedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
            lastUsedAt: now,
            useCount: 6,
            bookmarkedAt: null,
            installed: false,
          },
        ];
      },
      borrowedProfiles: async () => {
        record("agents.borrowedProfiles");
        if (!options?.experienceScenario) return [];
        return [{
          profileId: "borrowed-profile:qa-researcher",
          slug: "hub-borrowed-researcher",
          entityKind: "agent",
          name: "허브 리서처",
          nameEn: "Hub Borrowed Researcher",
          tagline: "사용자별 대여 실행 경험",
          taglineEn: "Owner-scoped borrowed execution experience",
          bookmarkedAt: now,
          firstUsedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
          lastUsedAt: now,
          useCount: 6,
          latestRuntime: {
            provider: "openai",
            modelId: "gpt-5.6-sol",
            effort: "high",
            source: "manual-override",
            recordedAt: now,
          },
          memoryCount: options?.borrowedEmptyGraph ? 0 : 1,
          relationCount: options?.borrowedEmptyGraph ? 0 : 1,
          hasQuarantinedDeviceHistory: false,
        }];
      },
      borrowedOntologyGraph: async (profileId) => ({
        schema: "agentlas.ontology-relation-graph.v1",
        agentId: profileId,
        generatedAt: now,
        nodes: options?.borrowedEmptyGraph ? [
          { id: "borrowed-root", kind: "agent", ref: profileId, safeLabel: "Agent", status: "active", source: "synthetic" },
        ] : [
          { id: "borrowed-root", kind: "agent", ref: profileId, safeLabel: "Agent", status: "active", source: "synthetic" },
          { id: "borrowed-memory", kind: "experience-item", ref: "memory-ref", safeLabel: "Experience", localLabel: "Verify sources before synthesis", status: "active", source: "relation-index" },
        ],
        edges: options?.borrowedEmptyGraph
          ? []
          : [{ id: "borrowed-edge", from: "borrowed-root", to: "borrowed-memory", kind: "contains", status: "active" }],
        totalNodeCount: options?.borrowedEmptyGraph ? 1 : 2,
        totalEdgeCount: options?.borrowedEmptyGraph ? 0 : 1,
        omittedNodeCount: 0,
        omittedEdgeCount: 0,
        truncated: false,
        limits: { nodes: 400, edges: 800 },
      }),
      setBookmark: async (agentId, bookmarked) => {
        record("agents.setBookmark", { agentId, bookmarked });
        return { agentId, bookmarkedAt: bookmarked ? now : null };
      },
    },
    experience: {
      intakeDiagnostics: async (agentId) => {
        record("experience.intakeDiagnostics", agentId);
        if (!options?.experienceScenario) {
          return {
            agentId,
            totals: { candidateCreated: 0, blocked: 0, skipped: 0 },
            redactedAdmits: { receipts: 0, redactedSpans: 0 },
            reasons: [],
          };
        }
        return {
          agentId,
          totals: { candidateCreated: 4, blocked: 2, skipped: 1 },
          redactedAdmits: { receipts: 2, redactedSpans: 5 },
          reasons: [
            { status: "candidate-created", code: "redacted-admit", count: 2 },
            { status: "blocked", code: "secret-value", count: 1 },
            { status: "blocked", code: "local-path-or-url", count: 1 },
            { status: "skipped", code: "non-operational-memory-kind", count: 1 },
          ],
        };
      },
      hubCatalog: async () => {
        record("experience.hubCatalog");
        if (options?.experienceCatalogUnavailable) {
          return { status: "unavailable", chips: [], checkedAt: now, message: "지금은 Hub 경험칩 목록을 불러오지 못했습니다." };
        }
        return {
          status: "ready",
          checkedAt: now,
          chips: [{
            title: options?.hubOperationalChipTitle || "브라우저 자동화 막힘 해결",
            summary: options?.hubOperationalChipSummary || "막힌 브라우저 자동화를 안전하게 복구합니다.",
            benefits: [options?.hubOperationalChipSummary || "권한과 실행 경로를 먼저 확인해 불필요한 재시도를 줄입니다."],
            author: "경험칩 제작자",
            workLabels: ["브라우저 자동화"],
            offers: [
              { mode: "purchase", durationDays: null, credits: 25 },
              { mode: "lease", durationDays: 30, credits: 20 },
            ],
            detailPath: "/ontology/opx-browser-recovery",
            updatedAt: now,
          }],
        };
      },
      ontologySummary: async (agentId) => {
        record("experience.ontologySummary", agentId);
        const agentPacks = experiencePacks.filter((pack) => pack.agentId === agentId);
        const packIds = new Set(agentPacks.map((pack) => pack.id));
        const agentCandidates = experienceCandidates.filter((candidate) => packIds.has(candidate.packId));
        const populated = Boolean(options?.experienceScenario);
        return {
          packCount: populated ? Math.max(2, agentPacks.length) : agentPacks.length,
          candidateCount: populated ? Math.max(6, agentCandidates.length) : agentCandidates.length,
          promotedCount: populated ? Math.max(3, agentCandidates.filter((item) => item.status === "promoted").length) : agentCandidates.filter((item) => item.status === "promoted").length,
          tasteDraftCount: populated ? 2 : 0,
          tasteNeedsEvidenceCount: populated ? 2 : 0,
          tasteUnclassifiedCount: populated ? 1 : 0,
          taskCount: populated ? 5 : 0,
          evidenceCount: populated ? 8 : 0,
          mcpCount: populated ? 2 : 0,
          lineageCount: populated ? 4 : 0,
          updateRelationCount: populated ? 3 : 0,
          localReceiptCount: experienceReceipts.filter((receipt) => packIds.has(receipt.packId)).length + experienceIntents.filter((intent) => packIds.has(intent.packId)).length,
          autoIntake: populated
            ? {
                candidateCreated: 4,
                blocked: 2,
                skipped: 1,
                reasons: [
                  { code: "privacy_sensitive", count: 2 },
                  { code: "duplicate_memory", count: 1 },
                ],
              }
            : { candidateCreated: 0, blocked: 0, skipped: 0, reasons: [] },
        };
      },
      ontologyGraph: async (agentId) => {
        record("experience.ontologyGraph", agentId);
        const rootId = `ontology-agent:${agentId}`;
        if (!options?.experienceScenario || options?.emptyOntologyGraph) {
          return {
            schema: "agentlas.ontology-relation-graph.v1",
            agentId,
            generatedAt: now,
            nodes: [{ id: rootId, kind: "agent", ref: agentId, status: "active", source: "synthetic" }],
            edges: [],
            totalNodeCount: 1,
            totalEdgeCount: 0,
            omittedNodeCount: 0,
            omittedEdgeCount: 0,
            truncated: false,
            limits: { nodes: 400, edges: 800 },
          };
        }
        const node = (id, kind, status, source, extra = {}) => ({ id, kind, status, source, ...extra });
        const edge = (id, from, to, kind, status = "active") => ({ id, from, to, kind, status });
        const nodes = [
          node(rootId, "agent", "active", "synthetic", { ref: agentId }),
          node("pack:research-ops", "pack", "active", "relation-index", { ref: "research-ops", packId: "research-ops", localLabel: "리서치 운영 경험" }),
          node("release:research-ops:r3", "release", "active", "relation-index", { ref: "research-ops-r3", packId: "research-ops" }),
          node("release:research-ops:base", "release", "active", "relation-index", { ref: "sha256:8ab31e", packId: "research-ops" }),
          node("item:source-triangulation", "experience-item", "promoted", "relation-index", { ref: "source-triangulation", packId: "research-ops", localLabel: "출처 3곳 교차검증 후 결론 확정" }),
          node("item:claim-ledger", "experience-item", "promoted", "relation-index", { ref: "claim-ledger", packId: "research-ops", localLabel: "주장-근거 원장으로 검증 관리" }),
          node("item:failure-recovery", "experience-item", "promoted", "relation-index", { ref: "failure-recovery", packId: "research-ops" }),
          node("candidate:browser-proof", "experience-item", "candidate", "private-candidate", { ref: "browser-proof", packId: "research-ops", localLabel: "게시 전 렌더링 화면 확인" }),
          node("task:research", "task", "active", "relation-index", { ref: "agentlas.task.v1/research", safeLabel: "research", packId: "research-ops" }),
          node("task:browser-verification", "task", "active", "relation-index", { ref: "browser-verification", safeLabel: "browser verification", packId: "research-ops" }),
          node("task:source-audit", "task", "active", "relation-index", { ref: "source-audit", safeLabel: "source audit", packId: "research-ops" }),
          node("mcp:browser", "mcp", "active", "relation-index", { ref: "agentlas-browser", safeLabel: "Agentlas Browser", packId: "research-ops" }),
          node("mcp:github", "mcp", "active", "relation-index", { ref: "github", safeLabel: "GitHub", packId: "research-ops" }),
          node("evidence:receipt-1", "evidence", "active", "relation-index", { ref: "receipt-1", packId: "research-ops" }),
          node("evidence:receipt-2", "evidence", "active", "relation-index", { ref: "receipt-2", packId: "research-ops" }),
          node("environment:darwin-arm64", "environment", "active", "relation-index", { ref: "darwin:arm64:codex", safeLabel: "macOS · Codex", packId: "research-ops" }),
          node("pack:editorial-taste", "pack", "active", "relation-index", { ref: "editorial-taste", packId: "editorial-taste" }),
          node("release:editorial-taste:r2", "release", "historical", "relation-index", { ref: "editorial-taste-r2", packId: "editorial-taste" }),
          node("taste:density", "taste-draft", "pending-evidence", "taste-draft", { ref: "taste-density", packId: "editorial-taste" }),
          node("taste:typography", "taste-draft", "pending-evidence", "taste-draft", { ref: "taste-typography", packId: "editorial-taste" }),
          node("axis:density", "taste-axis", "active", "taste-draft", { ref: "density", safeLabel: "density", packId: "editorial-taste" }),
          node("axis:typography", "taste-axis", "active", "taste-draft", { ref: "typography", safeLabel: "typography", packId: "editorial-taste" }),
        ];
        const edges = [
          edge("edge:agent:research", rootId, "pack:research-ops", "agent_has_pack"),
          edge("edge:pack:release", "pack:research-ops", "release:research-ops:r3", "has_release"),
          edge("edge:release:base", "release:research-ops:r3", "release:research-ops:base", "exact_base_binding"),
          edge("edge:release:item1", "release:research-ops:r3", "item:source-triangulation", "contains"),
          edge("edge:release:item2", "release:research-ops:r3", "item:claim-ledger", "contains"),
          edge("edge:release:item3", "release:research-ops:r3", "item:failure-recovery", "contains"),
          edge("edge:pack:candidate", "pack:research-ops", "candidate:browser-proof", "contains_candidate", "pending"),
          edge("edge:item1:research", "item:source-triangulation", "task:research", "applies_to_task"),
          edge("edge:item1:audit", "item:source-triangulation", "task:source-audit", "applies_to_task"),
          edge("edge:item2:audit", "item:claim-ledger", "task:source-audit", "applies_to_task"),
          edge("edge:item3:browser", "item:failure-recovery", "task:browser-verification", "applies_to_task"),
          edge("edge:release:browser", "release:research-ops:r3", "mcp:browser", "requires_mcp"),
          edge("edge:browser:github", "mcp:browser", "mcp:github", "alternative_mcp", "pending"),
          edge("edge:item1:evidence", "item:source-triangulation", "evidence:receipt-1", "supported_by"),
          edge("edge:item2:evidence", "item:claim-ledger", "evidence:receipt-2", "supported_by"),
          edge("edge:release:env", "release:research-ops:r3", "environment:darwin-arm64", "applies_in_environment"),
          edge("edge:agent:taste-pack", rootId, "pack:editorial-taste", "agent_has_pack"),
          edge("edge:taste-pack:release", "pack:editorial-taste", "release:editorial-taste:r2", "has_release", "historical"),
          edge("edge:agent:taste1", rootId, "taste:density", "agent_has_taste_draft", "pending"),
          edge("edge:agent:taste2", rootId, "taste:typography", "agent_has_taste_draft", "pending"),
          edge("edge:taste1:axis", "taste:density", "axis:density", "classified_as_taste_axis", "pending"),
          edge("edge:taste2:axis", "taste:typography", "axis:typography", "classified_as_taste_axis", "pending"),
        ];
        return {
          schema: "agentlas.ontology-relation-graph.v1",
          agentId,
          generatedAt: now,
          nodes,
          edges,
          totalNodeCount: nodes.length,
          totalEdgeCount: edges.length,
          omittedNodeCount: 0,
          omittedEdgeCount: 0,
          truncated: false,
          limits: { nodes: 400, edges: 800 },
        };
      },
      hubProjection: async (agentId, force) => {
        record("experience.hubProjection", { agentId, force: force === true });
        const hubOntologyAgentId = options?.hubOntologyAgentId || "agent-2";
        if (!options?.experienceScenario || agentId !== hubOntologyAgentId) {
          return {
            schemaVersion: 1,
            status: "unbound",
            supported: false,
            binding: null,
            projection: null,
          };
        }
        const agentDefinitionId = `agent-definition-${hubOntologyAgentId}`;
        const agentReleaseId = `agent-release-${hubOntologyAgentId}-r7`;
        return {
          schemaVersion: 1,
          status: "live",
          supported: true,
          binding: { agentDefinitionId, agentReleaseId },
          projection: {
            schemaVersion: 1,
            agentDefinitionId,
            agentReleaseId,
            state: "live",
            generatedAt: now,
            revision: `rev_${"a".repeat(32)}`,
            operationalChips: [{
              chipId: "chip-browser-publish",
              releaseId: "chip-browser-publish-r3",
              kind: "operational",
              displayName: options?.hubOperationalChipTitle || "게시 전 최종 화면 확인",
              summary: options?.hubOperationalChipSummary || "브라우저 게시 전 보이는 계정과 최종 화면을 확인하는 재현 가능한 절차입니다.",
              version: "3.0.0",
              verification: "verified",
              labels: ["browser", "publish"],
              evidenceLabel: "재현 성공",
              evidenceCount: 18,
            }],
            tasteChips: [{
              chipId: "chip-editorial-taste",
              releaseId: "chip-editorial-taste-r2",
              kind: "taste",
              displayName: "절제된 에디토리얼 톤",
              summary: "사람 A/B 선택에서 과한 장식보다 간결한 정보 밀도를 선호한 Taste 근거입니다.",
              version: "2.1.0",
              verification: "requested",
              labels: ["editorial", "pairwise"],
              evidenceLabel: "사람 A/B 선택",
              evidenceCount: 24,
            }],
            loadout: {
              revision: `rev_${"b".repeat(32)}`,
              state: purchasedPendingOnly ? "empty" : "ready",
              entries: purchasedPendingOnly ? [] : [{
                  chipId: "chip-browser-publish",
                  releaseId: "chip-browser-publish-r3",
                  kind: "operational",
                  state: "attached",
                }],
              changedAt: now,
            },
            ...purchasedPendingOnly && hubAttachmentDecision !== "approve" ? {} : {
              scheduledNextSession: {
                revision: `rev_${"c".repeat(32)}`,
                state: "pending-next-session",
                entries: hubAttachmentDecision === "approve"
                  ? [{
                      chipId: "chip-browser-publish",
                      releaseId: "chip-browser-publish-r4",
                      kind: "operational",
                      state: "scheduled-next-session",
                    }]
                  : [{
                      chipId: "chip-editorial-taste",
                      releaseId: "chip-editorial-taste-r2",
                      kind: "taste",
                      state: "scheduled-next-session",
                    }],
                changedAt: now,
              },
            },
            recommendations: hubAttachmentDecision ? [] : [{
              recommendationId: "recommendation-operational-r4",
              source: "Hephaestus Network",
              summary: "실패 복구 방법 업데이트",
              reasons: ["최근 게시 실패 복구 작업과 일치"],
              tradeoffs: ["다음 세션부터만 적용"],
              proposedChips: [{
                chipId: "chip-browser-publish",
                releaseId: "chip-browser-publish-r4",
                kind: "operational",
                state: "pending-approval",
              }],
              requiresApproval: true,
              createdAt: now,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }],
            pendingAttachApprovals: hubAttachmentDecision ? [] : [{
              approvalId: "approval-operational-r4",
              recommendationId: "recommendation-operational-r4",
              expectedLoadoutRevision: `rev_${"b".repeat(32)}`,
              selectedChips: [{
                chipId: "chip-browser-publish",
                releaseId: "chip-browser-publish-r4",
                kind: "operational",
                state: "pending-approval",
              }],
              createdAt: now,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }],
          },
        };
      },
      hubResolveAttach: async (agentId, approvalId, decision) => {
        record("experience.hubResolveAttach", { agentId, approvalId, decision });
        if (approvalId !== "approval-operational-r4" || (decision !== "approve" && decision !== "deny")) {
          throw new Error("Attachment approval changed");
        }
        hubAttachmentDecision = decision;
        const projection = await window.agentlas.experience.hubProjection(agentId, true);
        return {
          schemaVersion: 1,
          outcome: decision === "approve" ? "accepted" : "denied",
          loadoutState: decision === "approve" ? "applying" : "ready",
          acknowledgedAt: now,
          projection,
        };
      },
      createPack: async (input) => {
        record("experience.createPack", input);
        const pack = {
          id: `mock-experience-pack-${experiencePacks.length + 1}`,
          agentId: input.agentId,
          projectId: input.projectId ?? null,
          projectPath: input.projectGrant?.path ?? null,
          environmentKey: "mock-environment",
          environmentProfile: {
            schema: "agentlas.experience-environment-profile.v1",
            os: "agentlas.env.v1/os/macos",
            arch: "agentlas.env.v1/arch/arm64",
            runtime: "agentlas.env.v1/runtime/codex",
            constraints: ["agentlas.env.v1/os/macos", "agentlas.env.v1/arch/arm64", "agentlas.env.v1/runtime/codex"],
          },
          autoManaged: false,
          name: input.name,
          description: input.description ?? "",
          basePackageHash: "a".repeat(64),
          baseAgentDefinitionId: options?.experienceScenario ? `agent-definition-${input.agentId}` : null,
          baseAgentReleaseId: options?.experienceScenario ? `agent-release-${input.agentId}-r7` : null,
          basePackageHashVersion: options?.experienceScenario ? 1 : null,
          mcpRequirements: [],
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        experiencePacks.unshift(pack);
        return pack;
      },
      listPacks: async (input) => experiencePacks.filter((pack) => pack.agentId === input.agentId),
      captureFromMemory: async (input) => {
        record("experience.captureFromMemory", input);
        const pack = experiencePacks.find((item) => item.id === input.packId);
        if (!pack) throw new Error("No mock Experience Pack");
        const existing = experienceCandidates.find((item) => item.packId === input.packId && item.sourceMemoryId === input.sourceMemoryId);
        if (existing) return existing;
        const candidate = {
          id: `mock-experience-candidate-${experienceCandidates.length + 1}`,
          packId: input.packId,
          agentId: pack.agentId,
          sourceMemoryId: input.sourceMemoryId,
          summary: "브라우저 게시 전 보이는 계정과 최종 화면을 확인한다.",
          sensitivity: "internal",
          confidence: "high",
          status: "candidate",
          outcomeStatus: "unverified",
          publicSafe: false,
          taskSignatures: ["agentlas.task.v1/browser-automation"],
          autoManaged: false,
          createdAt: now,
          updatedAt: now,
          promotedAt: null,
        };
        experienceCandidates.unshift(candidate);
        return candidate;
      },
      listCandidates: async (packId) => experienceCandidates.filter((item) => item.packId === packId),
      listOperationalPublicProjections: async (packId) => operationalPublicProjections.filter((item) => item.packId === packId),
      saveOperationalPublicProjection: async (input) => {
        record("experience.saveOperationalPublicProjection", input);
        const pack = experiencePacks.find((item) => item.id === input.packId);
        if (!pack) throw new Error("No mock Experience Pack");
        let projection = operationalPublicProjections.find((item) => item.packId === input.packId);
        const value = {
          projectionId: projection?.projectionId || `opx_${"f".repeat(48)}`,
          packId: input.packId,
          agentId: pack.agentId,
          basePackageHash: pack.basePackageHash,
          baseAgentDefinitionId: pack.baseAgentDefinitionId || `agd_${"a".repeat(48)}`,
          baseAgentReleaseId: pack.baseAgentReleaseId || `agr_${"b".repeat(48)}`,
          environmentKey: pack.environmentKey,
          sourceBindings: input.sourceCandidateIds.map((candidateId) => ({ candidateId, sourceItemHash: `sha256:${"c".repeat(64)}` })),
          title: input.title,
          instructions: input.instructions,
          taskSignatures: input.taskSignatures,
          environmentConstraints: input.environmentConstraints,
          sourceSnapshotHash: "d".repeat(64),
          proposalHash: "e".repeat(64),
          privacyIssueCodes: [],
          status: "proposal",
          confirmationHash: null,
          confirmedAt: null,
          createdAt: projection?.createdAt || now,
          updatedAt: now,
        };
        if (projection) Object.assign(projection, value);
        else {
          projection = value;
          operationalPublicProjections.unshift(projection);
        }
        return projection;
      },
      confirmOperationalPublicProjection: async (input) => {
        record("experience.confirmOperationalPublicProjection", input);
        const projection = operationalPublicProjections.find((item) => item.projectionId === input.projectionId);
        if (!projection) throw new Error("No mock Operational projection");
        projection.status = "confirmed";
        projection.confirmationHash = "f".repeat(64);
        projection.confirmedAt = now;
        return projection;
      },
      listTasteDrafts: async (agentId) => options?.experienceScenario && agentId === (options?.hubOntologyAgentId || "agent-2") ? [
        {
          id: "taste-draft-editorial-1",
          agentId,
          sourceMemoryId: "memory-taste-editorial-1",
          statement: "과한 장식보다 비대칭 에디토리얼 레이아웃을 선호합니다.",
          sensitivity: "internal",
          confidence: "medium",
          axisCandidates: ["composition", "density"],
          taskSignatures: ["agentlas.task.v1/design"],
          basePackageHash: "a".repeat(64),
          baseAgentDefinitionId: null,
          baseAgentReleaseId: null,
          evidenceState: "pairwise-required",
          status: "observation",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "taste-draft-motion-2",
          agentId,
          sourceMemoryId: "memory-taste-motion-2",
          statement: "전환은 빠르되 시선 이동을 방해하는 튕김 효과는 피합니다.",
          sensitivity: "internal",
          confidence: "high",
          axisCandidates: ["motion", "pacing"],
          taskSignatures: ["agentlas.task.v1/design"],
          basePackageHash: "a".repeat(64),
          baseAgentDefinitionId: `agent-definition-${agentId}`,
          baseAgentReleaseId: `agent-release-${agentId}-r7`,
          evidenceState: "pairwise-required",
          status: "observation",
          createdAt: now,
          updatedAt: now,
        },
      ] : [],
      listTasteWorkflows: async (agentId) => tasteWorkflows.filter((item) => item.agentId === agentId),
      saveTasteGeneralization: async (input) => {
        record("experience.saveTasteGeneralization", input);
        const existing = tasteWorkflows.find((item) => item.draftId === input.draftId);
        const workflow = Object.assign(existing || {}, {
          workflowId: existing?.workflowId || `twf_${"a".repeat(48)}`,
          draftId: input.draftId,
          agentId: input.agentId,
          basePackageHash: "a".repeat(64),
          baseAgentDefinitionId: `agent-definition-${input.agentId}`,
          baseAgentReleaseId: `agent-release-${input.agentId}-r7`,
          environmentKey: "env:mock",
          tasteStyleId: `tst_${"b".repeat(48)}`,
          releaseId: `tsr_${"c".repeat(48)}`,
          title: input.title,
          summary: input.summary,
          ruleStatement: input.ruleStatement,
          axis: input.axis,
          taskSignature: input.taskSignature,
          contexts: input.contexts,
          generalizationHash: `sha256:${"d".repeat(64)}`,
          privacyIssueCodes: [],
          status: "proposal",
          confirmedAt: null,
          previewNames: null,
          previewRights: null,
          remotePreviewAssetIds: null,
          remoteRevision: null,
          remoteErrorCode: null,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        });
        if (!existing) tasteWorkflows.unshift(workflow);
        return workflow;
      },
      confirmTasteGeneralization: async (input) => {
        record("experience.confirmTasteGeneralization", input);
        const workflow = tasteWorkflows.find((item) => item.workflowId === input.workflowId);
        if (!workflow) throw new Error("No mock Taste workflow");
        workflow.status = "confirmed";
        workflow.confirmedAt = now;
        return workflow;
      },
      pickTastePreviews: async () => null,
      prepareTastePreviews: async (input) => {
        record("experience.prepareTastePreviews", input);
        const workflow = tasteWorkflows.find((item) => item.workflowId === input.workflowId);
        if (!workflow) throw new Error("No mock Taste workflow");
        workflow.previewNames = ["left.webp", "right.webp"];
        workflow.previewRights = input.rightsStatus;
        return workflow;
      },
      uploadTasteDraft: async (input) => {
        record("experience.uploadTasteDraft", input);
        const workflow = tasteWorkflows.find((item) => item.workflowId === input.workflowId);
        if (!workflow) throw new Error("No mock Taste workflow");
        workflow.status = "moderation-pending";
        workflow.remotePreviewAssetIds = [`tap_${"1".repeat(48)}`, `tap_${"2".repeat(48)}`];
        workflow.remoteRevision = `rev_${"e".repeat(32)}`;
        return workflow;
      },
      promote: async (input) => {
        record("experience.promote", input);
        const candidate = experienceCandidates.find((item) => item.id === input.candidateId);
        if (!candidate) throw new Error("No mock Experience candidate");
        candidate.status = "promoted";
        candidate.outcomeStatus = "attested";
        candidate.promotedAt = now;
        const receipt = {
          id: `mock-experience-receipt-${experienceReceipts.length + 1}`,
          packId: candidate.packId,
          candidateId: candidate.id,
          agentId: candidate.agentId,
          action: "promote",
          explicitConsent: true,
          verificationStatus: "attested",
          verificationMethod: "user-attested",
          evidenceHash: "b".repeat(64),
          publicSafe: false,
          createdAt: now,
        };
        experienceReceipts.unshift(receipt);
        return receipt;
      },
      listPromotionReceipts: async (packId) => experienceReceipts.filter((item) => item.packId === packId),
      createExportIntent: async (input) => {
        record("experience.createExportIntent", input);
        const pack = experiencePacks.find((item) => item.id === input.packId);
        if (!pack) throw new Error("No mock Experience Pack");
        const intent = {
          id: `mock-experience-intent-${experienceIntents.length + 1}`,
          packId: pack.id,
          agentId: pack.agentId,
          visibility: input.visibility,
          status: "local_intent",
          manifestHash: "c".repeat(64),
          createdAt: now,
        };
        experienceIntents.unshift(intent);
        return intent;
      },
      listExportIntents: async (packId) => experienceIntents.filter((item) => item.packId === packId),
      cloudSave: async (input) => {
        record("experience.cloudSave", input);
        const pack = experiencePacks.find((item) => item.id === input.packId);
        if (!pack) throw new Error("No mock Experience Pack");
        if (input.requestedVisibility === "private") {
          pack.baseAgentDefinitionId = pack.baseAgentDefinitionId || `agd_${"a".repeat(48)}`;
          pack.baseAgentReleaseId = pack.baseAgentReleaseId || `agr_${"b".repeat(48)}`;
          pack.basePackageHashVersion = "path-sha256-executable-v2";
        }
        const existing = experienceCloudUploads.find((item) =>
          item.packId === input.packId && item.requestedVisibility === input.requestedVisibility);
        if (existing) return existing;
        const isPublic = input.requestedVisibility === "public";
        const hashDigit = isPublic ? "d" : "c";
        const bundleId = `exb_${hashDigit.repeat(48)}`;
        const bundleHash = `sha256:${hashDigit.repeat(64)}`;
        const receipt = {
          schema: "agentlas.experience-upload-receipt.v1",
          uploadId: isPublic ? `exu_${"2".repeat(48)}` : `exu_${"1".repeat(48)}`,
          bundleId,
          bundleHash,
          experiencePackId: `exp_${"a".repeat(48)}`,
          experienceReleaseId: `exr_${"b".repeat(48)}`,
          ownerWorkspaceRef: "workspace:qa-experience-owner",
          status: isPublic ? "verification-requested" : "draft-saved",
          requestedVisibility: input.requestedVisibility,
          revision: isPublic ? `rev_${"2".repeat(32)}` : `rev_${"1".repeat(32)}`,
          createdAt: now,
          updatedAt: now,
        };
        const forcedState = options?.experienceCloudState;
        const upload = {
          id: isPublic ? "mock-cloud-public" : "mock-cloud-private",
          packId: pack.id,
          requestedVisibility: input.requestedVisibility,
          bundleId,
          bundleHash,
          bundle: {
            schemaVersion: "agentlas.experience-bundle.v1",
            kind: "agentlas-experience-bundle",
            bundleId,
            bundleHash,
            requestedVisibility: input.requestedVisibility,
            pack: { experiencePackId: receipt.experiencePackId, releaseId: receipt.experienceReleaseId },
            items: [], sourceAttestations: [], privacy: {},
          },
          idempotencyKey: isPublic ? "mock-public-idempotency" : "mock-private-idempotency",
          remoteUploadId: receipt.uploadId,
          remoteRevision: receipt.revision,
          state: forcedState || (isPublic ? "verification-requested" : "private-saved"),
          errorCode: forcedState === "conflict" ? "revision_conflict" : forcedState === "offline" ? "offline" : null,
          errorMessage: forcedState === "conflict" ? "Mock server revision conflict" : forcedState === "offline" ? "Mock network unavailable" : null,
          receipt,
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
        };
        experienceCloudUploads.unshift(upload);
        return upload;
      },
      cloudList: async (packId) => experienceCloudUploads.filter((item) => item.packId === packId),
      cloudReconcile: async (input) => {
        record("experience.cloudReconcile", input);
        const upload = experienceCloudUploads.find((item) => item.id === input.localUploadId);
        if (!upload) throw new Error("No mock Experience Cloud upload");
        if (upload.requestedVisibility === "public" && upload.state === "verification-requested") {
          upload.state = "verification-pending";
          upload.receipt.status = "verification-pending";
          upload.remoteRevision = `rev_${"3".repeat(32)}`;
          upload.receipt.revision = upload.remoteRevision;
        }
        return upload;
      },
      cloudExport: async (input) => {
        record("experience.cloudExport", input);
        const upload = experienceCloudUploads.find((item) => item.id === input.localUploadId);
        if (!upload) throw new Error("No mock Experience Cloud upload");
        return { bundle: upload.bundle, receipt: upload.receipt };
      },
      cloudWithdraw: async (input) => {
        record("experience.cloudWithdraw", input);
        const upload = experienceCloudUploads.find((item) => item.id === input.localUploadId);
        if (!upload) throw new Error("No mock Experience Cloud upload");
        upload.state = "withdrawn";
        upload.receipt.status = "withdrawn";
        return upload;
      },
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
      listGrowth: async (_limit) => {
        record("agentEvolution.listGrowth", { limit: _limit });
        const growth = evolutionProposals.filter((item) => item.source && item.source._growth === true);
        return {
          pending: growth.filter((item) => item.status === "candidate"),
          autoApplied: growth.filter(
            (item) => item.source._autoApplied === true && (item.status === "applied" || item.status === "measured"),
          ),
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
  const appVersion = require("../../package.json").version;
  return { ...(options || {}), appVersion, preloadMethodPaths: preloadMethodPaths() };
}

module.exports = { setupMockAgentlasBridge, preloadMethodPaths, mockBridgeOptions };
