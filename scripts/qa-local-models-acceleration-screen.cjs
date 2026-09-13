#!/usr/bin/env node
/*
 * 로컬 모델 화면 — 가속 표식·장치 줄·Hugging Face 출처 안내를 실제로 띄워 잰다 (2026-09-13).
 * dist/renderer 정적 빌드 + 가짜 브리지 + playwright chromium. Electron·dev 서버 불필요.
 *   node scripts/qa-local-models-acceleration-screen.cjs   (먼저 npm run build:renderer)
 * 검사: 로드된 모델 줄에 GPU 칩이 뜨고 마우스를 올리면 장치·층 수가 보인다, 컴퓨터 메뉴에 엔진이
 * 보고한 GPU 가 한 줄로 보인다, 출처 표기에 "조회만·복제 없음" 안내가 걸려 있다. 두 언어.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = process.env.QSHEET_DIST || path.join(root, "dist", "renderer");
const outDir = process.env.QA_OUT || path.join(root, "private", "tmp", "qa-local-models-acceleration");
const catalog = require(path.join(root, "dist/electron/local-model-hub/catalog.js"));
const hardwareModule = require(path.join(root, "dist/electron/local-model-hub/hardware.js"));
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

function snapshotFixture(mode) {
  const engine = catalog.compatibleEnginePackage("darwin", "arm64").item;
  const models = catalog.localModelCatalog();
  const model = models[0];
  const devices = mode === "gpu"
    ? [{ id: "MTL0", name: "Apple M4 Max", accelerator: "metal", gpu: true, memoryBytes: 38338 * 1048576, freeMemoryBytes: 38338 * 1048576 }, { id: "BLAS", name: "Accelerate", accelerator: "cpu", gpu: false, memoryBytes: 0, freeMemoryBytes: 0 }]
    : [{ id: "BLAS", name: "OpenBLAS", accelerator: "cpu", gpu: false, memoryBytes: 0, freeMemoryBytes: 0 }];
  const hardware = { schemaVersion: 1, profileId: "hardware:qa", observedAt: new Date().toISOString(), platform: "darwin", arch: "arm64", cpuModel: "Apple M4 Max", logicalCpuCount: 16,
    totalMemoryBytes: 48 * 2 ** 30, availableMemoryBytes: 14 * 2 ** 30, memoryKind: "unified", accelerator: mode === "gpu" ? "metal" : "unknown",
    acceleratorEvidence: mode === "gpu" ? "engine-observed" : "not-observed", vramBytes: mode === "gpu" ? 48 * 2 ** 30 : null, diskAvailableBytes: 400 * 2 ** 30, engineDevices: devices };
  const installation = { schemaVersion: 1, installationId: "inst-0000-0000-0000-000000000001", modelPackageId: model.packageId, repository: model.repository, revision: model.revision, fileName: model.fileName, fileSha256: model.sha256, quantization: model.quantization, enginePackageId: engine.packageId, installedAt: new Date().toISOString(), source: "download" };
  const resident = { schemaVersion: 1, receiptId: "r1", processEpoch: "epoch-0000-0000-0000-000000000001", installationId: installation.installationId, enginePackageId: engine.packageId, engineExecutableSha256: "0".repeat(64), endpoint: "http://127.0.0.1:1", contextTokens: 8192, state: "resident", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), reasonCode: null,
    acceleration: mode === "gpu" ? { evidence: "engine-log", backend: "metal", gpu: true, devices: [devices[0]], offloadedLayers: 29, totalLayers: 29 } : { evidence: "engine-log", backend: "cpu", gpu: false, devices: [], offloadedLayers: 0, totalLayers: 29 } };
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), hardware, engineCatalog: catalog.localEngineCatalog(), modelCatalog: models, engineProgress: [], modelProgress: [], downloadReceipts: [],
    engineInstallations: [{ schemaVersion: 1, receiptId: "e1", enginePackageId: engine.packageId, enginePackageSha256: engine.sha256, provenanceVerified: true, executableSha256: "0".repeat(64), executableRelativePath: "llama-b10903/llama-server", devices, installedAt: new Date().toISOString() }],
    modelInstallations: [installation], fitAssessments: models.map((row) => hardwareModule.estimateLocalModelFit(hardware, row)), loadReceipts: [resident], capabilityReceipts: [], runReceipts: [], resident, unavailableReason: null };
}

async function run(browser, baseUrl, locale, mode) {
  const snapshot = snapshotFixture(mode);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  await context.addInitScript({ content: `(${setupMockAgentlasBridge.toString()})(${JSON.stringify(mockBridgeOptions({}))});
    window.localStorage.setItem("agentlas.locale",${JSON.stringify(locale)});window.localStorage.setItem("agentlas.onboarded","1");
    const snapshot = ${JSON.stringify(snapshot)};
    window.agentlas.localModelHub = { snapshot: async () => snapshot, operations: async () => [],
      searchModels: async () => ({ models: [], syncedAt: new Date().toISOString(), source: "live", stale: false }),
      inspectRepository: async () => ({ repository: "x/y", revision: null, publisher: null, creator: null, converter: null, architecture: null, license: null, gated: "unknown", files: [], reasonCodes: [], syncedAt: null, source: "cache", stale: true }),
      addModel: async () => { throw new Error("qa"); }, installEnginePackage: async () => { throw new Error("qa"); }, installModelPackage: async () => { throw new Error("qa"); },
      downloadEngine: async () => { throw new Error("qa"); }, downloadModel: async () => { throw new Error("qa"); }, cancelOperation: async () => ({ cancelled: false }),
      importModel: async () => null, installEngine: async () => { throw new Error("qa"); }, installDownloadedModel: async () => { throw new Error("qa"); },
      loadModel: async () => snapshot.resident, unload: async () => {}, testCapabilities: async () => { throw new Error("qa"); } };
    window.agentlas.runtime = Object.assign(window.agentlas.runtime || {}, { setActive: async () => ({ ok: true }) });` });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/local-models.html`, { waitUntil: "domcontentloaded" });
  const ko = locale === "ko";
  await page.getByRole("button", { name: ko ? "내 모델" : "My models" }).click();
  const chip = page.locator("[data-acceleration]");
  await chip.waitFor({ state: "visible", timeout: 20000 });
  const chipState = await chip.getAttribute("data-acceleration");
  const chipTitle = await chip.getAttribute("title");
  const chipText = (await chip.innerText()).trim();
  await chip.hover();
  const box = await chip.boundingBox();
  assert.ok(box && box.width > 20 && box.height > 12, "칩이 보이는 크기여야 한다");
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${locale}-${mode}-resident.png`), clip: { x: 280, y: 180, width: 980, height: 420 } });
  await page.getByRole("button", { name: ko ? "컴퓨터와 실행 엔진" : "Computer and engine" }).click();
  const device = page.locator("[data-engine-device]");
  await device.waitFor({ state: "visible", timeout: 5000 });
  const deviceText = (await device.innerText()).trim();
  const deviceTitle = await device.getAttribute("title");
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${locale}-${mode}-library.png`) });
  await page.keyboard.press("Escape");
  // "내 모델" 에는 설치된 것만(픽스처: 1개) — 받을 수 있는 추천 모델은 여기 없어야 한다.
  const libraryCards = await page.locator("[data-model-package]").count();
  const libraryLabels = await page.locator("[data-model-package] small").allInnerTexts();
  await page.getByRole("button", { name: ko ? "탐색" : "Explore" }).click();
  const sourceTitle = await page.locator("section[aria-label] >> text=/GGUF/").first().getAttribute("title");
  await page.locator("[data-recommended-models]").waitFor({ state: "visible", timeout: 10000 });
  const recommendedCards = await page.locator("[data-recommended-package]").count();
  const recommendedButtons = await page.locator("[data-recommended-package] button").allInnerTexts();
  await page.screenshot({ path: path.join(outDir, `${locale}-${mode}-explore.png`) });
  await context.close();
  return { locale, mode, chipState, chipText, chipTitle, deviceText, deviceTitle, sourceTitle, libraryCards, libraryLabels, recommendedCards, recommendedButtons, errors };
}

async function main() {
  assert.ok(fs.existsSync(path.join(distDir, "local-models.html")), "먼저 npm run build:renderer");
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const locale of ["ko", "en"]) for (const mode of ["gpu", "cpu"]) results.push(await run(browser, baseUrl, locale, mode));
  } finally { await browser.close(); server.close(); }
  for (const result of results) {
    assert.deepEqual(result.errors, [], `${result.locale}/${result.mode}: 페이지 오류 없음`);
    if (result.mode === "gpu") {
      assert.equal(result.chipState, "gpu"); assert.equal(result.chipText, "GPU");
      assert.match(result.chipTitle, /Apple M4 Max/); assert.match(result.chipTitle, /29\/29/);
      assert.match(result.deviceText, /GPU · Apple M4 Max/);
    } else {
      assert.equal(result.chipState, "cpu"); assert.equal(result.chipText, "CPU");
      assert.match(result.chipTitle, result.locale === "ko" ? /CPU 실행/ : /Running on CPU/);
      assert.match(result.deviceText, result.locale === "ko" ? /GPU 없음/ : /No GPU/);
    }
    assert.ok(result.deviceTitle && result.deviceTitle.length > 10, "장치 줄에 마우스 안내가 있어야 한다");
    assert.match(result.sourceTitle || "", result.locale === "ko" ? /복제·재배포하지 않으며/ : /Nothing is mirrored/);
    assert.equal(result.libraryCards, 1, "내 모델에는 설치된 모델만(픽스처 1개)");
    assert.ok(result.libraryLabels.every((label) => !/다운로드 가능|Available to download/.test(label)), "내 모델에 '다운로드 가능' 줄이 없다");
    assert.equal(result.recommendedCards, 3, "탐색 위 추천에는 설치 안 된 내장 모델 3개");
    assert.ok(result.recommendedButtons.every((text) => /다운로드|Download/.test(text)), "추천 카드마다 다운로드 단추");
    // 화면 글자는 짧고, 설명은 마우스 안내에만 있다.
    assert.ok(result.chipText.length <= 3 && result.chipTitle.length > result.chipText.length);
  }
  console.log(JSON.stringify({ ok: true, outDir, results }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
