#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-chat-local-os-"));
process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";

const { initStore, getDb } = require("../dist/electron/store/db.js");
const {
  createChat,
  listChatMessages,
  setChatWorkingFolder,
} = require("../dist/electron/store/chats.js");
const { listAgentSurfaces } = require("../dist/electron/store/agent-surfaces.js");
const { listAgentApps } = require("../dist/electron/store/agent-apps.js");
const { listFirms } = require("../dist/electron/store/firms.js");
const { runMcpInvocation } = require("../dist/electron/mcp/client.js");

function seedAgent() {
  const now = "2026-05-31T00:00:00.000Z";
  getDb()
    .prepare(
      `INSERT INTO installed_agents (
        id, slug, name, tagline, system_prompt, mcp_servers_json,
        trust_grade, installed_at, tone, env_requirements_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-local-chat-smoke",
      "local-chat-smoke",
      "Local Chat Smoke Agent",
      "Uses built-in Agentlas OS when no model runtime is active",
      "If a business intent can be handled by Agentlas OS primitives, create and operate it locally.",
      "[]",
      "A",
      now,
      "green",
      "[]",
    );
}

(async () => {
  try {
    initStore();
    seedAgent();
    const chat = createChat({
      agentId: "agent-local-chat-smoke",
      title: "Local Agent OS chat smoke",
    });
    setChatWorkingFolder(chat.id, baseDir);

    const events = [];
    await runMcpInvocation(
      {
        chatId: chat.id,
        userPrompt: "쇼핑몰 사업하고 싶어. 여자옷 판매, 결제, 디비, 이미지 생성, 주문 운영 대시보드까지 알아서 해줘.",
        locale: "ko",
        permissions: "full",
      },
      (event) => events.push(event),
    );

    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.equal(events.some((event) => event.kind === "surface" && event.surface?.domain === "ecommerce"), true);
    assert.equal(events.some((event) => event.kind === "final" && /local meta-agent/i.test(event.text || "")), true);

    const messages = listChatMessages(chat.id);
    assert.equal(messages.some((message) => message.role === "user" && /쇼핑몰 사업/.test(message.text)), true);
    assert.equal(messages.some((message) => message.role === "system" && /hands-free/i.test(message.text)), true);
    assert.equal(messages.some((message) => message.role === "assistant" && /Agentlas local meta-agent/.test(message.text)), true);

    const surfaces = listAgentSurfaces(chat.id);
    assert.equal(surfaces.length, 1);
    assert.equal(surfaces[0].layout, "service-app");

    const apps = listAgentApps(chat.id);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].status, "tool-published");
    assert.ok(fs.existsSync(apps[0].previewPath));
    assert.ok(fs.existsSync(path.join(apps[0].rootPath, "data", "operations.json")));

    const firms = listFirms();
    assert.equal(firms.length, 1);
    assert.equal(firms[0].orgChart.length, 13);

    console.log("chat-local-agent-os smoke passed");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
})()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
