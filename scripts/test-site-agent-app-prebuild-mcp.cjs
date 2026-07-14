#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-prebuild-mcp-"));
const globalRoot = path.join(tmp, "desktop-global-mcp");
process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT = globalRoot;
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

function runMaterializerChild(modulePath, targetRoot) {
  return new Promise((resolve, reject) => {
    const script = [
      `process.env.AGENTLAS_E2E="1"`,
      `process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT=${JSON.stringify(targetRoot)}`,
      `require(${JSON.stringify(modulePath)}).materializeSystemTimeMcpServer()`,
    ].join(";");
    const child = spawn(process.execPath, ["-e", script], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `materializer exited ${code}`)));
  });
}

function runOversizedRequest(serverPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    child.stdin.end("x".repeat(64 * 1024 + 1));
  });
}

function runManySmallRequests(serverPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
    const lines = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "ping" })).join("\n");
    assert.ok(Buffer.byteLength(lines) > 64 * 1024);
    child.stdin.end(`${lines}\n`);
  });
}

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const systemTime = require("../dist/electron/mcp-tools/system-time-server.js");
  const registry = require("../dist/electron/mcp-tools/registry.js");
  const { testServerConnection } = require("../dist/electron/mcp-tools/client.js");
  const { readStableRegularFile } = require("../dist/electron/site/agent-app-mcp-config-policy.js");

  const serverPath = systemTime.materializeSystemTimeMcpServer();
  const installed = registry.installFromCatalog("agentlas-time");
  assert.equal(installed.catalogId, "agentlas-time");
  assert.equal(installed.command, process.execPath,
    "the global catalog row must use the packaged Electron binary, not a package manager or arbitrary command");
  assert.deepEqual(installed.args, [serverPath]);
  assert.equal(installed.url, null, "the safe keyless server must never use a remote URL transport");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_mcp_servers WHERE server_id = ?").get(installed.id).count, 0,
    "the system MCP is globally installed and is not owned by or permanently attached to an agent bundle");

  const auditedSource = fs.readFileSync(serverPath);
  fs.writeFileSync(serverPath, "stale-system-time-source", { mode: 0o600 });
  const windowsReplacement = `${serverPath}.windows-replacement`;
  fs.writeFileSync(windowsReplacement, auditedSource, { mode: 0o600 });
  systemTime.replaceSystemTimeMcpFileAtomically(windowsReplacement, serverPath, "win32");
  assert.equal(systemTime.isAuthenticSystemTimeMcpSource(serverPath), true,
    "the Windows-safe backup swap must replace an existing regular destination");

  const live = await testServerConnection(installed, { timeoutMs: 5_000 });
  assert.equal(live.connected, true,
    `process.execPath + ELECTRON_RUN_AS_NODE must complete a real packaged-style MCP handshake: ${JSON.stringify(live)}`);
  assert.deepEqual(live.tools.map((tool) => tool.name), ["get_current_time", "convert_time"]);
  assert.equal(await runOversizedRequest(serverPath), 78,
    "a request without a newline must be bounded instead of growing memory indefinitely");
  assert.equal(await runManySmallRequests(serverPath), 0,
    "a large chunk of individually bounded MCP requests must not be rejected as one oversized line");

  const raceFile = path.join(tmp, "config-race.json");
  const raceA = JSON.stringify({ version: "A", pad: "a".repeat(4_096) });
  const raceB = JSON.stringify({ version: "B", pad: "b".repeat(4_096) });
  assert.equal(Buffer.byteLength(raceA), Buffer.byteLength(raceB));
  fs.writeFileSync(raceFile, raceA, { mode: 0o600 });
  const swapScript = `const fs=require("node:fs"),p=process.argv[1],a=process.argv[2],b=process.argv[3];for(let i=0;i<3000;i++){const t=p+"."+process.pid+"."+i;fs.writeFileSync(t,i%2?a:b,{mode:0o600});if(process.platform==="win32")fs.rmSync(p,{force:true});fs.renameSync(t,p);}`;
  const swapper = spawn(process.execPath, ["-e", swapScript, raceFile, raceA, raceB], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore",
  });
  const swapperDone = new Promise((resolve, reject) => {
    swapper.once("error", reject);
    swapper.once("close", (code) => code === 0 ? resolve() : reject(new Error(`swapper exited ${code}`)));
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  let stableRaceReads = 0;
  for (let index = 0; index < 4_000; index += 1) {
    const bytes = readStableRegularFile(raceFile, 32 * 1024);
    if (!bytes) continue;
    const value = bytes.toString("utf8");
    assert.ok(value === raceA || value === raceB,
      "a path replacement race must never produce mixed or separately hashed bytes");
    stableRaceReads += 1;
  }
  await swapperDone;
  assert.ok(stableRaceReads > 0, "stable fd race regression did not observe any complete version");

  const modulePath = path.join(root, "dist/electron/mcp-tools/system-time-server.js");
  const concurrentRoot = path.join(tmp, "concurrent-global-mcp");
  await Promise.all(Array.from({ length: 4 }, () => runMaterializerChild(modulePath, concurrentRoot)));
  process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT = concurrentRoot;
  const concurrentPath = systemTime.systemTimeMcpServerPath();
  assert.equal(systemTime.isAuthenticSystemTimeMcpSource(concurrentPath), true,
    "concurrent materialization must converge on one exact audited source");

  const symlinkRoot = path.join(tmp, "symlink-global-mcp");
  const symlinkTarget = path.join(tmp, "symlink-target");
  fs.mkdirSync(symlinkTarget, { recursive: true });
  let symlinkSupported = true;
  try {
    fs.symlinkSync(symlinkTarget, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
  } catch {
    symlinkSupported = false;
  }
  if (symlinkSupported) {
    process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT = symlinkRoot;
    assert.throws(() => systemTime.materializeSystemTimeMcpServer(), /directory is unsafe/,
      "a symlink at the controlled global MCP parent must fail closed");
  }

  const oversizedRoot = path.join(tmp, "oversized-global-mcp");
  process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT = oversizedRoot;
  const oversizedPath = systemTime.systemTimeMcpServerPath();
  fs.mkdirSync(path.dirname(oversizedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(oversizedPath, "x".repeat(80 * 1024), { mode: 0o600 });
  systemTime.materializeSystemTimeMcpServer();
  assert.equal(systemTime.isAuthenticSystemTimeMcpSource(oversizedPath), true,
    "an oversized existing regular file must be replaced without an unbounded read");

  const leafSymlinkRoot = path.join(tmp, "leaf-symlink-global-mcp");
  process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT = leafSymlinkRoot;
  const leafPath = systemTime.systemTimeMcpServerPath();
  fs.mkdirSync(path.dirname(leafPath), { recursive: true, mode: 0o700 });
  const leafTarget = path.join(tmp, "leaf-target.cjs");
  fs.writeFileSync(leafTarget, "target", { mode: 0o600 });
  let leafSymlinkSupported = true;
  try { fs.symlinkSync(leafTarget, leafPath, "file"); } catch { leafSymlinkSupported = false; }
  if (leafSymlinkSupported) {
    assert.throws(() => systemTime.materializeSystemTimeMcpServer(), /file is unsafe/,
      "a destination leaf symlink must fail closed without chmod-following its target");
  }

  const pageSource = fs.readFileSync(path.join(root, "renderer/app/(shell)/site/page.tsx"), "utf8");
  const ipcSource = fs.readFileSync(path.join(root, "electron/ipc.ts"), "utf8");
  const clientSource = fs.readFileSync(path.join(root, "electron/mcp-tools/client.ts"), "utf8");
  const configSource = fs.readFileSync(path.join(root, "electron/mcp-tools/mcp-config.ts"), "utf8");
  assert.ok(
    pageSource.indexOf("prebuildReviewAgentAppMcp") < pageSource.indexOf("siteApi?.generateScreen"),
    "the recommendation/consent prompt must finish before design and Astryx generation",
  );
  assert.match(ipcSource, /연결 후보는 Desktop 시스템 전역 MCP에서 확인했습니다/);
  assert.match(ipcSource, /차단 항목은 에이전트 번들의 앱 선언에서 안전 정책에 따라 제외했습니다/,
    "blocked-only copy must identify the agent declaration rather than the global registry");
  assert.match(ipcSource, /mode === "launch" && recommendation\.status !== "review-required"/,
    "launch must not re-prompt a durable approval, decline, or blocked-only acknowledgement");
  assert.match(ipcSource, /reviewNativeSiteAgentAppMcp\(win, projectId, "force"\)/,
    "only an explicit card review may force a durable consent decision to reopen");
  assert.doesNotMatch(ipcSource, /상태 SHA-256|State SHA-256/,
    "the internal TOCTOU digest must not become user-facing technical copy");
  assert.match(clientSource, /isAuthenticSystemTimeMcpSource\(server\.args\[0\]\)/,
    "the global test transport must revalidate exact built-in source before enabling Electron's Node mode");
  assert.match(configSource, /command === process\.execPath/);
  assert.match(pageSource, /MCP 없이 계속 만듭니다|keep building without MCP/,
    "recommendation failure must not starve app creation");

  console.log("site Agent App prebuild MCP prompt + system-global keyless contract ok");
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(1);
});
