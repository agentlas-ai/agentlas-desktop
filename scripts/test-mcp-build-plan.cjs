#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-build-plan-"));
  app.setPath("userData", temp);
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  const registry = require("../dist/electron/mcp-tools/registry.js");
  const vault = require("../dist/electron/secrets/vault.js");
  const plans = require("../dist/electron/mcp-tools/build-plan.js");
  const resolver = require("../dist/electron/mcp-tools/attachment-resolver.js");
  store.initStore();
  plans.clearMcpBuildPlansForTest();

  try {
    registry.installFromCatalog("github");
    await vault.setEnvVar("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_super_secret_plan_value");
    const beforeRecommendation = store.getDb().prepare("SELECT COUNT(*) AS n FROM mcp_servers").get().n;
    const plan = await plans.recommendMcpBuildPlan({
      request: "Open Chrome, log in, inspect a GitHub repo, and write files",
      mode: "single",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const afterRecommendation = store.getDb().prepare("SELECT COUNT(*) AS n FROM mcp_servers").get().n;
    assert.equal(afterRecommendation, beforeRecommendation, "recommendation must not install or mutate registry rows");
    assert.ok(plan.candidates.some((item) => item.catalogId === "github" && item.keyState === "present"));
    assert.ok(
      plan.candidates.some((item) => item.catalogId === "playwright" && item.keyState === "not-required" && item.defaultSelected),
      JSON.stringify(plan.candidates, null, 2),
    );
    assert.ok(plan.candidates.every((item) => item.keyState !== "missing" || !item.defaultSelected));
    assert.ok(plan.candidates.every((item) =>
      typeof item.requiresKey === "boolean" &&
      item.minimumPermission &&
      item.minimumScopes.length > 0 &&
      item.recommendationReasonCode &&
      item.permissionBasis &&
      item.permissionEnforced === false
    ));
    const safePlan = JSON.stringify(plan);
    assert.doesNotMatch(safePlan, /ghp_super_secret_plan_value|command|args|endpoint|https?:\/\//i);
    assert.doesNotMatch(safePlan, /recommendationReason"|permissionWidening/i);

    const testCalls = [];
    const installedDuringConsent = [];
    const fakeDeps = {
      listInstalled: registry.listInstalledServers,
      installCatalog: (id) => {
        installedDuringConsent.push(id);
        return registry.installFromCatalog(id);
      },
      hasEnv: vault.hasEnvVar,
      testServer: async (server) => {
        testCalls.push(server.catalogId || server.id);
        return { connected: server.catalogId !== "agentlas-browser", missingEnv: [] };
      },
      buildConfig: async (serverIds) => ({
        configPath: path.join(temp, "fake-mcp.json"),
        allowedTools: [],
        codexConfigArgs: [],
        runtimeEnv: {},
        includedServerIds: [...serverIds],
      }),
    };
    const selected = plan.candidates.filter((item) => item.defaultSelected).map((item) => item.id);
    const applied = await plans.applyMcpBuildConsent({
      request: "Open Chrome, log in, inspect a GitHub repo, and write files",
      mode: "single",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: plan.id, selectedCandidateIds: selected },
      resolverDeps: fakeDeps,
    });
    assert.ok(applied.attachment.receipt.failed.some((item) => item.catalogId === "agentlas-browser"));
    assert.ok(applied.attachment.receipt.attached.some((item) => item.catalogId === "playwright"), "browser fallback should attach");
    assert.ok(applied.attachment.receipt.attached.some((item) => item.catalogId === "github"), "one failed MCP must not starve healthy groups");
    assert.ok(applied.attachment.receipt.fallback.some((item) => item.reason === "fallback_used"));
    assert.ok(installedDuringConsent.length > 0, "keyless catalog entries install only after approval");
    assert.doesNotMatch(JSON.stringify(applied.attachment.receipt), /ghp_super_secret_plan_value|command|args|endpoint|https?:\/\//i);
    const hostReceipt = path.join(temp, "mcp", "build-receipts", `${plan.id}.json`);
    assert.equal(fs.existsSync(hostReceipt), true, "receipt must persist under host userData");
    assert.doesNotMatch(fs.readFileSync(hostReceipt, "utf8"), /ghp_super_secret_plan_value|command|args|endpoint|https?:\/\//i);
    assert.equal(applied.attachment.receipt.hostReceiptStored, true);
    assert.equal(JSON.parse(fs.readFileSync(hostReceipt, "utf8")).hostReceiptStored, true);

    const registryFirstCalls = [];
    let registryFirstInstalls = 0;
    const installedLowPriorityServer = {
      id: "installed-low-priority",
      catalogId: "installed-low-priority",
      name: "Installed low priority",
      nameEn: "Installed low priority",
      transport: "stdio",
      command: "node",
      args: [],
      url: null,
      envKeys: [],
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    const candidate = (overrides) => ({
      public: {
        id: overrides.id,
        catalogId: overrides.catalogId,
        name: overrides.id,
        capability: "browser",
        reason: overrides.installed ? "installed-match" : "request-match",
        recommendationReasonCode: "browser-interaction",
        requiresKey: false,
        minimumPermission: "full",
        minimumScopes: ["approved-browser-session"],
        permissionBasis: "host-inferred",
        permissionEnforced: false,
        source: overrides.installed ? "system-registry" : "catalog",
        installed: overrides.installed,
        enabled: true,
        keyState: "not-required",
        readiness: overrides.installed ? "ready" : "available",
        defaultSelected: true,
        fallbackGroup: "registry-first",
        priority: overrides.priority,
      },
      serverId: overrides.installed ? installedLowPriorityServer.id : null,
      envKeys: [],
      transport: "stdio",
    });
    const installedCandidate = candidate({
      id: "installed-low",
      catalogId: "installed-low-priority",
      installed: true,
      priority: 10,
    });
    const catalogCandidate = candidate({
      id: "catalog-high",
      catalogId: "catalog-high-priority",
      installed: false,
      priority: 999,
    });
    const registryFirst = await resolver.resolveApprovedMcpCandidates({
      planId: "registry-first-plan",
      candidates: [catalogCandidate, installedCandidate],
      selectedCandidateIds: [catalogCandidate.public.id, installedCandidate.public.id],
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      deps: {
        listInstalled: () => [installedLowPriorityServer],
        installCatalog: () => { registryFirstInstalls += 1; throw new Error("must not install fallback"); },
        hasEnv: async () => true,
        testServer: async (server) => {
          registryFirstCalls.push(server.id);
          return { connected: true, missingEnv: [] };
        },
        buildConfig: async (serverIds) => ({
          configPath: path.join(temp, "registry-first.json"),
          allowedTools: [],
          codexConfigArgs: [],
          runtimeEnv: {},
          includedServerIds: [...serverIds],
        }),
      },
    });
    assert.deepEqual(registryFirstCalls, [installedLowPriorityServer.id], "installed/system registry must outrank catalog priority");
    assert.equal(registryFirstInstalls, 0, "a healthy installed MCP must suppress catalog installation");
    assert.equal(registryFirst.receipt.attached.length, 1, "a fallback group must attach exactly one MCP");
    assert.equal(registryFirst.receipt.attached[0].candidateId, installedCandidate.public.id);
    assert.ok(registryFirst.receipt.skipped.some((item) => item.candidateId === catalogCandidate.public.id && item.reason === "fallback_not_needed"));

    const callsAfterFirstApply = testCalls.length;
    const appliedAgain = await plans.applyMcpBuildConsent({
      request: "Open Chrome, log in, inspect a GitHub repo, and write files",
      mode: "single",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: plan.id, selectedCandidateIds: selected },
      resolverDeps: fakeDeps,
    });
    assert.equal(testCalls.length, callsAfterFirstApply, "one-pass consent is idempotent across interview turns");
    assert.equal(appliedAgain.attachment.receipt.resolvedAt, applied.attachment.receipt.resolvedAt);

    const singleFlightPlan = await plans.recommendMcpBuildPlan({
      request: "Inspect a GitHub repo",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const singleFlightGithub = singleFlightPlan.candidates.find((item) => item.catalogId === "github");
    assert.ok(singleFlightGithub);
    let releaseProbe;
    const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
    let singleFlightProbeCalls = 0;
    let singleFlightConfigCalls = 0;
    let singleFlightPersistenceCalls = 0;
    const singleFlightInput = {
      request: "Inspect a GitHub repo",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: singleFlightPlan.id, selectedCandidateIds: [singleFlightGithub.id] },
      resolverDeps: {
        ...fakeDeps,
        testServer: async () => {
          singleFlightProbeCalls += 1;
          await probeGate;
          return { connected: true, missingEnv: [] };
        },
        buildConfig: async (serverIds) => {
          singleFlightConfigCalls += 1;
          return {
            configPath: path.join(temp, "single-flight.json"),
            allowedTools: [],
            codexConfigArgs: [],
            runtimeEnv: {},
            includedServerIds: [...serverIds],
          };
        },
      },
      receiptPersistence: () => {
        singleFlightPersistenceCalls += 1;
        return path.join(temp, "single-flight-receipt.json");
      },
    };
    const firstFlight = plans.applyMcpBuildConsent(singleFlightInput);
    const sharedFlight = plans.applyMcpBuildConsent(singleFlightInput);
    await assert.rejects(
      () => plans.applyMcpBuildConsent({
        ...singleFlightInput,
        consent: { planId: singleFlightPlan.id, selectedCandidateIds: [] },
      }),
      /cannot be changed/,
      "a concurrent different selection must be rejected after the plan freezes",
    );
    releaseProbe();
    const [firstFlightResult, sharedFlightResult] = await Promise.all([firstFlight, sharedFlight]);
    assert.equal(firstFlightResult.attachment, sharedFlightResult.attachment, "same-selection callers must share one resolver result");
    assert.equal(singleFlightProbeCalls, 1, "single-flight must probe once");
    assert.equal(singleFlightConfigCalls, 1, "single-flight must serialize config once");
    assert.equal(singleFlightPersistenceCalls, 1, "single-flight must persist the receipt once");

    const allFailPlan = await plans.recommendMcpBuildPlan({
      request: "Open a browser and log in",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    let configCalls = 0;
    const allFail = await plans.applyMcpBuildConsent({
      request: "Open a browser and log in",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: allFailPlan.id, selectedCandidateIds: allFailPlan.candidates.filter((item) => item.defaultSelected).map((item) => item.id) },
      resolverDeps: {
        ...fakeDeps,
        testServer: async () => ({ connected: false, missingEnv: [] }),
        buildConfig: async () => { configCalls += 1; return null; },
      },
    });
    assert.equal(allFail.attachment.receipt.emptyMode, true);
    assert.equal(allFail.attachment.config, null);
    assert.equal(configCalls, 0, "all-failed mode must not serialize a poisoned config");

    const slackPlan = await plans.recommendMcpBuildPlan({
      request: "Post a message to Slack",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const slack = slackPlan.candidates.find((item) => item.catalogId === "slack");
    assert.ok(slack && slack.keyState === "missing" && !slack.defaultSelected);
    let missingKeyInstallCalls = 0;
    const missing = await plans.applyMcpBuildConsent({
      request: "Post a message to Slack",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: slackPlan.id, selectedCandidateIds: [slack.id] },
      resolverDeps: {
        ...fakeDeps,
        installCatalog: (id) => { missingKeyInstallCalls += 1; return registry.installFromCatalog(id); },
      },
    });
    assert.equal(missingKeyInstallCalls, 0, "missing-key selections must be omitted before install/connect");
    assert.ok(missing.attachment.receipt.missingKey.some((item) => item.catalogId === "slack"));

    const primaryPlan = await plans.recommendMcpBuildPlan({
      request: "Open Chrome in a browser and click",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const browserIds = primaryPlan.candidates.filter((item) => item.fallbackGroup === "browser" && item.defaultSelected).map((item) => item.id);
    const primaryCalls = [];
    const primary = await plans.applyMcpBuildConsent({
      request: "Open Chrome in a browser and click",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: primaryPlan.id, selectedCandidateIds: browserIds },
      resolverDeps: {
        ...fakeDeps,
        testServer: async (server) => { primaryCalls.push(server.catalogId); return { connected: true, missingEnv: [] }; },
      },
    });
    assert.equal(primaryCalls.filter(Boolean).length, 1, "healthy primary must suppress lower fallback startup");
    assert.equal(primary.attachment.receipt.attached.length, 1);
    assert.ok(primary.attachment.receipt.skipped.some((item) => item.reason === "fallback_not_needed"));

    const noRuntimePlan = await plans.recommendMcpBuildPlan(
      { request: "Open a browser and click" },
      {
        listInstalled: registry.listInstalledServers,
        hasEnv: vault.hasEnvVar,
        now: () => new Date(),
        resolveRuntime: async () => ({ kind: "codex", backend: "openai", source: "codex" }),
      },
    );
    assert.equal(noRuntimePlan.runtimeKind, "codex");
    assert.ok(noRuntimePlan.candidates.some((item) => item.readiness !== "runtime-incompatible"));
    const noRuntimeApplied = await plans.applyMcpBuildConsent({
      request: "Open a browser and click",
      consent: { planId: noRuntimePlan.id, selectedCandidateIds: noRuntimePlan.candidates.filter((item) => item.defaultSelected).map((item) => item.id) },
      resolverDeps: fakeDeps,
    });
    assert.equal(noRuntimeApplied.runtime.kind, "codex", "main must carry the resolved active runtime into Build");

    const rowsBeforeRecommendationOutage = store.getDb().prepare("SELECT COUNT(*) AS n FROM mcp_servers").get().n;
    const recommendationOutagePlan = await plans.recommendMcpBuildPlan(
      { request: "Open a browser and click" },
      {
        listInstalled: () => { throw new Error("registry unavailable"); },
        hasEnv: async () => false,
        now: () => new Date(),
        resolveRuntime: async () => { throw new Error("runtime detection unavailable"); },
      },
    );
    assert.equal(recommendationOutagePlan.status, "degraded");
    assert.equal(recommendationOutagePlan.warningCode, "recommendation_unavailable");
    assert.equal(recommendationOutagePlan.runtimeKind, null);
    assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM mcp_servers").get().n, rowsBeforeRecommendationOutage);
    const outageApplied = await plans.applyMcpBuildConsent({
      request: "Open a browser and click",
      consent: { planId: recommendationOutagePlan.id, selectedCandidateIds: [] },
      resolverDeps: fakeDeps,
    });
    assert.equal(outageApplied.attachment.receipt.emptyMode, true, "recommendation subsystem outage must degrade to empty MCP mode");

    const fallbackPlanId = `renderer-mcp-unavailable-${Date.now()}-qa`;
    let fallbackPersistenceCalls = 0;
    const rendererFallbackInput = {
      request: "Build even when renderer MCP recommendation IPC failed",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: fallbackPlanId, selectedCandidateIds: [], fallbackReason: "recommendation_unavailable" },
      resolverDeps: fakeDeps,
      receiptPersistence: () => { fallbackPersistenceCalls += 1; return "/tmp/value-free-receipt"; },
    };
    const rendererFallback = await plans.applyMcpBuildConsent(rendererFallbackInput);
    assert.equal(rendererFallback.attachment.receipt.emptyMode, true);
    assert.equal(rendererFallback.attachment.receipt.hostReceiptStored, true);
    await plans.applyMcpBuildConsent(rendererFallbackInput);
    assert.equal(fallbackPersistenceCalls, 1, "renderer outage fallback must remain one-pass and idempotent");
    const sessionSource = fs.readFileSync(path.join(__dirname, "../renderer/lib/build-session.ts"), "utf8");
    assert.match(sessionSource, /state\.phase = "mcp-review"[\s\S]*recommendation_unavailable/);
    assert.match(sessionSource, /fallbackReason: "recommendation_unavailable"/);

    const rejectionPlan = await plans.recommendMcpBuildPlan({
      request: "Open a browser",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const rejectionSelected = rejectionPlan.candidates.filter((item) => item.fallbackGroup === "browser" && item.defaultSelected).map((item) => item.id);
    const rejectedGroup = await plans.applyMcpBuildConsent({
      request: "Open a browser",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: rejectionPlan.id, selectedCandidateIds: rejectionSelected },
      resolverDeps: { ...fakeDeps, listInstalled: () => { throw new Error("host registry unavailable"); } },
    });
    assert.equal(rejectedGroup.attachment.receipt.emptyMode, true);
    assert.equal(rejectedGroup.attachment.receipt.degraded.filter((item) => item.reason === "host_failure").length, rejectionSelected.length);

    const configRejectPlan = await plans.recommendMcpBuildPlan({
      request: "Open a browser",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const configRejectIds = configRejectPlan.candidates.filter((item) => item.fallbackGroup === "browser" && item.defaultSelected).map((item) => item.id);
    let finalConfigCalls = 0;
    const configRejected = await plans.applyMcpBuildConsent({
      request: "Open a browser",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: configRejectPlan.id, selectedCandidateIds: configRejectIds },
      resolverDeps: {
        ...fakeDeps,
        testServer: async () => ({ connected: true, missingEnv: [] }),
        buildConfig: async (serverIds) => {
          finalConfigCalls += 1;
          const installed = registry.listInstalledServers();
          const includedServerIds = serverIds.filter((id) => installed.find((server) => server.id === id)?.catalogId === "playwright");
          return { configPath: "/tmp/rejected", allowedTools: [], codexConfigArgs: [], runtimeEnv: {}, includedServerIds };
        },
      },
    });
    assert.ok(finalConfigCalls >= 2, "a final-config rejection must rebuild with the next fallback");
    assert.ok(configRejected.attachment.receipt.attached.some((item) => item.catalogId === "playwright"));
    assert.ok(configRejected.attachment.receipt.fallback.some((item) => item.reason === "fallback_used"));
    assert.equal(configRejected.attachment.receipt.emptyMode, false);
    assert.ok(configRejected.attachment.receipt.degraded.some((item) => item.reason === "configuration_rejected"));

    const partialConfigPlan = await plans.recommendMcpBuildPlan({
      request: "Open a browser and inspect a GitHub repo",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const partialSelected = partialConfigPlan.candidates.filter((item) => item.defaultSelected).map((item) => item.id);
    const partialConfig = await plans.applyMcpBuildConsent({
      request: "Open a browser and inspect a GitHub repo",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: partialConfigPlan.id, selectedCandidateIds: partialSelected },
      resolverDeps: {
        ...fakeDeps,
        testServer: async () => ({ connected: true, missingEnv: [] }),
        buildConfig: async (serverIds) => {
          const installed = registry.listInstalledServers();
          const includedServerIds = serverIds.filter((id) => installed.find((server) => server.id === id)?.catalogId === "github");
          return { configPath: "/tmp/partial", allowedTools: [], codexConfigArgs: [], runtimeEnv: {}, includedServerIds };
        },
      },
    });
    assert.ok(partialConfig.attachment.receipt.attached.some((item) => item.catalogId === "github"), "one rejected group must not starve another group");
    assert.equal(partialConfig.attachment.receipt.emptyMode, false);
    assert.ok(partialConfig.attachment.receipt.degraded.filter((item) => item.fallbackGroup === "browser").every((item) => item.reason === "configuration_rejected"));

    const persistencePlan = await plans.recommendMcpBuildPlan({
      request: "Inspect a GitHub repo",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    let persistenceCalls = 0;
    const persistenceInput = {
      request: "Inspect a GitHub repo",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
      consent: { planId: persistencePlan.id, selectedCandidateIds: persistencePlan.candidates.filter((item) => item.defaultSelected).map((item) => item.id) },
      resolverDeps: fakeDeps,
      receiptPersistence: () => { persistenceCalls += 1; throw new Error("disk full"); },
    };
    const persistenceFailed = await plans.applyMcpBuildConsent(persistenceInput);
    assert.equal(persistenceFailed.attachment.receipt.hostReceiptStored, false);
    assert.equal(persistenceFailed.attachment.receipt.hostReceiptWarning, "receipt_storage_failed");
    assert.ok(persistenceFailed.attachment.receipt.attached.length > 0, "receipt write failure must not create capability shortage");
    const persistenceAgain = await plans.applyMcpBuildConsent(persistenceInput);
    assert.equal(persistenceCalls, 1, "an applied plan must not retry or mutate its receipt write");
    assert.equal(persistenceAgain.attachment.receipt.resolvedAt, persistenceFailed.attachment.receipt.resolvedAt);

    const custom = registry.installCustomServer({
      name: "mason@example.com https://private.example.test/account/123",
      transport: "stdio",
      command: "private-command",
      args: ["--secret", "account-123"],
    });
    const customPlan = await plans.recommendMcpBuildPlan({
      request: "Use the mason custom MCP",
      runtime: { kind: "codex", backend: "openai", source: "codex" },
    });
    const customJson = JSON.stringify(customPlan);
    assert.doesNotMatch(customJson, new RegExp(custom.id));
    assert.doesNotMatch(customJson, /mason@example\.com|private\.example|private-command|account-123|--secret/i);
    assert.ok(customPlan.candidates.some((item) =>
      item.catalogId === null &&
      item.name === "Custom MCP" &&
      item.permissionBasis === "unknown" &&
      item.minimumPermission === "full" &&
      item.permissionEnforced === false
    ));

    const builderSource = fs.readFileSync(path.join(__dirname, "../electron/hephaestus/builder.ts"), "utf8");
    assert.doesNotMatch(builderSource, /mcp-attachment-receipt\.json|persistMcpBuildReceipt/, "host MCP receipts must not enter package files or hashes");

    console.log(JSON.stringify({ ok: true, checks: 82 }, null, 2));
  } finally {
    store.getDb().close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
