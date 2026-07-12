#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "settings-resilience");

function loadMultimodalCatalog() {
  const ts = require("typescript");
  const sourcePath = path.join(root, "shared", "multimodal.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: "multimodal.ts",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", outputText)(mod, mod.exports, require);
  return mod.exports.MULTIMODAL_PROVIDERS;
}

const MULTIMODAL_PROVIDERS = loadMultimodalCatalog();

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
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
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      res.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function installSettingsFixture(payload) {
  const setupBase = (0, eval)(`(${payload.setupSource})`);
  setupBase(payload.baseOptions);
  window.localStorage.setItem("agentlas.locale", "ko");

  const calls = { runtime: 0, key: 0, multimodalStatus: 0 };
  const mobileCalls = { status: 0, list: 0, issue: 0, retry: 0, revoke: 0 };
  let mobileDevices = [];
  let mobilePairingExpiryDelay = 60_000;
  let mobileBridgeChanged = null;
  const provider = {
    id: "qa-image-provider",
    modality: "image",
    label: "QA Image Provider",
    labelKo: "QA 이미지 프로바이더",
    mode: "api-key",
    defaultModel: "qa-image-1",
    envKeys: [],
    setupUrl: "https://example.invalid/setup",
    docsUrl: "https://example.invalid/docs",
    billing: "paid-api",
    summary: "Provider used by the settings resilience test.",
    summaryKo: "설정 복원력 테스트용 프로바이더입니다.",
  };

  window.__settingsResilienceQa = {
    calls,
    mobileCalls,
    pairMobileDevice() {
      mobileDevices = [{
        deviceId: "device_1234567890abcdef1234567890abcdef",
        name: "QA iPhone",
        platform: "ios",
        appVersion: "1.0.0",
        issuedAt: new Date().toISOString(),
        revokedAt: null,
      }];
      mobileBridgeChanged?.({ reason: "device-paired" });
    },
    expireNextPairingQuickly() {
      mobilePairingExpiryDelay = 120;
    },
  };
  window.agentlas.mobileBridge = {
    status: async () => {
      mobileCalls.status += 1;
      return {
        running: true,
        endpoint: "wss://192.168.1.42:43123/v1/mobile",
        secure: true,
        hostId: "host_1234567890abcdef1234567890abcdef",
        devices: [...mobileDevices],
        error: null,
      };
    },
    listDevices: async () => {
      mobileCalls.list += 1;
      return [...mobileDevices];
    },
    issuePairing: async () => {
      mobileCalls.issue += 1;
      return {
        version: 1,
        hostId: "host_1234567890abcdef1234567890abcdef",
        displayName: "QA Desktop",
        endpoint: "wss://192.168.1.42:43123/v1/mobile",
        pairExchangeEndpoint: "https://192.168.1.42:43123/v1/mobile/pair/exchange",
        code: "A".repeat(22),
        expiresAt: new Date(Date.now() + mobilePairingExpiryDelay).toISOString(),
        certificateFingerprint: "a".repeat(64),
        certificateDer: "TUlJQg==",
      };
    },
    retry: async () => {
      mobileCalls.retry += 1;
      return {
        running: true,
        endpoint: "wss://192.168.1.42:43123/v1/mobile",
        secure: true,
        hostId: "host_1234567890abcdef1234567890abcdef",
        devices: [...mobileDevices],
        error: null,
      };
    },
    revokeDevice: async () => {
      mobileCalls.revoke += 1;
      return { ok: true };
    },
  };
  window.agentlasEvents.onMobileBridgeChanged = (handler) => {
    mobileBridgeChanged = handler;
    return () => {
      if (mobileBridgeChanged === handler) mobileBridgeChanged = null;
    };
  };
  window.agentlas.app.getVersion = async () => "9.9.9";
  window.agentlas.runtime.detect = async () => {
    calls.runtime += 1;
    return [{
      kind: "ollama",
      backend: "ollama",
      source: "ollama",
      version: "8.8.8",
      active: true,
      model: "qa-model",
      availableModels: ["qa-model"],
    }];
  };
  window.agentlas.secrets.hasApiKey = async (backend) => {
    calls.key += 1;
    return backend === "openai";
  };
  window.agentlas.config.getCustomBaseUrl = async () => "https://qa.example/v1";
  window.agentlas.multimodal.listProviders = async () => [provider, ...payload.catalogProviders];
  window.agentlas.multimodal.getSettings = async () => ({
    imageProvider: provider.id,
    videoProvider: "auto",
    audioProvider: "auto",
  });
  window.agentlas.multimodal.status = async () => {
    calls.multimodalStatus += 1;
    if (calls.multimodalStatus === 1) throw new Error("QA multimodal status outage");
    return [{ modality: "image", provider, env: [], ready: true }];
  };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "settings.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(installSettingsFixture, {
      setupSource: setupMockAgentlasBridge.toString(),
      baseOptions: mockBridgeOptions(),
      catalogProviders: MULTIMODAL_PROVIDERS,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });

    await page.goto(`${baseUrl}/settings.html`, { waitUntil: "domcontentloaded" });
    const multimodalError = page.getByTestId("settings-multimodal-error");
    await multimodalError.waitFor();

    // multimodal.status 실패와 무관하게 다른 도메인의 실제 결과가 화면에 정착해야 한다.
    await page.getByText("Ollama v8.8.8", { exact: false }).waitFor();
    await page.getByText("QA 이미지 프로바이더", { exact: true }).waitFor();
    await page.getByText("Grok CLI 이미지 (Imagine)", { exact: true }).waitFor();
    await page.getByText("Grok CLI 영상 (Imagine)", { exact: true }).waitFor();
    await page.getByText("버전 및 업데이트", { exact: true }).waitFor();
    await page.getByText("v9.9.9", { exact: true }).waitFor();
    assert.equal(await page.getByText("저장됨", { exact: true }).count(), 1, "OpenAI key state must survive the multimodal failure");
    assert.match(await multimodalError.innerText(), /다른 설정은 그대로 사용할 수 있습니다/);

    await multimodalError.getByRole("button", { name: "다시 시도" }).click();
    await multimodalError.waitFor({ state: "detached" });
    assert.deepEqual(
      await page.evaluate(() => window.__settingsResilienceQa.calls),
      { runtime: 1, key: 8, multimodalStatus: 2 },
      "Retry must refresh only the multimodal domain",
    );
    assert.equal(await page.getByText("QA 이미지 프로바이더", { exact: true }).count(), 1);
    await page.getByTestId("mobile-bridge-retry").click();
    await page.getByText("모바일 연결을 다시 열었습니다.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.__settingsResilienceQa.mobileCalls.retry),
      1,
      "Desktop retry must be exposed as a deliberate Settings action",
    );
    const pairButton = page.getByRole("button", { name: "새 기기 연결" });
    await pairButton.click();
    const pairingCard = page.getByTestId("mobile-bridge-pairing");
    await pairingCard.waitFor();
    await page.evaluate(() => window.__settingsResilienceQa.pairMobileDevice());
    await pairingCard.waitFor({ state: "detached" });
    await page.getByText("QA iPhone", { exact: true }).waitFor();
    assert.match(await page.getByTestId("mobile-bridge-device-count").innerText(), /연결된 모바일 1대/);
    assert.equal(
      await page.getByText("새 모바일 기기가 연결됐습니다.", { exact: true }).count(),
      1,
      "pair exchange event must clear the consumed QR and refresh the device list",
    );

    await page.evaluate(() => window.__settingsResilienceQa.expireNextPairingQuickly());
    await pairButton.click();
    await pairingCard.waitFor();
    await pairingCard.waitFor({ state: "detached" });
    assert.equal(
      await page.getByText("연결 QR이 만료됐습니다. 새 QR을 만들어 주세요.", { exact: true }).count(),
      1,
      "expired QR must not remain copyable or appear usable",
    );
    assert.deepEqual(errors, [], `settings resilience UI emitted errors: ${errors.join("\n")}`);
    await page.screenshot({ path: path.join(outDir, "multimodal-recovered.png"), fullPage: true });
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(`test-settings-resilience-ui: PASS (${outDir})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
