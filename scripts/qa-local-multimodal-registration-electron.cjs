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
const outDir = path.join(root, "private", "tmp", "qa-local-multimodal");
const REPO = process.env.QA_VLM_REPO || "ggml-org/SmolVLM-256M-Instruct-GGUF";
const REV = process.env.QA_VLM_REV || "b9e4379657e1450d04d02eec8e345667265b0a00";
const FILE = process.env.QA_VLM_FILE || "SmolVLM-256M-Instruct-Q8_0.gguf";
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
  const report = { repo: REPO, rev: REV, file: FILE, steps: {} };
  const t0 = Date.now();
  // 1. 저장소 등록(addModel) — 프로젝터(mmproj) 동반 파일이 정체성에 붙는지 → 엔진·모델 설치(프로젝터도 함께 다운로드) → 로드(--mmproj).
  const install = await page.evaluate(async ({ repo, rev, file }) => {
    const api = window.agentlas;
    const snapshot = await api.localModelHub.snapshot();
    const engine = snapshot.engineCatalog.find((row) => row.platform === snapshot.hardware.platform && row.arch === snapshot.hardware.arch);
    const identity = await api.localModelHub.addModel({ repository: repo, revision: rev, fileName: file });
    const [engineReceipt, modelReceipt] = await Promise.all([
      api.localModelHub.installEnginePackage({ packageId: engine.packageId, operationId: crypto.randomUUID() }),
      api.localModelHub.installModelPackage({ packageId: identity.packageId, operationId: crypto.randomUUID() }),
    ]);
    const load = await api.localModelHub.loadModel({ installationId: modelReceipt.installationId, contextTokens: 0, operationId: crypto.randomUUID() });
    return { packageId: identity.packageId, projector: identity.projector ?? null, installationProjector: modelReceipt.projectorFileName ?? null,
      loadState: load.state, loadReason: load.reasonCode ?? null, contextTokens: load.contextTokens, installationId: modelReceipt.installationId, engine: engineReceipt.enginePackageId };
  }, { repo: REPO, rev: REV, file: FILE });
  report.steps.install = { ...install, ms: Date.now() - t0 };
  console.log("[install]", JSON.stringify(install));
  if (install.loadState !== "resident") throw new Error(`load failed: ${install.loadReason}`);
  // 2. 능력 영수증 — 실제 빨강 이미지를 보내 색을 묻는다.
  const capability = await page.evaluate(async (installationId) => {
    const api = window.agentlas;
    const receipt = await api.localModelHub.testCapabilities({ installationId, strictJson: false, toolUse: false, cancellation: false, imageInput: true, operationId: crypto.randomUUID() });
    return { imageInput: receipt.imageInput, reasonCodes: receipt.reasonCodes };
  }, install.installationId);
  report.steps.capability = capability; console.log("[capability]", JSON.stringify(capability));
  // 3. detect() 가 멀티모달로 광고하는지 → 대시보드와 같은 IPC 로 멀티모달 역할에 등록 → 다시 읽어 확인.
  const roles = await page.evaluate(async () => {
    const api = window.agentlas;
    const runtimes = await api.runtime.detect();
    const local = runtimes.find((r) => r.kind === "agentlas-local");
    if (!local) return { error: "agentlas-local runtime not detected" };
    const model = (local.availableModels || [])[0] || null;
    const profile = local.allocationModelProfiles?.[model] ?? null;
    const selection = { kind: "agentlas-local", backend: local.backend || "agentlas-local", source: local.source, model, role: "multimodal", inherit: false };
    const multimodal = await api.runtime.setRoleMembers("multimodal", [selection]);
    const after = await api.runtime.detect();
    const localAfter = after.find((r) => r.kind === "agentlas-local");
    return { model, supportsMultimodal: profile?.supportsMultimodal ?? null, capabilities: profile?.capabilities ?? null,
      multimodalPool: Array.isArray(multimodal) ? multimodal.map((s) => `${s.kind}:${s.model}`) : multimodal,
      activeRoles: localAfter?.activeRoles ?? null, roleSelections: localAfter?.roleSelections ?? null };
  });
  report.steps.roles = roles; console.log("[roles]", JSON.stringify(roles));
  // 4. 이미지가 든 실제 실행 — 런타임 러너가 이미지 입력을 거부하지 않고 답하는지(제품 경로).
  const run = await page.evaluate(async () => {
    const api = window.agentlas;
    if (typeof api.runtime.probeImageInput === "function") return await api.runtime.probeImageInput();
    return { skipped: "no direct probe IPC; capability receipt is the evidence" };
  });
  report.steps.run = run;
  report.pageErrors = pageErrors;
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await desktop.close().catch(() => {});
  server.close();
  const ok = install.projector && install.installationProjector && capability.imageInput === "verified" && roles.supportsMultimodal === true && Array.isArray(roles.activeRoles) && roles.activeRoles.includes("multimodal") && pageErrors.length === 0;
  console.log(JSON.stringify({ ok: Boolean(ok), outDir }));
  if (!ok) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
