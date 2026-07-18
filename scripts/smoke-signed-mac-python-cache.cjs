#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const workforceProtocolContract = require("../electron/mcp-tools/workforce-protocol-contract.json");

const appArgument = process.argv.slice(2).find((arg) => arg.startsWith("--app="));
const signedApp = appArgument ? path.resolve(appArgument.slice("--app=".length)) : "";
const resourcesArgument = process.argv.slice(2).find((arg) => arg.startsWith("--resources="));
const explicitResources = resourcesArgument ? path.resolve(resourcesArgument.slice("--resources=".length)) : "";
// Windows/Linux artifact checks run under plain Node so they do not depend on
// a display server or Chromium sandbox. The signed macOS bridge exercise still
// runs under Electron and is the only branch that needs electron.app.
const app = signedApp ? require("electron").app : null;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-signed-python-cache-smoke-"));

function workforceProtocolDigest(metadata) {
  const canonical = Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function pythonArtifacts(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.name === "__pycache__") return [absolute];
    if (entry.isDirectory()) return pythonArtifacts(absolute);
    return entry.name.endsWith(".pyc") ? [absolute] : [];
  });
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePackagedWorkforceMcp({ python, runtimeRoot, isolatedHome, manifestVersion }) {
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client({
    name: "agentlas-packaged-runtime-smoke",
    version: app?.getVersion?.() || "0.0.0-package-smoke",
  }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: python,
    args: ["-m", "agentlas_cloud", "mcp", "serve"],
    cwd: runtimeRoot,
    stderr: "ignore",
    env: {
      ...getDefaultEnvironment(),
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      AGENTLAS_NETWORKING_HOME: path.join(isolatedHome, ".agentlas", "networking"),
      HEPHAESTUS_RUNTIME_ROOT: runtimeRoot,
      PYTHONPATH: runtimeRoot,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    },
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "packaged MCP initialize");
    const serverVersion = client.getServerVersion();
    assert.equal(serverVersion?.version, manifestVersion, "MCP serverVersion must equal the embedded Core manifest");
    const listed = await withTimeout(client.listTools(), 20_000, "packaged MCP tools/list");
    const workforceNames = [
      "workforce.search_candidates",
      "workforce.validate_selection",
      "workforce.prepare_execution",
    ];
    const workforceTools = workforceNames.map((name) => {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `packaged MCP is missing ${name}`);
      return tool;
    });
    const protocols = workforceTools.map((tool) => tool._meta?.["agentlas/workforce-protocol"]);
    assert.ok(protocols.every((metadata) => metadata && typeof metadata === "object"), "Workforce _meta must survive the real SDK client");
    const expectedMetadata = workforceProtocolContract.protocolMetadata;
    const expectedDigest = workforceProtocolDigest(expectedMetadata);
    const expectedKeys = [...Object.keys(expectedMetadata), "protocolDigest"].sort();
    for (const metadata of protocols) {
      assert.deepEqual(Object.keys(metadata).sort(), expectedKeys, "packaged Workforce metadata keys must exactly match Desktop");
      for (const [key, value] of Object.entries(expectedMetadata)) {
        assert.equal(metadata[key], value, `packaged Workforce ${key} must exactly match Desktop`);
      }
      assert.equal(metadata.protocolDigest, expectedDigest, "packaged Workforce protocol digest must exactly match Desktop");
    }
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    void transport.close().catch(() => {});
  }
}

(async () => {
  let exitCode = 0;
  try {
    assert.ok(signedApp || explicitResources, "--app=/path/to/Agentlas.app or --resources=/path/to/resources is required");
    if (signedApp) assert.equal(path.basename(signedApp), "Agentlas.app", "the macOS smoke target must be Agentlas.app");
    for (const secretKey of [
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "APPLE_TEAM_ID",
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "RAILWAY_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      assert.equal(process.env[secretKey], undefined, `${secretKey} must not cross into the signed-app runtime smoke`);
    }

    const resourcesRoot = explicitResources || path.join(signedApp, "Contents", "Resources");
    const runtimeRoot = path.join(resourcesRoot, "Hephaestus");
    const pythonRoot = path.join(resourcesRoot, "python-runtime");
    const packagedEngine = path.join(resourcesRoot, "app.asar", "dist", "electron", "hephaestus", "engine.js");
    assert.ok(fs.existsSync(path.join(runtimeRoot, "agentlas_cloud", "__main__.py")), "signed app is missing Agentlas OS");
    assert.ok(fs.existsSync(packagedEngine), "signed app is missing the packaged Desktop engine bridge");
    const coreManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
    const pythonManifest = JSON.parse(fs.readFileSync(path.join(pythonRoot, "agentlas-python-runtime.json"), "utf8"));
    const expectedTriple = process.platform === "darwin"
      ? process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
      : process.platform === "win32"
        ? "x86_64-pc-windows-msvc"
        : "x86_64-unknown-linux-gnu";
    assert.equal(pythonManifest.triple, expectedTriple, "signed app Python must match the running package architecture");
    const packagedPython = path.join(pythonRoot, ...pythonManifest.executableRelativePath.split("/"));
    assert.ok(fs.existsSync(packagedPython), "signed app is missing the pinned standalone Python executable");

    const isolatedHome = path.join(tempDir, "home");
    const userData = path.join(tempDir, "user-data");
    fs.mkdirSync(isolatedHome, { recursive: true });
    if (app) app.setPath("userData", userData);
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    process.env.AGENTLAS_NETWORKING_HOME = path.join(tempDir, "networking");
    process.env.HEPHAESTUS_RUNTIME_ROOT = runtimeRoot;
    // Hostile inherited values prove the packaged bridge applies its boundary
    // after all caller/process environment merging.
    process.env.PYTHONDONTWRITEBYTECODE = "";
    process.env.PYTHONPYCACHEPREFIX = path.join(runtimeRoot, "forbidden-cache");

    await probePackagedWorkforceMcp({
      python: packagedPython,
      runtimeRoot,
      isolatedHome,
      manifestVersion: coreManifest.version,
    });

    if (signedApp) {
      const { runHephaestus } = require(packagedEngine);
      const result = await runHephaestus("agentlas_cloud", ["stormbreaker", "harness"], {
        cwd: tempDir,
        timeoutMs: 30_000,
        locale: "en",
        env: {
          PYTHONDONTWRITEBYTECODE: "",
          PYTHONPYCACHEPREFIX: path.join(runtimeRoot, "caller-controlled-cache"),
        },
      });
      assert.equal(result.ok, true, result.error || result.stderr);
    }

    const forbidden = pythonArtifacts(resourcesRoot);
    assert.deepEqual(forbidden, [], `signed app Resources gained Python bytecode: ${forbidden.join(", ")}`);
    console.log("packaged Python/MCP exercise: PASS (native bundled Python + real SDK Workforce metadata + embedded Core)");
  } catch (error) {
    exitCode = 1;
    console.error("signed macOS Python cache exercise: FAIL", error);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    if (app) app.exit(exitCode);
    else process.exitCode = exitCode;
  }
})();
