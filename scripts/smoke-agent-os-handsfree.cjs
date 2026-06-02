#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-handsfree-os-"));
process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");

const { initStore, getDb } = require("../dist/electron/store/db.js");
const {
  createChat,
  listChatMessages,
  setChatWorkingFolder,
} = require("../dist/electron/store/chats.js");
const { recordAgentSurface } = require("../dist/electron/store/agent-surfaces.js");
const { getAgentAppBySurface } = require("../dist/electron/store/agent-apps.js");
const { listFirms } = require("../dist/electron/store/firms.js");
const { prepareEcommerceOpsManifest } = require("../dist/electron/ecommerce-pack/surface.js");
const {
  runHandsFreeAgentOs,
  shouldRunHandsFreeAgentOs,
} = require("../dist/electron/agent-os/hands-free.js");

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
      "agent-handsfree-smoke",
      "handsfree-smoke",
      "Hands-free Smoke Agent",
      "Turns plain business intent into operated Agentlas OS apps",
      "Create surfaces, teams, apps, fallbacks, and reusable tools without dead-ending on missing MCP/API.",
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
      agentId: "agent-handsfree-smoke",
      title: "Hands-free Agent OS smoke",
    });
    setChatWorkingFolder(chat.id, baseDir);

    const manifest = prepareEcommerceOpsManifest({
      prompt: "비개발자가 쇼핑몰 사업을 시작하려고 한다. 결제, 디비, 이미지, 주문 운영까지 에이전트가 대행해줘.",
      now: "2026-05-31T00:00:00.000Z",
    });
    assert.ok(manifest);
    assert.equal(shouldRunHandsFreeAgentOs(manifest), true);

    const surfaceId = "surface-handsfree-commerce-os";
    recordAgentSurface({
      id: surfaceId,
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      manifest,
    });

    const events = [];
    const result = await runHandsFreeAgentOs({
      chat,
      surfaceId,
      manifest,
      workingFolder: baseDir,
      sink: (event) => events.push(event),
    });

    assert.equal(result.ran, true);
    assert.equal(result.team.org.divisions.length, 4);
    assert.equal(result.team.org.divisions.reduce((sum, division) => sum + division.specialists.length, 0), 8);
    assert.equal(listFirms().some((firm) => firm.id === result.team.firm.id), true);
    assert.equal(result.autopilot.status, "operated");
    assert.ok(result.autopilot.steps.some((step) => step.id === "publish-tool" && step.status === "completed"));
    assert.ok(fs.existsSync(result.autopilot.appTool.mcpPath));

    const appRecord = getAgentAppBySurface(chat.id, surfaceId);
    assert.ok(appRecord);
    assert.equal(appRecord.status, "tool-published");
    assert.ok(fs.existsSync(appRecord.previewPath));

    const systemMessages = listChatMessages(chat.id).filter((message) => message.role === "system");
    assert.equal(systemMessages.some((message) => /hands-free/i.test(message.text)), true);
    assert.equal(events.some((event) => event.kind === "tool-use" && /creating a domain agent team/i.test(event.status)), true);

    const operationsPath = path.join(appRecord.rootPath, "data", "operations.json");
    const operationsText = fs.readFileSync(operationsPath, "utf8");
    assert.match(operationsText, /missing API\/MCP becomes browser delegation or local fallback/i);
    assert.doesNotMatch(operationsText, /4111\s*1111\s*1111\s*1111|4242\s*4242\s*4242\s*4242/i);
    assert.doesNotMatch(operationsText, /actual-password|actual-otp|actual-cvv|sk_live_/i);

    const genericManifest = {
      version: "0.1",
      kind: "surface",
      title: "Trip Planner Operator",
      domain: "travel",
      layout: "service-app",
      app: {
        name: "Trip Planner Operator",
        appType: "automation",
        routes: [{ path: "/", label: "Command", status: "planned" }],
        connectors: [],
        tools: [],
        deployment: { target: "agentlas desktop", readiness: "prototype" },
        business: { launchMetric: "first itinerary operated" },
      },
      data: {
        launch: {
          type: "launch-checklist",
          rows: [{ item: "Create itinerary workspace", status: "ready" }],
        },
      },
      widgets: [
        { type: "app-shell", data: "routes" },
        { type: "launch-checklist", data: "launch" },
      ],
      actions: [{ id: "operate-travel-app", label: "Operate app", type: "operate-app", permission: "full" }],
      evidence: [{ id: "travel_intent", kind: "claimed", source: "Smoke test" }],
      delegation: {
        mode: "agent-operated",
        autonomy: {
          mode: "agent-first",
          allowedWithoutPrompt: ["filesystem-write", "preview-package", "tool-publish"],
          checkpoints: ["paid-checkout", "raw-secret-entry"],
          noDeadEndReasons: ["missing-mcp"],
          destructiveActions: ["sudo-like deletion"],
        },
      },
      capabilities: [
        { id: "travel_app_filesystem", type: "filesystem", purpose: "Write reversible travel app files", approval: "once" },
      ],
    };
    assert.equal(shouldRunHandsFreeAgentOs(genericManifest), true);
    const genericSurfaceId = "surface-handsfree-generic-service-app";
    recordAgentSurface({
      id: genericSurfaceId,
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      manifest: genericManifest,
    });
    const genericResult = await runHandsFreeAgentOs({
      chat,
      surfaceId: genericSurfaceId,
      manifest: genericManifest,
      workingFolder: baseDir,
      sink: (event) => events.push(event),
    });
    assert.equal(genericResult.ran, true);
    assert.equal(genericResult.team, undefined);
    assert.equal(genericResult.autopilot.status, "operated");
    assert.ok(genericResult.autopilot.appTool.mcpPath.endsWith("server.mjs"));

    console.log("agent-os-handsfree smoke passed");
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
