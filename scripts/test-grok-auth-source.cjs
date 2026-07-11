#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-grok-auth-"));
const auth = path.join(temp, "auth.json");
const now = Date.parse("2026-07-11T00:00:00.000Z");
const { grokOAuthReady } = require("../dist/electron/multimodal/availability.js");

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
  console.log("Grok OAuth source classification contract passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function write(value) {
  fs.writeFileSync(auth, JSON.stringify(value), { mode: 0o600 });
}

process.exit(0);
