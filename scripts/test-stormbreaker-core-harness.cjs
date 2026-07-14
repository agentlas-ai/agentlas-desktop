#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-stormbreaker-core-"));
const runtimeRoot = path.join(temp, "runtime");
const moduleDir = path.join(runtimeRoot, "agentlas_cloud");
fs.mkdirSync(moduleDir, { recursive: true });
process.env.HEPHAESTUS_RUNTIME_ROOT = runtimeRoot;
app.setPath("userData", path.join(temp, "user-data"));

const prompt = [
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

async function main() {
  await app.whenReady();
  const { stormbreakerHarness } = require("../dist/electron/hephaestus/commands.js");

  const digest = createHash("sha256").update(prompt).digest("hex");
  writeHarness(prompt, digest);
  const valid = await stormbreakerHarness({ cwd: temp });
  assert.equal(valid.system_prompt, prompt);
  assert.equal(valid.prompt_sha256, digest);

  writeHarness(`${prompt}\nTAMPERED`, digest);
  await assert.rejects(
    () => stormbreakerHarness({ cwd: temp }),
    /SHA-256 integrity check/,
    "Desktop must fail closed when Core prompt bytes do not match the signed digest",
  );

  console.log("stormbreaker core harness contract ok");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
