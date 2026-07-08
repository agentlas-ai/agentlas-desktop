#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge } = require("./lib/mock-agentlas-bridge.cjs");

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
    () => window.__qa.calls.some((call) => call.name === "agentEvolution.createAndApplyPrompt" && /Learned rules/.test(call.payload.proposedContent)),
  );
  const evolutionCall = await page.evaluate(() =>
    window.__qa.calls.filter((call) => call.name === "agentEvolution.createAndApplyPrompt").at(-1),
  );
  assert.match(evolutionCall.payload.proposedContent, /Learned rules/);
  assert.match(evolutionCall.payload.proposedContent, /Publish target/);

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

  await page.getByRole("button", { name: /추가 —|Add —/ }).click();
  await page.getByRole("button", { name: /플랜 모드|Plan mode/ }).click();
  await page.getByRole("button", { name: /목표 추진|Goal mode/ }).click();
  await page.getByRole("button", { name: /전용 App 만들기|Dedicated App/ }).click();
  await page.getByText(/전용 App으로 만들기|Create a dedicated App/).waitFor();
  await page.getByRole("button", { name: /다음|Next/ }).click();

  await page.getByRole("button", { name: /읽기 \+ 쓰기|Read \+ write/ }).click();
  await page.getByText(/전체 권한|Full access/).click();

  assert.equal(await page.getByRole("button", { name: /^Network$/ }).count(), 0, "Network and Recommend should be one agent-finding flow");
  await page.getByRole("button", { name: /추가 —|Add —/ }).click();
  await page.getByRole("button", { name: "Stormbreaker" }).click();
  const stormWarningOk = page.getByRole("button", { name: /^(확인|알겠습니다|OK)$/ });
  if (await stormWarningOk.count()) {
    await stormWarningOk.click();
  }
  await page.getByRole("button", { name: /추가 —|Add —/ }).click();

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
  await page.getByText(/실행 중|전송 중|running|sending/i).first().waitFor({ timeout: 5000 });
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
  assert.equal(imageCall.payload.images[0].name, "qa-small.png");
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
  assert.equal(pasteCall.payload.images[0].name, "qa-paste.png");

  await page.waitForTimeout(100);
  await dispatchImageDrop(page, "qa-drop.png");
  await page.locator('[title="qa-drop.png"]').waitFor();
  await page.getByRole("button", { name: /보내기|Send/ }).click();
  await page.waitForFunction(() => window.__qa.calls.filter((call) => call.name === "invoke.run").length >= 2);
  const dropCall = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "invoke.run")[1]);
  assert.equal(dropCall.payload.images.length, 1);
  assert.equal(dropCall.payload.images[0].mediaType, "image/png");
  assert.equal(dropCall.payload.images[0].name, "qa-drop.png");

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
  await page.getByRole("option", { name: /\/folder/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "workspace.set"));
  const workspaceCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "workspace.set"));
  assert.equal(workspaceCall.payload.chatId, "chat-1");
  assert.equal(workspaceCall.payload.folder, "/tmp/agentlas-qa");

  await textbox.fill("/new");
  await page.getByRole("option", { name: /\/new/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "chats.create"));

  await textbox.fill("/hep");
  await page.getByRole("option", { name: /\/hep-network startup/ }).click();
  assert.match(await textbox.inputValue(), /^\/hep-network startup\s*$/);

  await textbox.fill("/hep-b");
  await page.getByRole("option", { name: /\/hep-build/ }).waitFor();
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
  await page.getByRole("option", { name: /QA Project/ }).click();
  assert.match(await textbox.inputValue(), /^@QA Project\s*$/);

  await textbox.fill("@QA_API");
  await page.getByRole("option", { name: /QA_API_KEY/ }).click();
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
  await page.getByRole("button", { name: /추가 —|Add —/ }).click();
  await page.getByRole("button", { name: /알아서 에이전트 부르기|에이전트 찾기|Find agent/ }).click();
  await page.getByRole("button", { name: /추가 —|Add —/ }).click();
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
  const stopButton = page.locator("[data-chat-stop-button='true']").first();
  await stopButton.waitFor();
  await page.getByText(/실행 중|전송 중|running|sending/i).first().waitFor();
  await stopButton.click();
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
    await page.getByRole("button", { name: /보내기|Send/ }).waitFor();
    durations.push(Date.now() - started);
  }

  const calls = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "invoke.run"));
  assert.equal(calls.length, total);
  assert.ok(calls.every((call) => call.payload.chatId === "chat-1"), "all long-session sends should stay in chat-1");
  assert.equal(calls[0].payload.userPrompt, "장기 세션 QA 001");
  assert.equal(calls[total - 1].payload.userPrompt, "장기 세션 QA 105");

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
  await page.getByPlaceholder(/매일 인스타 캡션|daily Instagram/i).fill("QA Morning Digest");
  await page.getByText(/개별 에이전트|Individual agent/).click();
  await page.locator("textarea").fill("매주 월요일 QA 상태를 요약해줘");
  await page.getByRole("button", { name: /^(만들기|Create)$/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "automations.create"));
  const createCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "automations.create"));
  assert.equal(createCall.payload.name, "QA Morning Digest");
  assert.equal(createCall.payload.scheduleHuman, "daily-09:00");
  assert.equal(createCall.payload.targetType, "agent");
  assert.equal(createCall.payload.targetId, "agent-2");
  assert.equal(createCall.payload.promptTemplate, "매주 월요일 QA 상태를 요약해줘");

  await finishPage(context, page, errors, evidence, "automation-create-surface");
}

async function runAutomationDefaultAndDetailSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/automation/new.html`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder(/매일 인스타 캡션|daily Instagram/i).fill("QA Default Prompt");
  await page.getByRole("button", { name: /^(만들기|Create)$/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "automations.create"));
  const createCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "automations.create"));
  assert.equal(createCall.payload.name, "QA Default Prompt");
  assert.equal(createCall.payload.promptTemplate, "오늘 할 일 요약해줘");
  assert.equal(createCall.payload.targetType, "firm");
  assert.equal(createCall.payload.targetId, "firm-1");

  const automationId = await page.evaluate(() => window.__qa.automations[0]?.id);
  assert.ok(automationId, "created automation should be available to open detail surface");
  await page.goto(`${baseUrl}/automation/detail.html?id=${encodeURIComponent(automationId)}`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByRole("heading", { name: "QA Default Prompt" }).waitFor();
  } catch (err) {
    await page.screenshot({ path: path.join(outDir, "automation-default-detail-timeout.png"), fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    console.error(JSON.stringify({ automationDetailTimeout: true, body: body.slice(0, 3000), calls: await page.evaluate(() => window.__qa.calls).catch(() => []), automations: await page.evaluate(() => window.__qa.automations).catch(() => []), errors }, null, 2));
    throw err;
  }
  await page.getByText("daily-09:00").first().waitFor();
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

// setupMockAgentlasBridge는 scripts/lib/mock-agentlas-bridge.cjs로 이동 (smoke-renderer-ui와 공유).

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
