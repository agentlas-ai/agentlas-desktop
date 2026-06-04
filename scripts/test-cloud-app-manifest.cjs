#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const { initStore } = require("../dist/electron/store/db.js");
const { createChat } = require("../dist/electron/store/chats.js");
const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
const {
  cloudAppRootPath,
  isCloudAppRoot,
  listAgentAppOperations,
  listAgentApps,
  recordCloudAppManifest,
} = require("../dist/electron/store/agent-apps.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-app-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");

const manifest = (title, valueProp) => ({
  version: "0.1",
  kind: "surface",
  title,
  domain: "creative",
  layout: "creative-studio",
  app: {
    name: title,
    appType: "creative-tool",
    valueProp,
    routes: [
      { path: "/brief", label: "Brief", purpose: "Collect topic and channel constraints." },
      { path: "/compose", label: "Compose", purpose: "Generate editable card news slides." },
    ],
  },
  data: {
    defaults: {
      type: "json",
      value: { ratio: "4:5", slides: 5 },
    },
  },
  widgets: [{ type: "brief-panel", data: "defaults" }],
});

let exitCode = 0;
try {
  initStore();
  seedBuiltinAgents();
  const chat = createChat({ title: "Cloud Apps", kind: "division" });
  const rootPath = cloudAppRootPath("cardnews-studio");

  const first = recordCloudAppManifest({
    cloudId: "cloud_app_cardnews",
    slug: "cardnews-studio",
    version: "1.0.0",
    runtimeEngine: "cardnews",
    minDesktopVersion: "0.2.14",
    sourceUrl: "https://agentlas.cloud/api/apps/v1/cardnews-studio",
    launchUrl: "http://localhost:3000",
    devCommand: "PORT=3000 node scripts/serve.mjs",
    chatId: chat.id,
    agentId: chat.agentId,
    manifest: manifest("Cardnews Studio", "Create editable social card drafts as a local web app."),
    metadata: { source: "mongo-catalog" },
  });

  assert.equal(first.installed, true);
  assert.equal(first.rootPath, rootPath);
  assert.equal(first.app.status, "cloud-installed");
  assert.equal(first.app.scaffold.version, "1.0.0");
  assert.equal(first.app.scaffold.runtimeEngine, "cardnews");
  assert.equal(first.app.scaffold.launchUrl, "http://localhost:3000/");
  assert.equal(first.app.scaffold.devCommand, "PORT=3000 node scripts/serve.mjs");
  assert.equal(isCloudAppRoot(first.rootPath), true);

  const second = recordCloudAppManifest({
    cloudId: "cloud_app_cardnews",
    slug: "cardnews-studio",
    version: "1.0.1",
    runtimeEngine: "cardnews",
    minDesktopVersion: "0.2.14",
    sourceUrl: "https://agentlas.cloud/api/apps/v1/cardnews-studio",
    launchUrl: "http://localhost:3000",
    devCommand: "PORT=3000 node scripts/serve.mjs",
    chatId: chat.id,
    agentId: chat.agentId,
    manifest: manifest("Cardnews Studio", "Create, edit, and export card news sets from one Agentlas App."),
    metadata: { source: "mongo-catalog" },
  });

  assert.equal(second.installed, false);
  assert.equal(second.app.id, first.app.id, "same slug should update the existing App record");
  assert.equal(second.app.status, "cloud-synced");
  assert.equal(second.app.scaffold.version, "1.0.1");
  assert.equal(second.app.manifest.app.valueProp, "Create, edit, and export card news sets from one Agentlas App.");

  const apps = listAgentApps();
  assert.equal(apps.filter((entry) => entry.rootPath === rootPath).length, 1);

  const ops = listAgentAppOperations(first.app.id).map((op) => op.operation);
  assert.equal(ops.length, 2);
  assert.ok(ops.includes("install-cloud-app"));
  assert.ok(ops.includes("sync-cloud-manifest"));

  console.log("cloud app manifest smoke passed");
} catch (err) {
  exitCode = 1;
  console.error(err);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (app && typeof app.quit === "function") app.quit();
  process.exit(exitCode);
}
