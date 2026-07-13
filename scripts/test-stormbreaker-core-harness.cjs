#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const installedMode = process.argv.includes("--installed");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-stormbreaker-core-"));
const runtimeRoot = installedMode
  ? process.env.HEPHAESTUS_RUNTIME_ROOT
  : path.join(temp, "runtime");
assert.ok(runtimeRoot, "--installed requires HEPHAESTUS_RUNTIME_ROOT");
const moduleDir = path.join(runtimeRoot, "agentlas_cloud");
if (!installedMode) fs.mkdirSync(moduleDir, { recursive: true });
process.env.HEPHAESTUS_RUNTIME_ROOT = runtimeRoot;
app.setPath("userData", path.join(temp, "user-data"));

const fixturePrompt = [
  "You are executing inside the Agentlas-owned STORMBREAKER GOAL + ULTRACODE HARNESS.",
  "GOAL MODE: fixture goal contract.",
  "ULTRACODE MODE: fixture implementation contract.",
  "DESKTOP_CORE_HARNESS_PROOF_72B1",
].join("\n");

function writeHarness(systemPrompt, digest) {
  const payload = {
    schema_version: "agentlas.stormbreaker.goal-ultracode-harness.v1",
    harness_id: "agentlas-core/stormbreaker-goal-ultracode",
    owner: "Agentlas Core",
    mode: "stormbreaker-goal-ultracode",
    system_prompt: systemPrompt,
    prompt_sha256: digest,
    host_rule: "fixture",
    inventory_rule: "fixture",
    completion_rule: "fixture",
  };
  fs.writeFileSync(
    path.join(moduleDir, "__main__.py"),
    [
      "import sys",
      "if sys.argv[1:3] == ['stormbreaker', 'harness']:",
      `    print(${JSON.stringify(JSON.stringify(payload))})`,
    ].join("\n"),
    "utf8",
  );
}

function assertNoLocalHarnessCopy() {
  const files = [
    "electron/hephaestus/commands.ts",
    "electron/hephaestus/loop-engineering.ts",
    "electron/mcp/client.ts",
  ];
  for (const relative of files) {
    const text = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.doesNotMatch(text, /["'`]GOAL MODE:\s+[^"'`]+/, `${relative} must not copy Core Goal mode`);
    assert.doesNotMatch(text, /["'`]ULTRACODE MODE:\s+[^"'`]+/, `${relative} must not copy Core UltraCode mode`);
  }
}

async function main() {
  await app.whenReady();
  const { stormbreakerHarness } = require("../dist/electron/hephaestus/commands.js");

  if (!installedMode) {
    const digest = createHash("sha256").update(fixturePrompt).digest("hex");
    writeHarness(fixturePrompt, digest);
  }
  const valid = await stormbreakerHarness({ cwd: temp });
  assert.equal(valid.system_prompt.split("GOAL MODE:").length - 1, 1);
  assert.equal(valid.system_prompt.split("ULTRACODE MODE:").length - 1, 1);
  assert.equal(createHash("sha256").update(valid.system_prompt).digest("hex"), valid.prompt_sha256);
  assertNoLocalHarnessCopy();

  const proof = {
    schema: "agentlas.desktop.cross-platform-harness-proof.v1",
    platform: process.platform,
    architecture: process.arch,
    electron: process.versions.electron,
    harness_id: valid.harness_id,
    mode: valid.mode,
    prompt_sha256: valid.prompt_sha256,
    system_prompt_utf8_base64: Buffer.from(valid.system_prompt, "utf8").toString("base64"),
  };
  if (process.env.AGENTLAS_HARNESS_PROOF_PATH) {
    const proofPath = path.resolve(process.env.AGENTLAS_HARNESS_PROOF_PATH);
    fs.mkdirSync(path.dirname(proofPath), { recursive: true });
    fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }

  if (!installedMode) {
    writeHarness(`${fixturePrompt}\nTAMPERED`, valid.prompt_sha256);
    await assert.rejects(
      () => stormbreakerHarness({ cwd: temp }),
      /SHA-256 integrity check/,
      "Desktop must fail closed when Core prompt bytes do not match the digest",
    );
  }

  console.log(JSON.stringify(proof));
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
