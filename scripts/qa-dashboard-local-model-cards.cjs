#!/usr/bin/env node
/*
 * 대시보드 "로컬" 묶음 — 설치된 모델 미니 카드(한 행 두 장)를 실제로 띄워 잰다 (2026-09-13).
 *   node scripts/qa-dashboard-local-model-cards.cjs   (먼저 npm run build:renderer)
 * 검사: 설치 2개면 카드 2장이 같은 행(같은 y)에 놓이고, 사용 중인 카드엔 GPU 칩·마우스 안내가 있고,
 * 다른 카드엔 "사용" 단추가 있다. 설치 0개면 "로컬 모델 받기" 카드 하나. 두 언어.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = process.env.QSHEET_DIST || path.join(root, "dist", "renderer");
const outDir = process.env.QA_OUT || path.join(root, "private", "tmp", "qa-dashboard-local-models");
const catalog = require(path.join(root, "dist/electron/local-model-hub/catalog.js"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nested = pathname.match(/^\/.+\/(?:_next\/.+)$/);
  if (nested) pathname = `/${pathname.slice(pathname.indexOf("/_next/") + 1)}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname.replace(/^\//, ""));
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) { const html = path.join(distDir, `${pathname.replace(/^\//, "")}.html`); if (fs.existsSync(html)) return html; }
  return path.join(distDir, "404.html");
}
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const file = resolveAsset(request.url);
      if (!fs.existsSync(file)) { response.writeHead(404); response.end("not found"); return; }
      response.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function fixture(installedCount) {
  const engine = catalog.compatibleEnginePackage("darwin", "arm64").item;
  const models = catalog.localModelCatalog().slice(0, installedCount);
  const installations = models.map((model, index) => ({ schemaVersion: 1, installationId: `inst-0000-0000-0000-00000000000${index + 1}`, modelPackageId: model.packageId, repository: model.repository, revision: model.revision, fileName: model.fileName, fileSha256: model.sha256, quantization: model.quantization, enginePackageId: engine.packageId, installedAt: new Date().toISOString(), source: "download" }));
  const resident = installations[0] ? { schemaVersion: 1, receiptId: "r1", processEpoch: "epoch-0000-0000-0000-000000000001", installationId: installations[0].installationId, enginePackageId: engine.packageId, engineExecutableSha256: "0".repeat(64), endpoint: "http://127.0.0.1:1", contextTokens: 8192, state: "resident", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), reasonCode: null,
    acceleration: { evidence: "engine-log", backend: "metal", gpu: true, devices: [{ id: "MTL0", name: "Apple M4 Max", accelerator: "metal", gpu: true, memoryBytes: null, freeMemoryBytes: null }], offloadedLayers: 29, totalLayers: 29 } } : null;
  const hardware = { schemaVersion: 1, profileId: "hardware:qa", observedAt: new Date().toISOString(), platform: "darwin", arch: "arm64", cpuModel: "Apple M4 Max", logicalCpuCount: 16, totalMemoryBytes: 48 * 2 ** 30, availableMemoryBytes: 14 * 2 ** 30, memoryKind: "unified", accelerator: "metal", acceleratorEvidence: "engine-observed", vramBytes: 48 * 2 ** 30, diskAvailableBytes: 400 * 2 ** 30, engineDevices: [] };
  const engineInstallations = installations.length ? [{ schemaVersion: 1, receiptId: "engine-receipt-1", enginePackageId: engine.packageId, enginePackageSha256: engine.sha256, provenanceVerified: true, executableSha256: "0".repeat(64), executableRelativePath: engine.fileName, installedAt: new Date().toISOString() }] : [];
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), hardware, engineCatalog: catalog.localEngineCatalog(), modelCatalog: catalog.localModelCatalog(), engineProgress: [], modelProgress: [], downloadReceipts: [], engineInstallations, modelInstallations: installations, fitAssessments: [], loadReceipts: resident ? [resident] : [], capabilityReceipts: [], runReceipts: [], resident, unavailableReason: null };
}

async function run(browser, baseUrl, locale, installedCount) {
  const snapshot = fixture(installedCount);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  await context.addInitScript({ content: `(${setupMockAgentlasBridge.toString()})(${JSON.stringify(mockBridgeOptions({}))});
    window.localStorage.setItem("agentlas.locale",${JSON.stringify(locale)});window.localStorage.setItem("agentlas.onboarded","1");
    let snapshot = ${JSON.stringify(snapshot)};
    const residentTemplate = snapshot.resident;
    const storeHandlers = [];
    window.agentlasEvents.onStoreChanged = (handler) => { storeHandlers.push(handler); return () => { const index = storeHandlers.indexOf(handler); if (index >= 0) storeHandlers.splice(index, 1); }; };
    window.__qa.localModelToggleCalls = [];
    window.agentlas.localModelHub = Object.assign(window.agentlas.localModelHub || {}, {
      snapshot: async () => structuredClone(snapshot), operations: async () => [],
      unload: async (payload) => { window.__qa.localModelToggleCalls.push({ name: "unload", payload }); if (window.__qa.blockNextLocalUnload) { window.__qa.blockNextLocalUnload = false; throw new Error("local_model_runs_active"); } snapshot = { ...snapshot, resident: null }; storeHandlers.forEach((handler) => handler({ entity: "runtime" })); },
      loadModel: async (payload) => { window.__qa.localModelToggleCalls.push({ name: "loadModel", payload }); const installation = snapshot.modelInstallations.find((item) => item.installationId === payload.installationId); snapshot = { ...snapshot, resident: { ...residentTemplate, installationId: installation.installationId, processEpoch: "epoch-0000-0000-0000-000000000002" } }; storeHandlers.forEach((handler) => handler({ entity: "runtime" })); return snapshot.resident; },
    });
    const baseDetect = window.agentlas.runtime.detect;
    const localSelection = snapshot.modelInstallations[0] ? { kind: "agentlas-local", backend: "agentlas-local", source: "agentlas-local:" + snapshot.engineCatalog[0].packageId + ":" + snapshot.modelInstallations[0].installationId, model: snapshot.modelInstallations[0].fileName, role: "worker", inherit: false } : null;
    const orchestratorSelection = { kind: "codex", backend: "openai", source: "/usr/local/bin/codex", model: "gpt-5.1-codex", effort: "high", role: "orchestrator", inherit: false };
    const rolePool = { members: { orchestrator: [{ role: "orchestrator", position: 1, selection: orchestratorSelection, updatedAt: new Date().toISOString() }], worker: localSelection ? [{ role: "worker", position: 1, selection: localSelection, updatedAt: new Date().toISOString() }] : [] }, picks: { orchestrator: { role: "orchestrator", selection: orchestratorSelection, position: 1, inherited: false, skipped: [] }, worker: localSelection ? { role: "worker", selection: localSelection, position: 1, inherited: false, skipped: [] } : { role: "worker", selection: { ...orchestratorSelection, role: "worker", inherit: true }, position: 1, inherited: true, skipped: [] } } };
    window.agentlas.runtime = Object.assign(window.agentlas.runtime || {}, {
      listRoleMembers: async () => structuredClone(rolePool),
      detect: async () => { const base = (await baseDetect()).map((item) => ({ ...item, activeRoles: (item.activeRoles || []).filter((role) => role !== "worker") })); if (!snapshot.resident || !localSelection) return base; return [...base, { ...localSelection, version: snapshot.resident.enginePackageId, active: false, activeRoles: ["worker"], roleSelections: { worker: localSelection }, label: "Agentlas Local", availableModels: [localSelection.model], allocationModels: [localSelection.model], allocationModelProfiles: { [localSelection.model]: { contextWindow: snapshot.resident.contextTokens, capabilities: [], supportsTools: true, supportsMultimodal: false } }, effort: null, efforts: [] }]; },
    });
    window.agentlas.runtime = Object.assign(window.agentlas.runtime || {}, { setActive: async () => ({ ok: true }) });` });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
  const group = page.locator('.dashboard-engine-group:has(.dashboard-local-model-card)');
  await group.first().waitFor({ state: "visible", timeout: 30000 });
  const cards = page.locator(".dashboard-local-model-card");
  await cards.first().waitFor({ state: "visible" });
  const count = await cards.count();
  const boxes = [];
  for (let i = 0; i < count; i += 1) boxes.push(await cards.nth(i).boundingBox());
  const chip = page.locator(".dashboard-local-model-card [data-acceleration]");
  const chipTitle = (await chip.count()) ? await chip.first().getAttribute("title") : null;
  const useButtons = await page.locator(".dashboard-local-model-use").count();
  const names = await cards.locator(".dashboard-local-model-name").allInnerTexts();
  const legacy = await page.locator(".dashboard-engine-card-name", { hasText: "Agentlas Local" }).count();
  const groupCount = await group.first().locator(".dashboard-engine-group-count").innerText();
  const localSwitch = page.getByRole("switch", { name: locale === "ko" ? "로컬 모델 사용" : "Use local model" });
  await localSwitch.waitFor({ state: "visible" });
  const switchInitial = { checked: await localSwitch.getAttribute("aria-checked"), disabled: await localSwitch.isDisabled() };
  let switchAfterOff = null, switchAfterOn = null, blockedOff = null, toggleCalls = [], offWorkerBadge = null, onWorkerBadge = null;
  if (installedCount > 0) {
    await localSwitch.click();
    await page.waitForFunction(() => document.querySelector('.dashboard-local-runtime-switch')?.getAttribute('aria-checked') === 'false');
    switchAfterOff = { checked: await localSwitch.getAttribute("aria-checked"), status: await page.locator('.dashboard-local-runtime-toggle [role="status"]').innerText() };
    offWorkerBadge = await page.locator('[data-role="worker"] .dashboard-runtime-pool-badge').last().innerText();
    await localSwitch.click();
    await page.waitForFunction(() => document.querySelector('.dashboard-local-runtime-switch')?.getAttribute('aria-checked') === 'true');
    switchAfterOn = { checked: await localSwitch.getAttribute("aria-checked"), status: await page.locator('.dashboard-local-runtime-toggle [role="status"]').innerText() };
    onWorkerBadge = await page.locator('[data-role="worker"] .dashboard-runtime-pool-badge').last().innerText();
    await page.evaluate(() => { window.__qa.blockNextLocalUnload = true; });
    await localSwitch.click();
    await page.locator('.dashboard-runtime-message[data-tone="error"]').waitFor({ state: "visible" });
    blockedOff = { checked: await localSwitch.getAttribute("aria-checked"), message: await page.locator('.dashboard-runtime-message[data-tone="error"]').innerText() };
    toggleCalls = await page.evaluate(() => window.__qa.localModelToggleCalls);
  }
  fs.mkdirSync(outDir, { recursive: true });
  await group.first().scrollIntoViewIfNeeded();
  await group.first().screenshot({ path: path.join(outDir, `${locale}-${installedCount}.png`) });
  await page.locator(".dashboard-runtime-control").screenshot({ path: path.join(outDir, `${locale}-${installedCount}-runtime-toggle.png`) });
  await context.close();
  return { locale, installedCount, count, boxes, chipTitle, useButtons, names, legacy, groupCount, switchInitial, switchAfterOff, switchAfterOn, blockedOff, offWorkerBadge, onWorkerBadge, toggleCalls, errors };
}

async function main() {
  assert.ok(fs.existsSync(path.join(distDir, "dashboard.html")), "먼저 npm run build:renderer");
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const locale of ["ko", "en"]) for (const installed of [2, 0]) results.push(await run(browser, baseUrl, locale, installed));
  } finally { await browser.close(); server.close(); }
  for (const r of results) {
    assert.deepEqual(r.errors, [], `${r.locale}/${r.installedCount}: 페이지 오류 없음`);
    assert.equal(r.legacy, 0, "'Agentlas Local · 연결' 카드는 더 이상 없다");
    if (r.installedCount === 2) {
      assert.equal(r.count, 2, "설치 2개 → 카드 2장");
      assert.ok(Math.abs(r.boxes[0].y - r.boxes[1].y) < 2, "두 장이 같은 행에 놓인다");
      assert.ok(r.boxes[0].width > 200 && r.boxes[0].height < 80, "가로형 미니 카드");
      assert.match(r.chipTitle || "", /Apple M4 Max/, "사용 중 카드에 GPU 근거가 마우스 안내로");
      assert.equal(r.useButtons, 1, "나머지 카드엔 '사용' 단추 하나");
      assert.equal(r.groupCount, "1/2");
      assert.deepEqual(r.switchInitial, { checked: "true", disabled: false });
      assert.equal(r.switchAfterOff.checked, "false");
      assert.match(r.switchAfterOff.status, r.locale === "ko" ? /GPU와 메모리 해제됨/ : /GPU and memory released/);
      assert.equal(r.offWorkerBadge, r.locale === "ko" ? "꺼짐 · 건너뜀" : "Off · skipped");
      assert.equal(r.onWorkerBadge, r.locale === "ko" ? "기본 선택" : "Default");
      assert.equal(r.switchAfterOn.checked, "true");
      assert.equal(r.blockedOff.checked, "true", "작업 중이면 스위치는 켜진 상태를 유지한다");
      assert.match(r.blockedOff.message, r.locale === "ko" ? /작업 중이라 끄지 않았습니다/ : /is working, so it stayed on/);
      assert.deepEqual(r.toggleCalls.map((call) => call.name), ["unload", "loadModel", "unload"]);
      assert.equal(r.toggleCalls[0].payload.cancelActiveRuns, false, "끄기는 실행 중 작업을 강제 취소하지 않는다");
    } else {
      assert.equal(r.count, 1); assert.match(r.names[0], r.locale === "ko" ? /로컬 모델 받기/ : /Get a local model/);
      assert.equal(r.groupCount, "0/0");
      assert.deepEqual(r.switchInitial, { checked: "false", disabled: true });
    }
  }
  console.log(JSON.stringify({ ok: true, outDir, results: results.map(({ boxes, ...rest }) => rest) }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
