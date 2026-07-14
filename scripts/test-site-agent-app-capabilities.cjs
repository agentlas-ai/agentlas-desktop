#!/usr/bin/env node
// Canonical contract + one-run read-only capability behavior. The verifier is
// deterministic and no MCP/model/network/browser process is started.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-capabilities-"));
app.setPath("userData", path.join(tmp, "user-data"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const { selectAgentAppRuntimeForTargets } = require("../dist/electron/runtime/selection.js");
  const runtimeTargets = [{ scope: "agent", targetId: "site-capability-agent" }];
  const codexFallback = selectAgentAppRuntimeForTargets([
    { kind: "codex", backend: null, source: "/fixture/codex", version: "test", active: true },
    { kind: "claude-code", backend: null, source: "/fixture/claude", version: "test", active: false },
  ], runtimeTargets);
  assert.ok(codexFallback?.picked, "a Codex target must retain a usable stateless Agent App path");
  assert.equal(codexFallback.active.kind, "claude-code");
  assert.equal(codexFallback.capabilityRuntimeEligible, false, "fallback Claude must not inherit the Codex target's Brave grant");
  assert.equal(codexFallback.fallbackFromKind, "codex");
  const claudePreferred = selectAgentAppRuntimeForTargets([
    { kind: "claude-code", backend: null, source: "/fixture/claude", version: "test", active: true },
  ], runtimeTargets);
  assert.equal(claudePreferred?.capabilityRuntimeEligible, true);
  assert.equal(claudePreferred?.fallbackFromKind, null);

  const packageRoot = path.join(tmp, "declared-agent");
  fs.mkdirSync(path.join(packageRoot, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, ".agentlas", "routing-card.json"), JSON.stringify({
    schemaVersion: "routing-card/2.0",
    type: "agent",
    name: "Verified Research Agent",
    summary: "Researches a topic using its explicitly declared read-only search capability.",
    required_inputs: [{ name: "topic", type: "text", description: "Question to research" }],
    optional_inputs: ["source constraints"],
    produces: [{ kind: "cited_brief", description: "Evidence-backed brief" }],
    required_plugins: ["brave-search", "filesystem", "hephaestus-network"],
    approval_requirements: ["network_access", "file_write"],
    memory_behavior: { reads: "project", writes: "project" },
  }, null, 2));

  const { readResolvedSiteAgentAppContract } = require("../dist/electron/site/agent-app-contract.js");
  const declared = readResolvedSiteAgentAppContract(packageRoot);
  assert.ok(declared, "routing-card/2.0 must resolve as a canonical Agent App contract");
  assert.equal(declared.contract.source, "declared-routing-card");
  assert.deepEqual(declared.contract.inputs.map((field) => field.name), ["topic", "source-constraints"]);
  assert.deepEqual(declared.contract.outputs.map((field) => field.name), ["cited_brief"]);
  assert.deepEqual(declared.contract.capabilities.readonlyMcpCatalogIds, ["brave-search"]);
  assert.ok(declared.contract.capabilities.unavailable.some((issue) =>
    issue.id === "filesystem" && issue.reason === "not-allowlisted"));
  assert.ok(declared.contract.capabilities.unavailable.some((issue) =>
    issue.id === "hephaestus-network" && issue.reason === "not-allowlisted"));
  assert.ok(declared.contract.capabilities.unavailable.some((issue) =>
    issue.id === "file_write" && issue.reason === "blocked-by-agent-app-policy"));
  assert.ok(declared.contract.capabilities.unavailable.some((issue) =>
    issue.id === "persistence" && issue.reason === "blocked-by-agent-app-policy"));

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES (?, ?, ?, ?, 'stdio', ?, ?, NULL, '[]', 1, ?)`,
  ).run(
    "site-capability-brave",
    "brave-search",
    "Brave Search",
    "Brave Search",
    process.execPath,
    JSON.stringify([__filename]),
    now,
  );

  const { prepareSiteAgentAppCapabilities } = require("../dist/electron/site/agent-app-capabilities.js");
  let incompatibleVerificationCalls = 0;
  const incompatibleRuntime = await prepareSiteAgentAppCapabilities(
    declared.contract.capabilities,
    "codex-fixture",
    {
      runtimeEligible: false,
      verifyServer: async () => {
        incompatibleVerificationCalls += 1;
        throw new Error("must not verify for an ineligible runtime");
      },
    },
  );
  assert.equal(incompatibleVerificationCalls, 0, "a non-Claude runtime must downgrade before MCP verification");
  assert.equal(incompatibleRuntime.grant, null, "an ineligible runtime must never receive the grant");
  assert.deepEqual(incompatibleRuntime.disclosure.available, []);
  assert.ok(incompatibleRuntime.disclosure.unavailable.some((issue) =>
    issue.id === "brave-search" && issue.reason === "runtime-unavailable"));

  let verificationCalls = 0;
  const prepared = await prepareSiteAgentAppCapabilities(
    declared.contract.capabilities,
    "safe-fixture",
    {
      verifyServer: async (server) => {
        verificationCalls += 1;
        assert.equal(server.id, "site-capability-brave");
        return {
          id: server.id,
          connected: true,
          tools: [{ name: "brave_web_search" }, { name: "brave_local_search" }],
          error: null,
          missingEnv: [],
          checkedAt: new Date().toISOString(),
        };
      },
    },
  );
  assert.equal(verificationCalls, 1, "the installed server must be verified immediately before grant creation");
  assert.ok(prepared.grant, "a pinned, enabled, currently verified server must receive a one-run grant");
  assert.equal(prepared.grant.runtimeStatus, "prepared");
  assert.deepEqual(prepared.grant.availableCatalogIds, ["brave-search"]);
  assert.deepEqual(prepared.grant.mcpAllowedTools, [
    "mcp__brave-search__brave_web_search",
    "mcp__brave-search__brave_local_search",
  ]);
  const configText = fs.readFileSync(prepared.grant.mcpConfigPath, "utf8");
  const config = JSON.parse(configText);
  assert.deepEqual(Object.keys(config.mcpServers), ["brave-search"]);
  assert.equal(/\bnpx\b|(?:^|\s)-y(?:\s|$)|@modelcontextprotocol\/server-brave-search/.test(configText), false,
    "Agent App must not serialize a package-manager download command");
  assert.equal(configText.includes("filesystem"), false);
  assert.equal(configText.includes("hephaestus"), false);
  prepared.grant.runtimeStatus = "runtime-unavailable";
  assert.deepEqual(prepared.finalDisclosure().available, [], "a post-preflight runtime change must downgrade disclosure");
  assert.ok(prepared.finalDisclosure().unavailable.some((issue) =>
    issue.id === "brave-search" && issue.reason === "runtime-unavailable"));
  const configPath = prepared.grant.mcpConfigPath;
  prepared.cleanup();
  assert.equal(fs.existsSync(configPath), false, "the one-run MCP config must be removed after invocation");

  // A catalog row alone is not an installation. In particular, never run the
  // catalog's unpinned `npx -y` command to discover whether it works.
  db.prepare("UPDATE mcp_servers SET command = ?, args_json = ? WHERE id = ?").run(
    "npx",
    JSON.stringify(["-y", "@modelcontextprotocol/server-brave-search"]),
    "site-capability-brave",
  );
  let unsafeVerificationCalls = 0;
  const rejected = await prepareSiteAgentAppCapabilities(
    declared.contract.capabilities,
    "unpinned-fixture",
    { verifyServer: async () => {
      unsafeVerificationCalls += 1;
      throw new Error("must not execute");
    } },
  );
  assert.equal(unsafeVerificationCalls, 0, "unpinned npx rows must be rejected before connection testing");
  assert.equal(rejected.grant, null);
  assert.ok(rejected.disclosure.unavailable.some((issue) =>
    issue.id === "brave-search" && issue.reason === "not-configured"));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("site agent app declared capability behavior ok");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(1);
});
