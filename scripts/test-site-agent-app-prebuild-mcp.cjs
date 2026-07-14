#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { gzipSync } = require("node:zlib");
const crossSpawn = require("cross-spawn");
const { app } = require("electron");
const { cleanupElectronFixture } = require("./lib/electron-fixture-cleanup.cjs");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-prebuild-mcp-"));
process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

function waitForChildClose(child, label, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => resolve({ code, signal })));
  });
}

function runOversizedRequest(serverArgs) {
  const child = spawn(process.execPath, serverArgs, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const done = waitForChildClose(child, "oversized System Time MCP request");
  child.stdin.end("x".repeat(64 * 1024 + 1));
  return done.then(({ code }) => code);
}

function runManySmallRequests(serverArgs) {
  const child = spawn(process.execPath, serverArgs, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const done = waitForChildClose(child, "many-small System Time MCP requests");
  const lines = Array.from({ length: 2_000 }, (_, index) =>
    JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "ping" })).join("\n");
  assert.ok(Buffer.byteLength(lines) > 64 * 1024);
  child.stdin.end(`${lines}\n`);
  return done.then(({ code }) => code);
}

function runInlineServer(serverArgs) {
  const child = spawn(process.execPath, serverArgs, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return waitForChildClose(child, "inline System Time MCP source rejection")
    .then(({ code }) => code);
}

async function verifyDefaultMcpFailureIsolation(registry) {
  const registryPath = require.resolve("../dist/electron/mcp-tools/registry.js");
  const browserPath = require.resolve("../dist/electron/mcp-tools/browser-cdp-launcher.js");
  const defaultsPath = require.resolve("../dist/electron/mcp-tools/defaults.js");
  const registryExports = require(registryPath);
  const browserExports = require(browserPath);
  const original = {
    listInstalledServers: registryExports.listInstalledServers,
    installFromCatalog: registryExports.installFromCatalog,
    materializeBrowserCdpLauncher: browserExports.materializeBrowserCdpLauncher,
    consoleError: console.error,
  };
  const attempted = [];
  try {
    registryExports.listInstalledServers = () => [];
    registryExports.installFromCatalog = (catalogId) => {
      attempted.push(catalogId);
      if (catalogId === "hephaestus-network") throw new Error("fixture first plugin failure");
      return { catalogId };
    };
    browserExports.materializeBrowserCdpLauncher = () => { throw new Error("fixture browser launcher failure"); };
    console.error = () => {};
    delete require.cache[defaultsPath];
    const defaults = require(defaultsPath);
    defaults.ensureDefaultMcpPluginsInstalled();
    assert.deepEqual(attempted, [...defaults.DEFAULT_MCP_CATALOG_IDS],
      "one launcher/plugin failure must not starve later global MCP defaults");
    assert.ok(attempted.includes("agentlas-time"), "System Time must still seed after earlier failures");
  } finally {
    registryExports.listInstalledServers = original.listInstalledServers;
    registryExports.installFromCatalog = original.installFromCatalog;
    browserExports.materializeBrowserCdpLauncher = original.materializeBrowserCdpLauncher;
    console.error = original.consoleError;
    delete require.cache[defaultsPath];
  }
  assert.equal(registryExports, registry, "failure-isolation test must patch the live registry module only");
}

function verifyWindowsCmdConfigPathRoundTrip(inlineConfig) {
  if (process.platform !== "win32") return Promise.resolve();
  const shimDir = path.join(tmp, "windows-cmd-roundtrip");
  const output = path.join(shimDir, "args.json");
  const configSnapshot = path.join(shimDir, "mcp.json");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(configSnapshot, inlineConfig, { mode: 0o600 });
  fs.writeFileSync(path.join(shimDir, "capture.cjs"),
    'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));\n');
  const shim = path.join(shimDir, "claude-fixture.cmd");
  fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0capture.cjs" "%~dp0args.json" %*\r\n');
  const child = crossSpawn(shim, [
    "--setting-sources", "",
    "--mcp-config", configSnapshot,
    "--allowedTools", "mcp__agentlas-time__get_current_time",
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return waitForChildClose(child, "Windows .cmd inline MCP round trip").then(({ code }) => {
    if (code !== 0) throw new Error(stderr || `cmd shim exited ${code}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), [
      "--setting-sources", "",
      "--mcp-config", configSnapshot,
      "--allowedTools", "mcp__agentlas-time__get_current_time",
    ], "cross-spawn must preserve the empty setting source, config path, and following Windows .cmd arguments");
    assert.equal(fs.readFileSync(configSnapshot, "utf8"), inlineConfig,
      "the Windows dispatch snapshot must contain the exact canonical config bytes");
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

  const expectedArgs = systemTime.systemTimeMcpLaunchArgs();
  assert.equal(systemTime.systemTimeMcpSourceDigest(),
    "11f73b8c137b1e52a806667739c89ae1e330ea7f7e9f9d7201ab42f2a042b712",
    "the audited built-in source digest must change only with an explicit review update");
  assert.equal(systemTime.systemTimeMcpLaunchWithinBudget(), true);
  assert.equal(expectedArgs[0], "-e");
  assert.ok(expectedArgs.length === 3 && expectedArgs[2].length > 0,
    "the audited source must be a bounded compressed in-memory payload");
  const inlineConfig = JSON.stringify({
    mcpServers: {
      "agentlas-time": {
        command: process.execPath,
        args: expectedArgs,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  });
  assert.equal(/[\r\n\0]/.test(inlineConfig), false);
  assert.ok(Buffer.byteLength(inlineConfig) <= 4_096);
  await verifyWindowsCmdConfigPathRoundTrip(inlineConfig);
  const wrongSourcePayload = gzipSync(Buffer.from('process.stdout.write("UNREVIEWED_SOURCE_EXECUTED");', "utf8"), {
    level: 9,
  }).toString("base64");
  assert.equal(await runInlineServer([expectedArgs[0], expectedArgs[1], wrongSourcePayload]), 78,
    "the child bootstrap must reject a valid compressed payload with the wrong source digest");
  let installed = registry.installFromCatalog("agentlas-time");
  assert.equal(installed.catalogId, "agentlas-time");
  assert.equal(installed.command, process.execPath,
    "the global catalog row must use the packaged Electron binary, not a package manager or arbitrary command");
  assert.deepEqual(installed.args, expectedArgs);
  assert.equal(installed.url, null, "the safe keyless server must never use a remote URL transport");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_mcp_servers WHERE server_id = ?").get(installed.id).count, 0,
    "the system MCP is globally installed and is not owned by or permanently attached to an agent bundle");

  const stableId = installed.id;
  const stableInstalledAt = installed.installedAt;
  const boundAgent = { id: "site-prebuild-mcp-bound-agent" };
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
  ).run(
    boundAgent.id,
    boundAgent.id,
    "MCP migration fixture",
    "MCP migration fixture",
    "Test fixture",
    "Test fixture",
    "Test fixture",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES (?, ?)")
    .run(boundAgent.id, installed.id);
  db.prepare(
    `UPDATE mcp_servers
     SET name = 'Legacy Time', name_en = 'Legacy Time', transport = 'http', command = NULL,
         args_json = ?, url = 'http://127.0.0.1:9/legacy', env_keys_json = '["LEGACY_SECRET"]', enabled = 0
     WHERE id = ?`,
  ).run(JSON.stringify([path.join(tmp, "legacy-mutable-time.cjs")]), installed.id);
  installed = registry.refreshInstalledCatalogServer("agentlas-time");
  const timeCatalog = require("../dist/electron/mcp-tools/catalog.js").getCatalogEntry("agentlas-time");
  assert.ok(timeCatalog);
  assert.equal(installed.id, stableId, "startup migration must preserve the system-global item id");
  assert.equal(installed.installedAt, stableInstalledAt, "startup migration must preserve install history");
  assert.equal(installed.enabled, false, "startup migration must preserve the user's enabled choice");
  assert.equal(installed.name, timeCatalog.name);
  assert.equal(installed.nameEn, timeCatalog.nameEn);
  assert.equal(installed.transport, "stdio");
  assert.equal(installed.command, process.execPath);
  assert.deepEqual(installed.args, expectedArgs, "legacy mutable paths must migrate to exact inline argv");
  assert.equal(installed.url, null);
  assert.deepEqual(installed.envKeys, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_mcp_servers WHERE agent_id = ? AND server_id = ?")
    .get(boundAgent.id, stableId).count, 1, "in-place migration must preserve existing agent bindings");
  assert.deepEqual(db.pragma("foreign_key_check"), [], "migration must preserve registry referential integrity");
  const beforeRefreshChanges = db.prepare("SELECT total_changes() AS count").get().count;
  registry.refreshInstalledCatalogServer("agentlas-time");
  const afterRefreshChanges = db.prepare("SELECT total_changes() AS count").get().count;
  assert.equal(afterRefreshChanges, beforeRefreshChanges, "an exact startup refresh must not rewrite SQLite/WAL");
  db.prepare("UPDATE mcp_servers SET enabled = 1 WHERE id = ?").run(installed.id);
  installed = registry.getServer(installed.id);

  const live = await testServerConnection(installed, { timeoutMs: 5_000 });
  assert.equal(live.connected, true,
    `process.execPath + ELECTRON_RUN_AS_NODE must complete a real packaged-style MCP handshake: ${JSON.stringify(live)}`);
  assert.deepEqual(live.tools.map((tool) => tool.name), ["get_current_time", "convert_time"]);
  assert.equal(await runOversizedRequest(installed.args), 78,
    "a request without a newline must be bounded instead of growing memory indefinitely");
  assert.equal(await runManySmallRequests(installed.args), 0,
    "a large chunk of individually bounded MCP requests must not be rejected as one oversized line");

  const spawnSentinel = path.join(tmp, "tampered-command-spawned");
  let loopbackRequests = 0;
  const loopback = http.createServer((_request, response) => {
    loopbackRequests += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolve, reject) => {
    loopback.once("error", reject);
    loopback.listen(0, "127.0.0.1", resolve);
  });
  const loopbackAddress = loopback.address();
  assert.ok(loopbackAddress && typeof loopbackAddress !== "string");
  const loopbackUrl = `http://127.0.0.1:${loopbackAddress.port}/mcp`;
  const tamperedRows = [
    { ...installed, args: [...installed.args.slice(0, -1), `${installed.args.at(-1)}A`] },
    { ...installed, command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(spawnSentinel)},"spawned")`] },
    { ...installed, args: [installed.args[0], `${installed.args[1]} `, installed.args[2]] },
    { ...installed, args: [...installed.args, "--unexpected"] },
    { ...installed, url: loopbackUrl },
    { ...installed, configurationValid: false },
    { ...installed, envKeys: ["UNEXPECTED_SECRET"] },
    { ...installed, transport: "http", command: null, args: [], url: loopbackUrl },
  ];
  for (const candidate of tamperedRows) {
    const status = await testServerConnection(candidate, { timeoutMs: 250 });
    assert.equal(status.connected, false, "a tampered official catalog row must fail closed before transport execution");
  }
  await new Promise((resolve) => loopback.close(resolve));
  assert.equal(loopbackRequests, 0, "a tampered official row must make zero network requests");
  assert.equal(fs.existsSync(spawnSentinel), false, "a tampered official row must spawn zero child commands");

  const raceFile = path.join(tmp, "config-race.json");
  const raceA = JSON.stringify({ version: "A", pad: "a".repeat(4_096) });
  const raceB = JSON.stringify({ version: "B", pad: "b".repeat(4_096) });
  assert.equal(Buffer.byteLength(raceA), Buffer.byteLength(raceB));
  fs.writeFileSync(raceFile, raceA, { mode: 0o600 });
  // Windows file replacement requires a delete + rename and hosted runners
  // scan every new file. A smaller Windows sample preserves the real NTFS
  // replacement race without turning the contract into a multi-minute gate.
  const replacementIterations = process.platform === "win32" ? 256 : 3_000;
  const readIterations = process.platform === "win32" ? 1_000 : 4_000;
  const swapScript = `const fs=require("node:fs"),p=process.argv[1],a=process.argv[2],b=process.argv[3],n=Number(process.argv[4]);for(let i=0;i<n;i++){const t=p+"."+process.pid+"."+i;fs.writeFileSync(t,i%2?a:b,{mode:0o600});if(process.platform==="win32")fs.rmSync(p,{force:true});fs.renameSync(t,p);}`;
  const swapper = spawn(process.execPath, ["-e", swapScript, raceFile, raceA, raceB, String(replacementIterations)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore",
  });
  const swapperDone = waitForChildClose(swapper, "stable-file replacement race").then(({ code }) => {
    if (code !== 0) throw new Error(`swapper exited ${code}`);
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  let stableRaceReads = 0;
  for (let index = 0; index < readIterations; index += 1) {
    const bytes = readStableRegularFile(raceFile, 32 * 1024);
    if (!bytes) continue;
    const value = bytes.toString("utf8");
    assert.ok(value === raceA || value === raceB,
      "a path replacement race must never produce mixed or separately hashed bytes");
    stableRaceReads += 1;
  }
  await swapperDone;
  assert.ok(stableRaceReads > 0, "stable fd race regression did not observe any complete version");
  await verifyDefaultMcpFailureIsolation(registry);

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
  assert.match(clientSource, /isCanonicalSystemTimeMcpServer\(server\)/,
    "the global test transport must reject every non-canonical built-in row before transport selection");
  assert.match(configSource, /Bypass the mutable per-run wrapper/);
  assert.match(pageSource, /MCP 없이 계속 만듭니다|keep building without MCP/,
    "recommendation failure must not starve app creation");

  console.log("site Agent App prebuild MCP prompt + system-global keyless contract ok");
  cleanupElectronFixture(tmp, "site-prebuild-mcp");
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  try { cleanupElectronFixture(tmp, "site-prebuild-mcp"); } catch { /* best effort */ }
  app.exit(1);
});
