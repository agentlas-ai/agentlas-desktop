#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-python-cache-boundary-"));
const resourcesRoot = path.join(tempDir, "Agentlas.app", "Contents", "Resources");
const runtimeRoot = path.join(resourcesRoot, "Hephaestus");
const packageRoot = path.join(runtimeRoot, "agentlas_cloud");
const userData = path.join(tempDir, "user-data");

function writeFile(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf8");
}

function allFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(absolute) : [absolute];
  });
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

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSourceCoverage() {
  const sources = {
    engine: fs.readFileSync(path.join(root, "electron", "hephaestus", "engine.ts"), "utf8"),
    studio: fs.readFileSync(path.join(root, "electron", "hephaestus", "studio.ts"), "utf8"),
    keyframes: fs.readFileSync(path.join(root, "electron", "oberon", "keyframes.ts"), "utf8"),
  };

  assert.match(
    sources.engine,
    /crossSpawn\(candidate, args, \{ env,[\s\S]*const env = withPythonCacheBoundary\(withCliPath\(\{ \.\.\.process\.env \}\)\);[\s\S]*probePython\(candidate, env\)/,
    "Python interpreter probes must inherit the bytecode boundary",
  );
  assert.match(
    sources.engine,
    /const env = withPythonCacheBoundary\(withCliPath\(\{[\s\S]*HEPHAESTUS_RUNTIME_ROOT:[\s\S]*\}\)\);[\s\S]*crossSpawn\(py\.python, fullArgs, \{[\s\S]*env,/,
    "Agentlas OS module runs must inherit the bytecode boundary after caller env merging",
  );
  assert.match(
    sources.studio,
    /const env = withPythonCacheBoundary\(withCliPath\(\{[\s\S]*STUDIO_REQUEST_TOKEN:[\s\S]*\}\)\);[\s\S]*crossSpawn\(py\.python, args, \{ cwd: runRoot, env,/,
    "the embedded Studio Python launcher must inherit the bytecode boundary",
  );
  assert.match(
    sources.keyframes,
    /spawn\(\s*pythonBin,[\s\S]*env: withPythonCacheBoundary\(process\.env\),/,
    "the Oberon Python batch runner must inherit the bytecode boundary",
  );

  const electronRoot = path.join(root, "electron");
  const pythonLaunchPattern = /\b(?:crossSpawn|spawn|spawnSync|execFile|execFileSync)\(\s*(?:candidate|py\.python|pythonBin|["']python(?:3)?["'])/g;
  const inventory = [];
  for (const filePath of allFiles(electronRoot).filter((file) => file.endsWith(".ts"))) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const _match of source.matchAll(pythonLaunchPattern)) {
      inventory.push(path.relative(root, filePath));
    }
  }
  assert.deepEqual(
    inventory.sort(),
    [
      "electron/hephaestus/engine.ts",
      "electron/hephaestus/engine.ts",
      "electron/hephaestus/studio.ts",
      "electron/oberon/keyframes.ts",
    ].sort(),
    "every direct production Python spawn must be inventoried and routed through the shared boundary",
  );
}

writeFile(path.join(packageRoot, "__init__.py"), "from . import probe\n");
writeFile(path.join(packageRoot, "probe.py"), "VALUE = 'loaded'\n");
writeFile(
  path.join(packageRoot, "__main__.py"),
  [
    "import json",
    "import os",
    "from . import probe",
    "print(json.dumps({",
    "  'value': probe.VALUE,",
    "  'dontWrite': os.environ.get('PYTHONDONTWRITEBYTECODE'),",
    "  'cachePrefix': os.environ.get('PYTHONPYCACHEPREFIX'),",
    "}))",
  ].join("\n"),
);

process.env.HEPHAESTUS_RUNTIME_ROOT = runtimeRoot;
app.setPath("userData", userData);

(async () => {
  let exitCode = 0;
  try {
    assertSourceCoverage();

    const { pythonCachePrefix, withPythonCacheBoundary } = require("../dist/electron/runtime/python-cache.js");
    app.setPath("userData", path.join(process.resourcesPath, "forbidden-python-cache-test"));
    const protectedFallback = pythonCachePrefix();
    assert.equal(
      isInside(process.resourcesPath, protectedFallback),
      false,
      "an unsafe userData override must fall back outside the real Electron Resources root",
    );
    app.setPath("userData", userData);
    const expectedPrefix = path.join(userData, "cache", "python-bytecode");
    assert.equal(pythonCachePrefix(), expectedPrefix, "Python cache fallback must stay in Agentlas userData");
    assert.equal(isInside(resourcesRoot, expectedPrefix), false, "Python cache prefix must stay outside Resources");

    const hostile = withPythonCacheBoundary({
      PYTHONDONTWRITEBYTECODE: "",
      PYTHONPYCACHEPREFIX: path.join(runtimeRoot, "caller-controlled-cache"),
    });
    assert.equal(hostile.PYTHONDONTWRITEBYTECODE, "1", "callers cannot re-enable Python bytecode writes");
    assert.equal(hostile.PYTHONPYCACHEPREFIX, expectedPrefix, "callers cannot redirect cache writes into the app bundle");

    const { runHephaestus } = require("../dist/electron/hephaestus/engine.js");
    const result = await runHephaestus("agentlas_cloud", [], {
      cwd: tempDir,
      timeoutMs: 20_000,
      locale: "en",
      env: {
        PYTHONDONTWRITEBYTECODE: "",
        PYTHONPYCACHEPREFIX: path.join(runtimeRoot, "caller-controlled-cache"),
      },
    });
    assert.equal(result.ok, true, result.error || result.stderr);
    assert.deepEqual(result.json, {
      value: "loaded",
      dontWrite: "1",
      cachePrefix: expectedPrefix,
    });

    const forbidden = pythonArtifacts(resourcesRoot);
    assert.deepEqual(forbidden, [], `signed Resources gained Python bytecode: ${forbidden.join(", ")}`);
    console.log("test-python-cache-boundary: PASS (direct spawn inventory + live Agentlas OS no-pyc proof)");
  } catch (error) {
    exitCode = 1;
    console.error("test-python-cache-boundary: FAIL", error);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    app.exit(exitCode);
  }
})();
