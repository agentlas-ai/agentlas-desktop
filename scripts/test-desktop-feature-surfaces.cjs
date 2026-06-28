#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "desktop-feature-surfaces");

if (!fs.existsSync(path.join(distDir, "build.html"))) {
  console.error("dist/renderer is missing. Run npm run build:renderer first.");
  process.exit(2);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
};

function resolveAsset(urlPath) {
  let pathname = decodeURIComponent(urlPath.split("?")[0] || "/");
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  const nestedIcon = pathname.match(/^\/.+\/(icon\.png)$/);
  if (nestedIcon) pathname = `/${nestedIcon[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = resolveAsset(req.url || "/");
      res.writeHead(filePath.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(filePath)] || "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const evidence = [];
  try {
    await runBuildSurface(browser, baseUrl, evidence);
    await runLibrarySurface(browser, baseUrl, evidence);
    await runChatSurface(browser, baseUrl, evidence);
    await runAutomationSurface(browser, baseUrl, evidence);
    await runHubLiveSurface(browser, baseUrl, evidence);

    const proof = {
      ok: true,
      baseUrl,
      recordedAt: new Date().toISOString(),
      evidence,
      screenshots: outDir,
    };
    fs.writeFileSync(path.join(outDir, "proof-summary.json"), JSON.stringify(proof, null, 2) + "\n", "utf8");
    console.log("desktop feature surface smoke passed");
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

async function newPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(setupMockAgentlasBridge, options);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/favicon|Failed to load resource/i.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  return { context, page, errors };
}

async function finishPage(context, page, errors, evidence, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  assert.deepEqual(errors, [], `${name} should not emit page errors`);
  evidence.push({ name, status: "pass", url: page.url() });
  await context.close();
}

async function runBuildSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /빌드|Build/ }).waitFor();
  await page.getByText("hep-build", { exact: true }).waitFor();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).click();

  await page.locator(".build-starter-chip").first().click();
  const textarea = page.locator("textarea").first();
  assert.ok((await textarea.inputValue()).length > 10, "starter chip should fill the request textarea");

  await page.waitForFunction(() => document.querySelectorAll("#build-model-select option").length >= 2);
  await page.locator("#build-model-select").selectOption({ index: 1 });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.getByText(/tmp\/agentlas-qa|agentlas-qa/).waitFor();

  await textarea.fill("검증용 리서치 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  try {
    await page.getByText(/패키지 준비됨|Package ready/).waitFor({ timeout: 7000 });
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "build-surface-timeout.png"), fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    const calls = await page.evaluate(() => window.__qa.calls).catch(() => []);
    console.error(JSON.stringify({ buildTimeout: true, body: body.slice(0, 3000), calls, errors }, null, 2));
    throw err;
  }
  await page.getByText(/정적 보안 스캔 통과|Static security scan passed/).waitFor();
  await page.getByRole("button", { name: /허브 \(공개\)|Hub \(public\)/ }).click();

  const calls = await page.evaluate(() => window.__qa.calls);
  const buildCall = calls.find((call) => call.name === "hephaestus.build");
  assert.equal(buildCall.payload.mode, "single");
  assert.equal(buildCall.payload.workspace, "/tmp/agentlas-qa");
  assert.equal(buildCall.payload.request, "검증용 리서치 에이전트");
  assert.ok(buildCall.payload.runtime, "selected build runtime should be passed");
  assert.ok(calls.some((call) => call.name === "team.importLocalFolder" && call.payload === "/tmp/agentlas-qa/qa-agent"));
  assert.ok(calls.some((call) => call.name === "hephaestus.publish" && call.payload.visibility === "marketplace"));

  await finishPage(context, page, errors, evidence, "build-surface");
}

async function runLibrarySurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByText(/My Agents Library|에이전트 라이브러리/).waitFor();
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "library-agents-timeout.png"), fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    console.error(JSON.stringify({ libraryTimeout: true, body: body.slice(0, 3000), calls: await page.evaluate(() => window.__qa.calls).catch(() => []), errors }, null, 2));
    throw err;
  }
  await page.getByText(/Builder Agent|빌더 에이전트/).first().click();
  await page.getByRole("heading", { name: /시스템 프롬프트|System Prompt/ }).waitFor();
  await page.getByText(/실행 모델 지정|Runtime Model Assignment/).waitFor();

  await page.getByRole("button", { name: /큐레이팅된 메모리|Curated Memory/ }).click();
  await page.getByText(/결정 사항|Decisions/).waitFor();
  await page.getByText("Route clearly").waitFor();
  await page.locator('input[type="checkbox"]').first().click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md"));
  const memoryWrite = await page.evaluate(() =>
    window.__qa.calls.find((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md"),
  );
  assert.match(memoryWrite.payload.content, /agentlas:disabled/);

  await page.getByRole("button", { name: /정체성|Identity/ }).click();
  await page.getByRole("button", { name: /프롬프트 편집|Edit prompt/ }).click();
  const promptEditor = page.locator("textarea").first();
  await promptEditor.fill("# Builder\n\nUpdated prompt from QA.");
  await page.getByRole("button", { name: /반영하기|Apply/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "AGENT.md"));
  const promptWrite = await page.evaluate(() =>
    window.__qa.calls.find((call) => call.name === "agentFiles.write" && call.payload.path === "AGENT.md"),
  );
  assert.match(promptWrite.payload.content, /Updated prompt from QA/);

  await page.locator("select").first().selectOption({ index: 1 });
  await page.getByRole("button", { name: /^저장$|^Save$/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentRuntime.set"));

  await finishPage(context, page, errors, evidence, "library-agents-surface");
}

async function runChatSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.getByRole("textbox").first();
  await textbox.waitFor();

  await page.locator("button.chat-input-mode-chip", { hasText: /플랜 모드|Plan mode/ }).click();
  await page.locator("button.chat-input-mode-chip", { hasText: /목표 추진|Goal mode/ }).click();
  await page.getByRole("button", { name: /추가|Add/ }).click();
  await page.getByText(/전용 App 만들기|Dedicated App/).first().click();
  await page.getByText(/전용 App으로 만들기|Create a dedicated App/).waitFor();
  await page.getByRole("button", { name: /다음|Next/ }).click();

  await page.getByRole("button", { name: /읽기 \+ 쓰기|Read \+ write/ }).click();
  await page.getByText(/전체 권한|Full access/).click();

  await page.getByRole("button", { name: "Network" }).click();
  await page.getByRole("button", { name: "Stormbreaker" }).click();
  if (await page.getByRole("button", { name: /확인|알겠습니다|OK/ }).count()) {
    await page.getByRole("button", { name: /확인|알겠습니다|OK/ }).click();
  }

  await page.locator("textarea").first().fill("검증용 채팅 옵션 실행");
  try {
    await page.getByRole("button", { name: /보내기|Send/ }).click();
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "chat-send-disabled.png"), fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    const textareas = await page.locator("textarea").evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, disabled: node.disabled, placeholder: node.placeholder }))).catch(() => []);
    const buttons = await page.locator("button").evaluateAll((nodes) => nodes.slice(-12).map((node) => ({ text: node.innerText, label: node.getAttribute("aria-label"), disabled: node.disabled }))).catch(() => []);
    console.error(JSON.stringify({ chatSendDisabled: true, body: body.slice(0, 3000), textareas, buttons, calls: await page.evaluate(() => window.__qa.calls).catch(() => []), errors }, null, 2));
    throw err;
  }
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "invoke.run"));
  const invokeCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "invoke.run"));
  assert.equal(invokeCall.payload.chatId, "chat-1");
  assert.match(invokeCall.payload.userPrompt, /^hep-network --stormbreaker 검증용 채팅 옵션 실행$/);
  assert.equal(invokeCall.payload.permissions, "full");
  assert.equal(invokeCall.payload.planMode, true);
  assert.equal(invokeCall.payload.goalMode, true);
  assert.equal(invokeCall.payload.appsGenerateMode, true);

  await finishPage(context, page, errors, evidence, "chat-options-surface");
}

async function runAutomationSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/automation.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/등록된 자동화가 없습니다|No automations/).waitFor();

  await page.goto(`${baseUrl}/automation/new.html`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder(/매일 인스타 캡션|daily Instagram/).fill("QA Morning Digest");
  await page.locator("select").first().selectOption("weekly-mon-10:00");
  await page.getByText(/개별 에이전트|Individual agent/).click();
  await page.locator("textarea").fill("매주 월요일 QA 상태를 요약해줘");
  await page.getByRole("button", { name: /만들기|Create/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "automations.create"));
  const createCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "automations.create"));
  assert.equal(createCall.payload.name, "QA Morning Digest");
  assert.equal(createCall.payload.scheduleHuman, "weekly-mon-10:00");
  assert.equal(createCall.payload.targetType, "agent");
  assert.equal(createCall.payload.targetId, "agent-2");
  assert.equal(createCall.payload.promptTemplate, "매주 월요일 QA 상태를 요약해줘");

  await finishPage(context, page, errors, evidence, "automation-create-surface");
}

async function runHubLiveSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { hubOffline: false });
  await page.goto(`${baseUrl}/marketplace.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Hub 실시간|Hub live/).waitFor();
  assert.equal(await page.getByText(/실제 Hub에 연결되지 않았습니다|not connected to the real Hub/).count(), 0);
  await finishPage(context, page, errors, evidence, "hub-live-surface");
}

function setupMockAgentlasBridge(options) {
  const now = new Date().toISOString();
  const calls = [];
  const eventHandlers = {};
  const automations = [];
  let runtimeOverrides = [];
  let lastRunId = 0;

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
    runtime: {
      listCommands: async () => [{ name: "/hep-build", description: "Build via Hephaestus", source: "codex" }],
      detect: async () => [
        {
          kind: "codex",
          backend: "openai",
          source: "/usr/local/bin/codex",
          version: "mock",
          active: true,
          model: "gpt-5.1-codex",
          efforts: ["low", "medium", "high"],
          availableModels: ["gpt-5.1-codex", "gpt-5.1"],
        },
      ],
      listModels: async () => [
        { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
        { id: "gpt-5.1", label: "GPT-5.1" },
      ],
      setActive: async (selection) => {
        record("runtime.setActive", selection);
        return selection;
      },
    },
    team: {
      list: async () => [orchestrator, builder],
      install: async (input) => localized(input),
      importLocalFolder: async (folder) => {
        record("team.importLocalFolder", folder);
        return { ...builder, localPath: folder };
      },
    },
    firms: {
      list: async () => [firm],
      get: async () => firm,
      install: async () => firm,
      getResolvedOrg: async () => resolvedOrg,
    },
    marketplace: {
      status: async () =>
        options && options.hubOffline
          ? { mode: "mcp", baseUrl: "mock://offline", online: false, usingFallback: true, lastError: "fetch failed", lastCheckedAt: now }
          : { mode: "mcp", baseUrl: "https://agentlas.cloud/api/mcp/v1", online: true, usingFallback: false, lastError: null, lastCheckedAt: now },
      listBundles: async () => [],
      listFirms: async () => [firm],
      listMine: async () => [],
      search: async () => [
        {
          slug: "shop-product-writer",
          name: "Shop Product Writer",
          nameEn: "Shop Product Writer",
          tagline: "상품 문구 작성",
          taglineEn: "Writes product copy",
          trustGrade: "A",
          installCount: 10,
          manifestUrl: "mock",
        },
      ],
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
      routePreview: async () => null,
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
      listRecent: async () => [],
      create: async (input) => ({ id: "chat-1", projectId: null, firmId: null, agentId: input.agentId || "agent-2", kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now }),
      switchAgent: async (_chatId, agentId) => ({ id: "chat-1", projectId: null, firmId: null, agentId, kind: "user", title: "QA Chat", archivedAt: null, createdAt: now, updatedAt: now }),
      rename: async (_id, title) => ({ id: "chat-1", projectId: null, firmId: null, agentId: "agent-2", kind: "user", title, archivedAt: null, createdAt: now, updatedAt: now }),
      archive: async () => {},
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
        window.setTimeout(() => emit(`invoke:${runId}`, { kind: "final", text: "QA final" }), 30);
        return { runId };
      },
      cancel: async (runId) => record("invoke.cancel", runId),
      eventChannel: (runId) => `invoke:${runId}`,
      clearHistory: async () => {},
    },
    projects: {
      list: async () => [],
      get: async () => null,
    },
    workspace: {
      get: async () => null,
      set: async () => null,
    },
    env: {
      list: async () => [],
      set: async () => ({ ok: true }),
    },
    automations: {
      list: async () => automations,
      create: async (payload) => {
        record("automations.create", payload);
        const item = { id: `auto-${automations.length + 1}`, createdAt: now, lastRunAt: null, nextRunAt: now, enabled: true, createdBy: "user", ...payload };
        automations.unshift(item);
        return item;
      },
      toggle: async (id, enabled) => {
        record("automations.toggle", { id, enabled });
        const item = automations.find((a) => a.id === id);
        if (item) item.enabled = enabled;
        return item;
      },
      remove: async (id) => {
        record("automations.remove", id);
        const idx = automations.findIndex((a) => a.id === id);
        if (idx >= 0) automations.splice(idx, 1);
      },
    },
    agentFiles: {
      list: async () => ({
        entries: [
          { kind: "file", name: "AGENT.md", path: "AGENT.md" },
          { kind: "file", name: "memory.md", path: "memory.md" },
        ],
      }),
      read: async (_id, filePath) => ({
        content: filePath.toLowerCase().includes("memory")
          ? [
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
            ].join("\n")
          : "# Builder\n\nBuild Agentlas work clearly.",
      }),
      write: async (agentId, filePath, content) => {
        record("agentFiles.write", { agentId, path: filePath, content });
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
      pickDirectory: async () => "/tmp/agentlas-qa",
      listDirectory: async (absPath) => ({
        path: absPath,
        exists: true,
        entries: [
          { kind: "file", name: "AGENTS.md", path: `${absPath}/AGENTS.md` },
          { kind: "file", name: "README.md", path: `${absPath}/README.md` },
          { kind: "dir", name: ".agentlas", path: `${absPath}/.agentlas` },
        ],
      }),
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
