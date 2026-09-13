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
    const hfModels = (query) => [
      { repository: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", author: "unsloth", gated: false, tags: ["text-generation"], downloads: 120000, license: "apache-2.0" },
      { repository: "bartowski/Llama-3.1-8B-Instruct-GGUF", author: "bartowski", gated: false, tags: ["text-generation"], downloads: 90000, license: "llama3.1" },
      { repository: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", author: "ggml-org", gated: false, tags: ["image-text-to-text"], downloads: 40000, license: "apache-2.0" },
    ].filter((m) => !query || m.repository.toLowerCase().includes(query.toLowerCase()));
    window.__hfSearchCalls = [];
    window.agentlas.localModelHub = { snapshot: async () => snapshot, operations: async () => [],
      searchModels: async ({ query }) => { window.__hfSearchCalls.push(query); await new Promise((r) => setTimeout(r, 400)); return { models: hfModels(query), syncedAt: new Date().toISOString(), source: "live", stale: false }; },
      inspectRepository: async ({ repository }) => ({ repository, revision: "a".repeat(40), publisher: repository.split("/")[0], creator: null, converter: null, architecture: "llama", license: "apache-2.0", gated: false,
        files: [{ fileName: "model-Q4_K_M.gguf", byteLength: 4.9 * 2 ** 30, sha256: "b".repeat(64), quantization: "Q4_K_M", downloadable: true, reasonCodes: [] }, { fileName: "model-Q8_0.gguf", byteLength: 8.5 * 2 ** 30, sha256: "c".repeat(64), quantization: "Q8_0", downloadable: true, reasonCodes: [] }],
        reasonCodes: [], syncedAt: new Date().toISOString(), source: "live", stale: false }),
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
  const table = page.locator("[data-hf-table]");
  await table.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-hf-table] tbody tr").length >= 6, null, { timeout: 10000 });
  const recommendedCards = await page.locator("[data-hf-table] tbody tr[data-curated=true]").count();
  const recommendedButtons = await page.locator("[data-hf-table] tbody tr[data-curated=true] button").allInnerTexts();
  const sourceTitle = "table";
  const fitLevels = await page.locator("[data-hf-table] tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-fit")));
  const fitTitles = await page.locator("[data-hf-table] tbody td:nth-child(5) span").evaluateAll((els) => els.map((el) => el.getAttribute("title") || ""));
  const roles = await page.locator("[data-hf-table] tbody td:nth-child(2) span").allInnerTexts();
  // 검색 중에도 표가 비지 않는다: 글자를 치고 400ms 로딩 동안 이전 행이 남아 있어야 한다.
  const input = page.getByRole("textbox", { name: ko ? "Hugging Face 모델 검색" : "Search Hugging Face models" });
  await input.click(); await input.type("qwen");
  await page.waitForTimeout(350);
  const rowsWhileLoading = await page.locator("[data-hf-table] tbody tr").count();
  const focusedWhileLoading = await input.evaluate((el) => document.activeElement === el);
  await page.waitForFunction(() => document.querySelectorAll("[data-hf-table] tbody tr").length === 2, null, { timeout: 10000 });
  const rowsAfterSearch = await page.locator("[data-hf-table] tbody tr").count();
  await input.fill(""); await page.waitForFunction(() => document.querySelectorAll("[data-hf-table] tbody tr").length >= 6, null, { timeout: 10000 });
  // 필터: 이미지 역할만
  await page.locator('[data-filter-role="vision"]').click();
  const visionRows = await page.locator("[data-hf-table] tbody tr").count();
  await page.locator('[data-filter-role="all"]').click();
  // 팝업: HF 행의 다운로드 → 파일 표
  await page.locator('[data-hf-repository="bartowski/Llama-3.1-8B-Instruct-GGUF"] button').click();
  await page.locator("[data-hf-files]").waitFor({ state: "visible", timeout: 10000 });
  const popupFiles = await page.locator("[data-hf-files] tbody tr").count();
  const popupFits = await page.locator("[data-hf-files] tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-fit")));
  await page.screenshot({ path: path.join(outDir, `${locale}-${mode}-popup.png`) });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(outDir, `${locale}-${mode}-explore.png`) });
  await context.close();
  return { locale, mode, chipState, chipText, chipTitle, deviceText, deviceTitle, sourceTitle, libraryCards, libraryLabels, recommendedCards, recommendedButtons, fitLevels, fitTitles, roles, rowsWhileLoading, focusedWhileLoading, rowsAfterSearch, visionRows, popupFiles, popupFits, errors };
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
    assert.ok(result.fitLevels.every((level) => ["smooth", "caution", "risky", "unknown"].includes(level)), "모든 행에 추천 판정");
    assert.ok(result.fitTitles.every((title) => title.length > 10), "추천 칩마다 마우스 안내(근거)");
    assert.ok(result.roles.includes(result.locale === "ko" ? "이미지" : "Vision") && result.roles.includes(result.locale === "ko" ? "코딩" : "Coding"), "역할 열이 이름·태그에서 분류된다");
    assert.ok(result.rowsWhileLoading >= 6, `검색 중에도 이전 행이 남는다(${result.rowsWhileLoading})`);
    assert.equal(result.focusedWhileLoading, true, "검색 중 입력창 초점이 유지된다");
    assert.equal(result.rowsAfterSearch, 2, "검색 결과로 바뀐다(qwen 2건, 추천은 검색 중 숨김)");
    assert.equal(result.visionRows, 1, "이미지 필터 → 1행");
    assert.equal(result.popupFiles, 2, "팝업에 파일 2행");
    assert.ok(result.popupFits.every((level) => level === (result.mode === "gpu" ? "smooth" : "caution")), `48GiB 기계에서 4.9/8.5GiB 파일은 GPU 면 원활, GPU 없으면 주의 (${result.popupFits})`);
    assert.equal(result.libraryCards, 1, "내 모델에는 설치된 모델만(픽스처 1개)");
    assert.ok(result.libraryLabels.every((label) => !/다운로드 가능|Available to download/.test(label)), "내 모델에 '다운로드 가능' 줄이 없다");
    assert.equal(result.recommendedCards, 3, "표 위쪽에 설치 안 된 내장 모델 3행");
    assert.ok(result.recommendedButtons.every((text) => /다운로드|Download/.test(text)), "추천 행마다 다운로드 단추");
    // 화면 글자는 짧고, 설명은 마우스 안내에만 있다.
    assert.ok(result.chipText.length <= 3 && result.chipTitle.length > result.chipText.length);
  }
  console.log(JSON.stringify({ ok: true, outDir, results }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
