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
      "Does not auto-call Agentlas Apps when no model runtime is active",
      "Reply through the selected runtime only. Do not create Apps, Workbench surfaces, or Agentlas OS operations automatically.",
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

    assert.equal(events.some((event) => event.kind === "error" && event.error?.code === "no-runtime"), true);
    assert.equal(events.some((event) => event.kind === "surface"), false);
    assert.equal(events.some((event) => event.kind === "final"), false);

    const messages = listChatMessages(chat.id);
    assert.equal(messages.some((message) => message.role === "assistant" && /Agentlas local meta-agent|Agentlas OS|Workbench|Creative Studio/i.test(message.text)), false);

    const surfaces = listAgentSurfaces(chat.id);
    assert.equal(surfaces.length, 0);

    const apps = listAgentApps(chat.id);
    assert.equal(apps.length, 0);

    const firms = listFirms();
    assert.equal(firms.length, 0);

    console.log("chat no-auto-app-routing smoke passed");
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
