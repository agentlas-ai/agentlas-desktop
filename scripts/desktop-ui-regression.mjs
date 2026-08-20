import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.AGENTLAS_DESKTOP_BASE_URL ?? "http://127.0.0.1:3100";
const runs = Number.parseInt(process.env.UI_REGRESSION_RUNS ?? "1", 10);
const screenshotDir = path.resolve(process.cwd(), process.env.UI_REGRESSION_ARTIFACT_DIR ?? path.join("artifacts", "ui-regression"));
const recordVideo = process.env.UI_REGRESSION_RECORD_VIDEO === "1";
const viewport = { width: 1440, height: 980 };

// 2026-08-10 현대화: 체크는 현재 UI의 실물 계약(실측 덤프)에 맞춘다.
// - import-dashboard: 대시보드에서 가져오기 버튼이 사라져 제거(가져오기는 /library/agents로
//   이동했는데 목 픽스처가 그 흐름을 지원하지 않아 별도 커버 불가 — 픽스처 보강 후 복원).
// - chat: /chat 라우트는 실물이 없어 404 — 현 채팅 표면인 /workspace/task로 이동.
const allRoutes = [
  { name: "dashboard", path: "/dashboard", check: checkDashboard },
  { name: "hub", path: "/marketplace", check: checkHub },
  { name: "build", path: "/build", check: checkBuild },
  { name: "cloud-upload", path: "/cloud", check: checkCloudUpload },
  { name: "apps", path: "/apps", check: checkApps },
  { name: "startup-studio", path: "/startup-founder-studio", check: checkStartupStudio },
  { name: "agents", path: "/library/agents", check: checkAgents },
  { name: "chat", path: "/workspace/task?id=chat-1", check: checkChat },
];
const routeFilter = new Set(
  (process.env.UI_REGRESSION_ROUTES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const routes = routeFilter.size > 0
  ? allRoutes.filter((route) => routeFilter.has(route.name))
  : allRoutes;

fs.rmSync(screenshotDir, { recursive: true, force: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const evidence = [];

for (let run = 1; run <= runs; run += 1) {
  for (const route of routes) {
    const context = await browser.newContext({
      viewport,
      recordVideo: recordVideo ? { dir: screenshotDir, size: viewport } : undefined,
    });
    await context.addInitScript(mockAgentlasBridge);
    const page = await context.newPage();
    const video = page.video();
    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    try {
      console.log(`[ui-regression] run ${run}/${runs} ${route.name} start`);
      await page.goto(`${baseUrl}${route.path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await route.check(page);
      const bodyText = (await page.locator("body").innerText()).trim();
      if (bodyText.length < 20) throw new Error("Rendered body is unexpectedly empty.");
      if (run === 1) {
        await page.screenshot({ path: path.join(screenshotDir, `${route.name}.png`), fullPage: true });
      }
      const actionableErrors = errors.filter((line) => !/favicon|hydration warning/i.test(line));
      if (actionableErrors.length > 0) throw new Error(actionableErrors.join("\n"));
      evidence.push({ route: route.name, path: route.path, run, status: "pass" });
      console.log(`[ui-regression] pass ${run}/${runs} ${route.name}`);
    } catch (err) {
      const baseMessage = err instanceof Error ? err.message : String(err);
      const message = errors.length > 0
        ? `${baseMessage}\nBrowser errors:\n${errors.join("\n")}`
        : baseMessage;
      failures.push(`${route.name} run ${run}: ${message}`);
      evidence.push({ route: route.name, path: route.path, run, status: "fail", message });
      await page.screenshot({ path: path.join(screenshotDir, `${route.name}-failed-run-${run}.png`), fullPage: true }).catch(() => {});
    } finally {
      await context.close();
      if (recordVideo && video) {
        try {
          const rawVideo = await video.path();
          const target = path.join(screenshotDir, `${String(run).padStart(2, "0")}-${route.name}.webm`);
          fs.renameSync(rawVideo, target);
        } catch (err) {
          console.warn(`[ui-regression] could not save video for ${route.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

await browser.close();

fs.writeFileSync(
  path.join(screenshotDir, "proof-summary.json"),
  JSON.stringify(
    {
      ok: failures.length === 0,
      baseUrl,
      recordedAt: new Date().toISOString(),
      recordVideo,
      viewport,
      evidence,
      failures,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log(`[ui-regression] clean runs: ${runs}`);

async function checkDashboard(page) {
  await page.getByRole("heading", { name: /대시보드|Dashboard/ }).waitFor();
  // 상시 위젯 두 개가 실제로 그려졌는가 — 승인 대기 스트립 + 런타임 연결 섹션.
  await page.getByText(/승인 대기|awaiting approval/).first().waitFor();
  // 화면상 대문자는 CSS text-transform — DOM 텍스트는 "Subscription · CLI"다.
  await page.getByText(/Subscription · CLI|구독형 · CLI/i).first().waitFor();
}

async function checkHub(page) {
  await page.getByText(/AI 인재·도구|AI talent & tools/).first().waitFor();
  await page.getByText(/경험칩 사고팔기|Buy & sell Experience Chips/).first().waitFor();
}

async function checkBuild(page) {
  await page.getByRole("heading", { name: /빌드|Build/ }).waitFor();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).first().click();
  await page.getByText(/빌드 0크레딧|Build 0 credits/).first().waitFor();
  await page.getByRole("textbox").first().fill("검증용 리서치 에이전트");
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  // 실행(딥인터뷰 시작)은 목 계약 밖 — 흐름이 시작 가능한 상태까지를 지킨다.
  await page.getByRole("button", { name: /빌드 시작|Start build/ }).waitFor();
}

async function checkCloudUpload(page) {
  await page.getByRole("heading", { name: /에이전트 저장 및 공개|Save or publish an agent/ }).waitFor();
  await page.getByRole("button", { name: /저장할 에이전트 폴더 선택|Choose an agent folder/ }).waitFor();
}

async function checkApps(page) {
  await page.getByRole("heading", { name: /아이디어를 실제 인터페이스로|Turn an idea into a working interface/ }).waitFor();
  if ((await page.getByText(/Oberon|T-rex/).count()) > 0) {
    throw new Error("Hidden experimental apps leaked into Sites.");
  }
}

async function checkStartupStudio(page) {
  await page.getByText("Startup Founder Studio", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: /새 아이디어|New Idea/ }).click();
  await page.getByPlaceholder(/창업 아이디어|startup idea/i).fill("검증용 창업 아이디어");
  await page.getByRole("button", { name: /^시작$|^Start$/ }).click();
  await page.locator("iframe[title='Startup Founder Studio'], iframe[title='스타트업 창업자 스튜디오']").waitFor();
}

async function checkAgents(page) {
  await page.getByRole("heading", { name: /Agent toolbox|에이전트 도구함/i }).first().waitFor();
  if ((await page.getByText("Orchestrator").count()) > 0) {
    throw new Error("System agent leaked into the user-facing agents screen.");
  }
  await page.getByText("Builder Agent").first().click();
  await page.getByText(/Builder Agent|빌더 에이전트/).first().waitFor();
}

async function checkChat(page) {
  // 현 채팅 표면(/workspace/task)이 목 채팅으로 부팅되고 컴포저가 입력 가능한가.
  await page.getByRole("textbox").first().waitFor();
  await page.getByRole("textbox").first().fill("검증용 에이전트 만들어줘");
}

function mockAgentlasBridge() {
  try {
    window.localStorage.setItem("agentlas.onboarded", "1");
    window.localStorage.setItem("agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack", "qa-suppressed");
    window.localStorage.setItem("agentlas.shellTour.dismissed.v1", "1");
    // 첫 실행 마법사·One 소개는 전 화면을 덮는다 — 억제 키가 빠지면 모든 라우트
    // 검사가 마법사 화면만 보고 죽는다(2026-08-10 실측, 컴포넌트 추가 후 목 미갱신).
    // 키의 버전은 컴포넌트가 정본이다 — v2 만 심어 두었더니 온보딩이 v3 로 올라간 뒤
    // 이 게이트가 다시 마법사 화면만 보고 죽었다(2026-08-20 실측). 옛 버전도 함께 심는
    // 이유는 옛 체크아웃에서도 이 게이트가 돌아야 하기 때문이다.
    for (const version of ["v2", "v3"]) {
      window.localStorage.setItem(`agentlas.work.firstRunOnboarding.${version}`, "1");
    }
    window.localStorage.setItem("agentlas.one.acknowledgedIntroVersion", "qa-suppressed");
    // 실행 시 계정 안내도 전 화면을 덮는다(role=presentation 백드롭이 클릭을 가로챈다).
    // 스누즈 값은 "지금부터 한 주" 형태여야 컴포넌트의 상한 검사를 통과한다.
    window.localStorage.setItem(
      "agentlas.beta-economy-notice.snoozed-until",
      String(Date.now() + 6 * 24 * 60 * 60 * 1000),
    );
    for (const id of ["dashboard", "workspace", "build", "agents", "hub", "automation", "automation-new", "automation-detail", "environment"]) {
      window.localStorage.setItem(`agentlas.pageTour.${id}.dismissed.v2`, "1");
    }
  } catch {
    // about:blank has no storage access before the first real navigation.
  }

  let installedPlugins = [];
  let runtimeOverrides = [];
  const now = new Date().toISOString();
  const agent = {
    id: "agent-1",
    slug: "agentlas-orchestrator",
    name: "오케스트레이터",
    nameEn: "Orchestrator",
    tagline: "요청을 분류하고 적절한 에이전트로 라우팅합니다.",
    taglineEn: "Routes requests to the right agent.",
    kind: "agent",
    tone: "blue",
    visibility: "background",
    systemPrompt: "# Orchestrator\n\nRoute work clearly.",
    mcpServers: ["github", "slack"],
    preferredBackend: "codex",
    trustGrade: "A",
  };
  const builderAgent = {
    id: "agent-2",
    slug: "builder-agent",
    name: "빌더 에이전트",
    nameEn: "Builder Agent",
    tagline: "빌드 실행 에이전트",
    taglineEn: "Build execution agent",
    kind: "agent",
    tone: "purple",
    visibility: "local",
    systemPrompt: "# Builder\n\nBuild Agentlas work clearly.",
    mcpServers: ["github"],
    preferredBackend: "codex",
    trustGrade: "A",
  };
  const firm = {
    id: "firm-1",
    slug: "founder-hq",
    name: "Founder HQ",
    nameEn: "Founder HQ",
    tagline: "창업자 작업을 돕는 팀",
    taglineEn: "Team for founder work",
    ceoAgentId: "agent-1",
    orgChart: [
      { agentSlug: "agentlas-orchestrator", agentId: "agent-1", role: "Orchestrator", reportsTo: null },
      { agentSlug: "builder-agent", agentId: "agent-2", role: "Builder", reportsTo: "agentlas-orchestrator" },
    ],
  };
  const resolvedOrg = {
    source: "orgchart",
    firmId: "firm-1",
    ceo: { id: "agentlas-orchestrator", name: "Orchestrator", role: "Orchestrator", agentId: "agent-1" },
    divisions: [
      {
        id: "builder-hq",
        name: "Builder HQ",
        role: "Builder HQ",
        agentId: "agent-1",
        specialists: [{ id: "builder-node", name: "Builder Agent", role: "Builder", agentId: "agent-2" }],
      },
    ],
  };
  const pluginCatalog = [
    {
      id: "slack",
      name: "Slack",
      nameEn: "Slack",
      description: "채널 메시지 읽기와 전송",
      descriptionEn: "Read and send channel messages",
      category: "communication",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      envRequirements: [{ key: "SLACK_BOT_TOKEN", label: "Slack token", labelEn: "Slack token", required: true, hint: "", hintEn: "" }],
      trust: "official",
      docsUrl: "https://example.com/slack",
      brandColor: "#4A154B",
      mark: "S",
    },
    {
      id: "github",
      name: "GitHub",
      nameEn: "GitHub",
      description: "이슈, PR, 코드 검색",
      descriptionEn: "Search issues, PRs, and code",
      category: "dev",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envRequirements: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub token", labelEn: "GitHub token", required: true, hint: "", hintEn: "" }],
      trust: "official",
      docsUrl: "https://example.com/github",
      brandColor: "#24292F",
      mark: "GH",
    },
  ];

  window.agentlasEvents = {
    on: (_channel, handler) => {
      window.setTimeout(() => handler({ kind: "stage", text: "검증 stage", phase: "delegate" }), 20);
      window.setTimeout(() => handler({ kind: "done", text: "검증 완료" }), 50);
      return () => {};
    },
    onActiveChats: () => () => {},
    // AppShell이 모든 라우트에서 마운트하는 구독 표면 — 목에 없으면 앱 부팅 자체가
    // TypeError로 죽어 이 게이트가 아무 라우트도 검증하지 못한다(2026-08-10 실측).
    onBrowserApproval: () => () => {},
    onMobileBridgeChanged: () => () => {},
    onSiteActivity: () => () => {},
  };

  window.agentlasUpdater = {
    onState: () => () => {},
  };

  window.agentlas = {
    // 대시보드 위젯·사이드바가 하드 호출하는 네임스페이스 — 목에 없으면 페이지가
    // TypeError로 ErrorBoundary에 잡혀 모든 라우트 검사가 죽는다(2026-08-10 실측,
    // 위젯 추가 후 목 미갱신 드리프트).
    tasks: {
      list: async () => [],
      findForChat: async () => null,
      get: async () => null,
    },
    confirm: {
      listPending: async () => [],
      committedAnswers: async () => [],
    },
    quests: {
      list: async () => [],
      claim: async () => ({ ok: true }),
    },
    agentEvolution: {
      listGrowth: async () => [],
      approveAndApply: async () => ({ ok: true }),
      reject: async () => ({ ok: true }),
      rollback: async () => ({ ok: true }),
    },
    app: {
      getLocale: async () => "ko-KR",
      getVersion: async () => "0.2.32",
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
    marketplace: {
      listBundles: async () => [],
      listFirms: async () => [firm],
      search: async () => [{ slug: "research-agent", name: "Research Agent", nameEn: "Research Agent", tagline: "조사 전문 에이전트", taglineEn: "Research specialist", trustGrade: "A", installCount: 12, manifestUrl: "mock" }],
      status: async () => ({ mode: "mcp", baseUrl: "mock", online: true, usingFallback: false, lastError: null, lastCheckedAt: now }),
      listMine: async () => [],
    },
    firms: {
      list: async () => [firm],
      install: async () => firm,
      get: async () => firm,
      getResolvedOrg: async () => resolvedOrg,
    },
    team: {
      list: async () => [agent, builderAgent],
      install: async () => agent,
      importLocalFolder: async () => agent,
    },
    mcpTools: {
      listCatalog: async () => pluginCatalog,
      listInstalled: async () => installedPlugins,
      install: async (catalogId) => {
        const server = { id: `mcp-${catalogId}`, catalogId, name: catalogId, nameEn: catalogId, transport: "stdio", command: "npx", args: [], url: null, envKeys: [], enabled: true, installedAt: now };
        installedPlugins = [server, ...installedPlugins.filter((item) => item.catalogId !== catalogId)];
        return server;
      },
      installCustom: async () => null,
      remove: async () => {},
      setEnabled: async (_id, enabled) => ({ ...installedPlugins[0], enabled }),
      test: async () => ({ ok: true }),
      status: async () => [],
    },
    hephaestus: {
      status: async () => ({ available: true, version: "3.9", reason: null }),
      doctor: async () => ({ ok: true, checks: [] }),
      stormbreaker: async () => ({ ok: true, runId: "stormbreaker-run-1" }),
      getSupervisor: async () => ({ enabled: true }),
      setSupervisor: async (enabled) => ({ enabled }),
      journal: async () => ({ ok: true, entries: [] }),
      build: async () => ({ runId: "build-run-1" }),
      buildEventChannel: (runId) => `build:${runId}`,
      buildReady: async () => {},
      cancelBuild: async () => {},
      publish: async () => ({ ok: true }),
      startStudio: async () => ({ ok: true, url: "/surface-preview" }),
      aoGraph: async () => ({ ok: true, json: { edges: [{ from: "User / Hub request", to: "agent-1", type: "handoff" }] } }),
      search: async () => ({ ok: true, json: { candidates: [] } }),
      network: async () => ({ ok: true, json: { candidates: [] } }),
      localGui: async () => ({ ok: true }),
      package: async () => ({ ok: true }),
      securityScan: async () => ({ ok: true, findings: [] }),
    },
    appFactory: {
      scaffold: async () => null,
      syncCloudManifest: async () => ({ ok: true }),
      runAutopilot: async () => ({ summary: "Autopilot mock complete", waitingOn: [] }),
      installMcpPlan: async () => ({ adapters: [], missingCredentials: [] }),
      runProviderTasks: async () => ({ summary: "Provider tasks mock complete" }),
      materializeAssets: async () => ({ summary: "Assets mock complete" }),
      activateLocalCommerceStack: async () => ({ summary: "Local stack mock complete" }),
      openProviderBrowser: async () => ({ summary: "Provider browser mock opened" }),
      captureProviderBrowserSessions: async () => ({ summary: "Provider sessions mock captured" }),
      launchProviderBrowserSession: async () => ({ summary: "Provider session mock launched" }),
      syncProviderBrowserResults: async () => ({ summary: "Provider results mock synced" }),
      resolveProviderCredentials: async () => ({ summary: "Credentials mock resolved" }),
      approveProviderPayment: async () => ({ summary: "Payment mock approved" }),
      runSmoke: async () => ({ ok: true, exitCode: 0 }),
      preparePreview: async () => ({ deployPath: "/tmp/agentlas-preview", fileUrl: "about:blank" }),
      openLaunchTarget: async () => ({ ok: true, url: "about:blank" }),
      publishAsTool: async () => ({ summary: "Tool publish mock complete" }),
      listApps: async () => [],
      getApp: async () => null,
      getAppBySurface: async () => null,
      listOperations: async () => [],
      archive: async () => ({}),
      restore: async () => ({}),
    },
    toolFactory: {
      scaffold: async () => null,
      runSmoke: async () => ({ ok: true, exitCode: 0 }),
      installMcp: async () => ({ server: { name: "mock-tool-mcp" } }),
      archive: async () => ({ result: {} }),
      restore: async () => ({ result: { summary: "Generated tool restored." } }),
      listTools: async () => [],
      getTool: async () => null,
      getToolBySurface: async () => null,
      listOperations: async () => [],
    },
    chats: {
      get: async () => ({ id: "chat-1", projectId: null, firmId: null, agentId: "agent-1", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now }),
      listRecent: async () => [],
      create: async () => ({ id: "chat-1", projectId: null, firmId: null, agentId: "agent-1", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now }),
      rename: async () => {},
      archive: async () => {},
      delete: async () => {},
    },
    agentGroups: {
      list: async () => [],
      listResolved: async () => [],
      getResolved: async () => null,
      create: async (input) => ({ id: "group-1", ...input, members: input.members ?? [], createdAt: now, updatedAt: now }),
      update: async (id, patch) => ({ id, name: patch.name ?? "QA Group", description: patch.description ?? "", orchestratorName: patch.orchestratorName ?? "QA Group Orchestrator", members: patch.members ?? [], createdAt: now, updatedAt: now }),
      removeMember: async () => ({ id: "group-1", name: "QA Group", description: "", orchestratorName: "QA Group Orchestrator", members: [], createdAt: now, updatedAt: now }),
      remove: async () => {},
    },
    invoke: {
      history: async () => [],
      attach: async () => null,
      activeChats: async () => [],
      run: async () => ({ runId: "invoke-run-1" }),
      cancel: async () => {},
      eventChannel: (runId) => `invoke:${runId}`,
    },
    projects: { list: async () => [], get: async () => null },
    env: { list: async () => [], set: async () => ({ ok: true }) },
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
      getSettings: async () => ({ imageProvider: "", videoProvider: "", audioProvider: "" }),
      saveSettings: async (settings) => settings,
      status: async () => [],
    },
    migration: {
      scan: async () => [],
      import: async () => ({ imported: 0, skipped: 0, errors: [] }),
    },
    runtime: {
      listCommands: async () => [{ name: "/hep-build", description: "Build via Hephaestus", source: "codex" }],
      detect: async () => [{ kind: "codex", backend: "openai", source: "/usr/local/bin/codex", version: "mock", active: true, model: "", efforts: [], availableModels: ["gpt-5.1-codex", "gpt-5.1"] }],
      listModels: async () => [
        { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
        { id: "gpt-5.1", label: "GPT-5.1" },
      ],
    },
    agentRuntime: {
      list: async () => runtimeOverrides,
      get: async (scope, targetId) => runtimeOverrides.find((item) => item.scope === scope && item.targetId === targetId) ?? null,
      set: async (input) => {
        const saved = { ...input, updatedAt: now };
        runtimeOverrides = [saved, ...runtimeOverrides.filter((item) => item.scope !== input.scope || item.targetId !== input.targetId)];
        return saved;
      },
      remove: async (scope, targetId) => {
        runtimeOverrides = runtimeOverrides.filter((item) => item.scope !== scope || item.targetId !== targetId);
      },
    },
    workspace: { get: async () => null },
    automations: { list: async () => [] },
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
    surfaceAssets: {
      materialize: async () => null,
      archive: async () => ({ result: {} }),
      restore: async () => ({ result: { summary: "Asset pack restored." } }),
      listPacks: async () => [],
      getPack: async () => null,
      getPackBySurface: async () => null,
      listOperations: async () => [],
    },
    agentFiles: {
      list: async () => ({ entries: [{ kind: "file", name: "AGENT.md", path: "AGENT.md" }, { kind: "file", name: "memory.md", path: "memory.md" }] }),
      read: async (_id, filePath) => ({
        content: filePath.toLowerCase().includes("memory")
          ? "# Memory\n\n## Decisions\n- **Route clearly** - Keep routing explicit.\n\n## Gotchas\n- **No fake data** - Do not show mock state as live.\n\n## Open Questions\n- **Publish target** - Confirm Cloud or Hub."
          : "# Orchestrator\n\nYou route Agentlas work clearly.",
      }),
      write: async () => {},
    },
    fs: { pickDirectory: async () => "/tmp/agentlas-qa" },
    usage: { snapshot: async () => null },
  };

  // ── 로드 경로 명시 스텁 — 이미 있는 픽스처는 절대 덮지 않고 빠진 것만 채운다 ──
  // (2026-08-10 실측: 위젯·패널 추가 후 목 미갱신 드리프트로 게이트 전 라우트 사망)
  const fillMissing = (ns, stubs) => {
    const target = window.agentlas[ns] ?? (window.agentlas[ns] = {});
    for (const [key, fn] of Object.entries(stubs)) {
      if (typeof target[key] !== "function") target[key] = fn;
    }
  };
  fillMissing("marketplace", {
    bookmarks: async () => [],
    syncBookmarks: async () => ({ ok: true }),
    onBookmarksSnapshot: () => () => {},
  });
  fillMissing("projects", { list: async () => [], get: async () => null, timeline: async () => null });
  fillMissing("env", { list: async () => [] });
  fillMissing("automations", {
    list: async () => [],
    latestRun: async () => null,
    listRuns: async () => [],
    listTriggerAttention: async () => [],
  });
  // listRoleMembers는 null이 "풀 미지원 빌드" 안전 경로 — 배열을 주면 role 키를 읽다 죽는다.
  fillMissing("runtime", { listRoleMembers: async () => null });
  fillMissing("invoke", { latestReceipt: async () => null, receipt: async () => null, latestOneSurface: async () => null });
  fillMissing("chats", { recap: async () => null, listByFirm: async () => [], markViewed: async () => ({ ok: true }) });
  fillMissing("hephaestus", { recover: async () => ({ ok: true }), updateJournal: async () => null, getEngineToggles: async () => ({}) });
  fillMissing("mcpTools", { pendingHubApprovals: async () => [] });
  fillMissing("workspace", { get: async () => null, defaultRunFolder: async () => null });
  fillMissing("cloudAgents", { listRegisteredUploadOptions: async () => [] });
  fillMissing("fs", { readTextFile: async () => null, listDirectory: async () => [] });

  // ── 목 드리프트 백스톱 — 정의 안 된 메서드는 null-resolve 스텁으로 받는다.
  // 새 메서드 하나가 추가될 때마다 게이트 전체가 TypeError로 죽는 구조를 없앤다.
  // 화면 검증(헤딩·텍스트박스 대기)은 그대로 동작하므로 실제 UI 회귀는 계속 잡힌다.
  const mockRoot = window.agentlas;
  window.agentlas = new Proxy(mockRoot, {
    get(target, ns) {
      const value = target[ns];
      if (typeof ns !== "string") return value;
      const nsObject = value && typeof value === "object" ? value : {};
      return new Proxy(nsObject, {
        get(nsTarget, method) {
          if (method in nsTarget) return nsTarget[method];
          if (typeof method !== "string") return undefined;
          // 구독형(onX·대문자 경계)은 동기 unsubscribe 함수를 돌려줘야 한다 — Promise를
          // 주면 cleanup에서 unsubscribe()가 TypeError로 죽는다(AuthGate 실측).
          // 경계 검사 없이 "on" 접두사만 보면 ontologySummary 같은 일반 메서드가
          // 구독 스텁을 받아 .then에서 죽는다(agents 라우트 실측).
          if (/^on[A-Z]/.test(method)) return () => () => {};
          return async () => null;
        },
      });
    },
  });
}
