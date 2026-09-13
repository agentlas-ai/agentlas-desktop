#!/usr/bin/env node
/*
 * 로컬 모델이 제품 도구(Agentlas Browser · Computer Use)를 실제로 부르는지 — 격리 앱에서 완주 실측 (2026-09-13).
 *   npm run build:renderer && node scripts/qa-local-model-drives-product-tools-electron.cjs
 * 격리 userData + 5종 격리 env 로 dev Electron 을 띄우고, 엔진·Qwen3-4B 를 실제로 설치·로드해 실행 모델로
 * 고른 뒤 Work 채팅에 과제를 보낸다. 실행 이벤트에서 tool-use 를 모아 어떤 도구가 실제로 불렸는지 기록한다.
 * 결과 JSON 과 캡처는 private/tmp/qa-local-model-product-tools/ 에.
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "private", "tmp", "qa-local-model-product-tools");
const MODEL = process.env.QA_LOCAL_MODEL || "hf:Qwen/Qwen3-4B-GGUF@bc640142c66e1fdd12af0bd68f40445458f3869b:Q4_K_M";
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

// toolMode: 사용자가 채팅에서 고르는 도구 모드와 같다. "auto" 는 도구 필요 판단을 연결된 모델(여기서는 4B)이 한다.
const TASKS = [
  { name: "browser-auto", prompt: "Agentlas 브라우저로 https://example.com 을 열고, 페이지 제목이 무엇인지 알려줘.", toolMode: "auto" },
  { name: "browser-mode", prompt: "https://example.com 을 열고, 페이지 제목이 무엇인지 알려줘.", toolMode: "browser" },
  { name: "computer-mode", prompt: "지금 내 컴퓨터 화면을 스크린샷으로 찍어서 무엇이 보이는지 한 줄로 말해줘.", toolMode: "computer-use" },
  { name: "file", prompt: "이 프로젝트 폴더에 hello.txt 파일을 만들고 안에 hi 라고 적어줘.", toolMode: "auto" },
];

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error("먼저 npm run build:renderer");
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-local-tools-"));
  const userData = path.join(scratch, "userData"); fs.mkdirSync(userData);
  const project = path.join(scratch, "project"); fs.mkdirSync(project);
  // 격리: HOME 을 스크래치로 — 프로젝트 없는 채팅의 작업 폴더가 홈이 되어 오너 홈에 파일이 생겼다(실측 hello.txt).
  const home = path.join(scratch, "home"); fs.mkdirSync(home);
  const desktop = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root, timeout: 90_000,
    env: {
      ...process.env,
      HOME: home,
      AGENTLAS_E2E: "1", AGENTLAS_E2E_AUTH: "1", NODE_ENV: "development",
      ELECTRON_START_URL: `${baseUrl}/one`, ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      AGENTLAS_QA_USER_DATA_DIR: userData, AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
      AGENTLAS_STORE_PATH: path.join(scratch, "qa-store.sqlite"),
      AGENTLAS_ONE_DIR: path.join(scratch, "qa-one-dir"),
      AGENTLAS_ONE_WORKSPACE_ROOT: path.join(scratch, "qa-one-ws"),
      AGENTLAS_COMPUTER_HISTORY_ROOT: path.join(scratch, "qa-ch"),
      AGENTLAS_NETWORKING_HOME: path.join(scratch, "qa-net"),
    },
  });
  const stdio = fs.createWriteStream(path.join(outDir, "electron.log"));
  desktop.process().stdout?.on("data", (chunk) => stdio.write(chunk));
  desktop.process().stderr?.on("data", (chunk) => stdio.write(chunk));
  const page = await desktop.firstWindow({ timeout: 90_000 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForURL((url) => url.pathname === "/one", { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.agentlas?.localModelHub), null, { timeout: 90_000 });
  // 첫 화면이 자리 잡기 전의 IPC 는 신뢰 창 검사에 걸린다(실측: 곧바로 부르면 untrusted-site-publish-ipc-sender).
  await page.waitForTimeout(3000);
  const report = { model: MODEL, steps: {}, tasks: [] };
  const t0 = Date.now();

  // 1. 엔진 + 모델 설치 → 로드 → 실행 모델로 선택 (제품과 같은 IPC 경로).
  const install = await page.evaluate(async (model) => {
    const api = window.agentlas;
    const snapshot = await api.localModelHub.snapshot();
    const engine = snapshot.engineCatalog.find((row) => row.platform === snapshot.hardware.platform && row.arch === snapshot.hardware.arch);
    const [engineReceipt, modelReceipt] = await Promise.all([
      api.localModelHub.installEnginePackage({ packageId: engine.packageId, operationId: crypto.randomUUID() }),
      api.localModelHub.installModelPackage({ packageId: model, operationId: crypto.randomUUID() }),
    ]);
    const load = await api.localModelHub.loadModel({ installationId: modelReceipt.installationId, contextTokens: 0, operationId: crypto.randomUUID() });
    if (load.state !== "resident") throw new Error(`load: ${load.reasonCode}`);
    await api.runtime.setActive({ kind: "agentlas-local", backend: "agentlas-local", source: `agentlas-local:${load.enginePackageId}:${load.installationId}`, model: modelReceipt.fileName });
    const runtimes = await api.runtime.detect();
    return { contextTokens: load.contextTokens, engineDevices: engineReceipt.devices, acceleration: load.acceleration, activeRuntime: runtimes.find((r) => r.active)?.kind ?? null, localRuntimeSeen: runtimes.some((r) => r.kind === "agentlas-local") };
  }, MODEL);
  report.steps.install = { ...install, ms: Date.now() - t0 };
  console.log("[install]", JSON.stringify(install));
  report.steps.installedTools = await page.evaluate(async () => (await window.agentlas.mcpTools.listInstalled()).map((row) => ({ id: row.id, catalogId: row.catalogId ?? null, enabled: row.enabled, state: row.state ?? null, configurationValid: row.configurationValid ?? null })));
  console.log("[tools]", JSON.stringify(report.steps.installedTools));

  // 2. 과제마다 새 Work 채팅 → 실행 → 이벤트 수집.
  const only = (process.env.QA_TASKS || "").split(",").filter(Boolean);
  for (const task of TASKS.filter((row) => !only.length || only.includes(row.name))) {
    const started = Date.now();
    const result = await page.evaluate(async ({ prompt, toolMode }) => {
      const api = window.agentlas;
      const chat = await api.chats.create({ title: `로컬 모델 도구 실측 · ${prompt.slice(0, 12)}`, taskMode: "task", originSurface: "work" });
      // Work 화면이 채팅을 열 때 하는 일: 이 창을 그 채팅의 브라우저 주인으로 묶는다(없으면 native-browser-task-unbound).
      await api.workLiveView.listTabs({ taskScopeId: chat.id }).catch(() => undefined);
      const runId = crypto.randomUUID();
      const events = [];
      const unsubscribe = window.agentlasEvents.on(api.invoke.eventChannel(runId), (event) => {
        if (["tool-use", "error", "notice", "final", "lifecycle"].includes(event.kind)) events.push(JSON.parse(JSON.stringify(event)));
      });
      await api.invoke.run({ runId, chatId: chat.id, userPrompt: prompt, images: [], locale: "ko", permissions: "full", toolMode, runtimeSelection: undefined });
      const deadline = Date.now() + 240_000;
      let receipt = null;
      while (Date.now() < deadline) {
        receipt = await api.invoke.latestReceipt(chat.id);
        if (receipt && ["completed", "failed", "cancelled", "interrupted"].includes(receipt.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      unsubscribe();
      const history = await api.invoke.history(chat.id);
      return { chatId: chat.id, receiptStatus: receipt?.status ?? "timeout", receipt: receipt ? JSON.parse(JSON.stringify(receipt)) : null, events, history: history.map((entry) => ({ role: entry.role, text: String(entry.text ?? "").slice(0, 300) })) };
    }, { prompt: task.prompt, toolMode: task.toolMode });
    const toolUses = result.events.filter((event) => event.kind === "tool-use");
    const summary = {
      name: task.name, prompt: task.prompt, status: result.receiptStatus, ms: Date.now() - started,
      toolUses: toolUses.map((event) => ({ tool: event.tool?.name ?? event.toolName ?? event.name ?? null, server: event.tool?.server ?? event.server ?? null, ok: event.tool?.ok ?? event.ok ?? null, raw: JSON.stringify(event).slice(0, 400) })),
      errors: result.events.filter((event) => event.kind === "error").map((event) => JSON.stringify(event).slice(0, 300)),
      notices: result.events.filter((event) => event.kind === "notice").map((event) => JSON.stringify(event).slice(0, 300)),
      finals: result.events.filter((event) => event.kind === "final").map((event) => JSON.stringify(event).slice(0, 300)),
      assistant: result.history.filter((entry) => entry.role === "assistant").at(-1)?.text ?? "",
      historyRoles: result.history.map((entry) => entry.role),
    };
    report.tasks.push(summary);
    console.log(`[${task.name}] ${summary.status} ${summary.ms}ms tools=${summary.toolUses.map((t) => t.tool).join(",")} | ${summary.assistant.slice(0, 120).replace(/\n/g, " ")}`);
    try {
      await page.goto(`${baseUrl}/workspace/task?id=${encodeURIComponent(result.chatId)}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(outDir, `${task.name}.png`) });
    } catch (error) { summary.screenshotError = String(error).slice(0, 200); }
    if (task.name === "file") { const found = [project, home].map((dir) => path.join(dir, "hello.txt")).find((file) => fs.existsSync(file)); summary.fileCreated = found ? `${found}: ${fs.readFileSync(found, "utf8").slice(0, 40)}` : null; }
  }
  report.pageErrors = pageErrors.slice(0, 10);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, scratch }, null, 2));
  try { await page.evaluate(async () => { const s = await window.agentlas.localModelHub.snapshot(); if (s.resident) await window.agentlas.localModelHub.unload({ processEpoch: s.resident.processEpoch, cancelActiveRuns: true }); }); } catch { /* best effort */ }
  try { await desktop.close(); } catch { /* best effort */ }
  server.close();
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
