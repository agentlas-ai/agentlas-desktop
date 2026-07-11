#!/usr/bin/env node
/*
 * Current-Mac Mobile Bridge smoke. This deliberately reads the dev bootstrap
 * credential internally and never prints it. Production phones use pairing.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("better-sqlite3");
const { WebSocket } = require("ws");

const userData = process.env.AGENTLAS_LIVE_USER_DATA || path.join(os.homedir(), "Library", "Application Support", "Agentlas");
const bridgeDirectory = path.join(userData, "mobile-bridge");
const manifest = JSON.parse(fs.readFileSync(path.join(bridgeDirectory, "endpoint.json"), "utf8"));
const bootstrap = JSON.parse(fs.readFileSync(path.join(bridgeDirectory, "dev-bootstrap.json"), "utf8"));
const certificate = fs.readFileSync(path.join(bridgeDirectory, "server-cert.pem"), "utf8");

assert.equal(manifest.version, 1);
assert.equal(manifest.secure, true);
assert.match(manifest.certificateFingerprint, /^[a-f0-9]{64}$/);
assert.equal(bootstrap.hostId, manifest.hostId);
assert.match(bootstrap.token, /^[A-Za-z0-9_-]{43,128}$/);

const events = [];
const pending = new Map();
let requestSequence = 0;

function fingerprint(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

const socket = new WebSocket(manifest.url, {
  headers: { Authorization: `Bearer ${bootstrap.token}` },
  ca: certificate,
  rejectUnauthorized: true,
  checkServerIdentity(_host, peer) {
    if (!peer.raw || fingerprint(peer.raw) !== manifest.certificateFingerprint) {
      return new Error("Mobile Bridge certificate fingerprint mismatch");
    }
    return undefined;
  },
});

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "event") {
    events.push(message);
    return;
  }
  if (message.type !== "response" || typeof message.id !== "string") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(Object.assign(new Error(message.error?.message || "Desktop rejected request"), { code: message.error?.code }));
});

function opened() {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function rpc(method, params = {}, timeoutMs = 30_000) {
  const id = `live_${Date.now()}_${++requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} was not observed`);
}

async function main() {
  await opened();
  const ready = await waitFor((event) => event.event === "bridge.ready", 10_000, "bridge.ready");
  const initialSnapshot = await waitFor((event) => event.event === "snapshot.updated", 10_000, "initial snapshot");
  assert.equal(ready.payload.hostId, manifest.hostId);
  assert.equal(initialSnapshot.payload.host.id, manifest.hostId);

  const [host, agents, chats, activeChats, automations, usage, runtimes] = await Promise.all([
    rpc("host.status"),
    rpc("team.list"),
    rpc("chats.listRecent", { limit: 100 }),
    rpc("invoke.activeChats"),
    rpc("automations.list"),
    rpc("usage.snapshot"),
    rpc("runtime.detect"),
  ]);
  assert.equal(host.id, manifest.hostId);
  assert.equal(Array.isArray(agents), true);
  assert.equal(Array.isArray(chats), true);
  assert.equal(Array.isArray(activeChats), true);
  assert.equal(Array.isArray(automations), true);
  assert.equal(Array.isArray(usage), true);
  assert.equal(Array.isArray(runtimes), true);
  assert.ok(agents.length > 0, "the live Desktop must expose at least one installed agent");

  const db = new Database(path.join(userData, "agentlas.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const dbAgentIds = new Set(db.prepare("SELECT id FROM installed_agents").all().map((row) => row.id));
    const dbChatIds = new Set(db.prepare("SELECT id FROM chats WHERE archived_at IS NULL").all().map((row) => row.id));
    const dbAutomationIds = new Set(db.prepare("SELECT id FROM automations").all().map((row) => row.id));
    assert.equal(agents.every((agent) => dbAgentIds.has(agent.id)), true);
    assert.equal(chats.every((chat) => dbChatIds.has(chat.id)), true);
    assert.equal(automations.every((automation) => dbAutomationIds.has(automation.id)), true);

    const title = `[Mobile Bridge QA] ${new Date().toISOString()}`;
    const created = await rpc("chats.create", { agentId: agents[0].id, title });
    assert.equal(db.prepare("SELECT title FROM chats WHERE id = ?").get(created.id)?.title, title);

    let startedRunId = null;
    let steered = false;
    let cancelledRunId = null;
    try {
      const started = await rpc("invoke.start", {
        chatId: created.id,
        userPrompt: "For an integration test, use the terminal to run `sleep 20`, then reply with MOBILE_BRIDGE_FIRST.",
        locale: "en",
        permissions: "write",
      });
      startedRunId = started.runId;
      assert.match(startedRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      await waitFor(
        (event) => event.event === "invoke.event" && event.payload?.runId === startedRunId,
        15_000,
        "live invocation stream",
      );

      const steer = await rpc("invoke.steer", {
        chatId: created.id,
        userPrompt: "Steering test: stop the previous task, use the terminal to run `sleep 20`, then reply with MOBILE_BRIDGE_STEERED only.",
        locale: "en",
        permissions: "write",
        expectedRunId: startedRunId,
      });
      assert.equal(steer.accepted, true);
      assert.equal(steer.queued, true);
      assert.equal(steer.activeRunId, startedRunId);
      steered = true;

      const attachDeadline = Date.now() + 20_000;
      while (Date.now() < attachDeadline) {
        const attached = await rpc("invoke.attach", { chatId: created.id });
        if (attached?.runId && attached.runId !== startedRunId) {
          cancelledRunId = attached.runId;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(cancelledRunId, "the main-owned steering queue must start a replacement run");
      assert.equal(await rpc("invoke.cancel", { runId: cancelledRunId }), "requested");
    } finally {
      if (startedRunId && !steered) await rpc("invoke.cancel", { runId: startedRunId }).catch(() => {});
      if (cancelledRunId) await rpc("invoke.cancel", { runId: cancelledRunId }).catch(() => {});
    }

    const history = await rpc("invoke.history", { chatId: created.id, limit: 200 });
    assert.equal(Array.isArray(history), true);
    assert.equal(history.some((message) => message.role === "user" && message.text.includes("integration test")), true);
    await rpc("chats.archive", { id: created.id });
    assert.ok(db.prepare("SELECT archived_at FROM chats WHERE id = ?").get(created.id)?.archived_at);

    console.log(JSON.stringify({
      ok: true,
      hostId: host.id,
      agents: agents.length,
      chats: chats.length,
      activeChats: activeChats.length,
      automations: automations.length,
      usageProviders: usage.length,
      runtimes: runtimes.length,
      initialSeq: [ready.seq, initialSnapshot.seq],
      invocationStream: true,
      steeringQueued: steered,
      replacementCancelled: Boolean(cancelledRunId),
      historyRoundTrip: true,
      archivedQaChat: true,
    }));
  } finally {
    db.close();
  }
}

main()
  .finally(() => socket.close())
  .then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
