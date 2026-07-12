#!/usr/bin/env node
/*
 * Loopback-only Android integration helper. It issues one fresh production
 * pairing payload through the installed renderer only after the phone asks,
 * returns it once, and exits. It never logs the nonce or certificate material.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

const { chromium } = require("playwright");

const port = Number.parseInt(process.env.AGENTLAS_PAIRING_SERVER_PORT || "17888", 10);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "invalid pairing server port");

const route = `/pairing/${crypto.randomBytes(18).toString("base64url")}`;
let consumed = false;
let inFlight = false;

async function issuePairing() {
  const browser = await chromium.connectOverCDP(
    process.env.AGENTLAS_LIVE_CDP_URL || "http://127.0.0.1:9223",
  );
  try {
    const page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("agentlas://"));
    assert.ok(page, "installed Agentlas renderer was not found");
    const payload = await page.evaluate(() => window.agentlas.mobileBridge.issuePairing());
    assert.equal(payload.version, 1);
    assert.match(payload.hostId, /^host_[a-f0-9]{32}$/);
    assert.match(payload.code, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(Date.parse(payload.expiresAt) > Date.now());
    return payload;
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== route) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  if (consumed || inFlight) {
    response.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
    response.end("pairing payload already consumed");
    return;
  }
  inFlight = true;
  try {
    const payload = await issuePairing();
    const body = JSON.stringify(payload);
    consumed = true;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body, () => server.close());
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("pairing unavailable");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    server.close();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}${route}` }));
});

const expiryTimer = setTimeout(() => {
  console.error("pairing helper expired before the phone requested a payload");
  process.exitCode = 1;
  server.close();
}, 5 * 60 * 1000);
expiryTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
