#!/usr/bin/env node
// A broken Telegram destination must stay isolated to its own binding. The
// automation scheduler reports to every opted-in chat, so one revoked bot may
// not prevent later healthy bindings from receiving the completion report.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-telegram-report-fanout-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";
app.setPath("userData", path.join(tempDir, "user-data"));

function seedBinding(db, id, chatId, createdAt) {
  db.prepare(
    `INSERT INTO telegram_bindings
     (id, target_kind, target_id, telegram_chat_id, telegram_chat_title,
      bot_user_id, bot_username, bot_display_name, status, enabled,
      automation_report_enabled, token_saved, token_fingerprint, created_at, updated_at)
     VALUES (?, 'agent', 'fanout-agent', ?, ?, ?, ?, ?, 'chat_paired', 1, 1, 1, ?, ?, ?)`,
  ).run(
    id,
    chatId,
    `Chat ${chatId}`,
    id === "binding-a" ? 1001 : 1002,
    `${id}_bot`,
    `Bot ${id}`,
    `${id}-fingerprint`,
    createdAt,
    createdAt,
  );
}

async function main() {
  let exitCode = 0;
  const originalFetch = global.fetch;
  let vault;
  let originalReadSecret;
  let connect;
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    seedBinding(db, "binding-a", "chat-a", "2026-01-01T00:00:00.000Z");
    seedBinding(db, "binding-b", "chat-b", "2026-01-01T00:00:01.000Z");

    vault = require("../dist/electron/secrets/vault.js");
    originalReadSecret = vault.readSecret;
    vault.readSecret = async (key) => (
      key.endsWith("binding-a")
        ? "111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_111111"
        : "222222222:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_222222"
    );

    const requests = [];
    global.fetch = async (url, init) => {
      const request = { url: String(url), body: JSON.parse(String(init?.body || "{}")) };
      requests.push(request);
      if (request.body.chat_id === "chat-a") {
        return {
          ok: false,
          status: 401,
          json: async () => ({ ok: false, description: "Unauthorized fixture" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 2 } }),
      };
    };

    // Require after patching the vault; compiled imports read the export at call time.
    connect = require("../dist/electron/telegram/connect.js");
    await connect.notifyTelegramAutomationDone(
      { id: "automation-fanout", name: "Fanout proof" },
      "ok",
      { output: "complete", at: "2026-01-01T00:01:00.000Z" },
    );

    assert.equal(requests.length, 2, "one failed destination must not stop the later Telegram report");
    assert.deepEqual(new Set(requests.map((request) => request.body.chat_id)), new Set(["chat-a", "chat-b"]));
    assert.match(requests.find((request) => request.body.chat_id === "chat-b").body.text, /Fanout proof/);
    console.log("telegram automation report failure isolation: PASS");
  } catch (error) {
    exitCode = 1;
    console.error("telegram automation report failure isolation: FAIL", error);
  } finally {
    connect?.stopTelegramWorkers?.();
    global.fetch = originalFetch;
    if (vault && originalReadSecret) vault.readSecret = originalReadSecret;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    app.exit(exitCode);
  }
}

void main();
