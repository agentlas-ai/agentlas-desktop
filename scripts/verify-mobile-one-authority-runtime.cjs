#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function insertCoordinator(db) {
  db.prepare(
    `INSERT OR REPLACE INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 1, 'orchestrator', 'visible', 'agent')`,
  ).run(
    "one-mobile-coordinator",
    "agentlas-orchestrator",
    "One",
    "One",
    "Canonical One coordinator",
    "Canonical One coordinator",
    "Coordinate locally within the admitted One boundary.",
    "2026-07-18T00:00:00.000Z",
  );
}

function request(id, params) {
  return {
    v: 1,
    type: "request",
    id,
    method: "one.invoke.start",
    params,
  };
}

async function worker() {
  process.env.AGENTLAS_E2E = "1";
  const { app } = require("electron");
  const userData = argument("--user-data");
  if (!userData) throw new Error("worker requires --user-data");
  app.setPath("userData", userData);
  await app.whenReady();

  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  insertCoordinator(db);

  const { createMobileBridgeAuthority } = require("../dist/electron/mobile-bridge/authority.js");
  const { invocationService } = require("../dist/electron/invocation/service.js");
  const { getChat } = require("../dist/electron/store/chats.js");
  const { findCanonicalTaskForChat } = require("../dist/electron/store/tasks.js");
  const hostId = "host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const authority = createMobileBridgeAuthority({
    hostIdentity: {
      version: 1,
      hostId,
      createdAt: "2026-07-18T00:00:00.000Z",
    },
    displayName: "Mobile One authority test",
    appVersion: "0.8.99-test",
    onError: () => {},
  });
  const pairedContext = {
    connectionId: "mobile-one-test",
    remoteAddress: "127.0.0.1",
    connectedAt: "2026-07-18T00:00:00.000Z",
    deviceId: "device_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    deviceName: "Test iPhone",
    devicePlatform: "ios",
    devBootstrap: false,
  };
  const originalStart = invocationService.start;
  const captured = [];
  invocationService.start = (input, binding) => {
    captured.push({ input, binding });
    return { runId: `run_mobile_one_${captured.length}` };
  };

  try {
    const beforeChats = db.prepare("SELECT COUNT(*) AS count FROM chats").get().count;
    const receipt = await authority.request(
      request("one_valid", {
        schemaVersion: 1,
        userPrompt: "Summarize the launch risks.",
        permissions: "full",
        images: [{ mediaType: "image/png", name: "risk.png", data: "iVBORw0KGgo=" }],
      }),
      pairedContext,
    );
    assert.deepEqual(Object.keys(receipt).sort(), [
      "authoritativeHostRef",
      "chatId",
      "runId",
      "schemaVersion",
    ]);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.authoritativeHostRef, hostId);
    assert.equal(receipt.runId, "run_mobile_one_1");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chats").get().count, beforeChats + 1);

    const admitted = captured[0];
    assert.deepEqual(Object.keys(admitted.input).sort(), [
      "borrowAgents",
      "chatId",
      "hubMode",
      "images",
      "oneMode",
      "permissions",
      "sessionRouting",
      "taskIntent",
      "userPrompt",
    ]);
    assert.equal(admitted.input.chatId, receipt.chatId);
    assert.equal(admitted.input.oneMode, true);
    assert.equal(admitted.input.taskIntent, "conversation");
    assert.equal(admitted.input.permissions, "full");
    assert.equal(admitted.input.sessionRouting, false);
    assert.equal(admitted.input.hubMode, "local-only");
    assert.deepEqual(admitted.input.borrowAgents, []);
    assert.deepEqual(admitted.binding, {
      source: "mobile-one",
      canonicalPath: null,
      directoryIdentity: null,
    });
    assert.equal(getChat(receipt.chatId).agentId, "one-mobile-coordinator");
    assert.equal(getChat(receipt.chatId).projectId, null);
    assert.equal(findCanonicalTaskForChat(receipt.chatId), null, "a simple One turn must remain Task-free");

    await assert.rejects(
      authority.request(
        request("one_dev_blocked", { schemaVersion: 1, userPrompt: "Hello" }),
        {
          ...pairedContext,
          deviceId: "device_dev_bootstrap",
          devicePlatform: "dev",
          devBootstrap: true,
        },
      ),
      /pairing credential issued after account verification/,
    );
    await assert.rejects(
      authority.request(
        request("one_fake_device_blocked", { schemaVersion: 1, userPrompt: "Hello" }),
        { ...pairedContext, deviceId: "device_not_a_credential" },
      ),
      /pairing credential issued after account verification/,
    );
    await assert.rejects(
      authority.request(
        request("one_hostile", {
          schemaVersion: 1,
          userPrompt: "Hello",
          permissions: "invalid",
        }),
        pairedContext,
      ),
      /permissions/,
    );
    assert.equal(captured.length, 1, "invalid Mobile input must never reach InvocationService");

    db.prepare("DELETE FROM installed_agents WHERE slug = ?").run("agentlas-orchestrator");
    const beforeMissing = db.prepare("SELECT COUNT(*) AS count FROM chats").get().count;
    await assert.rejects(
      authority.request(
        request("one_missing_coordinator", { schemaVersion: 1, userPrompt: "Hello" }),
        pairedContext,
      ),
      /canonical One coordinator is not installed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chats").get().count, beforeMissing);

    insertCoordinator(db);
    const beforeAdmissionFailure = db.prepare("SELECT COUNT(*) AS count FROM chats").get().count;
    invocationService.start = () => {
      throw new Error("simulated offline runtime admission failure");
    };
    await assert.rejects(
      authority.request(
        request("one_offline_runtime", { schemaVersion: 1, userPrompt: "Hello" }),
        pairedContext,
      ),
      /simulated offline runtime admission failure/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chats").get().count,
      beforeAdmissionFailure,
      "failed admission must roll back its empty conversation",
    );

    console.log(JSON.stringify({
      ok: true,
      taskFree: true,
      deviceCredentialGuard: true,
      hostileFieldsRejected: true,
      admissionRollback: true,
    }));
  } finally {
    invocationService.start = originalStart;
    authority.dispose();
    db.close();
    app.quit();
  }
}

function orchestrate() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-one-authority-"));
  const env = {
    ...process.env,
    AGENTLAS_STORE_PATH: path.join(temp, "one-mobile.sqlite"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(
      process.execPath,
      [__filename, "--worker", `--user-data=${path.join(temp, "user-data")}`],
      { env, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`Mobile One authority worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    process.stdout.write(result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  worker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
