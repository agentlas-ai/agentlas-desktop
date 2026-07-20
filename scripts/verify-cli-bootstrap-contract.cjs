#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const installer = read("electron/runtime/install-cli.ts");
const managedNode = read("electron/runtime/managed-node.ts");
const execRuntime = read("electron/runtime/exec.ts");
const nodeFetcher = read("scripts/fetch-node-runtime.mjs");
const builder = read("electron-builder.yml");
const releaseWorkflow = read(".github/workflows/release.yml");
const dashboard = read("renderer/components/EngineUsage.tsx");

for (const [pattern, label] of [
  [/@anthropic-ai\/claude-code"\s*, version: "2\.1\.214"/, "Claude Code package pin"],
  [/@openai\/codex"\s*, version: "0\.144\.6"/, "Codex package pin"],
  [/@google\/gemini-cli"\s*, version: "0\.51\.0"/, "Gemini package pin"],
  [/@xai-official\/grok"\s*, version: "0\.2\.103"/, "Grok package pin"],
  [/resolveManagedNodeRuntime\(\)/, "managed Node resolver"],
  [/NPM_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY/, "official npm registry isolation"],
  [/const installInFlight = new Map/, "single-flight install"],
  [/installed and verified:/, "post-install verification"],
  [/spawn\(powershell,[\s\S]{0,500}detached: true/, "direct PowerShell login"],
  [/AGENTLAS_NPM_BOOTSTRAP_BIN/, "isolated npm-only Node shim directory"],
  [/writeManagedWindowsCliLauncher/, "absolute managed provider launcher"],
]) {
  assert.match(installer, pattern, `${label} is missing`);
}
assert.doesNotMatch(installer, /curl[^\n]*\|\s*bash|irm[^\n]*\|\s*iex/, "Connect must not execute mutable remote scripts");
assert.doesNotMatch(installer, /shell:\s*true\s*[,}]/, "Windows login must not compose a cmd.exe shell string");
assert.match(installer, /runtime\.node\)}" "\$\{escapeCmdPath\(targetReal\)\}" %\*/, "Node-based provider launchers must call the persistent Node executable directly");
assert.match(installer, /fs\.rmSync\(path\.join\(AGENTLAS_NPM_PREFIX, "node\.cmd"\)/, "legacy generic Node shims must be removed from the provider prefix");
assert.match(execRuntime, /fs\.existsSync\(path\.join\(managed, "node\.cmd"\)\)\) return null/, "a legacy generic Node shim must prevent managed-prefix PATH promotion");

assert.match(managedNode, /MANAGED_NODE_VERSION = "24\.18\.0"/);
assert.match(managedNode, /managed Node runtime checksum verification failed/);
assert.match(managedNode, /runtimeTreeSha256/, "the complete packaged Node and npm tree must be pinned");
assert.match(managedNode, /materializePersistentNode/, "portable Windows builds need a stable Node executable for installed CLI shims");
assert.doesNotMatch(managedNode, /AGENTLAS_NODE_RUNTIME_ROOT/, "production runtime resolution must not accept an environment-selected trust root");
assert.match(nodeFetcher, /node-v\$\{NODE_VERSION\}-win-x64\.zip/);
assert.match(nodeFetcher, /0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821/);
assert.match(nodeFetcher, /Expand-Archive/, "the pinned Windows archive must use built-in PowerShell extraction");
assert.match(nodeFetcher, /runtimeTreeSha256/, "the fetch boundary must verify the full official runtime tree");
assert.match(builder, /win:[\s\S]*from: build-resources\/node-runtime[\s\S]*to: node-runtime/);
assert.match(releaseWorkflow, /runner\.os == 'Windows'[\s\S]{0,180}npm run fetch:node/);

const installAt = dashboard.indexOf("await api.runtime.installCli(e.cliKind)");
const loginAt = dashboard.indexOf("await api.runtime.openCliLogin(e.cliKind)");
assert.ok(installAt >= 0 && loginAt > installAt, "Connect must install before opening provider login");
assert.match(dashboard, /busyStage === "install"[\s\S]{0,80}설치 중/);
assert.match(dashboard, /busyStage === "login"|연결 중/);

// When the fetched private runtime is present, exercise the compiled verifier
// against the real official Node bytes and a tampered npm CLI fixture.
const fetchedRuntime = path.join(root, "build-resources", "node-runtime");
const fetchedManifest = path.join(fetchedRuntime, "agentlas-node-runtime.json");
if (fs.existsSync(fetchedManifest)) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-node-runtime-contract-"));
  try {
    const sourceRoot = path.join(temp, "source");
    const persistentParent = path.join(temp, "persistent");
    const npmRelative = path.join("node_modules", "npm", "bin", "npm-cli.js");
    const runtimeVerifier = require("../dist/electron/runtime/managed-node.js");
    fs.cpSync(fetchedRuntime, sourceRoot, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    assert.equal(
      runtimeVerifier.validateManagedNodeRuntimeRoot(sourceRoot, "win32", "x64").ok,
      true,
      "real pinned Windows Node runtime must verify",
    );
    const materialized = runtimeVerifier.materializeManagedNodeRuntimeForTests(
      sourceRoot,
      persistentParent,
      "win32",
      "x64",
    );
    assert.equal(materialized.ok, true, "verified Node executable must materialize into a persistent directory");
    assert.ok(materialized.runtime.node.startsWith(`${persistentParent}${path.sep}`));
    assert.ok(materialized.runtime.npmCli.startsWith(`${sourceRoot}${path.sep}`));
    const persistentNode = materialized.runtime.node;
    fs.appendFileSync(path.join(sourceRoot, npmRelative), "// tampered\n");
    const tampered = runtimeVerifier.validateManagedNodeRuntimeRoot(sourceRoot, "win32", "x64");
    assert.equal(tampered.ok, false, "tampered npm CLI must fail closed");
    assert.match(tampered.reason, /manifest|checksum|damaged/);
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(persistentNode), true, "portable app cleanup must not remove the installed CLI's Node executable");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ ok: true, checks: fs.existsSync(fetchedManifest) ? 37 : 28 }, null, 2));
