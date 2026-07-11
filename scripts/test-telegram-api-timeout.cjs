#!/usr/bin/env node
// Every Telegram Bot API request gets a finite deadline independent of the
// longer agent invocation timeout. The mock returns headers but stalls its body
// and ignores AbortSignal; the wrapper must still reject and abort on time.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-telegram-timeout-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_TELEGRAM_REQUEST_TIMEOUT_MS = "25";
app.setPath("userData", path.join(tempDir, "user-data"));

const TARGET_ID = "telegram-timeout-agent";
const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123456";

function seedAgent(db) {
  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TARGET_ID,
    "telegram-timeout-agent",
    "Telegram Timeout Agent",
    "Telegram Timeout Agent",
    "Test target",
    "Test target",
    "Test target",
    "[]",
    "[]",
    null,
    "A",
    new Date().toISOString(),
    "blue",
    0,
    null,
    "visible",
  );
}

async function main() {
  let exitCode = 0;
  const originalFetch = global.fetch;
  let connect;
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    seedAgent(db);

    let requestSignal = null;
    global.fetch = (_url, init) => {
      requestSignal = init?.signal ?? null;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}), // Deliberately stalls after headers and ignores abort.
      });
    };

    connect = require("../dist/electron/telegram/connect.js");
    const startedAt = Date.now();
    await assert.rejects(
      connect.startTelegramConnection({ targetKind: "agent", targetId: TARGET_ID, botToken: TOKEN }),
      /Telegram getMe request timed out after 25ms/,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 10, `request rejected too early (${elapsed}ms)`);
    assert.ok(elapsed < 1000, `request timeout was not finite (${elapsed}ms)`);
    assert.ok(requestSignal, "Telegram fetch must receive an AbortSignal");
    assert.equal(requestSignal.aborted, true, "deadline must abort the underlying fetch signal");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM telegram_bindings").get().n,
      0,
      "a timed-out token verification must not create a binding",
    );

    const source = fs.readFileSync(path.join(__dirname, "..", "electron", "telegram", "connect.ts"), "utf8");
    assert.match(source, /TELEGRAM_REQUEST_TIMEOUT_MS/, "request deadline must have its own constant");
    assert.match(source, /TELEGRAM_INVOCATION_TIMEOUT_MS/, "agent invocation timeout must remain separate");

    console.log("telegram API finite request timeout: PASS");
  } catch (err) {
    exitCode = 1;
    console.error("telegram API finite request timeout: FAIL", err);
  } finally {
    connect?.stopTelegramWorkers?.();
    global.fetch = originalFetch;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  }
}

void main();
