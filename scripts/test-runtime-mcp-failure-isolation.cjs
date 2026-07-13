#!/usr/bin/env node
const assert = require("node:assert/strict");
const { app } = require("electron");

function server(id) {
  return {
    id: `server-${id}`,
    catalogId: id,
    name: id,
    nameEn: id,
    transport: "stdio",
    command: process.execPath,
    args: [],
    url: null,
    envKeys: [],
    enabled: true,
    installedAt: "2026-07-13T00:00:00.000Z",
  };
}

async function main() {
  await app.whenReady();
  const { autoSelectMcpTools, buildMcpAutoSelectionPrompt } = require("../dist/electron/mcp-tools/auto-select.js");

  const installState = new Map();
  const installFailure = await autoSelectMcpTools({
    userPrompt: "Open the browser and click through the login flow",
    systemPrompt: "Browser execution",
    agentName: "Browser Agent",
    toolMode: "browser",
    hubMode: "local-only",
  }, {
    listInstalledServers: () => [...installState.values()],
    installFromCatalog: (id) => {
      if (id === "agentlas-browser") throw new Error("private install error must not escape");
      const installed = server(id);
      installState.set(id, installed);
      return installed;
    },
    readEnvVar: async () => "test-value",
    testServerConnection: async () => ({ connected: true, missingEnv: [] }),
  });
  const failedInstall = installFailure.tools.find((tool) => tool.id === "agentlas-browser");
  const healthyFallback = installFailure.tools.find((tool) => tool.id === "playwright");
  assert.equal(failedInstall.state, "install-failed");
  assert.equal(failedInstall.required, true);
  assert.equal(failedInstall.installed, false);
  assert.equal(healthyFallback.state, "ready", "one install failure must not starve a healthy MCP");
  assert.equal(healthyFallback.installed, true);
  const installPrompt = buildMcpAutoSelectionPrompt(installFailure, { toolMode: "browser", hubMode: "local-only" });
  assert.match(installPrompt, /agentlas-browser=install-failed\(required\)/);
  assert.match(installPrompt, /degrade only the function/);
  assert.doesNotMatch(installPrompt, /private install error/);

  const probeState = new Map([
    ["agentlas-browser", server("agentlas-browser")],
    ["playwright", server("playwright")],
  ]);
  const probeFailure = await autoSelectMcpTools({
    userPrompt: "Open the browser and click through the login flow",
    systemPrompt: "Browser execution",
    agentName: "Browser Agent",
    toolMode: "browser",
    hubMode: "local-only",
  }, {
    listInstalledServers: () => [...probeState.values()],
    installFromCatalog: (id) => {
      const installed = server(id);
      probeState.set(id, installed);
      return installed;
    },
    readEnvVar: async () => "test-value",
    testServerConnection: async (installed) => installed.catalogId === "agentlas-browser"
      ? { connected: false, missingEnv: [] }
      : { connected: true, missingEnv: [] },
  });
  const failedProbe = probeFailure.tools.find((tool) => tool.id === "agentlas-browser");
  const healthyAfterProbe = probeFailure.tools.find((tool) => tool.id === "playwright");
  assert.equal(failedProbe.state, "probe-failed");
  assert.equal(failedProbe.required, true);
  assert.equal(healthyAfterProbe.state, "ready", "one probe failure must not starve a healthy MCP");
  assert.equal(healthyAfterProbe.installed, true);
  assert.ok(
    probeFailure.tools.some((tool) => tool.state === "ready"),
    "runtime selection must preserve at least one healthy capability",
  );
  console.log("runtime MCP install/probe failure isolation and value-free degraded state: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => app.quit());
