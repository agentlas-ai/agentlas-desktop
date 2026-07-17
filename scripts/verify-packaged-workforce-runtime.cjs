#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const workforceContract = require("../electron/mcp-tools/workforce-protocol-contract.json");

const appArg = process.argv.slice(2).find((arg) => arg.startsWith("--app="));
const resourcesArg = process.argv.slice(2).find((arg) => arg.startsWith("--resources="));
const packagedApp = appArg ? path.resolve(appArg.slice("--app=".length)) : "";
const resourcesRoot = resourcesArg
  ? path.resolve(resourcesArg.slice("--resources=".length))
  : packagedApp
    ? path.join(packagedApp, "Contents", "Resources")
    : "";
const electronApp = packagedApp ? require("electron").app : null;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-packaged-workforce-verify-"));

function canonicalDigest(metadata) {
  const canonical = Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function exactStringSet(actual, expected, label) {
  assert.ok(Array.isArray(actual) && actual.every((entry) => typeof entry === "string"), `${label} must be strings`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert.equal(new Set(left).size, left.length, `${label} must not contain duplicates`);
  assert.deepEqual(left, right, `${label} must exactly match the Desktop authority`);
}

function record(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
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

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyMcp(python, runtimeRoot, isolatedHome, manifestVersion) {
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client(
    { name: "agentlas-packaged-runtime-verifier", version: electronApp?.getVersion?.() || "package" },
    { capabilities: {} },
  );
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
    assert.equal(client.getServerVersion()?.version, manifestVersion, "MCP serverVersion must match Core manifest");
    const inventory = await withTimeout(client.listTools(), 20_000, "packaged MCP tools/list");
    const authority = workforceContract.tools;
    exactStringSet(
      inventory.tools.filter((tool) => tool.name.startsWith("workforce.")).map((tool) => tool.name),
      authority.requiredNames,
      "Workforce tool inventory",
    );
    const byName = new Map(inventory.tools.map((tool) => [tool.name, tool]));
    const search = byName.get(authority.searchCandidates.name);
    const validate = byName.get(authority.validateSelection.name);
    const prepare = byName.get(authority.prepareExecution.name);
    exactStringSet(search?.inputSchema?.required, authority.searchCandidates.requiredInputFields, "search required inputs");
    exactStringSet(search?.inputSchema?.properties?.sourceScope?.enum, authority.searchCandidates.sourceScopeValues, "sourceScope enum");
    exactStringSet(validate?.inputSchema?.required, authority.validateSelection.requiredInputFields, "validate required inputs");
    exactStringSet(prepare?.inputSchema?.required, authority.prepareExecution.requiredInputFields, "prepare required inputs");
    exactStringSet(Object.keys(record(prepare?.inputSchema?.properties, "prepare properties")), authority.prepareExecution.inputPropertyFields, "prepare properties");
    const attempt = record(prepare.inputSchema.properties.prepareAttempt, "prepareAttempt");
    assert.equal(attempt.additionalProperties, false, "prepareAttempt must reject undeclared fields");
    exactStringSet(attempt.required, authority.prepareExecution.prepareAttemptRequiredFields, "prepareAttempt required fields");
    exactStringSet(Object.keys(record(attempt.properties, "prepareAttempt properties")), authority.prepareExecution.prepareAttemptRequiredFields, "prepareAttempt properties");
    assert.equal(attempt.properties.schemaVersion?.const, workforceContract.protocolMetadata.prepareAttemptSchemaVersion);

    const expectedMetadata = workforceContract.protocolMetadata;
    const expectedKeys = [...Object.keys(expectedMetadata), "protocolDigest"].sort();
    const expectedDigest = canonicalDigest(expectedMetadata);
    for (const name of authority.requiredNames) {
      const metadata = byName.get(name)?._meta?.["agentlas/workforce-protocol"];
      assert.deepEqual(Object.keys(record(metadata, `${name} protocol metadata`)).sort(), expectedKeys);
      for (const [key, expected] of Object.entries(expectedMetadata)) {
        assert.equal(metadata[key], expected, `${name} ${key} must match Desktop`);
      }
      assert.equal(metadata.protocolDigest, expectedDigest, `${name} protocolDigest must match Desktop`);
    }
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await transport.close().catch(() => {});
  }
}

(async () => {
  let exitCode = 0;
  try {
    assert.ok(resourcesRoot, "--app=/path/to/Agentlas.app or --resources=/path/to/resources is required");
    if (packagedApp) assert.equal(path.basename(packagedApp), "Agentlas.app", "official verifier requires Agentlas.app");
    for (const key of [
      "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "CSC_LINK",
      "CSC_KEY_PASSWORD", "GH_TOKEN", "GITHUB_TOKEN", "RAILWAY_TOKEN",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    ]) {
      assert.equal(process.env[key], undefined, `${key} must not cross into the packaged runtime verifier`);
    }

    const runtimeRoot = path.join(resourcesRoot, "Hephaestus");
    const pythonRoot = path.join(resourcesRoot, "python-runtime");
    const appArchive = path.join(resourcesRoot, "app.asar");
    const engine = path.join(resourcesRoot, "app.asar", "dist", "electron", "hephaestus", "engine.js");
    const pythonManifestPath = path.join(pythonRoot, "agentlas-python-runtime.json");
    assert.ok(fs.existsSync(path.join(runtimeRoot, "agentlas_cloud", "__main__.py")), "package is missing Agentlas Core");
    assert.ok(fs.existsSync(appArchive), "package is missing the Desktop app archive");
    if (electronApp) assert.ok(fs.existsSync(engine), "package is missing the Desktop Core bridge");
    assert.ok(fs.existsSync(pythonManifestPath), "package is missing the standalone Python manifest");
    const coreManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
    const pythonManifest = JSON.parse(fs.readFileSync(pythonManifestPath, "utf8"));
    const expectedTriple = process.platform === "darwin"
      ? process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
      : process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
    assert.equal(pythonManifest.triple, expectedTriple, "standalone Python must match package platform/architecture");
    const python = path.join(pythonRoot, ...pythonManifest.executableRelativePath.split("/"));
    assert.ok(fs.existsSync(python), "package is missing the pinned standalone Python executable");

    const isolatedHome = path.join(temporaryRoot, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    if (electronApp) electronApp.setPath("userData", path.join(temporaryRoot, "user-data"));
    await verifyMcp(python, runtimeRoot, isolatedHome, coreManifest.version);

    if (electronApp) {
      process.env.HOME = isolatedHome;
      process.env.USERPROFILE = isolatedHome;
      process.env.AGENTLAS_NETWORKING_HOME = path.join(isolatedHome, ".agentlas", "networking");
      process.env.HEPHAESTUS_RUNTIME_ROOT = runtimeRoot;
      process.env.PYTHONDONTWRITEBYTECODE = "";
      process.env.PYTHONPYCACHEPREFIX = path.join(runtimeRoot, "forbidden-cache");
      const result = await require(engine).runHephaestus("agentlas_cloud", ["stormbreaker", "harness"], {
        cwd: temporaryRoot,
        timeoutMs: 30_000,
        locale: "en",
        env: { PYTHONDONTWRITEBYTECODE: "", PYTHONPYCACHEPREFIX: path.join(runtimeRoot, "caller-cache") },
      });
      assert.equal(result.ok, true, result.error || result.stderr);
    }
    assert.deepEqual(pythonArtifacts(resourcesRoot), [], "packaged resources must remain free of Python bytecode");
    console.log("packaged Workforce runtime verification: PASS");
  } catch (error) {
    exitCode = 1;
    console.error("packaged Workforce runtime verification: FAIL", error);
  } finally {
    try { fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    if (electronApp) electronApp.exit(exitCode);
    else process.exitCode = exitCode;
  }
})();
