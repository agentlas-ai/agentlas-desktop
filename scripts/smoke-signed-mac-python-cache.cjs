#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const appArgument = process.argv.slice(2).find((arg) => arg.startsWith("--app="));
const signedApp = appArgument ? path.resolve(appArgument.slice("--app=".length)) : "";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-signed-python-cache-smoke-"));

function pythonArtifacts(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.name === "__pycache__") return [absolute];
    if (entry.isDirectory()) return pythonArtifacts(absolute);
    return entry.name.endsWith(".pyc") ? [absolute] : [];
  });
}

(async () => {
  let exitCode = 0;
  try {
    assert.ok(signedApp, "--app=/path/to/Agentlas.app is required");
    assert.equal(path.basename(signedApp), "Agentlas.app", "the smoke target must be Agentlas.app");
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

    const resourcesRoot = path.join(signedApp, "Contents", "Resources");
    const runtimeRoot = path.join(resourcesRoot, "Hephaestus");
    const packagedEngine = path.join(resourcesRoot, "app.asar", "dist", "electron", "hephaestus", "engine.js");
    assert.ok(fs.existsSync(path.join(runtimeRoot, "agentlas_cloud", "__main__.py")), "signed app is missing Agentlas OS");
    assert.ok(fs.existsSync(packagedEngine), "signed app is missing the packaged Desktop engine bridge");

    const isolatedHome = path.join(tempDir, "home");
    const userData = path.join(tempDir, "user-data");
    fs.mkdirSync(isolatedHome, { recursive: true });
    app.setPath("userData", userData);
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    process.env.AGENTLAS_NETWORKING_HOME = path.join(tempDir, "networking");
    process.env.HEPHAESTUS_RUNTIME_ROOT = runtimeRoot;
    // Hostile inherited values prove the packaged bridge applies its boundary
    // after all caller/process environment merging.
    process.env.PYTHONDONTWRITEBYTECODE = "";
    process.env.PYTHONPYCACHEPREFIX = path.join(runtimeRoot, "forbidden-cache");

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

    const forbidden = pythonArtifacts(resourcesRoot);
    assert.deepEqual(forbidden, [], `signed app Resources gained Python bytecode: ${forbidden.join(", ")}`);
    console.log("signed macOS Python cache exercise: PASS (packaged bridge + embedded Agentlas OS)");
  } catch (error) {
    exitCode = 1;
    console.error("signed macOS Python cache exercise: FAIL", error);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    app.exit(exitCode);
  }
})();
