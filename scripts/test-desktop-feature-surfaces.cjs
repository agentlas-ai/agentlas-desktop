#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");
const sharp = require("sharp");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "desktop-feature-surfaces");

if (!fs.existsSync(path.join(distDir, "build.html"))) {
  console.error("dist/renderer is missing. Run npm run build:renderer first.");
  process.exit(2);
}

const focusedRun = process.argv.some((arg) => arg.startsWith("--") && arg.endsWith("-only"));
// Focused evidence must not erase screenshots owned by unrelated surface gates.
// A full run still starts from a clean directory so its proof summary is complete.
if (!focusedRun) fs.rmSync(outDir, { recursive: true, force: true });
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
    if (process.argv.includes("--memory-evolution-only")) {
      await runMemoryEvolutionSurface(browser, baseUrl, evidence);
      console.log("desktop memory/evolution surface smoke passed");
      return;
    }
    if (process.argv.includes("--chat-only")) {
      await runChatSurface(browser, baseUrl, evidence);
      console.log("desktop chat visible-progress surface smoke passed");
      return;
    }
    if (process.argv.includes("--chat-recommend-only")) {
      await runChatRecommendSurface(browser, baseUrl, evidence);
      console.log("desktop chat recommendation surface smoke passed");
      return;
    }
    if (process.argv.includes("--build-roster-sync-only")) {
      await runBuildRosterSyncSurface(browser, baseUrl, evidence);
      await runBuildRosterReplaySurface(browser, baseUrl, evidence);
      console.log("desktop Build roster sync surface smoke passed");
      return;
    }
    if (process.argv.includes("--build-mcp-only")) {
      await runBuildMcpSurface(browser, baseUrl, evidence, "mixed");
      await runBuildMcpSurface(browser, baseUrl, evidence, "empty");
      console.log("desktop Build MCP surface smoke passed");
      return;
    }
    if (process.argv.includes("--mcp-experience-only")) {
      await runBuildMcpSurface(browser, baseUrl, evidence, "mixed");
      await runBuildMcpSurface(browser, baseUrl, evidence, "empty");
      await runBuildMcpRecommendationFailureSurface(browser, baseUrl, evidence);
      await runExperienceSurface(browser, baseUrl, evidence);
      // Refresh the two tracked baselines alongside the focused MCP evidence.
      await runBuildSurface(browser, baseUrl, evidence);
      await runLibrarySurface(browser, baseUrl, evidence);
      console.log("desktop MCP + Experience product surfaces smoke passed");
      return;
    }
    if (process.argv.includes("--experience-only")) {
      await runExperienceSurface(browser, baseUrl, evidence);
      await runExperienceCloudStateSurface(browser, baseUrl, evidence, "offline");
      await runExperienceCloudStateSurface(browser, baseUrl, evidence, "conflict");
      await runCompactAgentSurface(browser, baseUrl, evidence);
      console.log("desktop Experience surface smoke passed");
      return;
    }
    if (process.argv.includes("--hub-ontology-only")) {
      await runHubOntologyProjectionSurface(browser, baseUrl, evidence);
      await runOntologyWebglFallbackSurface(browser, baseUrl, evidence);
      await runOntologyScaleSurface(browser, baseUrl);
      await runOntologyErrorSurface(browser, baseUrl);
      console.log("desktop exact Hub Ontology projection, WebGL fallback, scale, and error-state surfaces passed");
      return;
    }
    if (process.argv.includes("--agent-governance-only")) {
      await runLibrarySurface(browser, baseUrl, evidence);
      await runFirmAgentSurface(browser, baseUrl, evidence);
      await runExperienceSurface(browser, baseUrl, evidence);
      await runExperienceCloudStateSurface(browser, baseUrl, evidence, "offline");
      await runExperienceCloudStateSurface(browser, baseUrl, evidence, "conflict");
      await runCompactAgentSurface(browser, baseUrl, evidence);
      await runBuildSurface(browser, baseUrl, evidence);
      console.log("desktop agent governance surface smoke passed");
      return;
    }
    await runSurface("dashboard-first-visit", () => runDashboardFirstVisitTourSurface(browser, baseUrl, evidence));
    await runSurface("dashboard-attention", () => runDashboardAttentionSurface(browser, baseUrl, evidence));
    await runSurface("build", () => runBuildSurface(browser, baseUrl, evidence));
    await runSurface("build-roster-sync", () => runBuildRosterSyncSurface(browser, baseUrl, evidence));
    await runSurface("build-roster-replay", () => runBuildRosterReplaySurface(browser, baseUrl, evidence));
    await runSurface("build-interview", () => runBuildInterviewSurface(browser, baseUrl, evidence));
    await runSurface("build-cancel", () => runBuildCancelSurface(browser, baseUrl, evidence));
    await runSurface("library", () => runLibrarySurface(browser, baseUrl, evidence));
    await runSurface("firm-agent", () => runFirmAgentSurface(browser, baseUrl, evidence));
    await runSurface("import", () => runImportSurface(browser, baseUrl, evidence));
    await runSurface("memory-evolution", () => runMemoryEvolutionSurface(browser, baseUrl, evidence));
    await runSurface("chat", () => runChatSurface(browser, baseUrl, evidence));
    await runSurface("new-chat-scope", () => runNewChatScopeSurface(browser, baseUrl, evidence));
    await runSurface("chat-model", () => runChatModelSurface(browser, baseUrl, evidence));
    await runSurface("chat-attachment", () => runChatAttachmentSurface(browser, baseUrl, evidence));
    await runSurface("chat-paste-drop", () => runChatPasteDropAttachmentSurface(browser, baseUrl, evidence));
    await runSurface("chat-autocomplete", () => runChatAutocompleteSurface(browser, baseUrl, evidence));
    await runSurface("chat-mention", () => runChatMentionSurface(browser, baseUrl, evidence));
    await runSurface("chat-context-mention", () => runChatContextMentionSurface(browser, baseUrl, evidence));
    await runSurface("chat-recommend", () => runChatRecommendSurface(browser, baseUrl, evidence));
    await runSurface("chat-stop-ime", () => runChatStopAndImeSurface(browser, baseUrl, evidence));
    await runSurface("chat-long-session", () => runChatLongSessionSurface(browser, baseUrl, evidence), 90_000);
    await runSurface("automation", () => runAutomationSurface(browser, baseUrl, evidence));
    await runSurface("automation-detail", () => runAutomationDefaultAndDetailSurface(browser, baseUrl, evidence));
    await runSurface("hub-live", () => runHubLiveSurface(browser, baseUrl, evidence));

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

async function runSurface(name, operation, timeoutMs = 45_000) {
  process.stdout.write(`[surface] ${name} ... `);
  let timeout;
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} surface timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    console.log("PASS");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function newPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.viewportWidth || 1440, height: options.viewportHeight || 980 } });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions(options));
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

async function readFiniteSceneNumber(scene, attribute, label) {
  const raw = await scene.getAttribute(attribute);
  assert.notEqual(raw, null, `${label} must expose ${attribute}`);
  const value = Number(raw);
  assert(Number.isFinite(value), `${label} ${attribute} must be a finite number`);
  return value;
}

async function waitForOntologyCameraSettled(page, graph) {
  const scene = graph.getByTestId("ontology-3d-scene");
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="agent-ontology-graph"] [data-testid="ontology-3d-scene"]');
    return element instanceof HTMLElement
      && Number(element.dataset.cameraRevision || "0") > 0
      && element.dataset.cameraAnimating === "false";
  });
  return scene;
}

async function assertOntologyGraphPaint(graph, theme) {
  const shell = graph.locator('[data-engine-state="ready"]');
  await shell.waitFor();
  const scene = graph.getByTestId("ontology-3d-scene");
  await scene.waitFor();
  assert.equal(await scene.getAttribute("data-engine"), "three-webgl", `${theme} ontology renderer must be Three.js WebGL`);
  assert.equal(await scene.getAttribute("data-camera-type"), "PerspectiveCamera", `${theme} ontology camera must be perspective 3D`);
  assert.equal(await scene.getAttribute("data-node-shape"), "sphere", `${theme} ontology nodes must all be spherical`);
  assert.equal(await scene.getAttribute("data-non-spherical-node-instances"), "0", `${theme} ontology scene must not contain square nodes`);
  assert.equal(
    await scene.getAttribute("data-spherical-node-instances"),
    await scene.getAttribute("data-node-count"),
    `${theme} every rendered ontology node must use the spherical instance batch`,
  );
  const depthSpan = await readFiniteSceneNumber(scene, "data-depth-span", `${theme} ontology scene`);
  const sceneRadius = await readFiniteSceneNumber(scene, "data-scene-radius", `${theme} ontology scene`);
  const nodeCount = await readFiniteSceneNumber(scene, "data-node-count", `${theme} ontology scene`);
  const edgeCount = await readFiniteSceneNumber(scene, "data-edge-count", `${theme} ontology scene`);
  const drawCalls = await readFiniteSceneNumber(scene, "data-draw-calls", `${theme} ontology scene`);
  assert(nodeCount > 0, `${theme} ontology scene must render at least one spherical node`);
  assert(edgeCount >= 0, `${theme} ontology edge count must not be negative`);
  if (nodeCount > 1) assert(depthSpan > sceneRadius * 0.15, `${theme} ontology layout must have meaningful Z depth`);
  assert.equal(await graph.locator('canvas[data-ontology-webgl="true"]').count(), 1, `${theme} ontology scene must own one WebGL canvas`);
  assert(drawCalls > 0 && drawCalls <= 10, `${theme} ontology scene must remain within its draw-call budget`);
  assert.equal(await graph.getByTestId("ontology-node-hover-label").count(), 1, `${theme} ontology scene must use one shared hover label`);
  assert.equal(await graph.getByTestId("ontology-node-hover-label").isVisible(), false, `${theme} ontology label must stay hidden at rest`);
  assert.equal(await graph.getByTestId("ontology-node-inspector").isVisible(), true, `${theme} ontology inspector must remain visible`);
  const markerRadius = await graph.getByTestId("ontology-node-inspector").locator("[class*=nodeMark]").first().evaluate((element) => getComputedStyle(element).borderRadius);
  assert(markerRadius === "999px" || markerRadius === "50%", `${theme} ontology inspector marker must be circular`);
}

async function assertOntologyHoverLabel(page, graph, label) {
  await waitForOntologyCameraSettled(page, graph);
  const engine = graph.locator('[role="img"]');
  const bounds = await engine.boundingBox();
  assert.ok(bounds, `${label} ontology engine must have bounds`);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const hoverLabel = graph.getByTestId("ontology-node-hover-label");
  await hoverLabel.waitFor({ state: "visible" });
  assert.equal((await hoverLabel.innerText()).trim(), label, `${label} must be the only label rendered on pointer hover`);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(80);
  assert.equal(await hoverLabel.isVisible(), false, `${label} must disappear after pointer leave`);
}

function quaternionAngle(left, right) {
  const dot = Math.abs(left.reduce((total, value, index) => total + value * right[index], 0));
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
}

async function assertOntologyOrbit(page, graph) {
  const scene = await waitForOntologyCameraSettled(page, graph);
  const engine = graph.locator('[role="img"]');
  const bounds = await engine.boundingBox();
  assert.ok(bounds, "ontology orbit surface must have bounds");
  const beforeQuaternion = (await scene.getAttribute("data-camera-quaternion")).split(",").map(Number);
  const beforeDistance = Number(await scene.getAttribute("data-camera-distance"));
  await page.mouse.move(bounds.x + bounds.width * 0.24, bounds.y + bounds.height * 0.34);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.52, bounds.y + bounds.height * 0.42, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(220);
  const afterQuaternion = (await scene.getAttribute("data-camera-quaternion")).split(",").map(Number);
  const afterDistance = Number(await scene.getAttribute("data-camera-distance"));
  assert(quaternionAngle(beforeQuaternion, afterQuaternion) > 0.08, "pointer drag must orbit the perspective camera in 3D");
  assert(Math.abs(afterDistance - beforeDistance) / beforeDistance < 0.02, "orbit must preserve camera distance instead of panning the graph");
}

async function assertOntologyZoom(page, graph) {
  const scene = await waitForOntologyCameraSettled(page, graph);
  const beforeDistance = await readFiniteSceneNumber(scene, "data-camera-distance", "ontology zoom camera");
  await graph.getByRole("button", { name: /확대|Zoom in/ }).click();
  await page.waitForFunction((distance) => {
    const element = document.querySelector('[data-testid="agent-ontology-graph"] [data-testid="ontology-3d-scene"]');
    return element instanceof HTMLElement
      && element.dataset.cameraAnimating === "false"
      && Number(element.dataset.cameraDistance || "Infinity") < distance * 0.9;
  }, beforeDistance);
  const zoomedDistance = await readFiniteSceneNumber(scene, "data-camera-distance", "ontology zoom camera");
  assert(zoomedDistance < beforeDistance * 0.9, "zoom-in must reduce the perspective camera distance");

  await graph.getByRole("button", { name: /전체 맞춤|Fit graph/ }).click();
  await page.waitForFunction((distance) => {
    const element = document.querySelector('[data-testid="agent-ontology-graph"] [data-testid="ontology-3d-scene"]');
    return element instanceof HTMLElement
      && element.dataset.cameraAnimating === "false"
      && Number(element.dataset.cameraDistance || "0") > distance * 1.05;
  }, zoomedDistance);
}

async function captureOntologyEvidence(page, graph, outputPath, theme) {
  await waitForOntologyCameraSettled(page, graph);
  const shell = graph.locator('[data-engine-state="ready"]');
  const bounds = await shell.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height };
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: outputPath, fullPage: true, animations: "disabled" });
  const metadata = await sharp(outputPath).metadata();
  const extract = {
    left: Math.max(0, Math.round(bounds.left)),
    top: Math.max(0, Math.round(bounds.top)),
    width: Math.min(Math.round(bounds.width), (metadata.width || 1) - Math.max(0, Math.round(bounds.left))),
    height: Math.min(Math.round(bounds.height), (metadata.height || 1) - Math.max(0, Math.round(bounds.top))),
  };
  const stats = await sharp(outputPath).extract(extract).stats();
  assert(stats.entropy > 1.2, `${theme} ontology evidence must not collapse into a blank compositor frame`);
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
  const storedWorkspaceGrant = JSON.parse(
    await page.evaluate(() => window.localStorage.getItem("agentlas.build.workspace")),
  );
  assert.equal(storedWorkspaceGrant.path, "/tmp/agentlas-qa");
  assert.equal(storedWorkspaceGrant.kind, "directory");
  assert.equal(storedWorkspaceGrant.scope.kind, "capability");
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/tmp\/agentlas-qa|agentlas-qa/).waitFor();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("#build-model-select option").length >= 2);
  await page.locator("#build-model-select").selectOption({ index: 1 });
  textarea = page.locator("textarea").first();

  await textarea.fill("검증용 리서치 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  await approveEmptyMcpPlan(page);
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
  await page.getByText(/내 Agent Cloud에 비공개 저장했습니다|Saved privately to your Agent Cloud|업로드 완료|Uploaded/).waitFor();
  await page.getByRole("button", { name: /허브 \(공개\)|Hub \(public\)/ }).click();
  await page.getByText(/Hub 공개 제출 완료|Submitted to the public Hub|업로드 완료|Uploaded/).waitFor();

  const calls = await page.evaluate(() => window.__qa.calls);
  const buildCall = calls.find((call) => call.name === "hephaestus.build");
  assert.equal(buildCall.payload.mode, "single");
  assert.equal(buildCall.payload.workspaceGrant?.path, "/tmp/agentlas-qa");
  assert.equal(buildCall.payload.workspaceGrant?.scope?.kind, "capability");
  assert.equal(buildCall.payload.request, "검증용 리서치 에이전트");
  assert.ok(buildCall.payload.runtime, "selected build runtime should be passed");
  assert.ok(calls.some((call) => call.name === "team.importLocalFolder" && call.payload?.path === "/tmp/agentlas-qa/qa-agent"));
  assert.ok(calls.some((call) => call.name === "hephaestus.publish" && call.payload.visibility === "private-link"));
  assert.ok(calls.some((call) => call.name === "hephaestus.publish" && call.payload.visibility === "marketplace"));

  await finishPage(context, page, errors, evidence, "build-surface");
}

async function runBuildMcpSurface(browser, baseUrl, evidence, scenario) {
  const { context, page, errors } = await newPage(browser, { mcpBuildScenario: scenario });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).click();
  await page.locator("textarea").first().fill("브라우저와 GitHub를 쓰는 검증 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();

  const planCard = page.locator(".build-mcp-plan-card");
  await planCard.waitFor();
  await planCard.getByText(/브라우저 조작이 필요한 요청|The request needs browser interaction/).first().waitFor();
  await planCard.getByText(/예상 필요 권한|Estimated required permission/).first().waitFor();
  await planCard.getByText(/호스트 추정|host estimate/).first().waitFor();
  await planCard.getByText(/강제 안 됨|not enforced/).first().waitFor();
  await planCard.getByText(/실제 API 키·서버·DB 계정 권한은 더 넓을 수 있으며|Actual API-key, server, or database-account access can be broader/).waitFor();
  await planCard.getByText(/키 없음|key missing/).first().waitFor();
  assert.equal(await planCard.getByText(/The request needs browser interaction/).count(), 0, "Korean MCP plan must not mix English reason prose");
  await planCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, `build-mcp-${scenario}-plan-surface.png`), fullPage: true });
  evidence.push({ name: `build-mcp-${scenario}-plan`, status: "pass", url: page.url() });

  await page.getByRole("button", { name: /선택 3개로 빌드|Build with 3 selected/ }).click();
  const receiptCard = page.locator(".build-mcp-receipt-card");
  await receiptCard.waitFor();
  if (scenario === "mixed") {
    await receiptCard.getByText(/연결 확인됨|resolved/).waitFor();
    await receiptCard.getByText("Agentlas Browser → Playwright", { exact: true }).waitFor();
    await receiptCard.getByText(/연결 결과를 로컬 기록으로 저장하지 못했지만|local attachment receipt could not be stored/).waitFor();
    await receiptCard.getByText(/붙음 · 2|Attached · 2/).waitFor();
    await receiptCard.getByText(/연결 실패 · 1|Failed · 1/).waitFor();
  } else {
    await receiptCard.getByText(/MCP 없는 제한 모드|empty MCP mode/).waitFor();
    await receiptCard.getByText(/MCP가 하나도 붙지 않아도 빌드 자체는 계속됩니다|Build continues even when no MCP/).waitFor();
  }
  const buildCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "hephaestus.build"));
  assert.equal(buildCall.payload.mcpConsent.selectedCandidateIds.length, 3);
  await finishPage(context, page, errors, evidence, `build-mcp-${scenario}-receipt-surface`);
}

async function runBuildMcpRecommendationFailureSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { mcpBuildScenario: "recommendation-failure" });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).click();
  await page.locator("textarea").first().fill("MCP 추천 장애에도 계속할 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  const planCard = page.locator(".build-mcp-plan-card");
  await planCard.waitFor();
  await planCard.getByText(/MCP 추천 서비스 불가 · 한 번 확인 후 MCP 없이 계속|MCP recommendation service unavailable/).waitFor();
  assert.equal(await planCard.getByText(/이 요청에 맞는 MCP 추천이 없습니다|No task-relevant MCP was found/).count(), 0, "recommendation outage must not masquerade as a successful empty search");
  await planCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, "build-mcp-recommendation-outage-plan-surface.png"), fullPage: true });
  evidence.push({ name: "build-mcp-recommendation-outage-plan", status: "pass", url: page.url() });
  await page.getByRole("button", { name: /MCP 없이 계속|Continue without MCP/ }).click();
  const receiptCard = page.locator(".build-mcp-receipt-card");
  await receiptCard.getByText(/MCP 없는 제한 모드|empty MCP mode/).waitFor();
  const buildCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "hephaestus.build"));
  assert.equal(buildCall.payload.mcpConsent.fallbackReason, "recommendation_unavailable");
  assert.deepEqual(buildCall.payload.mcpConsent.selectedCandidateIds, []);
  await finishPage(context, page, errors, evidence, "build-mcp-recommendation-outage-receipt-surface");
}

async function runBuildRosterSyncSurface(browser, baseUrl, evidence) {
  return runBuildRosterSurface(browser, baseUrl, evidence, {
    importDelayMs: 1400,
    evidenceName: "build-roster-sync",
    waitForRegistrationBeforeNavigation: false,
  });
}

async function runBuildRosterReplaySurface(browser, baseUrl, evidence) {
  return runBuildRosterSurface(browser, baseUrl, evidence, {
    importDelayMs: 0,
    evidenceName: "build-roster-replay",
    waitForRegistrationBeforeNavigation: true,
  });
}

async function runBuildRosterSurface(browser, baseUrl, evidence, options) {
  const { context, page, errors } = await newPage(browser, { importDelayMs: options.importDelayMs });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.getByText(/tmp\/agentlas-qa|agentlas-qa/).waitFor();
  await page.getByRole("button", { name: /단일 에이전트|Single agent/ }).click();
  const textarea = page.locator("textarea").first();
  await textarea.fill("즉시 등록 검증 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  await approveEmptyMcpPlan(page);
  await page.getByText(/패키지 준비됨|Package ready/).waitFor({ timeout: 7000 });
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "team.importLocalFolder"));
  if (options.waitForRegistrationBeforeNavigation) {
    await page.getByText(/패키지 준비됨 · 조직도에 추가됨|Package ready · added to org chart/).waitFor({ timeout: 5000 });
  }

  const navigationEntriesBefore = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  await page.locator('a[href="/dashboard"]').first().click();
  await page.waitForURL(/\/dashboard(?:\.html)?$/);
  await page.getByText(/가져온 QA 에이전트|Imported QA Agent/).first().waitFor({ timeout: 5000 });
  assert.equal(
    await page.evaluate(() => performance.getEntriesByType("navigation").length),
    navigationEntriesBefore,
    "the mounted org chart must update after registration without a page reload",
  );

  await page.getByRole("button", { name: /에이전트 클라우드|Agent Cloud/ }).click();
  const agentLink = page.locator('a[href="/library/agents"]').first();
  await agentLink.click();
  await page.waitForURL(/\/library\/agents/);
  await page.getByText(/가져온 QA 에이전트|Imported QA Agent/).first().waitFor({ timeout: 5000 });
  await expectDataActive(page.getByRole("button", { name: /싱글 · 에이전트|Single · agents/ }), "true");
  await finishPage(context, page, errors, evidence, options.evidenceName);
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

async function approveEmptyMcpPlan(page) {
  const button = page.getByRole("button", { name: /MCP 없이 계속|Continue without MCP/ });
  await button.waitFor();
  await button.click();
}

async function runBuildInterviewSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { buildScenario: "interview" });
  await page.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
  await page.locator("textarea").first().fill("인터뷰가 필요한 에이전트");
  await page.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
  await approveEmptyMcpPlan(page);
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
  await approveEmptyMcpPlan(page);
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
  await page.getByTestId("governed-agent-identity").waitFor();
  assert.equal(
    await page.evaluate(() => window.__qa.calls.some((call) => call.name === "experience.ontologyGraph")),
    false,
    "relation index must stay lazy until the Ontology tab is opened",
  );
  assert.equal(await page.getByRole("heading", { name: /시스템 프롬프트|System Prompt/ }).count(), 0, "raw prompt heading must not be rendered");
  assert.equal(await page.getByRole("button", { name: /프롬프트 편집|Edit prompt|프롬프트 복사|Copy prompt|기본값 재설정|Reset to default/ }).count(), 0, "raw prompt controls must not be rendered");
  assert.deepEqual(
    (await page.getByTestId("agent-detail-tabs").getByRole("button").allTextContents()).map((text) => text.trim()),
    ["정체성 & 페르소나", "큐레이팅된 메모리", "플레이북 & 워크플로우", "활동 및 자체 진화", "온톨로지 칩"],
    "agent tabs must preserve the governed order",
  );
  await page.getByText(/실행 모델 지정|Runtime Model Assignment/).waitFor();

  const aliasEdit = page.getByRole("button", { name: /로컬 표시 이름 편집|Edit local display name/ });
  await aliasEdit.click();
  const aliasInput = page.getByRole("textbox", { name: /로컬 표시 이름|Local display name/ });
  await aliasInput.waitFor();
  assert.equal(await aliasInput.evaluate((input) => input === document.activeElement), true, "alias editor should receive focus");
  await aliasInput.fill("취소할 별칭");
  await aliasInput.press("Escape");
  assert.equal(await aliasInput.count(), 0, "Escape should cancel alias editing");
  await aliasEdit.click();
  await page.getByRole("textbox", { name: /로컬 표시 이름|Local display name/ }).fill("QA 빌더");
  await page.getByRole("textbox", { name: /로컬 표시 이름|Local display name/ }).press("Enter");
  await page.getByRole("heading", { name: "QA 빌더", exact: true }).waitFor();
  await page.getByTestId("agent-original-name").getByText(/빌더 에이전트|Builder Agent/).waitFor();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "team.setLocalDisplayName" && call.payload.id === "agent-2" && call.payload.value === "QA 빌더"));
  assert.ok(await page.getByText("QA 빌더", { exact: true }).count() >= 2, "saved alias should update both roster and detail without changing the ID");

  await page.getByRole("button", { name: /큐레이팅된 메모리|Curated Memory/ }).click();
  await page.getByText(/결정 사항|Decisions/).waitFor();
  await page.getByText("Route clearly").waitFor();
  await page.locator('input[type="checkbox"]').first().click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md"));
  const memoryWrite = await page.evaluate(() =>
    window.__qa.calls.find((call) => call.name === "agentFiles.write" && call.payload.path === "memory.md"),
  );
  assert.match(memoryWrite.payload.content, /agentlas:disabled/);
  assert.match(memoryWrite.payload.content, /## Private provenance\nKeep this operator-authored section byte-stable/, "memory edits must preserve unknown operator sections");

  await page.getByRole("button", { name: /정체성|Identity/ }).click();
  await page.locator("select").first().selectOption({ index: 1 });
  await page.getByRole("button", { name: /^저장$|^Save$/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentRuntime.set"));
  await page.getByRole("button", { name: /전역 기본|Global default/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentRuntime.remove"));

  await finishPage(context, page, errors, evidence, "library-agents-surface");
}

async function runFirmAgentSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { experienceScenario: true, viewportHeight: 1100 });
  await page.goto(`${baseUrl}/firm/detail.html?id=firm-1`, { waitUntil: "domcontentloaded" });
  await page.getByText(/빌더 에이전트|Builder Agent/).first().click();
  await page.getByTestId("governed-agent-identity").waitFor();
  assert.equal(await page.getByRole("heading", { name: /시스템 프롬프트|System Prompt/ }).count(), 0, "firm detail must not render the raw prompt heading");
  assert.equal(await page.getByRole("button", { name: /프롬프트 편집|Edit prompt|프롬프트 복사|Copy prompt|기본값 재설정|Reset to default/ }).count(), 0, "firm detail must not render raw prompt controls");
  assert.deepEqual(
    (await page.getByTestId("agent-detail-tabs").getByRole("button").allTextContents()).map((text) => text.trim()),
    ["정체성 & 페르소나", "큐레이팅된 메모리", "플레이북 & 워크플로우", "활동 및 자체 진화", "온톨로지 칩"],
    "firm agent tabs must match the library order",
  );
  await page.getByRole("button", { name: /로컬 표시 이름 편집|Edit local display name/ }).waitFor();

  await page.getByRole("button", { name: /플레이북 & 워크플로우|Playbook & Workflow/ }).click();
  await page.getByTestId("agent-learning-playbook").waitFor();
  await page.getByText(/학습은 자동으로 플레이북 파일을 만들지 않습니다|Learning never auto-creates a playbook file/).waitFor();
  await page.getByText("AGENT.md", { exact: true }).first().waitFor();

  await page.getByRole("button", { name: /활동 및 자체 진화|Activity & Self-Evolution/ }).click();
  await page.getByTestId("agent-learning-activity").waitFor();
  await page.getByText(/귀속 불명 레거시|Legacy unattributed/).waitFor();

  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  const ontology = page.getByTestId("experience-ontology-summary");
  await ontology.waitFor();
  await ontology.locator("summary").click();
  await ontology.getByText(/privacy_sensitive/).waitFor();
  const graph = page.getByTestId("agent-ontology-graph");
  await graph.waitFor();
  await graph.locator('[data-engine-state="ready"]').waitFor();
  await assertOntologyGraphPaint(graph, "firm agent");
  await graph.locator('select[aria-label="노드 찾기"], select[aria-label="Find node"]').selectOption({ label: "취향 후보 · taste-density" });
  await graph.getByTestId("ontology-node-inspector").getByText("취향 후보 · taste-density", { exact: true }).waitFor();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentLearning.summary" && call.payload === "agent-2"));
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "experience.ontologySummary" && call.payload === "agent-2"));
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "experience.ontologyGraph" && call.payload === "agent-2"));
  await page.waitForTimeout(350);

  await finishPage(context, page, errors, evidence, "firm-agent-governance-surface");
}

async function runCompactAgentSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { viewportWidth: 920, viewportHeight: 900 });
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  const roster = page.locator('[data-tour-id="agents.roster"]');
  await roster.waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-tour-id="agents.roster"]');
    return element instanceof HTMLElement && element.getBoundingClientRect().width <= 65;
  });
  await page.getByTitle(/Builder Agent|빌더 에이전트/).first().click();
  const tabs = page.getByTestId("agent-detail-tabs");
  await tabs.waitFor();
  assert.equal(await tabs.evaluate((nav) => getComputedStyle(nav).overflowX === "auto"), true, "compact agent tabs should scroll horizontally instead of clipping");
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  const compactGraph = page.getByTestId("agent-ontology-graph");
  await compactGraph.waitFor();
  await compactGraph.locator('[data-engine-state="ready"], [data-engine-state="fallback"]').waitFor();
  await page.getByTestId("experience-ontology-summary").waitFor();
  assert.equal(await page.getByTestId("ontology-chip-management").getAttribute("open"), null, "compact ontology management must stay collapsed by default");
  assert.equal(await compactGraph.evaluate((root) => {
    const shell = root.querySelector('[data-engine-state]')?.getBoundingClientRect();
    const inspector = root.querySelector('[data-testid="ontology-node-inspector"]')?.getBoundingClientRect();
    return Boolean(shell && inspector && inspector.left >= shell.left && inspector.right <= shell.right && inspector.bottom <= shell.bottom);
  }), true, "compact Atlas inspector must stay inside the graph surface");
  for (const button of [
    page.getByRole("button", { name: /일 시키기|Put to work/ }),
    page.getByRole("button", { name: /제거|Remove/ }),
  ]) {
    assert.equal(await button.evaluate((element) => getComputedStyle(element).whiteSpace), "nowrap", "compact agent actions must not split text by syllable");
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "920px agent surface must not overflow the page horizontally");
  await finishPage(context, page, errors, evidence, "library-agent-compact-surface");
}

async function runExperienceSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, { experienceScenario: true, viewportHeight: 1200 });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Builder Agent|빌더 에이전트/).first().click();
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  const ontologySummary = page.getByTestId("experience-ontology-summary");
  await ontologySummary.waitFor();
  await ontologySummary.locator("summary").click();
  await page.getByText(/경험 항목|Items/).waitFor();
  await page.getByText(/privacy_sensitive/).waitFor();
  await page.locator('[data-intake-state="blocked"]').getByText(/2/).waitFor();
  await page.getByTestId("ontology-chip-management").locator("summary").click();
  await page.getByText(/^경험 칩$|^Experience Chips$/).first().waitFor();
  await page.getByText(/로컬 원본 · Agent와 별도 자산|Local source · separate asset from Agent/).waitFor();
  await page.getByText(/원본 에이전트 패키지와 합치거나 복사하지 않으며|never copies or merges the base agent package/).waitFor();

  await page.getByPlaceholder(/경험 칩 묶음 이름|Experience Chips name/).fill("브라우저 운영 경험");
  await page.getByRole("button", { name: /프로젝트 폴더 선택|Choose project folder/ }).click();
  await page.getByRole("button", { name: /경험 칩 만들기|Create Experience Chips/ }).click();
  await page.getByText("브라우저 운영 경험", { exact: true }).first().waitFor();

  const memorySelect = page.locator('[data-testid="experience-panel"] select').first();
  await memorySelect.selectOption("memory-browser-workflow");
  await page.getByRole("button", { name: /후보 만들기|Create candidate/ }).click();
  await page.getByText("브라우저 게시 전 보이는 계정과 최종 화면을 확인한다.", { exact: true }).waitFor();
  await page.getByRole("button", { name: /검수 후 승격 \(attested\)|Review & promote \(attested\)/ }).click();
  await page.getByText("ATTESTED", { exact: true }).waitFor();
  await page.getByText(/1 candidates · 1 attested · 0 intents/).waitFor();

  await page.getByRole("button", { name: /비공개 로컬 의도 기록|Record private local intent/ }).click();
  await page.getByText(/1 candidates · 1 attested · 1 intents/).waitFor();
  await page.getByText(/로컬 의도는 비공개 호환 영수증입니다|Local intent is a private compatibility receipt/).waitFor();
  await page.getByText(/1\. 원본 Agent 업로드|1\. Base Agent upload/).waitFor();
  await page.getByText(/2\. Experience 업로드|2\. Experience upload/).waitFor();
  await page.getByText(/Agent 제작자와 달라도 됩니다|May differ from the Agent author/).waitFor();
  await page.getByText(/공개 활성 \(서버만\)|Public active \(server only\)/).waitFor();
  await page.getByText(/충돌 시 다시 맞춤·재시도|Conflict → reconcile & retry/).waitFor();

  await page.getByRole("button", { name: /Experience만 비공개 저장|Save Experience privately/ }).click();
  await page.locator('[data-testid="experience-cloud-status"][data-cloud-state="private-saved"]').waitFor();
  await page.getByText(/workspace:qa-experience-owner/).waitFor();
  await page.getByRole("button", { name: /공개 사본 소스|Public-copy source/ }).click();
  await page.getByLabel(/Operational 공개 제목|Operational public title/).fill("게시 완료 상태 확인");
  await page.getByLabel(/Operational 공개 절차|Operational public instructions/).fill("렌더링된 목적지를 확인합니다.\n예상 상태가 없으면 마지막 동작만 반복합니다.");
  await page.getByLabel(/Operational 작업 유형|Operational task signature/).selectOption("agentlas.task.v1/browser-automation");
  await page.getByRole("button", { name: /공개 사본 저장|Save public copy/ }).click();
  await page.getByRole("button", { name: /명시적 확인|Explicit confirm/ }).click();
  await page.getByRole("button", { name: /공개 검증 요청|Request public verification/ }).click();
  await page.locator('[data-testid="experience-cloud-status"][data-cloud-state="verification-requested"]').waitFor();
  await page.getByText(/아직 공개 활성 상태는 아닙니다|not public-active yet/).waitFor();
  await page.getByRole("button", { name: /상태 다시 맞추기|Reconcile status/ }).click();
  await page.locator('[data-testid="experience-cloud-status"][data-cloud-state="verification-pending"]').waitFor();

  const calls = await page.evaluate(() => window.__qa.calls);
  assert.ok(calls.some((call) => call.name === "experience.createPack"));
  assert.ok(calls.some((call) => call.name === "experience.captureFromMemory"));
  assert.ok(calls.some((call) => call.name === "experience.promote" && call.payload.verification.status === "attested"));
  assert.ok(calls.some((call) => call.name === "experience.createExportIntent" && call.payload.visibility === "private"));
  assert.ok(calls.some((call) => call.name === "experience.cloudSave" && call.payload.requestedVisibility === "private"));
  assert.ok(calls.some((call) => call.name === "experience.saveOperationalPublicProjection"));
  assert.ok(calls.some((call) => call.name === "experience.confirmOperationalPublicProjection"));
  assert.ok(calls.some((call) => call.name === "experience.cloudSave" && call.payload.requestedVisibility === "public"));
  assert.ok(calls.some((call) => call.name === "experience.cloudReconcile"));
  assert.equal(calls.some((call) => call.name === "cloudAgents.publish"), false, "Experience upload must remain separate from Agent upload");
  await finishPage(context, page, errors, evidence, "library-experience-surface");
}

async function runHubOntologyProjectionSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, {
    experienceScenario: true,
    hubOntologyAgentId: "agent-2",
    hubOntologyNeutralFixture: true,
    viewportHeight: 1250,
  });
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Research Analyst Agent|리서치 분석 에이전트/).first().click();
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();

  const hub = page.getByTestId("agent-hub-ontology-projection");
  await hub.waitFor();
  const graph = page.getByTestId("agent-ontology-graph");
  await graph.waitFor();
  await graph.locator('[data-engine-state="ready"]').waitFor();
  await graph.getByText(/ONTOLOGY ATLAS|온톨로지 아틀라스/).waitFor();
  await graph.getByText(/THREE · 3D/).waitFor();
  await graph.getByLabel(/관계선 범례|Relation legend/).waitFor();
  await assertOntologyGraphPaint(graph, "initial");
  await assertOntologyOrbit(page, graph);
  await graph.getByRole("button", { name: /전체 맞춤|Fit graph/ }).click();
  await waitForOntologyCameraSettled(page, graph);
  const nodePicker = graph.locator('select[aria-label="노드 찾기"], select[aria-label="Find node"]');
  await nodePicker.selectOption({ label: "Agentlas Browser" });
  await graph.getByTestId("ontology-node-inspector").getByText("Agentlas Browser", { exact: true }).waitFor();
  await page.waitForTimeout(350);
  await assertOntologyHoverLabel(page, graph, "Agentlas Browser");
  await assertOntologyZoom(page, graph);
  const relationList = graph.getByTestId("ontology-relation-list");
  await relationList.locator("summary").click();
  await relationList.getByText(/필수 MCP|requires MCP/).waitFor();
  await relationList.locator("summary").click();
  await graph.getByRole("button", { name: "Hub", exact: true }).click();
  assert.equal(await graph.locator('[data-scope="hub"]').count(), 1, "Hub scope must be an actual graph filter");
  await nodePicker.selectOption({ label: "절제된 에디토리얼 톤" });
  await graph.getByTestId("ontology-node-inspector").getByText("절제된 에디토리얼 톤", { exact: true }).waitFor();
  await graph.getByRole("button", { name: "전체", exact: true }).click();
  assert.equal(await graph.getByText(/안전 차단|Safety/).count(), 0, "safety status must not be fabricated as an entity node");
  const localExperience = page.getByTestId("agent-local-experience");
  await localExperience.getByRole("heading", { name: /이 Mac에서 쌓인 경험|Experience accumulated on this Mac/ }).waitFor();
  assert.equal(
    await page.evaluate(() => {
      const hubNode = document.querySelector('[data-testid="agent-hub-ontology-projection"]');
      const localNode = document.querySelector('[data-testid="agent-local-experience"]');
      return Boolean(hubNode && localNode && (hubNode.compareDocumentPosition(localNode) & Node.DOCUMENT_POSITION_FOLLOWING));
    }),
    true,
    "exact Hub loadout must appear before the separate local Experience area",
  );
  assert.equal(await hub.getAttribute("data-projection-status"), "live");
  await hub.getByText(/읽기 전용|Read only/).waitFor();
  await page.getByTestId("ontology-hub-details").locator("summary").click();
  await hub.getByText("agent-definition-agent-2", { exact: true }).waitFor();
  await hub.getByText("agent-release-agent-2-r7", { exact: true }).waitFor();
  await page.getByTestId("ontology-operational-chips").getByText("게시 전 최종 화면 확인", { exact: true }).waitFor();
  await page.getByTestId("ontology-taste-chips").getByText("절제된 에디토리얼 톤", { exact: true }).waitFor();
  await page.getByTestId("ontology-active-loadout").getByText(/현재 세션에 장착됨|Active this session/).waitFor();
  await page.getByTestId("ontology-next-session").getByText(/다음 세션 예약|Scheduled next session/).waitFor();
  await page.getByTestId("ontology-pending-approvals").getByText(/명시적 승인 필요|Explicit approval required/).waitFor();
  await page.getByTestId("ontology-recommendations").getByText(/Operational 칩 업데이트/).waitFor();
  const management = page.getByTestId("ontology-chip-management");
  await management.locator("summary").click();
  await page.getByTestId("local-taste-drafts").waitFor();
  assert.equal(await page.getByTestId("taste-draft-count").innerText(), "2");
  await page.getByText(/과한 장식보다 비대칭 에디토리얼/).waitFor();
  await management.locator("summary").click();

  assert.equal(
    await hub.getByRole("button", { name: /승인|Approve|장착|Attach|구매|Purchase|대여|Lease/ }).count(),
    0,
    "My Agents Hub projection must remain read-only",
  );
  assert.doesNotMatch(await hub.innerText(), /\/Users\/|[A-Za-z]:\\|ghp_|sk-(?:proj-)?/i, "Hub card must not render host paths or credentials");
  await hub.getByRole("button", { name: /Hub 상태 새로고침|Refresh Hub status/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) =>
    call.name === "experience.hubProjection" && call.payload.agentId === "agent-2" && call.payload.force === true));
  const calls = await page.evaluate(() => window.__qa.calls);
  assert.equal(calls.some((call) => /attach|purchase|lease/i.test(call.name)), false, "refresh must not attach, purchase, or lease");
  assert.equal(calls.some((call) => call.name === "experience.cloudSave"), false, "Hub projection must not upload local Experience");
  await page.getByTestId("ontology-hub-details").locator("summary").click();
  await nodePicker.selectOption({ label: "리서치 분석 에이전트" });
  await graph.getByTestId("ontology-node-inspector").getByText("리서치 분석 에이전트", { exact: true }).waitFor();
  await graph.getByRole("button", { name: /전체 맞춤|Fit graph/ }).click();
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    localStorage.setItem("agentlas.theme", "dark");
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(350);
  await assertOntologyGraphPaint(graph, "dark");
  const darkEvidencePath = path.join(outDir, "library-hub-ontology-projection-surface-dark.png");
  await captureOntologyEvidence(page, graph, darkEvidencePath, "dark");
  evidence.push(darkEvidencePath);
  await page.evaluate(() => {
    localStorage.setItem("agentlas.theme", "light");
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(350);
  await assertOntologyGraphPaint(graph, "light");
  const lightEvidencePath = path.join(outDir, "library-hub-ontology-projection-surface.png");
  await captureOntologyEvidence(page, graph, lightEvidencePath, "light");
  assert.deepEqual(errors, [], "library Hub ontology surface should not emit page errors");
  evidence.push({ name: "library-hub-ontology-projection-surface", status: "pass", url: page.url() });
  await context.close();
}

async function runOntologyWebglFallbackSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser, {
    experienceScenario: true,
    hubOntologyAgentId: "agent-2",
    hubOntologyNeutralFixture: true,
    viewportHeight: 1100,
  });
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Research Analyst Agent|리서치 분석 에이전트/).first().click();
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  const graph = page.getByTestId("agent-ontology-graph");
  await graph.locator('[data-engine-state="ready"]').waitFor();
  await graph.evaluate((root) => {
    const canvas = root.querySelector('canvas[data-ontology-webgl="true"]');
    if (!canvas) throw new Error("Three.js ontology canvas missing");
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  });
  await graph.locator('[data-engine-state="fallback"]').waitFor();
  await graph.getByText(/GPU 지도를 사용할 수 없어 관계 목록으로 표시합니다|GPU map unavailable/).waitFor();
  assert((await graph.locator("button").count()) > 5, "fallback must keep ontology nodes keyboard-accessible");
  await page.waitForTimeout(350);
  const fallbackEvidencePath = path.join(outDir, "library-ontology-webgl-fallback-surface.png");
  await page.screenshot({ path: fallbackEvidencePath, fullPage: true });
  evidence.push({ name: "library-ontology-webgl-fallback-surface", status: "pass", url: page.url() });
  await graph.getByRole("button", { name: /GPU 다시 시도|Retry GPU/ }).click();
  await graph.locator('[data-engine-state="ready"]').waitFor();
  assert.equal(await graph.locator('canvas[data-ontology-webgl="true"]').count(), 1, "WebGL retry must restore exactly one Three.js canvas");
  await assertOntologyGraphPaint(graph, "fallback retry");
  assert.deepEqual(errors, [], "WebGL fallback and retry surface should not emit page errors");
  await context.close();
}

async function runOntologyScaleSurface(browser, baseUrl) {
  const { context, page, errors } = await newPage(browser, { experienceScenario: true, viewportHeight: 1000 });
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.agentlas.experience.ontologyGraph = async (agentId) => {
      const rootId = `scale-agent:${agentId}`;
      const nodes = [{ id: rootId, kind: "agent", ref: agentId, safeLabel: "Agent", status: "active", source: "synthetic" }];
      const edges = [];
      for (let pack = 0; pack < 24; pack += 1) {
        const packId = `scale-pack-${pack}`;
        const packNode = `pack:${packId}`;
        const releaseNode = `release:${packId}`;
        nodes.push({ id: packNode, kind: "pack", packId, ref: packId, safeLabel: "Experience pack", status: "active", source: "relation-index" });
        nodes.push({ id: releaseNode, kind: "release", packId, ref: `${packId}-r1`, safeLabel: "Experience release", status: "active", source: "relation-index" });
        edges.push({ id: `edge:agent:${pack}`, from: rootId, to: packNode, kind: "agent_has_pack", status: "active" });
        edges.push({ id: `edge:release:${pack}`, from: packNode, to: releaseNode, kind: "has_release", status: "active" });
      }
      for (let index = 0; index < 300; index += 1) {
        const pack = index % 24;
        const id = `item:scale-${index}`;
        nodes.push({ id, kind: "experience-item", packId: `scale-pack-${pack}`, ref: `scale-${index}`, safeLabel: "Promoted experience", status: "promoted", source: "relation-index" });
        edges.push({ id: `edge:item:${index}`, from: `release:scale-pack-${pack}`, to: id, kind: "contains", status: "active" });
      }
      for (let index = 0; index < 90; index += 1) {
        const id = `mcp:scale-${index}`;
        nodes.push({ id, kind: "mcp", ref: `mcp-${index}`, safeLabel: `MCP ${index}`, status: "active", source: "relation-index" });
        edges.push({ id: `edge:mcp:${index}`, from: `release:scale-pack-${index % 24}`, to: id, kind: "requires_mcp", status: "active" });
      }
      for (let index = 0; index < 110; index += 1) {
        const id = `task:scale-${index}`;
        nodes.push({ id, kind: "task", ref: `task-${index}`, safeLabel: `task-${index}`, status: "active", source: "relation-index" });
        edges.push({ id: `edge:task:${index}`, from: `item:scale-${index}`, to: id, kind: "applies_to_task", status: "active" });
      }
      return {
        schema: "agentlas.ontology-relation-graph.v1",
        agentId,
        generatedAt: new Date().toISOString(),
        nodes,
        edges,
        totalNodeCount: nodes.length,
        totalEdgeCount: edges.length,
        omittedNodeCount: 0,
        omittedEdgeCount: 0,
        truncated: false,
        limits: { nodes: 600, edges: 1000 },
      };
    };
  });
  await page.getByText(/Builder Agent|빌더 에이전트/).first().click();
  const startedAt = Date.now();
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  const graph = page.getByTestId("agent-ontology-graph");
  await graph.locator('[data-engine-state="ready"]').waitFor({ timeout: 5000 });
  assert(Date.now() - startedAt < 5000, "capped scale graph must become interactive within five seconds");
  await graph.getByText(/400 NODE · \d+ RELATION · CAPPED/).waitFor();
  await assertOntologyGraphPaint(graph, "400-node scale");
  const scene = graph.getByTestId("ontology-3d-scene");
  assert.equal(await scene.getAttribute("data-node-count"), "400", "3D renderer must honor the 400-node cap");
  assert.equal(await scene.getAttribute("data-spherical-node-instances"), "400", "all capped scale nodes must remain spherical instances");
  const renderedEdges = await readFiniteSceneNumber(scene, "data-edge-count", "400-node scale scene");
  assert(renderedEdges > 0 && renderedEdges <= 800, "3D renderer must honor the 800-edge cap");
  assert.equal(await graph.locator('select[aria-label="노드 찾기"] option, select[aria-label="Find node"] option').count(), 400, "renderer node picker must honor the 400-node cap");
  const relationList = graph.getByTestId("ontology-relation-list");
  assert.equal(await relationList.locator("[class*=relationRow]").count(), 0, "closed relation ledger must not eagerly mount hundreds of rows");
  await relationList.locator("summary").click();
  const relationRows = relationList.locator("[class*=relationRow]");
  await relationRows.first().waitFor();
  assert((await relationRows.count()) > 0 && (await relationRows.count()) <= 800, "opened relation ledger must honor the 800-edge cap");
  assert.deepEqual(errors, [], "scale ontology surface should not emit page errors");
  await context.close();
}

async function runOntologyErrorSurface(browser, baseUrl) {
  const { context, page, errors } = await newPage(browser, { experienceScenario: true, viewportHeight: 900 });
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.agentlas.experience.ontologyGraph = async () => {
      throw new Error("synthetic relation index outage /Users/private/secret");
    };
  });
  await page.getByText(/Builder Agent|빌더 에이전트/).first().click();
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  const graph = page.getByTestId("agent-ontology-graph");
  await graph.locator('[data-data-state="error"]').waitFor();
  await graph.getByText(/관계지도를 불러오지 못했습니다|relation map could not be loaded/).waitFor();
  assert.doesNotMatch(await graph.innerText(), /\/Users\/private|secret/i, "relation error UI must not expose raw host details");
  assert.equal(errors.length, 0, "handled ontology read failure must not emit page errors");
  await context.close();
}

async function runExperienceCloudStateSurface(browser, baseUrl, evidence, state) {
  const { context, page, errors } = await newPage(browser, { experienceScenario: true, experienceCloudState: state, viewportHeight: 1200 });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Builder Agent|빌더 에이전트/).first().click();
  await page.getByRole("button", { name: /온톨로지 칩|Ontology Chips/ }).click();
  await page.getByTestId("ontology-chip-management").locator("summary").click();
  await page.getByPlaceholder(/경험 칩 묶음 이름|Experience Chips name/).fill(`state-${state}`);
  await page.getByRole("button", { name: /프로젝트 폴더 선택|Choose project folder/ }).click();
  await page.getByRole("button", { name: /경험 칩 만들기|Create Experience Chips/ }).click();
  await page.locator('[data-testid="experience-panel"] select').first().selectOption("memory-browser-workflow");
  await page.getByRole("button", { name: /후보 만들기|Create candidate/ }).click();
  await page.getByRole("button", { name: /검수 후 승격 \(attested\)|Review & promote \(attested\)/ }).click();
  await page.getByRole("button", { name: /Experience만 비공개 저장|Save Experience privately/ }).click();
  await page.locator(`[data-testid="experience-cloud-status"][data-cloud-state="${state}"]`).waitFor();
  if (state === "offline") {
    await page.getByText(/오프라인 · 재개 가능|Offline · resumable/).waitFor();
  } else {
    await page.getByText(/로컬 자료는 그대로입니다|Local material is intact/).waitFor();
  }
  await finishPage(context, page, errors, evidence, `library-experience-${state}-surface`);
}

async function runImportSurface(browser, baseUrl, evidence) {
  const { context, page, errors } = await newPage(browser);
  await page.goto(`${baseUrl}/library/agents.html`, { waitUntil: "domcontentloaded" });
  await page.getByText(/My Agents Library|에이전트 라이브러리/).waitFor();
  await page.getByRole("button", { name: /^가져오기$|^Import$/ }).click();
  await page.getByRole("heading", { name: /가져온 QA 에이전트|Imported QA Agent/ }).waitFor();
  await page.getByTestId("governed-agent-identity").waitFor();
  assert.equal(await page.getByRole("heading", { name: /시스템 프롬프트|System Prompt/ }).count(), 0);

  const calls = await page.evaluate(() => window.__qa.calls);
  assert.ok(calls.some((call) => call.name === "fs.pickDirectory"), "folder picker should open before import");
  assert.ok(calls.some((call) => call.name === "team.importLocalFolder" && call.payload?.path === "/tmp/agentlas-qa"), "picked folder should be imported");

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
  assert.match(latestMemory, /## Private provenance\nKeep this operator-authored section byte-stable/, "rapid memory edits must not erase unknown sections");

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

  assert.equal(await page.getByRole("button", { name: /프롬프트 편집|Edit prompt|기본값 재설정|Reset to default/ }).count(), 0, "raw prompt mutation controls must stay absent");
  await page.getByRole("button", { name: /활동 및 자체 진화|Activity & Self-Evolution/ }).click();
  await page.getByTestId("agent-memory-curation-ledger").getByText(/학습 검사 7회|Curation checks 7/).waitFor();
  await page.getByText(/학습 검사 영수증|Curation receipts/).waitFor();
  await page.getByText(/새 기억 없음 3|3 no-new-memory/).first().waitFor();
  await page.getByText(/에이전트 자산 진화 제안|Agent Asset Evolution Proposal/).waitFor();
  await page.getByRole("button", { name: /diff 검토 후보 만들기|Create diff review candidate/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentEvolution.createProposal" && /Learned rules/.test(call.payload.proposedContent)),
  );
  const evolutionCall = await page.evaluate(() =>
    window.__qa.calls.filter((call) => call.name === "agentEvolution.createProposal" && /Learned rules/.test(call.payload.proposedContent)).at(-1),
  );
  assert.match(evolutionCall.payload.proposedContent, /Learned rules/);
  assert.match(evolutionCall.payload.proposedContent, /Publish target/);
  const beforeEvolutionApprove = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "agentEvolution.approveAndApply").length);
  await page.getByRole("button", { name: /검토 완료 · 승인 및 적용|Review complete · approve & apply/ }).click();
  await page.waitForFunction((before) => window.__qa.calls.filter((call) => call.name === "agentEvolution.approveAndApply").length > before, beforeEvolutionApprove);
  await page.getByText(/APPLY · asset v1→v2 · governed/).waitFor();

  await page.getByRole("button", { name: /스킬 고르기|Choose skill/ }).click();
  await page.getByRole("button", { name: /^주입$|^Inject$/ }).click();
  await page.waitForFunction(
    () => window.__qa.calls.some((call) => call.name === "agentEvolution.createProposal" && call.payload.proposalType === "skill" && call.payload.targetPath === "skills/qa-skill/SKILL.md"),
  );
  const skillCandidate = await page.evaluate(() =>
    window.__qa.calls.find((call) => call.name === "agentEvolution.createProposal" && call.payload.proposalType === "skill"),
  );
  const exactCatalogSkill = "---\nname: qa-skill\ndescription: QA helper skill\n---\n\n# Exact QA catalog body\n\nRun the full source instructions.\n";
  assert.equal(skillCandidate.payload.proposedContent, exactCatalogSkill, "candidate must preserve the exact catalog SKILL.md source");
  assert.equal(
    skillCandidate.payload.source.catalogContentHash,
    createHash("sha256").update(exactCatalogSkill).digest("hex"),
    "candidate provenance must carry the main-owned catalog source hash",
  );
  assert.equal(
    await page.evaluate(() => window.__qa.calls.some((call) => call.name === "skills.readCatalog" && call.payload.slug === "qa-skill")),
    true,
    "renderer must fetch the exact main-owned catalog asset before proposing injection",
  );
  assert.equal(
    await page.evaluate(() => window.__qa.calls.some((call) => call.name === "agentFiles.write" && call.payload.path === "skills/qa-skill/SKILL.md")),
    false,
    "skill candidate must not write SKILL.md before explicit approval",
  );
  assert.equal(await page.getByText(/스킬 주입 완료|Skill injected/).count(), 0, "completion copy must not appear before approval");
  const beforeSkillApprove = await page.evaluate(() => window.__qa.calls.filter((call) => call.name === "agentEvolution.approveAndApply").length);
  await page.getByRole("button", { name: /검토 완료 · 승인 및 적용|Review complete · approve & apply/ }).click();
  await page.waitForFunction((before) => window.__qa.calls.filter((call) => call.name === "agentEvolution.approveAndApply").length > before, beforeSkillApprove);
  await page.getByText(/스킬 주입 완료|Skill injected/).waitFor();
  await page.getByRole("button", { name: /이 영수증으로 롤백|Rollback from this receipt/ }).click();
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "agentEvolution.rollback"));
  await page.getByText(/스킬 제거 롤백 완료|Skill removal rollback complete/).waitFor();

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
  // The chat now replaces the generic "running" label with the latest
  // main-owned progress status. Accept either legacy copy or the concrete
  // thinking/tool status, but never treat the invoke.run IPC call alone as UI
  // evidence that progress is visible.
  await page.getByText(
    /실행 중|전송 중|running|sending|Agentlas orchestrator started|Hub 에이전트 빌리는 중/i,
  ).first().waitFor({ timeout: 5000 });
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

  await page.locator('input[type="file"]').setInputFiles({
    name: "qa-too-large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  const attachmentAlert = page.locator('[data-chat-attachment-error="true"]');
  await attachmentAlert.waitFor();
  const alertMessage = await attachmentAlert.innerText();
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
      Object.defineProperty(dragover, "dataTransfer", { value: { dropEffect: "none", files: [file], types: ["Files"] } });
      footer.dispatchEvent(dragover);
      const event = new Event("drop", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "dataTransfer", { value: { files: [file], types: ["Files"] } });
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
    await page.getByRole("option", { name: /리서치 에이전트|Research Agent/ }).click();
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
  await page.getByRole("option", { name: /Founder HQ/ }).click();
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
  // 자동 라우팅 — 추천 토글 ON이면 시트 없이 즉시 라우팅·실행된다(codex hep-network 동작).
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "single",
    proofName: "chat-recommend-single-surface",
    assertCalls: (calls) => {
      assert.ok(calls.some((call) => call.name === "chats.switchAgent" && call.payload.agentId === "agent-1"));
      assert.ok(calls.some((call) => call.name === "invoke.run" && call.payload.userPrompt === "추천 단일 실행"));
    },
  });
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "network",
    proofName: "chat-recommend-network-surface",
    assertCalls: (calls) => {
      // 허브 고용 전에 크레딧 게이트가 잔액을 조회해야 한다(부족할 때만 페이월).
      assert.ok(calls.some((call) => call.name === "billing.getCredits"), "credit gate must check balance before hub hire");
      const call = calls.find((item) => item.name === "invoke.run");
      assert.deepEqual(call.payload.borrowAgents, ["no-ai-slop-copywriter", "security-reviewer"]);
      assert.equal(call.payload.userPrompt, "추천 네트워크 실행");
    },
  });
  await runRecommendChoice(browser, baseUrl, evidence, {
    mode: "pipeline",
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
  // 자동 라우팅 — 픽 시트 없이 곧바로 실행까지 간다.
  await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "invoke.run"));
  assert.equal(
    await page.getByRole("button", { name: /다른 에이전트 찾기|Find another agent/ }).count(),
    0,
    "auto routing must not show the manual pick sheet",
  );
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
  await page.getByRole("option", { name: /FDA SaMD 510\(k\)|Pre-market Notification/ }).waitFor();
  await page.locator(".portal-card-title", { hasText: /FDA SaMD 510\(k\)|Pre-market Notification/ }).waitFor();
  await page.screenshot({ path: path.join(outDir, "hub-live-autocomplete-surface.png"), fullPage: true });
  evidence.push({ name: "hub-live-autocomplete-surface", status: "pass", url: page.url() });
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
