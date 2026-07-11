#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const afterPack = require("../build-resources/after-pack-clean.cjs").default;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-after-pack-runtime-"));
const previousRef = process.env.HEPHAESTUS_REF;

function fixture(platform, suffix, compatibilityVersion = "1.1.14") {
  const projectDir = path.join(temp, `project-${suffix}`);
  const appOutDir = path.join(temp, `output-${suffix}`);
  const resourcesDir = platform === "darwin"
    ? path.join(appOutDir, "Agentlas.app", "Contents", "Resources")
    : path.join(appOutDir, "resources");
  const sourceRoot = path.join(projectDir, "Hephaestus");
  const packagedRoot = path.join(resourcesDir, "Hephaestus");
  fs.mkdirSync(path.join(sourceRoot, "agentlas_cloud"), { recursive: true });
  fs.mkdirSync(path.join(packagedRoot, "agentlas_cloud"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "manifest.json"), JSON.stringify({ version: "1.1.14" }));
  fs.writeFileSync(path.join(packagedRoot, "manifest.json"), JSON.stringify({ version: "1.1.14" }));
  fs.writeFileSync(path.join(packagedRoot, "agentlas_cloud", "__main__.py"), "# fixture\n");
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
    agentlasUpdateCompatibility: { bundledRuntimeVersion: compatibilityVersion },
  }));
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { projectDir, appInfo: { productFilename: "Agentlas" } },
  };
}

(async () => {
  try {
    process.env.HEPHAESTUS_REF = "v1.1.14";
    for (const platform of ["darwin", "win32", "linux"]) {
      await afterPack(fixture(platform, platform));
    }

    await assert.rejects(
      afterPack(fixture("linux", "bad-compat", "1.1.13")),
      /update compatibility runtime mismatch/,
    );

    process.env.HEPHAESTUS_REF = "v9.9.9";
    await assert.rejects(
      afterPack(fixture("linux", "bad-ref")),
      /HEPHAESTUS_REF mismatch/,
    );
    console.log("test-after-pack-runtime-contract: PASS (darwin/windows/linux + feed/ref mismatch fail-closed)");
  } finally {
    if (previousRef === undefined) delete process.env.HEPHAESTUS_REF;
    else process.env.HEPHAESTUS_REF = previousRef;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
