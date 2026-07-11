#!/usr/bin/env node
// Telegram binding publication must be atomic across Keychain and SQLite:
// a failed secret write may not leave a token_saved=1 row for either connect or clone.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-telegram-atomicity-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";
app.setPath("userData", path.join(tempDir, "user-data"));

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123456";
const TARGET_ID = "telegram-atomicity-agent";
const SOURCE_ID = "telegram-clone-source";

function seedAgent(db) {
  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TARGET_ID,
    "telegram-atomicity-agent",
    "Telegram Atomicity Agent",
    "Telegram Atomicity Agent",
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

function seedCloneSource(db) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO telegram_bindings
     (id, target_kind, target_id, bot_user_id, bot_username, bot_display_name, status,
      enabled, token_saved, token_fingerprint, created_at, updated_at)
     VALUES (?, 'agent', ?, 424242, 'atomicity_bot', 'Atomicity Bot',
             'waiting_for_chat', 1, 1, 'source-fingerprint', ?, ?)`,
  ).run(SOURCE_ID, TARGET_ID, now, now);
}

async function main() {
  let exitCode = 0;
  const originalFetch = global.fetch;
  let vault;
  let originalSetSecret;
  let originalDeleteSecret;
  let connect;
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    seedAgent(db);
    seedCloneSource(db);

    vault = require("../dist/electron/secrets/vault.js");
    await vault.setSecret(`telegram.bot-token:${SOURCE_ID}`, TOKEN);
    originalSetSecret = vault.setSecret;
    originalDeleteSecret = vault.deleteSecret;
    const compensated = [];
    vault.setSecret = async () => {
      throw new Error("simulated Keychain write failure");
    };
    vault.deleteSecret = async (key) => {
      compensated.push(key);
      await originalDeleteSecret(key);
    };

    global.fetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: String(url).endsWith("/getMe")
          ? { id: 424242, is_bot: true, first_name: "Atomicity Bot", username: "atomicity_bot" }
          : true,
      }),
    });

    // Require after patching the vault. The compiled module resolves vault exports at call time.
    connect = require("../dist/electron/telegram/connect.js");
    const before = db.prepare("SELECT COUNT(*) AS n FROM telegram_bindings").get().n;
    assert.equal(before, 1, "fixture should contain only the clone source");

    await assert.rejects(
      connect.startTelegramConnection({ targetKind: "agent", targetId: TARGET_ID, botToken: TOKEN }),
      /simulated Keychain write failure/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM telegram_bindings").get().n,
      before,
      "connect must not publish a binding when Keychain save fails",
    );

    await assert.rejects(
      connect.cloneTelegramConnection({ sourceBindingId: SOURCE_ID, targetKind: "agent", targetId: TARGET_ID }),
      /simulated Keychain write failure/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM telegram_bindings").get().n,
      before,
      "clone must not publish a binding when Keychain save fails",
    );
    assert.equal(
      db.prepare("SELECT token_saved FROM telegram_bindings WHERE id = ?").get(SOURCE_ID).token_saved,
      1,
      "a failed clone must not damage the valid source binding",
    );
    assert.equal(compensated.length, 2, "both failed writes should run compensating secret cleanup");
    assert.ok(compensated.every((key) => key.startsWith("telegram.bot-token:")));

    console.log("telegram connect Keychain/SQLite atomicity: PASS");
  } catch (err) {
    exitCode = 1;
    console.error("telegram connect Keychain/SQLite atomicity: FAIL", err);
  } finally {
    connect?.stopTelegramWorkers?.();
    global.fetch = originalFetch;
    if (vault && originalSetSecret) vault.setSecret = originalSetSecret;
    if (vault && originalDeleteSecret) vault.deleteSecret = originalDeleteSecret;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  }
}

void main();
