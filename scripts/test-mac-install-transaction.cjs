#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const installer = fs.readFileSync(path.join(root, "scripts/install-stable-mac.sh"), "utf8");
const swap = fs.readFileSync(path.join(root, "scripts/atomic-swap-mac.swift"), "utf8");
const localConfig = fs.readFileSync(path.join(root, "electron-builder.mac-local.yml"), "utf8");
const baseConfig = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const stableConfig = fs.readFileSync(path.join(root, "electron-builder.mac-stable.yml"), "utf8");
const agentRules = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");

const stageCopy = installer.indexOf('ditto "$mount_point/Agentlas.app" "$stage_path"');
const stageTrust = installer.indexOf('verify_official_app "$stage_path"');
const preparedJournal = installer.indexOf('"--phase=prepared"');
const exchange = installer.lastIndexOf('atomic_exchange "$stage_path" /Applications/Agentlas.app');
assert.ok(stageCopy >= 0 && stageTrust > stageCopy, "candidate must be staged and then verified");
assert.ok(exchange > stageTrust && exchange > preparedJournal, "old app cannot move before staged trust+journal complete");
assert.match(swap, /renamex_np\(source, target, UInt32\(RENAME_SWAP\)\)/);
assert.match(installer, /"--phase=swapped"/);
assert.match(installer, /recover_interrupted_transaction/);
assert.doesNotMatch(installer, /mv \/Applications\/Agentlas\.app/);
assert.doesNotMatch(installer, /ditto [^\n]* \/Applications\/Agentlas\.app/);
assert.match(installer, /install_lock="\/Applications\/.agentlas-install\.lock"/);
assert.match(installer, /if ! mkdir "\$install_lock"/);
assert.match(installer, /acquire_install_lock\nrecover_interrupted_transaction/);
assert.match(installer, /rm -rf "\$install_lock"/);

assert.match(localConfig, /appId:\s*com\.agentlas\.desktop\.candidate/);
assert.match(localConfig, /productName:\s*Agentlas-Local-Candidate/);
assert.match(localConfig, /output:\s*release-local/);
assert.match(localConfig, /publish:\s*null/);
assert.match(localConfig, /identity:\s*null/);
for (const config of [baseConfig, stableConfig]) {
  assert.match(config, /afterSign:\s*build-resources\/after-sign-trust\.cjs/);
  assert.match(config, /macos-release-signing-policy\.json/);
}
assert.match(agentRules, /Never copy, `ditto`, or `mv` a local\/QA candidate/);
assert.match(agentRules, /Apple\s+Distribution, ad-hoc, or `identity=null`/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-install-journal-test-"));
const journal = path.join(temp, "transaction.json");
const helper = path.join(root, "scripts/mac-install-transaction.mjs");
const write = spawnSync(process.execPath, [
  helper,
  "write",
  `--file=${journal}`,
  "--stage=/Applications/.agentlas-install-stage.Abc123/Agentlas.app",
  "--version=0.8.33",
  "--had-existing=true",
  "--phase=prepared",
], { encoding: "utf8" });
assert.equal(write.status, 0, write.stderr);
const read = spawnSync(process.execPath, [helper, "read", `--file=${journal}`], { encoding: "utf8" });
assert.equal(read.status, 0, read.stderr);
assert.equal(read.stdout.trim(), "/Applications/.agentlas-install-stage.Abc123/Agentlas.app\t0.8.33\t1\tprepared");
assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
const clear = spawnSync(process.execPath, [helper, "clear", `--file=${journal}`], { encoding: "utf8" });
assert.equal(clear.status, 0, clear.stderr);
assert.equal(fs.existsSync(journal), false);
fs.rmSync(temp, { recursive: true, force: true });

console.log("test-mac-install-transaction: PASS (same-volume stage, atomic swap, journal, local identity isolation)");
