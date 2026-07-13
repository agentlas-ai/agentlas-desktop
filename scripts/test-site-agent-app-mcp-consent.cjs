#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

process.env.AGENTLAS_E2E = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-mcp-consent-"));
app.setPath("userData", path.join(tmp, "user-data"));
app.setPath("home", path.join(tmp, "home"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const {
    createSiteProject,
    getSiteProject,
    siteProjectForRenderer,
  } = require("../dist/electron/site/store.js");
  const {
    recommendSiteAgentAppMcpForProject,
    recordSiteAgentAppMcpDecision,
    siteAgentAppMcpCredentialMode,
  } = require("../dist/electron/site/agent-app-mcp-plan.js");
  const { getCatalogEntry } = require("../dist/electron/mcp-tools/catalog.js");
  const {
    validSiteAgentAppMcpConsentDecision,
  } = require("../dist/electron/site/agent-app-mcp-consent.js");

  assert.equal(siteAgentAppMcpCredentialMode(getCatalogEntry("brave-search")), "key-required");
  assert.equal(siteAgentAppMcpCredentialMode(getCatalogEntry("filesystem")), "keyless",
    "catalog rows must distinguish key-required from keyless even when a keyless tool is not Agent App allowlisted");

  const project = createSiteProject({
    name: "Consent research app",
    surface: "agent-app",
    agentAppTarget: {
      kind: "agent",
      id: "fixture-agent",
      name: "Research Agent",
      description: "Safe fixture",
      memberCount: 1,
    },
    astryxTemplate: "ai-chat-landing",
    agentAppContract: {
      schemaVersion: 1,
      source: "declared-package",
      inputs: [{
        name: "topic",
        type: "string",
        label: "Topic",
        description: "Topic",
        required: true,
        format: "textarea",
        options: [],
        defaultValue: null,
      }],
      outputs: [{ name: "brief", label: "Brief", type: "markdown", description: "Brief" }],
      capabilities: {
        schemaVersion: 1,
        source: "declared-package",
        readonlyMcpCatalogIds: ["brave-search"],
        unavailable: [],
      },
    },
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES (?, 'brave-search', 'Brave Search', 'Brave Search', 'stdio', ?, ?, NULL, '["BRAVE_API_KEY"]', 1, ?)`,
  ).run("fixture-brave", process.execPath, JSON.stringify([__filename]), now);

  const before = await recommendSiteAgentAppMcpForProject(getSiteProject(project.id));
  assert.equal(before.status, "review-required");
  assert.deepEqual(before.rows.map((row) => ({
    catalogId: row.catalogId,
    credentialMode: row.credentialMode,
    keyState: row.keyState,
    readiness: row.readiness,
  })), [{
    catalogId: "brave-search",
    credentialMode: "key-required",
    keyState: "missing",
    readiness: "missing-key",
  }]);
  assert.equal(JSON.stringify(before).includes("BRAVE_API_KEY"), false, "recommendation must not expose key names");
  assert.equal(JSON.stringify(before).includes(process.execPath), false, "recommendation must not expose executable paths");

  const approved = await recordSiteAgentAppMcpDecision(project.id, "approved");
  assert.equal(approved.status, "approved");
  assert.ok(approved.receiptId);
  const persisted = getSiteProject(project.id);
  assert.equal(validSiteAgentAppMcpConsentDecision(
    persisted.agentAppContract.capabilities,
    persisted.id,
    persisted.agentAppMcpConsent,
  ), "approved");

  const changedDeclaration = {
    ...persisted.agentAppContract.capabilities,
    readonlyMcpCatalogIds: [],
  };
  assert.equal(validSiteAgentAppMcpConsentDecision(
    changedDeclaration,
    persisted.id,
    persisted.agentAppMcpConsent,
  ), null, "a declaration/policy change must invalidate the old receipt");

  const degraded = await recommendSiteAgentAppMcpForProject(persisted, {
    listInstalled: () => { throw new Error("SENTINEL_PRIVATE_REGISTRY_FAILURE"); },
    hasCredential: async () => { throw new Error("SENTINEL_PRIVATE_KEYCHAIN_FAILURE"); },
  });
  assert.equal(degraded.status, "approved");
  assert.equal(degraded.rows[0].readiness, "not-configured");
  assert.equal(degraded.rows[0].keyState, "unknown");
  assert.equal(JSON.stringify(degraded).includes("SENTINEL_PRIVATE"), false);

  const declined = await recordSiteAgentAppMcpDecision(project.id, "declined");
  assert.equal(declined.status, "declined");
  assert.deepEqual(getSiteProject(project.id).agentAppMcpConsent.approvedCatalogIds, []);

  const privateRoot = path.join(tmp, "home", ".agentlas", "site", "agentapp", "private-app");
  const privateThumbnail = path.join(privateRoot, "thumbnail.png");
  const publicDto = siteProjectForRenderer({
    ...getSiteProject(project.id),
    agentAppArtifact: {
      schemaVersion: 1,
      appRecordId: "record",
      appId: "app",
      appName: "Research Agent",
      rootPath: privateRoot,
      sourceScreenId: "screen",
      status: "ready",
      launchUrl: null,
      thumbnail: { path: privateThumbnail, width: 1280, height: 720, updatedAt: now },
      publish: null,
      createdAt: now,
      updatedAt: now,
      failureReason: `build failed at ${privateRoot}/secret-source.ts`,
    },
  });
  const publicJson = JSON.stringify(publicDto);
  assert.equal("rootPath" in publicDto.agentAppArtifact, false);
  assert.equal("path" in publicDto.agentAppArtifact.thumbnail, false);
  assert.equal(publicDto.agentAppArtifact.failureReason, "agent-app-build-failed");
  assert.equal(publicJson.includes(privateRoot), false);
  assert.equal(publicJson.includes(privateThumbnail), false);

  console.log("site agent app MCP recommendation and consent receipt ok");
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(1);
});
