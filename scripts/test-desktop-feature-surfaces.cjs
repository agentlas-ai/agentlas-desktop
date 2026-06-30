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

const TINY_PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

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
    await runDashboardFirstVisitTourSurface(browser, baseUrl, evidence);
    await runDashboardAttentionSurface(browser, baseUrl, evidence);
    await runBuildSurface(browser, baseUrl, evidence);
    await runBuildInterviewSurface(browser, baseUrl, evidence);
    await runBuildCancelSurface(browser, baseUrl, evidence);
    await runLibrarySurface(browser, baseUrl, evidence);
    await runImportSurface(browser, baseUrl, evidence);
    await runMemoryEvolutionSurface(browser, baseUrl, evidence);
    await runChatSurface(browser, baseUrl, evidence);
    await runNewChatScopeSurface(browser, baseUrl, evidence);
    await runChatModelSurface(browser, baseUrl, evidence);
    await runChatAttachmentSurface(browser, baseUrl, evidence);
    await runChatPasteDropAttachmentSurface(browser, baseUrl, evidence);
    await runChatAutocompleteSurface(browser, baseUrl, evidence);
    await runChatMentionSurface(browser, baseUrl, evidence);
    await runChatContextMentionSurface(browser, baseUrl, evidence);
    await runChatRecommendSurface(browser, baseUrl, evidence);
    await runChatStopAndImeSurface(browser, baseUrl, evidence);
    await runChatLongSessionSurface(browser, baseUrl, evidence);
    await runAutomationSurface(browser, baseUrl, evidence);
    await runAutomationDefaultAndDetailSurface(browser, baseUrl, evidence);
    await runHubLiveSurface(browser, baseUrl, evidence);

    const proof = {
      ok: true,
      baseUrl,
      recordedAt: new Date().toISOString(),
      evidence,
      screenshots: path.relative(root, outDir),
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
  const singleMode = page.getByRole("button", { name: /단일 에이전트|Single agent/ });
  const teamMode = page.getByRole("button", { name: /멀티 에이전트 팀|Multi-agent team/ });
  const packageMode = page.getByRole("button", { name: /기존 에이전트 패키징|Package existing agent/ });
  await page.locator(".build-mode-price", { hasText: /빌드 0크레딧|Build 0 credits/ }).first().waitFor();
  await page.getByText(/데스크톱 Build 자체는 Agentlas 크레딧 0|Desktop Build itself costs 0 Agentlas credits/).waitFor();
  await teamMode.click();
  await expectDataActive(teamMode, "true");
  await packageMode.click();
  await expectDataActive(packageMode, "true");
  await singleMode.click();
  await expectDataActive(singleMode, "true");
  await singleMode.click();
  await expectDataActive(singleMode, "false");
  await singleMode.click();

  await page.locator(".build-starter-chip").first().click();
  let textarea = page.locator("textarea").first();
  assert.ok((await textarea.inputValue()).length > 10, "starter chip should fill the request textarea");

  await page.waitForFunction(() => document.querySelectorAll("#build-model-select option").length >= 2);
  await page.locator("#build-model-select").selectOption({ index: 1 });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.getByText(/tmp\/agentlas-qa|agentlas-qa/).waitFor();
  assert.equal(await page.evaluate(() => window.localStorage.getItem("agentlas.build.workspace")), "/tmp/agentlas-qa");
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/tmp\/agentlas-qa|agentlas-qa/).waitFor();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("#build-model-select option").length >= 2);
  await page.locator("#build-model-select").selectOption({ index: 1 });
  textarea = page.locator("textarea").first();

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
  await page.getByRole("button", { name: /내 클라우드 \(비공개\)|My Cloud \(private\)/ }).click();
  await page.getByText(/업로드 완료|Uploaded/).waitFor();
  await page.getByRole("button", { name: /허브 \(공개\)|Hub \(public\)/ }).click();

  const calls = await page.evaluate(() => window.__qa.calls);
  const buildCall = calls.find((call) => call.name === "hephaestus.build");
  assert.equal(buildCall.payload.mode, "single");
  assert.equal(buildCall.payload.workspace, "/tmp/agentlas-qa");
  assert.equal(buildCall.payload.request, "검증용 리서치 에이전트");
  assert.ok(buildCall.payload.runtime, "selected build runtime should be passed");
  assert.ok(calls.some((call) => call.name === "team.importLocalFolder" && call.payload === "/tmp/agentlas-qa/qa-agent"));
  assert.ok(calls.some((call) => call.name === "hephaestus.publish" && call.payload.visibility === "private-link"));
  assert.ok(calls.some((call) => call.name === "hephaestus.publish" && call.payload.visibility === "marketplace"));

  await finishPage(context, page, errors, evidence, "build-surface");
}

async function runDashboardAttentionSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { pendingConfirmations: 2 });
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/2개 승인 대기|2 approvals waiting/).waitFor();
  await page.locator(".app-attention-nudge").getByText(/2개 승인 대기|2 approvals waiting/).waitFor();
  await page.locator(".dashboard-count-pill").getByText("2", { exact: true }).waitFor();
  await page.waitForFunction(
    () => /배포 전 공개 여부를 승인해 주세요|Approve public visibility before deploy/.test(document.body.innerText),
  );
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "attention.setPendingConfirmations" && call.payload === 2),
  );

  await finishPage(context, page, errors, evidence, "dashboard-attention-surface");
}

async function runDashboardFirstVisitTourSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { showPageTour: true });
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("dialog", { name: /대시보드 안내|Dashboard tour/ }).waitFor();
  await page.locator(".agentlas-tour-ring").waitFor();
  await page.getByText(/내 팀 한눈에|Your whole team/).waitFor();
  await page.getByText(/로컬·클라우드·허브 에이전트|Every local, cloud, and Hub agent/).waitFor();
  await page.getByRole("button", { name: /다음|Next/ }).click();
  await page.getByText(/엔진 연결 상태|Engine connections/).waitFor();
  await page.locator("[data-tour-id='dashboard.llm'].agentlas-tour-target-active").waitFor();
  await finishPage(context, page, errors, evidence, "dashboard-first-visit-tour-surface");
}

async function expectDataActive(locator, expected) {
  await locator.waitFor();
  assert.equal(await locator.getAttribute("data-active"), expected);
}

async function runBuildInterviewSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { buildScenario: "interview" });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.locator("textarea").first().fill("인터뷰가 필요한 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  await page.getByText(/어떤 산출물이 필요합니까/).waitFor();
  await page.getByText(/어디에 배포할까요/).waitFor();
  await page.locator(".build-interview-card .build-interview-opt", { hasText: /리포트/ }).click();
  await page.locator(".build-interview-card .build-interview-opt[title^='앱:']").click();
  await page.locator(".build-interview-card .build-interview-opt", { hasText: /비공개/ }).click();
  assert.equal(
    await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "hephaestus.build").length),
    1,
    "interview option clicks must not advance before confirm",
  );
  await page.getByRole("button", { name: /선택 3개 확인|Confirm 3/ }).click();
  await page.getByText(/패키지 준비됨|Package ready/).waitFor();

  const calls = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "hephaestus.build"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.request, "인터뷰가 필요한 에이전트");
  assert.match(calls[1].payload.request, /1\. 리포트/);
  assert.match(calls[1].payload.request, /2\. 앱/);
  assert.match(calls[1].payload.request, /1\. 비공개/);
  assert.ok(Array.isArray(calls[1].payload.history));
  assert.ok(calls[1].payload.history.some((item) => item.role === "assistant" && item.text.includes("<<agentlas-ask>>")));

  await finishPage(context, page, errors, evidence, "build-interview-surface");
}

async function runBuildCancelSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { buildScenario: "slow" });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.locator("textarea").first().fill("느린 빌드 취소 테스트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  await page.getByRole("button", { name: /중지|Stop/ }).waitFor();
  await page.getByRole("button", { name: /중지|Stop/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "hephaestus.cancelBuild"));
  const cancelCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "hephaestus.cancelBuild"));
  assert.equal(cancelCall.payload, "build-run-1");

  await finishPage(context, page, errors, evidence, "build-cancel-surface");
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
  await page.getByRole("button", { name: /전역 기본|Global default/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentRuntime.remove"));

  await finishPage(context, page, errors, evidence, "library-agents-surface");
}

async function runImportSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/My Agents Library|에이전트 라이브러리/).waitFor();
  await page.getByRole("button", { name: /^가져오기$|^Import$/ }).click();
  await page.getByRole("heading", { name: /가져온 QA 에이전트|Imported QA Agent/ }).waitFor();
  await page.getByRole("heading", { name: /시스템 프롬프트|System Prompt/ }).waitFor();

  const calls = await page.evaluate(() => window.__qa.calls);
  assert.ok(calls.some((call) => call.name === "fs.pickDirectory"), "folder picker should open before import");
  assert.ok(calls.some((call) => call.name === "team.importLocalFolder" && call.payload === "/tmp/agentlas-qa"), "picked folder should be imported");

  await finishPage(context, page, errors, evidence, "import-agent-surface");
}

async function runMemoryEvolutionSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Builder Agent|빌더 에이전트/).first().click();
  await page.getByRole("button", { name: /큐레이팅된 메모리|Curated Memory/ }).click();
  await page.getByText("Route clearly").waitFor();

  const checkboxes = page.locator('input[type="checkbox"]');
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();
  await page.waitForFunction(
    () => window.__qa.calls.filter((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md").length >= 2,
  );
  let memoryWrites = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md"));
  let latestMemory = memoryWrites.at(-1).payload.content;
  assert.match(latestMemory, /Route clearly.*agentlas:disabled/);
  assert.match(latestMemory, /No fake data.*agentlas:disabled/);

  await page.locator('button[title*="로컬 전용"], button[title*="Local-only"]').first().click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md" && /Route clearly.*agentlas:synced/.test(call.payload.content)),
  );
  memoryWrites = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md"));
  latestMemory = memoryWrites.at(-1).payload.content;
  assert.match(latestMemory, /Route clearly.*agentlas:synced.*agentlas:disabled/);

  await page.getByRole("button", { name: /결정 승격|Promote to decision/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md" && /Publish target.*미결 항목 승격 반영|Publish target.*promoted from an open question/.test(call.payload.content)),
  );

  await page.getByRole("button", { name: /정체성|Identity/ }).click();
  await page.getByRole("button", { name: /프롬프트 편집|Edit prompt/ }).click();
  await page.locator("textarea").first().fill("# Builder\n\nTemporary prompt from QA.");
  await page.getByRole("button", { name: /반영하기|Apply/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "AGENT.md" && /Temporary prompt from QA/.test(call.payload.content)),
  );
  await page.getByRole("button", { name: /기본값 재설정|Reset to default/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "AGENT.md" && /Build Agentlas work clearly/.test(call.payload.content)),
  );

  await page.getByRole("button", { name: /활동 및 자체 진화|Activity & Self-Evolution/ }).click();
  await page.getByText(/자가 프롬프트 진화 제안|Agent Evolution Proposal/).waitFor();
  await page.getByRole("button", { name: /진화 제안 승인 및 적용|Approve & apply evolution/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "AGENT.md" && /Learned rules/.test(call.payload.content)),
  );
  const evolutionWrite = await page.evaluate(() =>
    window.__qa.calls.filter((call) => call.name === "agentFiles.write" && call.payload.path === "AGENT.md").at(-1),
  );
  assert.match(evolutionWrite.payload.content, /Learned rules/);
  assert.match(evolutionWrite.payload.content, /Publish target/);

  await page.getByRole("button", { name: /스킬 고르기|Choose skill/ }).click();
  await page.getByRole("button", { name: /^주입$|^Inject$/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === ".agentlas/skills/qa-skill/SKILL.md"),
  );
  const skillWrite = await page.evaluate(() =>
    window.__qa.calls.find((call) => call.name === "agentFiles.write" && call.payload.path === ".agentlas/skills/qa-skill/SKILL.md"),
  );
  assert.match(skillWrite.payload.content, /QA helper skill/);
  await page.getByText(/수동 스킬 주입|Manual skill injection/).waitFor();

  await finishPage(context, page, errors, evidence, "memory-evolution-surface");
}

async function runChatSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { visibleProgressInvoke: true });
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.getByRole("textbox").first();
  await textbox.waitFor();
  assert.equal(await page.locator(".sidenav").count(), 0, "chat route should not render the global SideNav next to the chat sidebar");
  assert.equal(await page.locator("[data-tour-id='workspace.sidebar']").count(), 1, "chat route should keep exactly one left sidebar");
  await page.locator("[data-tour-id='workspace.sidebar']").getByRole("button", { name: /새 채팅|New chat/ }).waitFor();

  await page.locator("button.chat-input-mode-chip", { hasText: /플랜 모드|Plan mode/ }).click();
  await page.locator("button.chat-input-mode-chip", { hasText: /목표 추진|Goal mode/ }).click();
  await page.getByRole("button", { name: /추가|Add/ }).click();
  await page.getByText(/전용 App 만들기|Dedicated App/).first().click();
  await page.getByText(/전용 App으로 만들기|Create a dedicated App/).waitFor();
  await page.getByRole("button", { name: /다음|Next/ }).click();

  await page.getByRole("button", { name: /읽기 \+ 쓰기|Read \+ write/ }).click();
  await page.getByText(/전체 권한|Full access/).click();

  assert.equal(await page.getByRole("button", { name: /^Network$/ }).count(), 0, "Network and Recommend should be one agent-finding flow");
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
  await page.getByText(/실행이 살아 있습니다|Run is active/).waitFor();
  await page.getByText(/현재 단계: Hub 에이전트 빌리는 중: qa-agent|Current step: Hub/).waitFor();
  assert.ok(await page.getByText(/Hub 에이전트 빌리는 중: qa-agent/).count(), "Hub borrow progress should be visible");
  await page.locator("aside").getByRole("button", { name: /패널 닫기|Close panel/ }).click();
  assert.equal(
    await page.locator("aside", { hasText: /Hub 에이전트 빌리는 중: qa-agent/ }).count(),
    0,
    "workflow panel should close before activity-card reopen check",
  );
  await page.locator(".agentlas-activity-card", { hasText: /Hub 에이전트 빌리는 중: qa-agent/ }).first().click();
  await page.locator("aside").getByText(/Hub 에이전트 빌리는 중: qa-agent/).first().waitFor();
  const rightPanel = page.locator(".chat-right-panel");
  const workflowHeading = rightPanel.getByText(/오케스트레이션|Orchestration|에이전트 작업|Agent activity/).first();
  await workflowHeading.waitFor();
  await rightPanel.getByText(/실행 중|running|위임 중|delegating|대기|idle/).first().waitFor();
  const activityText = rightPanel.getByText(/Hub 에이전트 빌리는 중: qa-agent/).first();
  await activityText.waitFor();
  const orchestrationBox = await workflowHeading.boundingBox();
  const activityBox = await activityText.boundingBox();
  assert.ok(orchestrationBox && activityBox, "agent tab should render orchestration and activity status");
  assert.ok(orchestrationBox.y < activityBox.y, "workflow tree should stay above activity cards");
  await page.getByRole("button", { name: /워크스페이스 패널|Workspace panel/ }).click();
  await page.getByRole("button", { name: /폴더 열기|Open folder/ }).click();
  await page.locator(".chat-right-panel").getByRole("treeitem", { name: "README.md" }).click();
  await page.locator(".chat-right-panel").getByText("README.md").waitFor();
  await page.locator(".chat-right-panel").getByText(/Panel viewer smoke file/).waitFor();
  await page.locator(".chat-right-panel").getByRole("button", { name: /파일|file/ }).click();
  await page.locator(".chat-right-panel").getByRole("treeitem", { name: "preview.html" }).click();
  await page.locator(".chat-right-panel").getByText("preview.html", { exact: true }).waitFor();
  await page.frameLocator(".chat-right-panel iframe").getByText("Browser smoke frame").waitFor();
  const invokeCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "invoke.run"));
  assert.equal(invokeCall.payload.chatId, "chat-1");
  assert.match(invokeCall.payload.userPrompt, /^stormbreaker 검증용 채팅 옵션 실행$/);
  assert.equal(invokeCall.payload.permissions, "full");
  assert.equal(invokeCall.payload.planMode, true);
  assert.equal(invokeCall.payload.goalMode, true);
  assert.equal(invokeCall.payload.appsGenerateMode, true);

  await finishPage(context, page, errors, evidence, "chat-options-surface");
}

async function runNewChatScopeSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-tour-id='workspace.sidebar']").getByRole("button", { name: /새 채팅|New chat/ }).click();
  await page.getByRole("dialog", { name: /새 채팅 시작 위치|New chat scope/ }).waitFor();
  await page.screenshot({ path: path.join(outDir, "chat-new-project-scope-dialog-surface.png"), fullPage: true });
  await page.getByRole("button", { name: /QA Project/ }).click();
  await page.waitForFunction(() =>
    window.__qa.calls.some((call) => call.name === "chats.create" && call.payload.projectId === "project-1"),
  );
  await page.waitForFunction(() =>
    window.__qa.calls.some((call) => call.name === "workspace.set" && call.payload.chatId !== "chat-1" && call.payload.folder === "/tmp/agentlas-qa-project"),
  );
  const createCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "chats.create" && call.payload.projectId === "project-1"));
  const workspaceCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "workspace.set" && call.payload.folder === "/tmp/agentlas-qa-project"));
  assert.equal(createCall.payload.agentId, "agent-2");
  assert.match(workspaceCall.payload.chatId, /^chat-created-/);
  await finishPage(context, page, errors, evidence, "chat-new-project-scope-surface");
}

async function runChatModelSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox").first().waitFor();
  const modelChip = page.locator("button.chat-input-model-chip");
  await modelChip.waitFor();
  await modelChip.click();
  await page.getByRole("button", { name: /^GPT-5\.1$/ }).click();
  await page.waitForFunction(() =>
    window.__qa.calls.some((call) => call.name === "runtime.setActive" && call.payload.model === "gpt-5.1"),
  );

  await modelChip.click();
  await page.getByRole("button", { name: /^High$/ }).click();
  await page.waitForFunction(() =>
    window.__qa.calls.some((call) => call.name === "runtime.setActive" && call.payload.effort === "high"),
  );

  const calls = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "runtime.setActive"));
  assert.equal(calls[0].payload.model, "gpt-5.1");
  assert.equal(calls[1].payload.model, "gpt-5.1");
  assert.equal(calls[1].payload.effort, "high");

  await finishPage(context, page, errors, evidence, "chat-model-surface");
}

async function runChatAttachmentSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox").first().waitFor();

  await page.locator('input[type="file"]').setInputFiles({
    name: "qa-small.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BYTES),
  });
  await page.getByRole("button", { name: /보내기|Send/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "invoke.run"));
  const imageCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "invoke.run"));
  assert.equal(imageCall.payload.images.length, 1);
  assert.equal(imageCall.payload.images[0].mediaType, "image/png");
  assert.ok(imageCall.payload.images[0].data.length > 10);

  const alertMessage = await new Promise(async (resolve) => {
    page.once("dialog", async (dialog) => {
      const msg = dialog.message();
      await dialog.accept();
      resolve(msg);
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "qa-too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
  });
  assert.match(alertMessage, /qa-too-large\.png/);

  await finishPage(context, page, errors, evidence, "chat-attachments-surface");
}

async function runChatPasteDropAttachmentSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.getByRole("textbox").first();
  await textbox.waitFor();

  await dispatchImagePaste(page, "qa-paste.png");
  await page.locator('[title="qa-paste.png"]').waitFor();
  await page.getByRole("button", { name: /보내기|Send/ }).click();
  await page.waitForFunction(() => window.__qa.calls.filter((call) => call.name === "invoke.run").length >= 1);
  const pasteCall = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "invoke.run")[0]);
  assert.equal(pasteCall.payload.images.length, 1);
  assert.equal(pasteCall.payload.images[0].mediaType, "image/png");

  await page.waitForTimeout(100);
  await dispatchImageDrop(page, "qa-drop.png");
  await page.locator('[title="qa-drop.png"]').waitFor();
  await page.getByRole("button", { name: /보내기|Send/ }).click();
  await page.waitForFunction(() => window.__qa.calls.filter((call) => call.name === "invoke.run").length >= 2);
  const dropCall = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "invoke.run")[1]);
  assert.equal(dropCall.payload.images.length, 1);
  assert.equal(dropCall.payload.images[0].mediaType, "image/png");

  await finishPage(context, page, errors, evidence, "chat-paste-drop-attachments-surface");
}

async function dispatchImagePaste(page, name) {
  await page.evaluate(
    ({ bytes, fileName }) => {
      const textarea = document.querySelector("textarea");
      if (!textarea) throw new Error("textarea not found");
      const file = new File([new Uint8Array(bytes)], fileName, { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      textarea.dispatchEvent(event);
    },
    { bytes: TINY_PNG_BYTES, fileName: name },
  );
}

async function dispatchImageDrop(page, name) {
  await page.evaluate(
    ({ bytes, fileName }) => {
      const footer = document.querySelector("textarea")?.closest("footer");
      if (!footer) throw new Error("composer footer not found");
      const file = new File([new Uint8Array(bytes)], fileName, { type: "image/png" });
      const dragover = new Event("dragover", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(dragover, "dataTransfer", { value: { dropEffect: "none", files: [file] } });
      footer.dispatchEvent(dragover);
      const event = new Event("drop", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
      footer.dispatchEvent(event);
    },
    { bytes: TINY_PNG_BYTES, fileName: name },
  );
}

async function runChatAutocompleteSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.locator("textarea").first();
  await textbox.waitFor();

  await textbox.fill("/help");
  await page.keyboard.press("Enter");
  await page.getByText(/단축키|Shortcuts/).waitFor();
  assert.equal((await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "invoke.run").length)), 0);

  await textbox.fill("/folder");
  await page.getByRole("button", { name: /\/folder 이 대화의 작업 폴더 선택|\/folder Pick a working folder/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "workspace.set"));
  const workspaceCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "workspace.set"));
  assert.equal(workspaceCall.payload.chatId, "chat-1");
  assert.equal(workspaceCall.payload.folder, "/tmp/agentlas-qa");

  await textbox.fill("/new");
  await page.getByRole("button", { name: /\/new 새 채팅 시작|\/new Start a new chat/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "chats.create"));

  await textbox.fill("/hep");
  await page.getByRole("button", { name: /\/hep-network startup/ }).click();
  assert.match(await textbox.inputValue(), /^\/hep-network startup\s*$/);

  await textbox.fill("/hep-b");
  await page.getByRole("button", { name: /\/hep-build/ }).waitFor();
  await textbox.focus();
  await page.keyboard.press("Tab");
  assert.match(await textbox.inputValue(), /^\/hep-build\s*$/);

  await finishPage(context, page, errors, evidence, "chat-autocomplete-surface");
}

async function runChatMentionSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.locator("textarea").first();
  await textbox.waitFor();
  await page.getByText(/빌더 에이전트|Builder Agent/).first().waitFor();

  await textbox.fill("@research");
  try {
    await page.getByText(/리서치 에이전트|Research Agent/).click();
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "chat-mentions-timeout.png"), fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    const textareaState = await textbox.evaluate((node) => ({
      value: node.value,
      disabled: node.disabled,
      selectionStart: node.selectionStart,
      selectionEnd: node.selectionEnd,
    })).catch(() => null);
    const buttons = await page.locator("button").evaluateAll((nodes) =>
      nodes.map((node) => ({ text: node.innerText, label: node.getAttribute("aria-label"), disabled: node.disabled })).slice(-30),
    ).catch(() => []);
    console.error(JSON.stringify({ mentionTimeout: true, body: body.slice(0, 4000), textareaState, buttons, calls: await page.evaluate(() => window.__qa.calls).catch(() => []), errors }, null, 2));
    throw err;
  }
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "chats.switchAgent" && call.payload.agentId === "agent-3"));

  await textbox.fill("@Founder");
  await page.getByText("Founder HQ").click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "chats.switchAgent" && call.payload.agentId === "agent-1"));

  await finishPage(context, page, errors, evidence, "chat-mentions-surface");
}

async function runChatContextMentionSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.locator("textarea").first();
  await textbox.waitFor();
  await page.getByText(/QA Project/).first().waitFor();

  await textbox.fill("@QA");
  await page.getByRole("button", { name: /QA Project/ }).click();
  assert.match(await textbox.inputValue(), /^@QA Project\s*$/);

  await textbox.fill("@QA_API");
  await page.getByRole("button", { name: /QA_API_KEY/ }).click();
  assert.match(await textbox.inputValue(), /^@QA_API_KEY\s*$/);

  await finishPage(context, page, errors, evidence, "chat-context-mentions-surface");
}

async function runChatRecommendSurface(browser, baseUrl, evidence) {
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "single",
    button: /이 에이전트 사용하기|Use this agent/,
    proofName: "chat-recommend-single-surface",
    assertCalls: (calls) => {
      assert.ok(calls.some((call) => call.name === "chats.switchAgent" && call.payload.agentId === "agent-1"));
      assert.ok(calls.some((call) => call.name === "invoke.run" && call.payload.userPrompt === "추천 단일 실행"));
    },
  });
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "network",
    button: /선택한 에이전트 사용하기|Use selected agents/,
    proofName: "chat-recommend-network-surface",
    assertCalls: (calls) => {
      const call = calls.find((item) => item.name === "invoke.run");
      assert.deepEqual(call.payload.borrowAgents, ["no-ai-slop-copywriter", "security-reviewer"]);
      assert.equal(call.payload.userPrompt, "추천 네트워크 실행");
    },
  });
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "pipeline",
    button: /이 파이프라인 사용하기|Use this pipeline/,
    proofName: "chat-recommend-pipeline-surface",
    assertCalls: (calls) => {
      const call = calls.find((item) => item.name === "invoke.run");
      assert.equal(call.payload.userPrompt, "stormbreaker 추천 파이프라인 실행");
      assert.deepEqual(
        call.payload.pipelineStages.map((stage) => [stage.order, stage.kind, stage.agentId, stage.agentName]),
        [
          [1, "plan", "agent-1", "Planner"],
          [2, "qa", "agent-2", "Builder"],
        ],
      );
    },
  });
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "none",
    button: /추천 없이 실행|Run without recommendation/,
    proofName: "chat-recommend-plain-surface",
    assertCalls: (calls) => {
      const call = calls.find((item) => item.name === "invoke.run");
      assert.equal(call.payload.userPrompt, "추천 없음 그냥 실행");
      assert.equal(call.payload.borrowAgents, undefined);
    },
  });
}

async function runRecommendChoice(browser, baseUrl, evidence, spec) {
  const { context, page, errors } = await newPage(browser, { recommendMode: spec.mode });
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.locator("textarea").first();
  await textbox.waitFor();
  await page.getByRole("button", { name: /알아서 에이전트 부르기|에이전트 찾기|Find agent/ }).click();
  const textByMode = {
    single: "추천 단일 실행",
    network: "추천 네트워크 실행",
    pipeline: "추천 파이프라인 실행",
    none: "추천 없음 그냥 실행",
  };
  await textbox.fill(textByMode[spec.mode]);
  await page.getByRole("button", { name: /보내기|Send/ }).click();
  await page.getByRole("dialog", { name: /알아서 에이전트 부르기|에이전트 찾기|Find agent/ }).waitFor();
  await page.getByRole("button", { name: /다른 에이전트 찾기|Find another agent/ }).waitFor();
  await page.getByRole("button", { name: spec.button }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "invoke.run"));
  const calls = await page.evaluate(() => window.__qa.calls);
  assert.ok(calls.some((call) => call.name === "hephaestus.routePreview"), "routePreview should run before recommendation execution");
  spec.assertCalls(calls);
  await finishPage(context, page, errors, evidence, spec.proofName);
}

async function runChatStopAndImeSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { slowInvoke: true });
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.locator("textarea").first();
  await textbox.waitFor();

  await textbox.fill("느린 실행 중지 테스트");
  await page.getByRole("button", { name: /보내기|Send/ }).click();
  await page.getByRole("button", { name: /중지|Stop/ }).waitFor();
  await page.getByText(/실행이 살아 있습니다|Run is active/).waitFor();
  await page.locator("aside").getByText(/전송 중|Sending|sending/).first().waitFor();
  assert.equal(
    await page.locator("aside").getByText(/대기 중 — 메시지를 보내면 실행 흐름이 표시됩니다|Idle — send a message/i).count(),
    0,
    "workflow panel must not look idle while a run is active",
  );
  await page.getByRole("button", { name: /중지|Stop/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "invoke.cancel"));

  await textbox.fill("한글 조합 중");
  await page.evaluate(() => {
    const textarea = document.querySelector("textarea");
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }));
  });
  await page.waitForTimeout(250);
  const calls = await page.evaluate(() => window.__qa.calls);
  assert.equal(calls.filter((call) => call.name === "invoke.run").length, 1, "IME Enter should not send another message");

  await finishPage(context, page, errors, evidence, "chat-stop-ime-surface");
}

async function runChatLongSessionSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { longChatInvoke: true });
  await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  const textbox = page.locator("textarea").first();
  await textbox.waitFor();

  const total = 105;
  const durations = [];
  for (let i = 1; i <= total; i += 1) {
    const started = Date.now();
    await textbox.fill(`장기 세션 QA ${String(i).padStart(3, "0")}`);
    await page.getByRole("button", { name: /보내기|Send/ }).click();
    await page.waitForFunction(
      (count) => window.__qa.calls.filter((call) => call.name === "invoke.run").length >= count,
      i,
    );
    await page.waitForFunction(
      (count) => (document.body.innerText.match(/QA final/g) || []).length >= count,
      i,
    );
    await page.getByRole("button", { name: /보내기|Send/ }).waitFor();
    durations.push(Date.now() - started);
  }

  const calls = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "invoke.run"));
  assert.equal(calls.length, total);
  assert.ok(calls.every((call) => call.payload.chatId === "chat-1"), "all long-session sends should stay in chat-1");
  assert.equal(calls[0].payload.userPrompt, "장기 세션 QA 001");
  assert.equal(calls[total - 1].payload.userPrompt, "장기 세션 QA 105");
  assert.equal(await page.getByText(/QA final 105/).count(), 1);
  const workflowPanel = page.locator("[data-tour-id='workspace.workflow']");
  if ((await workflowPanel.count()) === 0) {
    await page.locator("[data-tour-id='workspace.workflow-toggle']").click();
    await workflowPanel.waitFor();
  }
  if ((await workflowPanel.getByText(/Network route stable #105/).count()) === 0) {
    try {
      await workflowPanel.getByText(/Network route stable #105/).waitFor({ timeout: 5000 });
    } catch (err) {
      const workflowText = await workflowPanel.evaluateAll((nodes) => nodes.map((node) => node.innerText)).catch(() => []);
      const bodyText = await page.locator("body").innerText().catch(() => "");
      console.error(JSON.stringify({ longSessionWorkflowMissing: true, workflowText, bodyTail: bodyText.slice(-3000) }, null, 2));
      throw err;
    }
  }
  assert.equal(
    await workflowPanel.getByText(/Network route stable #105/).count(),
    1,
    "workflow panel should show latest network activity instead of idle state",
  );

  const sorted = [...durations].sort((a, b) => a - b);
  const stats = {
    sends: total,
    avgMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted[sorted.length - 1],
  };
  await page.screenshot({ path: path.join(outDir, "chat-long-session-105-surface.png"), fullPage: false });
  assert.deepEqual(errors, [], "chat-long-session-105-surface should not emit page errors");
  evidence.push({ name: "chat-long-session-105-surface", status: "pass", url: page.url(), stats });
  await context.close();
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

async function runAutomationDefaultAndDetailSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/automation/new.html`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder(/매일 인스타 캡션|daily Instagram/).fill("QA Default Prompt");
  await page.getByRole("button", { name: /만들기|Create/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "automations.create"));
  const createCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "automations.create"));
  assert.equal(createCall.payload.name, "QA Default Prompt");
  assert.equal(createCall.payload.promptTemplate, "오늘 할 일 요약해줘");
  assert.equal(createCall.payload.targetType, "firm");
  assert.equal(createCall.payload.targetId, "firm-1");

  await page.getByRole("link", { name: "QA Default Prompt" }).click();
  try {
    await page.getByRole("heading", { name: "QA Default Prompt" }).waitFor();
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "automation-default-detail-timeout.png"), fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    console.error(JSON.stringify({ automationDetailTimeout: true, body: body.slice(0, 3000), calls: await page.evaluate(() => window.__qa.calls).catch(() => []), automations: await page.evaluate(() => window.__qa.automations).catch(() => []), errors }, null, 2));
    throw err;
  }
  await page.getByText("daily-09:00").waitFor();
  await page.getByText("Founder HQ").waitFor();
  await page.getByText("아직 실행된 적 없음").waitFor();
  await page.getByText("오늘 할 일 요약해줘").waitFor();

  await finishPage(context, page, errors, evidence, "automation-default-detail-surface");
}

async function runHubLiveSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { hubOffline: false });
  await page.goto(`${baseUrl}/marketplace.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Hub 실시간|Hub live/).waitFor();
  assert.equal(await page.getByText(/실제 Hub에 연결되지 않았습니다|not connected to the real Hub/).count(), 0);
  assert.equal(await page.getByText(/라이브 Hub 항목|live Hub items/).count(), 0);
  assert.equal(await page.locator(".hub-cat-chip").count(), 0, "Hub top category chips should stay removed");
  await page.getByText(/총 267개|267 total/).waitFor();
  await page.locator(".portal-input").fill("FDA");
  await page.getByText(/FDA SaMD 510\(k\)|Pre-market Notification/).waitFor();
  assert.equal(await page.getByText(/Shop Product Writer|상품설명 작가/).count(), 0);
  await page.locator(".portal-input").fill("");
  await page.getByText(/총 267개|267 total/).waitFor();
  await finishPage(context, page, errors, evidence, "hub-live-surface");
}

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
  const automations = [];
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
  let importCounter = 0;
  let installedAgents = [orchestrator, builder, researcher];
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
	    marketplace: {
	      status: async () =>
	        options && options.hubOffline
	          ? { mode: "mcp", baseUrl: "mock://offline", online: false, usingFallback: false, lastError: "fetch failed", lastCheckedAt: now }
	          : { mode: "mcp", baseUrl: "https://agentlas.cloud/api/mcp/v1", online: true, usingFallback: false, lastError: null, lastCheckedAt: now },
	      listBundles: async () => [],
	      listFirms: async () => [],
	      listMine: async () => [],
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
      listRecent: async () => [],
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
