#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pairing = require("../dist/electron/mobile-bridge/pairing.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-auth-revoke-"));
const devicePath = pairing.mobileBridgeDeviceStorePath(root);
fs.mkdirSync(path.dirname(devicePath), { recursive: true, mode: 0o700 });

const activeId = `device_${"a".repeat(32)}`;
const alreadyRevokedId = `device_${"b".repeat(32)}`;
const issuedAt = "2026-07-18T00:00:00.000Z";
const priorRevokedAt = "2026-07-18T00:01:00.000Z";
fs.writeFileSync(devicePath, JSON.stringify({
  version: 1,
  devices: [
    {
      deviceId: activeId,
      tokenHash: "c".repeat(64),
      name: "Mason iPhone",
      platform: "ios",
      appVersion: "1.0.0",
      issuedAt,
      revokedAt: null,
    },
    {
      deviceId: alreadyRevokedId,
      tokenHash: "d".repeat(64),
      name: "Old Android",
      platform: "android",
      appVersion: null,
      issuedAt,
      revokedAt: priorRevokedAt,
    },
  ],
}), { mode: 0o600 });

const revokedAt = new Date("2026-07-18T00:02:00.000Z");
assert.deepEqual(
  pairing.revokeAllStoredMobileBridgeDevices(root, revokedAt),
  [activeId],
  "auth loss must revoke every currently active durable device credential",
);
const after = JSON.parse(fs.readFileSync(devicePath, "utf8"));
assert.equal(after.devices[0].revokedAt, revokedAt.toISOString());
assert.equal(after.devices[1].revokedAt, priorRevokedAt, "an earlier revocation receipt must remain unchanged");

const stable = fs.readFileSync(devicePath, "utf8");
assert.deepEqual(pairing.revokeAllStoredMobileBridgeDevices(root, new Date()), []);
assert.equal(fs.readFileSync(devicePath, "utf8"), stable, "idempotent auth revocation must not rewrite the ledger");

const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-auth-revoke-corrupt-"));
const corruptPath = pairing.mobileBridgeDeviceStorePath(corruptRoot);
fs.mkdirSync(path.dirname(corruptPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(corruptPath, "{not-json", { mode: 0o600 });
assert.throws(
  () => pairing.revokeAllStoredMobileBridgeDevices(corruptRoot, revokedAt),
  /JSON|Unexpected|invalid/i,
  "a corrupt credential ledger must fail closed",
);
assert.equal(fs.readFileSync(corruptPath, "utf8"), "{not-json", "corrupt state must never be overwritten");

if (process.platform !== "win32") {
  assert.equal(fs.statSync(devicePath).mode & 0o777, 0o600, "credential ledger must remain owner-only");
}

const runtimeSource = fs.readFileSync(path.join(__dirname, "../electron/mobile-bridge/runtime.ts"), "utf8");
const ipcSource = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.ts"), "utf8");
assert.match(
  runtimeSource,
  /!getSessionCookieHeader\(\)[\s\S]*revokeAllStoredMobileBridgeDevices\(options\.userDataPath\)/,
  "a signed-out Desktop boot must revoke credentials before the bridge accepts sockets",
);
assert.match(
  ipcSource,
  /auth:signOut[\s\S]*revokeAllMobileBridgeDevicesForAuthChange[\s\S]*await signOut\(\)/,
  "explicit logout must revoke and disconnect phones before dropping account authority",
);
assert.match(
  mainSource,
  /onAuthSessionInvalidated\([\s\S]*revokeAllMobileBridgeDevicesForAuthChange/,
  "silent expiry or server invalidation must revoke paired-device authority",
);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(corruptRoot, { recursive: true, force: true });

console.log("mobile-pair auth revocation: PASS");
process.exit(0);
