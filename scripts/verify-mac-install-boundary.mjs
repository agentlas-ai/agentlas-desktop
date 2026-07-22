#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyMacAppBundle } from "./lib/mac-app-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.split("=");
  return [key, value.join("=") || "1"];
}));
const sourceArgument = String(args.get("--source") || "");
const destinationArgument = String(args.get("--destination") || "");
const source = sourceArgument ? resolve(sourceArgument) : "";
const destination = destinationArgument ? resolve(destinationArgument) : "";
const mode = String(args.get("--mode") || "");
const officialDestination = "/Applications/Agentlas.app";
const policyPath = resolve(root, String(args.get("--policy") || "build-resources/macos-release-signing-policy.json"));

function verifyInstallContract() {
  const installer = readFileSync(join(root, "scripts/install-stable-mac.sh"), "utf8");
  const swap = readFileSync(join(root, "scripts/atomic-swap-mac.swift"), "utf8");
  const localConfig = readFileSync(join(root, "electron-builder.mac-local.yml"), "utf8");
  const baseConfig = readFileSync(join(root, "electron-builder.yml"), "utf8");
  const stableConfig = readFileSync(join(root, "electron-builder.mac-stable.yml"), "utf8");

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
  assert.match(installer, /install_lock="\/Applications\/\.agentlas-install\.lock"/);
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

  const temp = mkdtempSync(join(tmpdir(), "agentlas-install-journal-verify-"));
  const journal = join(temp, "transaction.json");
  const helper = join(root, "scripts/mac-install-transaction.mjs");
  try {
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
    assert.equal(statSync(journal).mode & 0o777, 0o600);
    const clear = spawnSync(process.execPath, [helper, "clear", `--file=${journal}`], { encoding: "utf8" });
    assert.equal(clear.status, 0, clear.stderr);
    assert.equal(existsSync(journal), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "self-test",
    sameVolumeStage: true,
    atomicSwap: true,
    journalRecovery: true,
    localIdentityIsolated: true,
  }));
}

if (args.has("--self-test")) {
  verifyInstallContract();
  process.exit(0);
}

if (!source || !destination || !["official", "local"].includes(mode)) {
  throw new Error("--source, --destination, and --mode=official|local are required");
}
if (mode === "official") {
  if (destination !== officialDestination || basename(source) !== "Agentlas.app") {
    throw new Error("official install identity/path mismatch");
  }
  // Historical official DMGs can contain an app whose notarization is proven
  // by Gatekeeper (`source=Notarized Developer ID`) even when the inner app's
  // ticket was not stapled separately. New release packaging uses the stricter
  // default helper and requires the staple before publication.
  const trust = verifyMacAppBundle({ appPath: source, policyPath, requireStapledNotarization: false });
  if (!trust.ok) throw new Error(`official install source rejected (${trust.category})`);
  console.log(JSON.stringify({ ok: true, mode, destinationClass: "official", trustCategory: trust.category }));
} else {
  if (destination === officialDestination || basename(source) !== "Agentlas-Local-Candidate.app") {
    throw new Error("local candidate must never share the official application path/name");
  }
  const plist = join(source, "Contents", "Info.plist");
  const bundleId = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8" });
  if (bundleId.status !== 0 || bundleId.stdout.trim() !== "com.agentlas.desktop.candidate") {
    throw new Error("local candidate bundle identifier mismatch");
  }
  if (["app-update.yml", "app-update.yaml"].some((name) => existsSync(join(source, "Contents", "Resources", name)))) {
    throw new Error("local candidate contains an update feed");
  }
  console.log(JSON.stringify({ ok: true, mode, destinationClass: "isolated-local", officialFeedEmbedded: false }));
}
