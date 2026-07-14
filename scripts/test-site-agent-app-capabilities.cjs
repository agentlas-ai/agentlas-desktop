#!/usr/bin/env node
// Canonical contract + one-run read-only capability behavior. The verifier is
// deterministic and no MCP/model/network/browser process is started.
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { cleanupElectronFixture } = require("./lib/electron-fixture-cleanup.cjs");

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
    name: "Verified Time Agent",
    summary: "Uses one content-pinned, system-global read-only time capability.",
    required_inputs: [{ name: "topic", type: "text", description: "Question" }],
    optional_inputs: ["source constraints"],
    produces: [{ kind: "brief", description: "Brief" }],
    required_plugins: ["agentlas-time", "brave-search", "filesystem"],
    approval_requirements: ["network_access", "file_write"],
    memory_behavior: { reads: "project", writes: "project" },
  }, null, 2));

  const { readResolvedSiteAgentAppContract } = require("../dist/electron/site/agent-app-contract.js");
  const declared = readResolvedSiteAgentAppContract(packageRoot);
  assert.ok(declared);
  assert.deepEqual(declared.contract.capabilities.readonlyMcpCatalogIds, ["agentlas-time"]);
  assert.ok(declared.contract.capabilities.unavailable.some((issue) =>
    issue.id === "brave-search" && issue.reason === "not-allowlisted"),
  "an unpinned Brave catalog row must remain declared/visible but never executable");
  assert.ok(declared.contract.capabilities.unavailable.some((issue) => issue.id === "filesystem"));

  const {
    systemTimeMcpLaunchArgs,
    isAuthenticSystemTimeMcpLaunch,
  } = require("../dist/electron/mcp-tools/system-time-server.js");
  const timeServerArgs = systemTimeMcpLaunchArgs();
  assert.equal(isAuthenticSystemTimeMcpLaunch(process.execPath, timeServerArgs), true);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES (?, 'agentlas-time', 'System Time', 'System Time', 'stdio', ?, ?, NULL, '[]', 1, ?)`,
  ).run("site-capability-time", process.execPath, JSON.stringify(timeServerArgs), now);

  const projectId = randomUUID();
  const { createSiteAgentAppMcpConsentReceipt } = require("../dist/electron/site/agent-app-mcp-consent.js");
  const consentReceipt = createSiteAgentAppMcpConsentReceipt({
    projectId,
    profile: declared.contract.capabilities,
    decision: "approved",
    approvedCatalogIds: ["agentlas-time"],
    readinessDigest: "a".repeat(64),
  });
  const { prepareSiteAgentAppCapabilities, declaredSiteAgentAppCapabilities } =
    require("../dist/electron/site/agent-app-capabilities.js");

  let absentCalls = 0;
  const absent = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "absent", {
    projectId,
    verifyServer: async () => { absentCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(absentCalls, 0);
  assert.equal(absent.grant, null);
  assert.ok(absent.disclosure.unavailable.some((issue) => issue.id === "agentlas-time" && issue.reason === "consent-required"));

  let ineligibleCalls = 0;
  const ineligible = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "ineligible", {
    projectId,
    consentReceipt,
    runtimeEligible: false,
    verifyServer: async () => { ineligibleCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(ineligibleCalls, 0);
  assert.equal(ineligible.grant, null);

  const verifyTime = async (server) => ({
    id: server.id,
    connected: true,
    tools: [{ name: "get_current_time" }, { name: "convert_time" }],
    error: null,
    missingEnv: [],
    checkedAt: new Date().toISOString(),
  });
  const prepared = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "safe", {
    projectId,
    consentReceipt,
    verifyServer: verifyTime,
  });
  assert.ok(prepared.grant);
  assert.deepEqual(prepared.grant.availableCatalogIds, ["agentlas-time"]);
  assert.deepEqual(prepared.grant.mcpAllowedTools, [
    "mcp__agentlas-time__get_current_time",
    "mcp__agentlas-time__convert_time",
  ]);
  assert.deepEqual(prepared.grant.mcpServerBindings, [{
    serverId: "site-capability-time",
    catalogId: "agentlas-time",
    configKey: "agentlas-time",
  }]);
  assert.deepEqual(prepared.grant.mcpRuntimeEnv, {}, "keyless grant must forward zero secret aliases");
  const configBytes = fs.readFileSync(prepared.grant.mcpConfigPath);
  assert.equal(prepared.grant.mcpConfigSha256, createHash("sha256").update(configBytes).digest("hex"));
  assert.equal(configBytes.includes(Buffer.from("UNRELATED_SECRET_CANARY")), false);
  const inlineConfig = JSON.parse(configBytes.toString("utf8"));
  assert.deepEqual(inlineConfig.mcpServers["agentlas-time"], {
    command: process.execPath,
    args: timeServerArgs,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  }, "the keyless built-in must bypass the mutable child wrapper");
  assert.equal(fs.existsSync(path.join(path.dirname(prepared.grant.mcpConfigPath), "mcp-child-env-wrapper.cjs")), false);
  assert.ok(configBytes.length <= 4_096, "the inline Agent App config must stay inside the cross-platform argv budget");
  assert.ok(configBytes.length <= 4_096,
    "the runner's validated Windows snapshot input must stay inside the Agent App config budget");
  const { resolveSiteAgentAppInlineMcpConfigForDispatch } =
    require("../dist/electron/site/agent-app-mcp-config-policy.js");
  const { listInstalledServers } = require("../dist/electron/mcp-tools/registry.js");
  const expectedInlineConfig = JSON.stringify(inlineConfig);
  assert.equal(
    resolveSiteAgentAppInlineMcpConfigForDispatch(prepared.grant, listInstalledServers()),
    expectedInlineConfig,
    "Main's final dispatch gate must convert the stable preflight file to canonical inline JSON",
  );
  const configPath = prepared.grant.mcpConfigPath;
  fs.writeFileSync(configPath, '{"mcpServers":{}}');
  assert.equal(resolveSiteAgentAppInlineMcpConfigForDispatch(prepared.grant, listInstalledServers()), null,
    "a config changed after preflight must downgrade before dispatch");
  fs.writeFileSync(configPath, configBytes);
  db.prepare("UPDATE mcp_servers SET args_json = ? WHERE id = ?")
    .run(JSON.stringify([...timeServerArgs, "--tampered-after-preflight"]), "site-capability-time");
  assert.equal(resolveSiteAgentAppInlineMcpConfigForDispatch(prepared.grant, listInstalledServers()), null,
    "a registry row changed after preflight must downgrade before dispatch");
  db.prepare("UPDATE mcp_servers SET args_json = ? WHERE id = ?")
    .run(JSON.stringify(timeServerArgs), "site-capability-time");
  fs.rmSync(configPath);
  assert.equal(resolveSiteAgentAppInlineMcpConfigForDispatch(prepared.grant, listInstalledServers()), null,
    "a deleted preflight config must downgrade before dispatch");
  fs.writeFileSync(configPath, configBytes);
  prepared.grant.runtimeStatus = "runtime-unavailable";
  assert.deepEqual(prepared.finalDisclosure().available, []);
  prepared.cleanup();
  assert.equal(fs.existsSync(configPath), false);

  db.prepare("UPDATE mcp_servers SET env_keys_json = ? WHERE id = ?")
    .run(JSON.stringify(["UNRELATED_SECRET_CANARY"]), "site-capability-time");
  let canaryReads = 0;
  let canaryVerifications = 0;
  const canary = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "canary", {
    projectId,
    consentReceipt,
    hasCredential: async () => { canaryReads += 1; return true; },
    verifyServer: async () => { canaryVerifications += 1; return verifyTime({ id: "bad" }); },
  });
  assert.equal(canary.grant, null);
  assert.equal(canaryReads, 0, "unexpected env names must be rejected before any vault read");
  assert.equal(canaryVerifications, 0, "unexpected env names must be rejected before process execution");
  db.prepare("UPDATE mcp_servers SET env_keys_json = '[]' WHERE id = ?").run("site-capability-time");

  for (const malformedArgs of ["[1]", JSON.stringify([...timeServerArgs, {}])]) {
    db.prepare("UPDATE mcp_servers SET args_json = ? WHERE id = ?").run(malformedArgs, "site-capability-time");
    let malformedVerifications = 0;
    const malformed = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "malformed-args", {
      projectId,
      consentReceipt,
      verifyServer: async () => { malformedVerifications += 1; return verifyTime({ id: "bad" }); },
    });
    assert.equal(malformed.grant, null, "malformed args JSON must degrade to no-tool instead of throwing");
    assert.equal(malformedVerifications, 0);
  }
  db.prepare("UPDATE mcp_servers SET args_json = ? WHERE id = ?")
    .run(JSON.stringify(timeServerArgs), "site-capability-time");
  db.prepare("UPDATE mcp_servers SET env_keys_json = '[1]' WHERE id = ?").run("site-capability-time");
  let malformedEnvVerifications = 0;
  const malformedEnv = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "malformed-env", {
    projectId,
    consentReceipt,
    verifyServer: async () => { malformedEnvVerifications += 1; return verifyTime({ id: "bad" }); },
  });
  assert.equal(malformedEnv.grant, null, "malformed env JSON must degrade to no-tool instead of throwing");
  assert.equal(malformedEnvVerifications, 0);
  db.prepare("UPDATE mcp_servers SET env_keys_json = '[]' WHERE id = ?").run("site-capability-time");

  const verificationFailure = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "verify-fail", {
    projectId,
    consentReceipt,
    verifyServer: async () => { throw new Error("SENTINEL_PRIVATE_VERIFICATION_ERROR"); },
  });
  assert.equal(verificationFailure.grant, null);
  assert.equal(JSON.stringify(verificationFailure).includes("SENTINEL_PRIVATE"), false);

  const configFailure = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "config-fail", {
    projectId,
    consentReceipt,
    verifyServer: verifyTime,
    buildConfig: async () => { throw new Error("SENTINEL_PRIVATE_CONFIG_ERROR"); },
  });
  assert.equal(configFailure.grant, null);
  assert.equal(JSON.stringify(configFailure).includes("SENTINEL_PRIVATE"), false);

  const unsafeTools = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "unsafe-tools", {
    projectId,
    consentReceipt,
    verifyServer: async (server) => ({ ...(await verifyTime(server)), tools: [
      { name: "get_current_time" }, { name: "convert_time" }, { name: "write_file" },
    ] }),
  });
  assert.equal(unsafeTools.grant, null);

  let arbitraryCalls = 0;
  const arbitrary = await prepareSiteAgentAppCapabilities(declared.contract.capabilities, "arbitrary", {
    projectId,
    consentReceipt,
    listInstalled: () => [{
      id: "arbitrary-time", catalogId: "agentlas-time", name: "Time", nameEn: "Time",
      transport: "stdio", command: process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/echo",
      args: [], url: null, envKeys: [], enabled: true, installedAt: now,
    }],
    verifyServer: async () => { arbitraryCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(arbitraryCalls, 0);
  assert.equal(arbitrary.grant, null);

  const braveProfile = declaredSiteAgentAppCapabilities(["brave-search"], "declared-package");
  assert.deepEqual(braveProfile.readonlyMcpCatalogIds, []);
  assert.ok(braveProfile.unavailable.some((issue) => issue.id === "brave-search" && issue.reason === "not-allowlisted"));
  let braveCalls = 0;
  const brave = await prepareSiteAgentAppCapabilities(braveProfile, "brave-blocked", {
    projectId,
    verifyServer: async () => { braveCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(braveCalls, 0, "unprovenance Brave rows must never reach verification or receive the key");
  assert.equal(brave.grant, null);

  cleanupElectronFixture(tmp, "site-capabilities");
  console.log("site agent app declared capability behavior ok");
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  try { cleanupElectronFixture(tmp, "site-capabilities"); } catch { /* best effort */ }
  app.exit(1);
});
