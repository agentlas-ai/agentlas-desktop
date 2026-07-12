#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-grok-auth-"));
const auth = path.join(temp, "auth.json");
const bin = path.join(temp, process.platform === "win32" ? "grok.exe" : "grok");
const now = Date.parse("2026-07-11T00:00:00.000Z");
const previousAuthFile = process.env.AGENTLAS_GROK_AUTH_FILE;
const previousGrokBin = process.env.AGENTLAS_GROK_BIN;
const previousHome = process.env.HOME;
const previousPath = process.env.PATH;

async function main() {
  process.env.AGENTLAS_GROK_AUTH_FILE = auth;
  process.env.AGENTLAS_GROK_BIN = bin;
  process.env.HOME = temp;
  process.env.PATH = temp;
  const { grokOAuthReady, isProviderReady } = require("../dist/electron/multimodal/availability.js");
  const { getMultimodalProvider } = require("../dist/shared/multimodal.js");

  try {
    write({ qa: { auth_mode: "oidc", refresh_token: "refresh", expires_at: "2000-01-01T00:00:00.000Z" } });
    assert.equal(grokOAuthReady(auth, now), true, "refresh token keeps an expired access session renewable");
    write({ qa: { auth_mode: "oidc", expires_at: "2099-01-01T00:00:00.000Z" } });
    assert.equal(grokOAuthReady(auth, now), true);
    write({ qa: { auth_mode: "oidc", expires_at: "2000-01-01T00:00:00.000Z" } });
    assert.equal(grokOAuthReady(auth, now), false);
    write({ qa: { auth_mode: "api_key", key: "not-oauth", expires_at: "2099-01-01T00:00:00.000Z" } });
    assert.equal(grokOAuthReady(auth, now), false, "API-key records must not masquerade as subscription OAuth");
    fs.writeFileSync(auth, "not json");
    assert.equal(grokOAuthReady(auth, now), false);

    const imageProvider = getMultimodalProvider("grok-cli-image");
    const videoProvider = getMultimodalProvider("grok-cli-video");
    assert.ok(imageProvider, "Grok image must remain in the multimodal catalog");
    assert.ok(videoProvider, "Grok video must remain in the multimodal catalog");

    fs.writeFileSync(bin, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    write({ qa: { auth_mode: "oidc", refresh_token: "refresh" } });
    assert.equal(await isProviderReady(imageProvider), true, "Grok image requires an executable CLI and OAuth");
    assert.equal(await isProviderReady(videoProvider), true, "Grok video requires an executable CLI and OAuth");

    fs.rmSync(bin, { force: true });
    assert.equal(await isProviderReady(imageProvider), false, "OAuth without the Grok CLI is not ready");

    fs.writeFileSync(bin, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    write({ qa: { auth_mode: "api_key", key: "metered-api-key" } });
    assert.equal(await isProviderReady(imageProvider), false, "API-key-only auth must not masquerade as subscription media");
    console.log("Grok OAuth source and multimodal readiness contract passed");
  } finally {
    if (previousAuthFile === undefined) delete process.env.AGENTLAS_GROK_AUTH_FILE;
    else process.env.AGENTLAS_GROK_AUTH_FILE = previousAuthFile;
    if (previousGrokBin === undefined) delete process.env.AGENTLAS_GROK_BIN;
    else process.env.AGENTLAS_GROK_BIN = previousGrokBin;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function write(value) {
  fs.writeFileSync(auth, JSON.stringify(value), { mode: 0o600 });
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
