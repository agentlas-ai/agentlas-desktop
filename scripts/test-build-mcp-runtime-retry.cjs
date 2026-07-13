#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

function server(id, catalogId = id) {
  return {
    id: `server-${id}`,
    catalogId,
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

function candidate(id, group, priority) {
  return {
    public: {
      id: `candidate-${id}`,
      catalogId: id,
      name: id,
      capability: group,
      reason: "installed-match",
      recommendationReasonCode: group === "browser" ? "browser-interaction" : "repository-work",
      requiresKey: false,
      minimumPermission: "full",
      minimumScopes: [group],
      permissionBasis: "host-inferred",
      permissionEnforced: false,
      source: "system-registry",
      installed: true,
      enabled: true,
      keyState: "not-required",
      readiness: "ready",
      defaultSelected: true,
      fallbackGroup: group,
      priority,
    },
    serverId: `server-${id}`,
    envKeys: [],
    transport: "stdio",
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-build-mcp-runtime-retry-"));
  app.setPath("userData", temp);
  await app.whenReady();
  const resolver = require("../dist/electron/mcp-tools/attachment-resolver.js");
  const retry = require("../dist/electron/hephaestus/mcp-runtime-retry.js");
  const startupFatal = require("../dist/electron/runtime/mcp-startup-fatal.js");
  assert.equal(startupFatal.containsMcpStartupTransportFatal("MCP github transport closed"), true);
  assert.equal(startupFatal.containsMcpStartupTransportFatal("model quota exceeded"), false);
  const primary = candidate("agentlas-browser", "browser", 100);
  const fallback = candidate("playwright", "browser", 50);
  const healthy = candidate("github", "repository", 100);
  const servers = [server("agentlas-browser"), server("playwright"), server("github")];
  const deps = {
    listInstalled: () => servers,
    installCatalog: (id) => servers.find((item) => item.catalogId === id),
    hasEnv: async () => true,
    testServer: async () => ({ connected: true, missingEnv: [] }),
    buildConfig: async (serverIds) => ({
      configPath: path.join(temp, "mcp.json"),
      allowedTools: serverIds.map((id) => `mcp__${id.replace(/^server-/, "")}`),
      codexConfigArgs: [],
      runtimeEnv: {},
      includedServerIds: [...serverIds],
      includedServers: serverIds.map((id) => {
        const item = servers.find((entry) => entry.id === id);
        return { serverId: id, catalogId: item.catalogId, configKey: item.catalogId };
      }),
    }),
  };
  const attachment = await resolver.resolveApprovedMcpCandidates({
    planId: "runtime-retry-plan",
    candidates: [primary, fallback, healthy],
    selectedCandidateIds: [primary.public.id, fallback.public.id, healthy.public.id],
    runtime: { kind: "codex", backend: "openai", source: "codex" },
    deps,
  });
  assert.deepEqual(
    attachment.receipt.attached.map((item) => item.candidateId).sort(),
    [primary.public.id, healthy.public.id].sort(),
  );
  assert.ok(attachment.runtimeBindings.some((item) => item.candidateId === primary.public.id && item.configKey === "agentlas-browser"));

  const recovered = await attachment.recoverRuntimeFailure(primary.public.id);
  assert.ok(recovered, "selected same-capability fallback should be recoverable");
  assert.ok(recovered.receipt.attached.some((item) => item.candidateId === fallback.public.id));
  assert.ok(recovered.receipt.attached.some((item) => item.candidateId === healthy.public.id), "healthy MCP must survive exact");
  assert.ok(recovered.receipt.degraded.some((item) =>
    item.candidateId === primary.public.id && item.reason === "runtime_startup_failed"));
  assert.ok(recovered.receipt.fallback.some((item) =>
    item.fromCandidateId === primary.public.id && item.toCandidateId === fallback.public.id));

  const noApprovedFallback = await resolver.resolveApprovedMcpCandidates({
    planId: "runtime-retry-no-fallback",
    candidates: [primary, fallback, healthy],
    selectedCandidateIds: [primary.public.id, healthy.public.id],
    runtime: { kind: "codex", backend: "openai", source: "codex" },
    deps,
  });
  const healthyOnlyRecovery = await noApprovedFallback.recoverRuntimeFailure(primary.public.id);
  assert.ok(healthyOnlyRecovery, "no same-group fallback must still preserve healthy MCPs");
  assert.deepEqual(healthyOnlyRecovery.receipt.attached.map((item) => item.candidateId), [healthy.public.id]);
  assert.ok(healthyOnlyRecovery.receipt.degraded.some((item) =>
    item.candidateId === primary.public.id && item.reason === "runtime_startup_failed"));
  assert.equal(healthyOnlyRecovery.receipt.emptyMode, false);

  const onlyFailedMcp = await resolver.resolveApprovedMcpCandidates({
    planId: "runtime-retry-empty-mode",
    candidates: [primary],
    selectedCandidateIds: [primary.public.id],
    runtime: { kind: "codex", backend: "openai", source: "codex" },
    deps,
  });
  const emptyRecovery = await onlyFailedMcp.recoverRuntimeFailure(primary.public.id);
  assert.ok(emptyRecovery, "the only failed MCP must recover as explicit empty-MCP mode");
  assert.equal(emptyRecovery.config, null);
  assert.equal(emptyRecovery.receipt.emptyMode, true);
  assert.deepEqual(emptyRecovery.receipt.attached, []);
  assert.ok(emptyRecovery.receipt.degraded.some((item) => item.candidateId === primary.public.id));

  const events = { onPartial() {}, onStatus() {}, onTool() {}, onUsage() {}, onThinking() {} };
  const requestFor = (active) => ({
    systemPrompt: "Build",
    history: [],
    userPrompt: "Build safely",
    backendLabel: "Codex",
    permission: "full",
    locale: "en",
    mcpConfigPath: active?.config?.configPath,
    mcpAllowedTools: active?.config?.allowedTools,
    mcpCodexConfigArgs: active?.config?.codexConfigArgs,
    env: active?.config?.runtimeEnv,
  });
  let attempts = 0;
  const successful = await retry.runBuildRunnerWithMcpRecovery({
    attachment,
    signal: new AbortController().signal,
    makeRequest: requestFor,
    events,
    runner: async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("codex CLI exit 1\nMCP client for `agentlas-browser` failed to start: transport closed");
      assert.ok(request.mcpAllowedTools?.some((item) => item.includes("playwright")));
      assert.ok(!request.mcpAllowedTools?.some((item) => item.includes("agentlas-browser")));
      return { text: "done" };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(successful.retryReceipt.retryCount, 1);
  assert.equal(successful.retryReceipt.failedCandidateId, primary.public.id);
  assert.ok(successful.attachment.receipt.degraded.some((item) => item.candidateId === primary.public.id));

  attempts = 0;
  const healthyOnlyRun = await retry.runBuildRunnerWithMcpRecovery({
    attachment: noApprovedFallback,
    signal: new AbortController().signal,
    makeRequest: requestFor,
    events,
    runner: async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("codex CLI exit 1\nMCP client for `agentlas-browser` failed to start: transport closed");
      assert.ok(request.mcpAllowedTools?.some((item) => item.includes("github")), "healthy MCP must remain attached");
      assert.ok(!request.mcpAllowedTools?.some((item) => item.includes("agentlas-browser")));
      assert.match(request.systemPrompt, /Unavailable capability: browser/);
      assert.match(request.systemPrompt, /Do not call it, simulate its external side effect, or claim that side effect completed/);
      return { text: "healthy-only done" };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(healthyOnlyRun.retryReceipt.replacementCandidateId, null);
  assert.equal(healthyOnlyRun.retryReceipt.unavailableCapability, "browser");
  assert.equal(healthyOnlyRun.retryReceipt.emptyMcpMode, false);

  attempts = 0;
  const emptyModeRun = await retry.runBuildRunnerWithMcpRecovery({
    attachment: onlyFailedMcp,
    signal: new AbortController().signal,
    makeRequest: requestFor,
    events,
    runner: async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("codex CLI exit 1\nMCP client for `agentlas-browser` failed to start: transport closed");
      assert.equal(request.mcpConfigPath, undefined);
      assert.equal(request.mcpAllowedTools, undefined);
      assert.match(request.systemPrompt, /No MCP is attached in this retry/);
      assert.match(request.systemPrompt, /all MCP-dependent side effects are unavailable/);
      return { text: "empty-mode done" };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(emptyModeRun.retryReceipt.replacementCandidateId, null);
  assert.equal(emptyModeRun.retryReceipt.emptyMcpMode, true);

  attempts = 0;
  await assert.rejects(
    () => retry.runBuildRunnerWithMcpRecovery({
      attachment,
      signal: new AbortController().signal,
      makeRequest: requestFor,
      events,
      runner: async (_request, emitted) => {
        attempts += 1;
        emitted.onTool("bash", "{}", "completed", "tool-1", false);
        throw new Error("codex CLI exit 1\nMCP client for `agentlas-browser` failed to start: transport closed");
      },
    }),
    /MCP client/,
  );
  assert.equal(attempts, 1, "observed tool work must block replay");

  attempts = 0;
  await assert.rejects(
    () => retry.runBuildRunnerWithMcpRecovery({
      attachment,
      signal: new AbortController().signal,
      makeRequest: requestFor,
      events,
      runner: async () => {
        attempts += 1;
        throw new Error("codex CLI exit 1\nmodel quota exceeded while answering the task");
      },
    }),
    /quota/,
  );
  assert.equal(attempts, 1, "arbitrary model/task errors must never retry");

  attempts = 0;
  await assert.rejects(
    () => retry.runBuildRunnerWithMcpRecovery({
      attachment,
      signal: new AbortController().signal,
      makeRequest: requestFor,
      events,
      runner: async () => {
        attempts += 1;
        throw new Error("codex CLI exit 1\nMCP agentlas-browser transport closed; MCP github failed to start");
      },
    }),
    /transport closed/,
  );
  assert.equal(attempts, 1, "ambiguous multi-server attribution must fail closed");

  attempts = 0;
  await assert.rejects(
    () => retry.runBuildRunnerWithMcpRecovery({
      attachment,
      signal: new AbortController().signal,
      makeRequest: requestFor,
      events,
      runner: async () => {
        attempts += 1;
        throw new Error("codex CLI exit 1\nMCP client for `agentlas-browser` failed to start: transport closed");
      },
    }),
    /MCP client/,
  );
  assert.equal(attempts, 2, "a failed retry must stop after exactly one retry");

  console.log("Build MCP runtime-fatal attribution, approved fallback, no-work replay, and one-retry bound: PASS");
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => app.quit());
