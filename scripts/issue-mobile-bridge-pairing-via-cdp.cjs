#!/usr/bin/env node
/*
 * Installed-app QA helper. It asks the real Electron renderer for a fresh
 * two-minute pairing payload and writes it to a caller-owned 0600 temp file.
 * The payload contains a one-time nonce and public certificate material, never
 * a device credential. The Flutter live test consumes and deletes it.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { chromium } = require("playwright");

async function main() {
  const outputArg = process.argv[2];
  assert.ok(outputArg, "usage: issue-mobile-bridge-pairing-via-cdp.cjs <absolute-output-file>");
  assert.equal(path.isAbsolute(outputArg), true, "pairing payload output path must be absolute");
  assert.equal(fs.existsSync(outputArg), false, "refusing to overwrite an existing pairing payload file");

  const browser = await chromium.connectOverCDP(
    process.env.AGENTLAS_LIVE_CDP_URL || "http://127.0.0.1:9223",
  );
  try {
    const page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("agentlas://"));
    assert.ok(page, "installed Agentlas renderer was not found through the local QA CDP endpoint");
    await page.waitForFunction(() => Boolean(window.agentlas?.mobileBridge?.issuePairing), null, {
      timeout: 5_000,
    });
    const payload = await page.evaluate(() => window.agentlas.mobileBridge.issuePairing());
    assert.equal(payload.version, 1);
    assert.match(payload.hostId, /^host_[a-f0-9]{32}$/);
    assert.match(payload.code, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(new URL(payload.endpoint).protocol, "wss:");
    assert.equal(new URL(payload.pairExchangeEndpoint).protocol, "https:");
    assert.ok(Date.parse(payload.expiresAt) > Date.now());
    fs.writeFileSync(outputArg, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log("Fresh installed-app pairing payload written for Flutter QA.");
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
