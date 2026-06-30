import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.AGENTLAS_DESKTOP_BASE_URL ?? "http://127.0.0.1:3100";
const runs = Number.parseInt(process.env.UI_REGRESSION_RUNS ?? "1", 10);
const screenshotDir = path.resolve(process.cwd(), process.env.UI_REGRESSION_ARTIFACT_DIR ?? path.join("artifacts", "ui-regression"));
const recordVideo = process.env.UI_REGRESSION_RECORD_VIDEO === "1";
const viewport = { width: 1440, height: 980 };

const routes = [
  { name: "import-dashboard", path: "/dashboard", check: checkDashboardImport },
  { name: "dashboard", path: "/dashboard", check: checkDashboard },
  { name: "hub", path: "/marketplace", check: checkHub },
  { name: "build", path: "/build", check: checkBuild },
  { name: "cloud-upload", path: "/cloud", check: checkCloudUpload },
  { name: "apps", path: "/apps", check: checkApps },
  { name: "startup-studio", path: "/startup-founder-studio", check: checkStartupStudio },
  { name: "agents", path: "/library/agents", check: checkAgents },
  { name: "chat", path: "/chat?id=chat-1", check: checkChat },
  { name: "onboarding", path: "/onboarding", check: checkOnboarding },
];

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
      const message = err instanceof Error ? err.message : String(err);
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

async function checkDashboardImport(page) {
  await page.getByRole("heading", { name: /대시보드|Dashboard/ }).waitFor();
  await page.getByRole("button", { name: /에이전트 가져오기|Import agents/ }).click();
  await page.getByText(/가져오기 완료|Imported/).waitFor();
}

async function checkDashboard(page) {
  await page.getByRole("heading", { name: /대시보드|Dashboard/ }).waitFor();
  await page.getByText("Founder HQ").click();
  await page.getByText("Builder Agent").first().waitFor();
  await page.getByText("Builder Agent").first().click();
  await page.waitForURL(/\/library\/agents\?.*agentId=agent-2/);
  await page.getByText("실행 모델 지정").waitFor();
}

async function checkHub(page) {
  await page.getByText("Hub", { exact: true }).waitFor();
  await page.getByText(/Hub 실시간|Hub realtime|에이전트 받기|Agent Hub/).first().waitFor();
}

async function checkBuild(page) {
  await page.getByRole("heading", { name: /빌드|Build/ }).waitFor();
  await page.getByText("hep-build", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: /단일 에이전트/ }).click();
  await page.getByText(/빌드 0크레딧|Build 0 credits/).first().waitFor();
  await page.getByPlaceholder(/인스타그램/).fill("검증용 리서치 에이전트");
  await page.getByRole("button", { name: /생성 폴더 선택/ }).click();
  await page.getByRole("button", { name: /빌드 시작|Start build/ }).click();
  await page.getByText(/딥인터뷰|답변 대기|Deep interview|awaiting/).first().waitFor();
}

async function checkCloudUpload(page) {
  await page.getByRole("heading", { name: /에이전트 업로드|Agent upload/ }).waitFor();
  await page.getByRole("button", { name: /업로드할 에이전트 폴더 선택|Choose an agent folder/ }).click();
  await page.getByRole("button", { name: /^업로드$|^Upload$/ }).click();
  await page.getByText(/업로드 완료|Upload complete/).waitFor();
}

async function checkApps(page) {
  await page.getByText("Agent Apps", { exact: true }).waitFor();
  await page.getByText(/에이전트 앱 3개|3 agent apps/).waitFor();
  await page.getByText(/스타트업 창업자 스튜디오|Startup Founder Studio/).first().waitFor();
  await page.getByRole("button", { name: /런타임 점검|Check runtime/ }).click();
  await page.getByText(/런타임 준비됨|Runtime ready/).waitFor();
}

async function checkStartupStudio(page) {
  await page.getByText("Startup Founder Studio", { exact: true }).waitFor();
  await page.getByRole("button", { name: /새 아이디어/ }).click();
  await page.getByPlaceholder(/창업 아이디어|startup idea/i).fill("검증용 창업 아이디어");
  await page.getByRole("button", { name: /^시작$/ }).click();
  await page.locator("iframe[title='Startup Founder Studio']").waitFor();
}

async function checkAgents(page) {
  await page.getByRole("heading", { name: /My Agents|내 에이전트/ }).waitFor();
  if ((await page.getByText("Orchestrator").count()) > 0) {
    throw new Error("System agent leaked into the user-facing agents screen.");
  }
  await page.getByText("Builder Agent").first().click();
  await page.getByText(/Builder Agent|빌더 에이전트/).first().waitFor();
}

async function checkChat(page) {
  await page.getByRole("textbox").waitFor();
  await page.getByRole("textbox").fill("검증용 에이전트 만들어줘");
  await page.getByText(/알아서 에이전트 부르기|에이전트 찾기|Find agents/).first().waitFor();
}

async function checkOnboarding(page) {
  await page.getByText(/Agentlas에 오신 걸 환영해요|Welcome to Agentlas/).waitFor();
}

function mockAgentlasBridge() {
  try {
    window.localStorage.setItem("agentlas.onboarded", "1");
    window.localStorage.setItem("agentlas.shellTour.dismissed.v1", "1");
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
  };

  window.agentlasUpdater = {
    onState: () => () => {},
  };

  window.agentlas = {
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
}
