#!/usr/bin/env node
// Real loopback bridge integration with a stubbed invocation authority. No agent,
// model, browser, network provider, or user secret is invoked by this test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, shell } = require("electron");
const { cleanupElectronFixture } = require("./lib/electron-fixture-cleanup.cjs");

process.env.AGENTLAS_E2E = "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-runtime-"));
const homeDir = path.join(tempDir, "home");
fs.mkdirSync(homeDir, { recursive: true });
app.setPath("userData", path.join(tempDir, "user-data"));
app.setPath("home", homeDir);

const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
const { invocationService } = require("../dist/electron/invocation/service.js");
const { listInstalledAgents } = require("../dist/electron/mcp/registry.js");
const { recordScaffoldedApp } = require("../dist/electron/store/agent-apps.js");
const { getOrCreateAutomationSession, switchChatAgent } = require("../dist/electron/store/chats.js");
const { initStore } = require("../dist/electron/store/db.js");
const { siteAgentAppContextFromSnapshot } = require("../dist/electron/site/agent-app.js");
const {
  disposeSiteAgentAppRuntimes,
  launchSiteAgentApp,
  siteAgentAppRuntimeStatus,
  stopSiteAgentApp,
} = require("../dist/electron/site/agent-app-runtime.js");
const {
  createSiteProject,
  siteAgentAppsRoot,
  updateSiteAgentAppArtifact,
} = require("../dist/electron/site/store.js");

const CONTRACT = {
  schemaVersion: 1,
  source: "declared-package",
  inputs: [{
    name: "topic",
    type: "string",
    label: "Research topic",
    description: "Question to investigate",
    required: true,
    format: "textarea",
    options: [],
    defaultValue: null,
  }],
  outputs: [{ name: "brief", label: "Cited brief", type: "markdown", description: "Findings and sources" }],
  capabilities: {
    schemaVersion: 1,
    source: "declared-package",
    readonlyMcpCatalogIds: ["agentlas-time"],
    unavailable: [],
  },
};

let exitCode = 0;
app.whenReady().then(async () => {
  const originalOpenExternal = shell.openExternal;
  const originalStart = invocationService.start;
  const originalOnEvent = invocationService.onEvent;
  const originalCancel = invocationService.cancel;
  try {
    initStore();
    seedBuiltinAgents();
    const installedAgents = listInstalledAgents();
    const seededAgent = installedAgents[0];
    assert.ok(seededAgent);
    const project = createSiteProject({
      name: "Research Agent",
      surface: "agent-app",
      agentAppTarget: {
        kind: "agent",
        id: seededAgent.id,
        name: "Research Agent",
        description: "Creates cited research briefs.",
        memberCount: 1,
      },
      astryxTemplate: "ai-chat-landing",
      agentAppContract: CONTRACT,
    });
    const context = siteAgentAppContextFromSnapshot(
      project.agentAppTarget,
      project.astryxTemplate,
      project.agentAppContract,
      project.agentAppVisual,
    );
    context.manifest.designSystem = {
      ...(context.manifest.designSystem || {}),
      sourceScreenId: "screen-runtime-contract",
    };
    const chat = getOrCreateAutomationSession({
      automationId: `site-agent-app:${project.id}`,
      agentId: seededAgent.id,
    });
    const scaffold = await scaffoldServiceApp({
      chatId: chat.id,
      surfaceId: `site:${project.id}`,
      manifest: context.manifest,
    }, {
      baseDir: siteAgentAppsRoot(),
      directChild: true,
      localPort: 43_212,
    });
    const record = recordScaffoldedApp({
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      surfaceId: `site:${project.id}`,
      manifest: context.manifest,
      scaffold,
    });
    const distRoot = path.join(scaffold.rootPath, "astryx-app", "dist");
    fs.mkdirSync(distRoot, { recursive: true });
    fs.writeFileSync(
      path.join(distRoot, "index.html"),
      '<!doctype html><html><body data-agentlas-agent-app="true"><div id="root">Astryx runtime fixture</div></body></html>',
      "utf8",
    );
    const now = new Date().toISOString();
    updateSiteAgentAppArtifact(project.id, {
      schemaVersion: 1,
      appRecordId: record.id,
      appId: scaffold.appId,
      appName: project.agentAppTarget.name,
      rootPath: scaffold.rootPath,
      sourceScreenId: "screen-runtime-contract",
      status: "ready",
      launchUrl: null,
      thumbnail: null,
      publish: null,
      createdAt: now,
      updatedAt: now,
      failureReason: null,
    });

    let openedUrl = "";
    let listener = null;
    let capturedRequest = null;
    let invocationFailure = null;
    shell.openExternal = async (url) => {
      openedUrl = url;
    };
    invocationService.onEvent = (next) => {
      listener = next;
      return () => { if (listener === next) listener = null; };
    };
    invocationService.start = (request) => {
      capturedRequest = request;
      queueMicrotask(() => listener?.({
        runId: request.runId,
        chatId: request.chatId,
        event: invocationFailure
          ? { kind: "error", error: { code: "raw-cli-failure", message: invocationFailure } }
          : { kind: "final", text: '{"brief":"Bridge result"}' },
      }));
      return { runId: request.runId };
    };
    invocationService.cancel = () => true;

    const launch = await launchSiteAgentApp(project.id);
    assert.equal(launch.ok, true);
    assert.equal(launch.running, true);
    assert.equal(launch.opened, true);
    assert.ok(launch.origin);
    assert.ok(openedUrl.startsWith(`${launch.origin}/#cap=`));
    assert.equal(JSON.stringify(launch).includes("cap="), false, "the capability must not cross renderer IPC");
    const capability = new URLSearchParams(new URL(openedUrl).hash.slice(1)).get("cap");
    assert.ok(capability && capability.length >= 40);

    const index = await fetch(`${launch.origin}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /data-agentlas-agent-app="true"/);
    const runtimeCsp = index.headers.get("content-security-policy") || "";
    assert.match(runtimeCsp, /img-src 'self' data: blob:/, "model output images must remain same-origin or embedded");
    assert.doesNotMatch(runtimeCsp, /img-src[^;]*https:/, "the local Desktop runtime must block remote HTTPS image fetches");
    assert.match(runtimeCsp, /connect-src 'self'/, "fetch/XHR must remain limited to the same-origin runtime API");
    assert.doesNotMatch(runtimeCsp, /connect-src[^;]*https:/);

    const post = (
      authorization,
      origin = launch.origin,
      body = { inputs: { topic: "Verify the bridge" } },
    ) => fetch(`${launch.origin}/__agentlas/v1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    });
    const crossOrigin = await post(`Bearer ${capability}`, "https://evil.example");
    assert.equal(crossOrigin.status, 403, "a valid capability must not authorize a different Origin");
    const missingCapability = await post("");
    assert.equal(missingCapability.status, 401);
    const valid = await post(`Bearer ${capability}`);
    assert.equal(valid.status, 200);
    const payload = await valid.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.outputs.brief, "Bridge result");
    assert.deepEqual(payload.capabilities, {
      available: [],
      unavailable: [{ id: "agentlas-time", reason: "consent-required" }],
    }, "missing consent must keep the app successful while disclosing stateless/no-tool mode");
    assert.equal(capturedRequest.chatId, chat.id);
    assert.equal(capturedRequest.permissions, "read");
    assert.equal(capturedRequest.hubMode, "local-only");
    assert.equal(capturedRequest.agentAppMode, true);
    assert.equal(capturedRequest.agentAppRuntimeToolGrant, undefined);
    assert.match(capturedRequest.userPrompt, /agentlas-time \(consent-required\)/);
    assert.deepEqual(capturedRequest.borrowAgents, []);
    assert.equal(capturedRequest.planMode, false);
    assert.equal(capturedRequest.goalMode, false);
    assert.match(capturedRequest.userPrompt, /pinned Agent App target "Research Agent"/);
    assert.match(capturedRequest.userPrompt, /untrusted end-user input/);
    assert.equal(capturedRequest.userPrompt.includes(capability), false);

    // The single-flight reservation must happen before the request body has
    // finished arriving. This guards the async body-read TOCTOU window.
    const runUrl = new URL(`${launch.origin}/__agentlas/v1/run`);
    let slowResolve;
    let slowReject;
    const slowResponse = new Promise((resolve, reject) => {
      slowResolve = resolve;
      slowReject = reject;
    });
    const slowRequest = http.request({
      hostname: runUrl.hostname,
      port: Number(runUrl.port),
      path: runUrl.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        origin: launch.origin,
        "content-type": "application/json",
      },
    }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { body += chunk; });
      incoming.on("end", () => slowResolve({ status: incoming.statusCode, body }));
    });
    slowRequest.on("error", slowReject);
    slowRequest.flushHeaders();
    slowRequest.write('{"inputs":{"topic":"slow');
    for (let attempt = 0; attempt < 50 && !siteAgentAppRuntimeStatus(project.id).activeRun; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(siteAgentAppRuntimeStatus(project.id).activeRun, true, "an incomplete authenticated body must reserve the run slot");
    const concurrent = await post(`Bearer ${capability}`);
    assert.equal(concurrent.status, 409, "a second request must not enter during async body parsing");
    slowRequest.end(' request"}}');
    const completedSlow = await slowResponse;
    assert.equal(completedSlow.status, 200);
    assert.equal(JSON.parse(completedSlow.body).outputs.brief, "Bridge result");

    const firstCapability = capability;
    await launchSiteAgentApp(project.id);
    const secondCapability = new URLSearchParams(new URL(openedUrl).hash.slice(1)).get("cap");
    assert.ok(secondCapability && secondCapability !== firstCapability, "each launch must rotate the browser capability");
    const rotatedOut = await post(`Bearer ${firstCapability}`);
    assert.equal(rotatedOut.status, 401, "a previous launch capability must stop working after rotation");

    const requestBeforeInvalidInput = capturedRequest;
    const invalidInput = await post(`Bearer ${secondCapability}`, launch.origin, { inputs: {} });
    assert.equal(invalidInput.status, 400);
    const invalidInputPayload = await invalidInput.json();
    assert.match(invalidInputPayload.error.message, /Research topic is required/i, "input validation may remain specific");
    assert.equal(capturedRequest, requestBeforeInvalidInput, "invalid input must not enter invocationService");

    const browserFailureSentinels = [
      "SENTINEL_HTTP_STDERR_DO_NOT_EXPOSE",
      "/Users/sentinel/browser-private-workspace",
      "/private/tmp/sentinel-browser-agent-app.mcp.json",
      "sk-browser-sentinel_12345678901234567890",
    ];
    invocationFailure = `${browserFailureSentinels.join(" | ")} | stderr=permission denied`;
    const failedRun = await post(`Bearer ${secondCapability}`);
    assert.equal(failedRun.status, 502);
    const failedPayload = await failedRun.json();
    assert.deepEqual(failedPayload, {
      ok: false,
      error: {
        code: "agent-app-runtime-failed",
        message: "Agent App runtime failed.",
      },
    });
    const failedProjection = JSON.stringify(failedPayload);
    for (const sentinel of [...browserFailureSentinels, invocationFailure]) {
      assert.equal(failedProjection.includes(sentinel), false, `browser response must not expose ${sentinel}`);
    }
    invocationFailure = null;

    const differentAgent = installedAgents.find((agent) => agent.id !== seededAgent.id);
    assert.ok(differentAgent, "a second built-in agent is required for the target-binding guard");
    const previousRunId = capturedRequest.runId;
    switchChatAgent(chat.id, differentAgent.id);
    const changedTarget = await post(`Bearer ${secondCapability}`);
    assert.equal(changedTarget.status, 400, "a changed hidden-chat target must fail closed");
    const changedTargetPayload = await changedTarget.json();
    assert.match(changedTargetPayload.error.message, /target binding changed/i);
    assert.equal(capturedRequest.runId, previousRunId, "a target mismatch must not enter invocationService");

    const stopped = await stopSiteAgentApp(project.id);
    assert.equal(stopped.running, false);
    console.log("site agent app loopback runtime bridge ok");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    shell.openExternal = originalOpenExternal;
    invocationService.start = originalStart;
    invocationService.onEvent = originalOnEvent;
    invocationService.cancel = originalCancel;
    disposeSiteAgentAppRuntimes();
    cleanupElectronFixture(tempDir, "site-runtime");
    app.exit(exitCode);
  }
}).catch((error) => {
  console.error(error);
  try { cleanupElectronFixture(tempDir, "site-runtime"); } catch { /* best effort */ }
  app.exit(1);
});
