#!/usr/bin/env node
// Publish preflight integration: validates the real Site/AppFactory/Astryx registry
// binding without contacting a hosting provider or reading a real OS Keychain.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

process.env.AGENTLAS_E2E = "1";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-publish-"));
const homeDir = path.join(tempDir, "home");
const appTempDir = path.join(tempDir, "tmp");
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(appTempDir, { recursive: true });
app.setPath("userData", path.join(tempDir, "user-data"));
app.setPath("home", homeDir);
app.setPath("temp", appTempDir);

const fakeBin = path.join(tempDir, "fake-bin");
const fakeProviderLog = path.join(tempDir, "fake-vercel-log.jsonl");
const fakeProviderFailureMode = path.join(tempDir, "fake-vercel-failure-mode.txt");
const fakeRenderInvocation = path.join(tempDir, "fake-render-invoked.txt");
fs.mkdirSync(fakeBin, { recursive: true });
const fakeVercel = path.join(fakeBin, "vercel");
fs.writeFileSync(fakeVercel, `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const failureMode = fs.existsSync(${JSON.stringify(fakeProviderFailureMode)})
  ? fs.readFileSync(${JSON.stringify(fakeProviderFailureMode)}, "utf8").trim()
  : "";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const hash = (value) => value ? crypto.createHash("sha256").update(value).digest("hex") : null;
  fs.appendFileSync(${JSON.stringify(fakeProviderLog)}, JSON.stringify({
    args,
    tokenHash: hash(process.env.VERCEL_TOKEN || ""),
    stdinHash: hash(stdin),
  }) + "\\n");
  if (args[0] === "--version") console.log("Vercel CLI 99.1.2");
  else if (args[0] === "whoami") console.log(JSON.stringify({ username: "native-approval-account" }));
  else if (args[0] === "link") {
    const cwdAt = args.indexOf("--cwd");
    const cwd = cwdAt >= 0 ? args[cwdAt + 1] : process.cwd();
    fs.mkdirSync(path.join(cwd, ".vercel"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".vercel", "project.json"), JSON.stringify({ projectId: failureMode ? "prj-mid-deploy-failure" : "prj-native-approval" }));
  } else if (args[0] === "env" && args[2] === "OPENAI_API_KEY" && failureMode === "llm-secret-response-lost") {
    console.error("simulated Vercel LLM secret commit with lost response");
    process.exitCode = 2;
  } else if (args[0] === "deploy") {
    console.log("Inspect: https://vercel.com/native-approval-account/agentlas-test/deployments/dep-test");
    console.log("Production: https://native-approval-test.vercel.app");
  }
});
process.stdin.resume();
`, { mode: 0o700 });
fs.writeFileSync(path.join(fakeBin, "render"), `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(fakeRenderInvocation)}, process.argv.slice(2).join(" "));
process.exitCode = 99;
`, { mode: 0o700 });
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ""}`;

const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const { getAgentApp, recordScaffoldedApp } = require("../dist/electron/store/agent-apps.js");
const { getChat, getOrCreateAutomationSession, getOrCreateSiteSession } = require("../dist/electron/store/chats.js");
const { initStore } = require("../dist/electron/store/db.js");
const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
const { listInstalledAgents } = require("../dist/electron/mcp/registry.js");
const {
  deleteApiKey,
  deleteSecret,
  saveApiKey,
  setSecret,
} = require("../dist/electron/secrets/vault.js");
const { siteAgentAppContextFromSnapshot } = require("../dist/electron/site/agent-app.js");
const {
  createSiteProject,
  getSiteProject,
  siteAgentAppsRoot,
  updateSiteAgentAppArtifact,
} = require("../dist/electron/site/store.js");
const {
  connectSiteAgentAppPublishProvider,
  getSiteAgentAppPublishProviderStatus,
  isSitePublishLlmCredentialLocked,
  isSitePublishProviderCredentialLocked,
  normalizeProviderDeploymentUrl,
  providerGeneratedUrlFromCommandOutput,
  publishSiteAgentApp,
  saveSitePublishProviderToken,
  verifySiteAgentAppDeployment,
} = require("../dist/electron/site/agent-app-publish.js");
const { deleteSiteProjectWithAssets } = require("../dist/electron/site/delete-project.js");

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
};

const CONSENT = {
  providerAccountReady: true,
  providerTermsHandledByUser: true,
  planConfirmedByUser: true,
  deploymentApproved: true,
  llmKeyTransferApproved: true,
};

// The renderer checkboxes are proposal data only. The production IPC must
// fail closed before acquiring the project operation or opening native UI when
// the caller is not the trusted app window's top frame.
const ipcSource = fs.readFileSync(path.join(__dirname, "..", "electron", "ipc.ts"), "utf8");
const publishHandlerOffset = ipcSource.indexOf('ipcMain.handle("site:publishAgentApp"');
const senderGuardOffset = ipcSource.indexOf("assertTrustedSitePublishIpcSender(event)", publishHandlerOffset);
const operationOffset = ipcSource.indexOf("tryAcquireSiteProjectOperation", publishHandlerOffset);
assert.ok(publishHandlerOffset >= 0 && senderGuardOffset > publishHandlerOffset && operationOffset > senderGuardOffset,
  "publish IPC must validate its sender before acquiring the project operation");
assert.match(ipcSource, /frame\s*!==\s*event\.sender\.mainFrame/, "publish IPC must reject child-frame callers");
assert.match(ipcSource, /!isTrustedSiteRendererUrl\(frame\.url\)/, "publish IPC must validate the top-frame URL");
assert.match(ipcSource, /url\.protocol\s*===\s*"agentlas:"\s*&&\s*url\.hostname\s*===\s*"app"/,
  "production publish IPC must be restricted to agentlas://app");
assert.match(ipcSource, /dialog\.showMessageBox\(win/, "publish authorization must use a main-owned native dialog");
const publishDialogSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "components", "site", "SitePublishDialog.tsx"), "utf8");
const sitePageSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "(shell)", "site", "page.tsx"), "utf8");
const publishBackendSource = fs.readFileSync(path.join(__dirname, "..", "electron", "site", "agent-app-publish.ts"), "utf8");
assert.match(
  publishDialogSource,
  /durableVerificationReceiptCreated[\s\S]+deployment-verification-required[\s\S]+durableProviderMutationReceipt[\s\S]+durableVerificationReceiptCreated \|\| durableProviderMutationReceipt\) await onPublished/,
  "verification-required and durable provider mutation receipts must refresh the parent project state",
);
assert.match(
  sitePageSource,
  /deployment-verification-required[\s\S]{0,600}아직 Live가 아닙니다/,
  "verification-required must be surfaced as non-Live instead of publish success",
);
assert.match(
  publishDialogSource,
  /provider !== "render" && \(\s*<button[^>]+onClick=\{\(\) => void connectProvider\(\)\}/,
  "Render must not expose the CLI browser-connect action",
);
const deleteHandlerOffset = ipcSource.indexOf('ipcMain.handle("site:deleteProject"');
const deleteSenderGuardOffset = ipcSource.indexOf("assertTrustedSitePublishIpcSender(event)", deleteHandlerOffset);
const deleteOperationOffset = ipcSource.indexOf('tryAcquireSiteProjectOperation(projectId, "delete")', deleteHandlerOffset);
const deleteAcknowledgementOffset = ipcSource.indexOf("confirmNativeSiteProjectDeletion", deleteHandlerOffset);
assert.ok(
  deleteHandlerOffset >= 0 &&
  deleteSenderGuardOffset > deleteHandlerOffset &&
  deleteOperationOffset > deleteSenderGuardOffset &&
  deleteAcknowledgementOffset > deleteOperationOffset,
  "Site deletion must guard the sender, hold the project lease, and request main-owned remote retention acknowledgement",
);
const vercelMutationAttemptOffset = publishBackendSource.indexOf('phase: "mutation-attempted"', publishBackendSource.indexOf("async function deployVercel"));
const vercelLinkOffset = publishBackendSource.indexOf("const link = await runCommand", publishBackendSource.indexOf("async function deployVercel"));
const vercelSecretAttemptOffset = publishBackendSource.indexOf('phase: "secret-transfer-attempted"', publishBackendSource.indexOf("async function deployVercel"));
const vercelAccessWriteOffset = publishBackendSource.indexOf("const accessSecret = await runCommand", publishBackendSource.indexOf("async function deployVercel"));
const railwayStartOffset = publishBackendSource.indexOf("async function deployRailway");
const railwayProjectAttemptOffset = publishBackendSource.indexOf('phase: "mutation-attempted"', railwayStartOffset);
const railwayInitOffset = publishBackendSource.indexOf("const init = await runCommand", railwayStartOffset);
const railwayServiceAttemptOffset = publishBackendSource.indexOf('phase: "mutation-attempted"', railwayProjectAttemptOffset + 1);
const railwayServiceWriteOffset = publishBackendSource.indexOf("const addService = await runCommand", railwayStartOffset);
const railwaySecretAttemptOffset = publishBackendSource.indexOf('phase: "secret-transfer-attempted"', railwayStartOffset);
const railwayAccessWriteOffset = publishBackendSource.indexOf("const accessSecret = await runCommand", railwayStartOffset);
const renderMutationAttemptOffset = publishBackendSource.indexOf('phase: "mutation-attempted"', publishBackendSource.indexOf("async function deployRender"));
const renderPostOffset = publishBackendSource.indexOf('renderApiRequest(session.apiKey, "/services"', publishBackendSource.indexOf("async function deployRender"));
assert.ok(vercelMutationAttemptOffset >= 0 && vercelMutationAttemptOffset < vercelLinkOffset,
  "Vercel orphan-risk intent must be durable before its first mutation command");
assert.ok(vercelSecretAttemptOffset >= 0 && vercelSecretAttemptOffset < vercelAccessWriteOffset,
  "Vercel secret name must be durable before the provider secret write");
assert.ok(railwayProjectAttemptOffset >= 0 && railwayProjectAttemptOffset < railwayInitOffset,
  "Railway orphan-risk project intent must be durable before init");
assert.ok(railwayServiceAttemptOffset >= 0 && railwayServiceAttemptOffset < railwayServiceWriteOffset,
  "Railway deterministic service intent must be durable before service creation");
assert.ok(railwaySecretAttemptOffset >= 0 && railwaySecretAttemptOffset < railwayAccessWriteOffset,
  "Railway secret name must be durable before the provider secret write");
assert.ok(renderMutationAttemptOffset >= 0 && renderMutationAttemptOffset < renderPostOffset,
  "Render orphan-risk service intent must be durable before POST");
assert.match(ipcSource, /providerApiKeyFingerprint[\s\S]+renderIntent/,
  "Render native confirmation must show the API-key fingerprint and exact service intent");

let exitCode = 0;
app.whenReady().then(async () => {
  try {
    initStore();
    seedBuiltinAgents();
    const renderStatusWithoutApiKey = await getSiteAgentAppPublishProviderStatus("render");
    assert.equal(renderStatusWithoutApiKey.ready, false);
    assert.equal(renderStatusWithoutApiKey.cliInstalled, false);
    assert.equal(renderStatusWithoutApiKey.tokenStored, false);
    assert.equal(
      renderStatusWithoutApiKey.reason,
      "Render API key가 저장되어 있지 않습니다.",
      "Render is API-key-only and must never ask the user to install a nonexistent CLI",
    );
    const renderConnectWithoutApiKey = await connectSiteAgentAppPublishProvider("render");
    assert.equal(renderConnectWithoutApiKey.ok, false);
    assert.equal(renderConnectWithoutApiKey.userAction.code, "provider-login-required");
    assert.match(renderConnectWithoutApiKey.userAction.message, /Render API key.*Keychain/);
    assert.equal(renderConnectWithoutApiKey.userAction.url, "https://dashboard.render.com/u/settings#api-keys");
    assert.equal(fs.existsSync(fakeRenderInvocation), false, "Render status/connect must never execute a PATH binary");
    assert.throws(
      () => normalizeProviderDeploymentUrl("vercel", "https://127.0.0.1/"),
      /vercel\.app/,
      "literal loopback verification targets must be rejected before network access",
    );
    assert.throws(
      () => normalizeProviderDeploymentUrl("railway", "https://169.254.169.254/latest/meta-data/"),
      /railway\.app/,
      "literal link-local verification targets must be rejected before network access",
    );
    assert.equal(
      providerGeneratedUrlFromCommandOutput(
        "vercel",
        "Inspect: https://vercel.com/acme/site/deployments/dep-1\nProduction: https://qa-contract.vercel.app",
      ),
      "https://qa-contract.vercel.app/",
      "Vercel parser must skip the earlier Inspect dashboard URL",
    );
    assert.equal(
      providerGeneratedUrlFromCommandOutput(
        "railway",
        'Dashboard: https://railway.com/project/prj-1\n{"domain":"qa-contract.up.railway.app"}',
      ),
      "https://qa-contract.up.railway.app/",
      "Railway parser must skip the earlier dashboard URL and accept its generated domain",
    );
    const verificationPasscode = "verification-passcode-12345678901234567890";
    const verificationRequests = [];
    const safeVerification = await verifySiteAgentAppDeployment("vercel", "https://qa-contract.vercel.app/", verificationPasscode, {
      attempts: 1,
      resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
      requestProbe: async (input) => {
        verificationRequests.push(input);
        return input.url.endsWith("/api/run")
          ? { status: 400, body: '{"ok":false,"error":{"code":"invalid-input"}}' }
          : { status: 200, body: "" };
      },
    });
    assert.equal(safeVerification.ok, true, JSON.stringify(safeVerification));
    assert.deepEqual(verificationRequests.map((input) => input.url).sort(), [
      "https://qa-contract.vercel.app/",
      "https://qa-contract.vercel.app/api/run",
      "https://qa-contract.vercel.app/healthz",
    ]);
    const apiProbe = verificationRequests.find((input) => input.url.endsWith("/api/run"));
    assert.equal(apiProbe.method, "POST");
    assert.equal(apiProbe.headers.Authorization, `Bearer ${verificationPasscode}`);
    assert.equal(apiProbe.headers["Content-Type"], "application/json");
    assert.equal(apiProbe.body, "{}");
    assert.equal(JSON.stringify(safeVerification).includes(verificationPasscode), false,
      "verification result must never expose the app access passcode");

    const fakeHealthPage = await verifySiteAgentAppDeployment("vercel", "https://qa-contract.vercel.app/", verificationPasscode, {
      attempts: 1,
      resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
      requestProbe: async (input) => input.url.endsWith("/api/run")
        ? { status: 200, body: '{"ok":true}' }
        : { status: 200, body: "healthy-looking page" },
    });
    assert.equal(fakeHealthPage.ok, false, "a fake health page without the authenticated API contract must not publish");
    assert.match(fakeHealthPage.reason, /api\/run|invalid-input/);
    let boundedRequestCount = 0;
    const boundedVerification = await verifySiteAgentAppDeployment("vercel", "https://qa-contract.vercel.app/", verificationPasscode, {
      attempts: 2,
      retryDelayMs: 0,
      resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
      requestProbe: async () => {
        boundedRequestCount += 1;
        return { status: 503, body: "" };
      },
    });
    assert.equal(boundedVerification.ok, false);
    assert.equal(boundedRequestCount, 6, "two bounded attempts must make only root + /healthz + /api/run requests per attempt");
    let privateDnsRequestCount = 0;
    const blockedDnsVerification = await verifySiteAgentAppDeployment("railway", "https://qa-contract.up.railway.app/", verificationPasscode, {
      attempts: 1,
      resolveHost: async () => [{ address: "169.254.169.254", family: 4 }],
      requestProbe: async () => {
        privateDnsRequestCount += 1;
        return { status: 200, body: "" };
      },
    });
    assert.equal(blockedDnsVerification.ok, false);
    assert.match(blockedDnsVerification.reason, /private|loopback|link-local|예약/);
    assert.equal(privateDnsRequestCount, 0, "private DNS answers must be rejected before HTTPS request creation");
    const seededAgent = listInstalledAgents()[0];
    assert.ok(seededAgent, "a built-in agent is required for the registry foreign key");
    await deleteApiKey("openai");
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
      sourceScreenId: "screen-publish-contract",
    };
    const chat = getOrCreateAutomationSession({
      automationId: `site-agent-app:${project.id}`,
      agentId: project.agentAppTarget.id,
    });
    const scaffold = await scaffoldServiceApp({
      chatId: chat.id,
      surfaceId: `site:${project.id}`,
      manifest: context.manifest,
    }, {
      baseDir: siteAgentAppsRoot(),
      directChild: true,
      localPort: 43_211,
    });
    const record = recordScaffoldedApp({
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      surfaceId: `site:${project.id}`,
      manifest: context.manifest,
      scaffold,
    });
    const now = new Date().toISOString();
    updateSiteAgentAppArtifact(project.id, {
      schemaVersion: 1,
      appRecordId: record.id,
      appId: scaffold.appId,
      appName: project.agentAppTarget.name,
      rootPath: scaffold.rootPath,
      sourceScreenId: "screen-publish-contract",
      status: "ready",
      launchUrl: null,
      thumbnail: null,
      publish: null,
      createdAt: now,
      updatedAt: now,
      failureReason: null,
    });

    const request = {
      projectId: project.id,
      provider: "vercel",
      llmProvider: "openai",
      consent: CONSENT,
    };
    const missingAccessKey = await publishSiteAgentApp(request);
    assert.equal(missingAccessKey.ok, false);
    assert.equal(missingAccessKey.status, "needs-user-action");
    assert.equal(missingAccessKey.packageValidated, true, "the generated package and ID-free public binding must pass preflight");
    assert.equal(missingAccessKey.userAction.code, "app-access-key-required");

    const providerTokenA = "vca_native_approval_token_A_123456789";
    const providerTokenB = "vca_attacker_swap_token_B_987654321";
    const appAccessKey = "site-access-native-approval-1234567890";
    const llmKeyForDeploy = "sk-native-approval-llm-key-1234567890";
    const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const readProviderLog = () => fs.existsSync(fakeProviderLog)
      ? fs.readFileSync(fakeProviderLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    await setSecret("site-publish:vercel:access-token", providerTokenA);

    let cancelledApproval = null;
    const cancelled = await publishSiteAgentApp({ ...request, appAccessKey }, {
      confirmNativeApproval: async (approval) => {
        cancelledApproval = approval;
        return false;
      },
    });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.status, "needs-user-action");
    assert.equal(cancelled.userAction.code, "native-approval-required");
    assert.ok(cancelledApproval, "native confirmation must run even though no LLM key value exists yet");
    assert.match(cancelledApproval.artifactDigest, /^[a-f0-9]{64}$/);
    assert.equal(cancelledApproval.providerAccountLabel, "native-approval-account");
    assert.equal(cancelledApproval.providerConnectionMethod, "token");
    assert.equal(cancelledApproval.llmKeyFingerprint, null, "missing/legacy secret metadata must not trigger a pre-approval key read");
    assert.equal(cancelledApproval.appAccessKeyFingerprint, sha256(appAccessKey));
    assert.equal(JSON.stringify(cancelledApproval).includes(appAccessKey), false, "native approval receives only the app passcode fingerprint");
    const cancelledLog = readProviderLog();
    assert.equal(cancelledLog.some((entry) => ["link", "env", "deploy"].includes(entry.args[0])), false, "cancel must perform no provider mutation");

    const tamperLogOffset = cancelledLog.length;
    const tamperedAfterApproval = await publishSiteAgentApp({ ...request, appAccessKey }, {
      confirmNativeApproval: async () => {
        const packageDirs = fs.readdirSync(appTempDir)
          .filter((name) => name.startsWith("agentlas-site-publish-"));
        assert.equal(packageDirs.length, 1, "native approval must bind one private deployment copy");
        fs.appendFileSync(path.join(appTempDir, packageDirs[0], "package.json"), "\n", "utf8");
        return true;
      },
    });
    assert.equal(tamperedAfterApproval.ok, false);
    assert.equal(tamperedAfterApproval.status, "needs-user-action");
    assert.equal(tamperedAfterApproval.userAction.code, "deployment-contract-missing");
    assert.match(tamperedAfterApproval.reason, /artifact/i);
    const tamperLog = readProviderLog().slice(tamperLogOffset);
    assert.equal(tamperLog.some((entry) => ["link", "env", "deploy"].includes(entry.args[0])), false,
      "an approval-time artifact change must fail before any provider mutation");

    await saveApiKey("openai", llmKeyForDeploy);
    let approvedSummary = null;
    let firstVerificationCalls = 0;
    const awaitingVerification = await publishSiteAgentApp({ ...request, appAccessKey }, {
      confirmNativeApproval: async (approval) => {
        approvedSummary = approval;
        const packageDirs = fs.readdirSync(appTempDir)
          .filter((name) => name.startsWith("agentlas-site-publish-"));
        assert.equal(packageDirs.length, 1);
        const healthShim = fs.readFileSync(path.join(appTempDir, packageDirs[0], "api", "healthz.mjs"), "utf8");
        assert.match(healthShim, /status\(200\)/, "Vercel publish tree must include a main-owned /healthz function");
        assert.doesNotMatch(healthShim, /OPENAI|ANTHROPIC|GEMINI|\/api\/run/, "health probe must not invoke paid inference");
        assert.equal(isSitePublishProviderCredentialLocked("vercel"), true);
        assert.equal(isSitePublishLlmCredentialLocked("openai"), true);
        await assert.rejects(
          saveSitePublishProviderToken("vercel", providerTokenB),
          /native 게시 승인|credential/i,
          "provider token mutation API must be locked while native approval is open",
        );
        // Simulate a compromised renderer swapping the saved provider token
        // while the native dialog is open. The captured token must still own
        // re-verification and every mutation command.
        await setSecret("site-publish:vercel:access-token", providerTokenB);
        return true;
      },
      verifyDeployment: async (provider, url, receivedAccessKey) => {
        firstVerificationCalls += 1;
        assert.equal(provider, "vercel");
        assert.equal(url, "https://native-approval-test.vercel.app/");
        assert.equal(receivedAccessKey, appAccessKey, "main-owned verifier must receive the approved app passcode");
        return {
          ok: false,
          pageStatus: 200,
          healthStatus: 503,
          apiStatus: 400,
          apiErrorCode: "invalid-input",
          reason: "deployment is still warming",
        };
      },
    });
    assert.equal(awaitingVerification.ok, false, JSON.stringify(awaitingVerification));
    assert.equal(awaitingVerification.status, "needs-user-action");
    assert.equal(awaitingVerification.userAction.code, "deployment-verification-required");
    assert.equal(awaitingVerification.providerProjectId, "prj-native-approval");
    assert.equal(awaitingVerification.url, "https://native-approval-test.vercel.app/");
    assert.equal(firstVerificationCalls, 1);
    assert.equal(approvedSummary.providerAccountLabel, "native-approval-account");
    assert.equal(approvedSummary.llmKeyFingerprint, sha256(llmKeyForDeploy));
    assert.match(approvedSummary.intentDigest, /^[a-f0-9]{64}$/,
      "native approval must bind the complete provider/account/secret intent");
    assert.ok(approvedSummary.llmKeyVersion, "new Keychain saves must expose a value-free version identity");
    const approvedLog = readProviderLog();
    const mutationLog = approvedLog.filter((entry) => ["link", "env", "deploy"].includes(entry.args[0]));
    assert.ok(mutationLog.length >= 5, "approved deploy must link, set selector/two secrets, and deploy");
    assert.ok(mutationLog.every((entry) => entry.tokenHash === sha256(providerTokenA)), "provider mutation must use only the credential captured before native approval");
    const accessWrite = mutationLog.find((entry) => entry.args[0] === "env" && entry.args[2] === "AGENTLAS_APP_ACCESS_KEY");
    const llmWrite = mutationLog.find((entry) => entry.args[0] === "env" && entry.args[2] === "OPENAI_API_KEY");
    assert.equal(accessWrite?.stdinHash, sha256(`${appAccessKey}\n`), "app access key must travel only over provider CLI stdin");
    assert.equal(llmWrite?.stdinHash, sha256(`${llmKeyForDeploy}\n`), "LLM key must travel only over provider CLI stdin after approval");
    assert.equal(JSON.stringify(awaitingVerification).includes(appAccessKey), false);
    assert.equal(JSON.stringify(awaitingVerification).includes(llmKeyForDeploy), false);
    const unverifiedReceipt = getSiteProject(project.id).agentAppArtifact?.publish;
    assert.equal(unverifiedReceipt?.status, "verification-required", "CLI success alone must never persist published");
    assert.equal(unverifiedReceipt?.providerProjectId, "prj-native-approval");
    assert.equal(unverifiedReceipt?.url, "https://native-approval-test.vercel.app/");
    const unverifiedProject = getSiteProject(project.id);
    const firstDeploymentId = unverifiedProject.agentAppDeployments.at(-1).deploymentId;
    const firstDeploymentEvents = unverifiedProject.agentAppDeployments.filter((event) => event.deploymentId === firstDeploymentId);
    assert.ok(firstDeploymentEvents.some((event) => event.phase === "mutation-attempted"),
      "the durable ledger must begin before the first provider mutation");
    assert.ok(firstDeploymentEvents.some((event) => event.phase === "resource-created"));
    assert.ok(firstDeploymentEvents.some((event) => event.phase === "secret-transfer-attempted"));
    assert.ok(firstDeploymentEvents.some((event) => event.phase === "secret-transferred"));
    assert.equal(firstDeploymentEvents.at(-1).status, "verification-required");
    assert.deepEqual(firstDeploymentEvents.at(-1).transferredSecrets.sort(), ["AGENTLAS_APP_ACCESS_KEY", "OPENAI_API_KEY"]);

    let wrongPasscodeVerificationCalls = 0;
    const providerLogBeforeWrongPasscode = readProviderLog().length;
    const wrongPasscodeRetry = await publishSiteAgentApp({
      projectId: project.id,
      provider: "vercel",
      llmProvider: "google",
      appAccessKey: "wrong-deployment-passcode-123456789012345",
      consent: {
        providerAccountReady: false,
        providerTermsHandledByUser: false,
        planConfirmedByUser: false,
        deploymentApproved: false,
        llmKeyTransferApproved: false,
      },
    }, {
      verifyDeployment: async () => {
        wrongPasscodeVerificationCalls += 1;
        throw new Error("wrong passcode must fail before network verification");
      },
    });
    assert.equal(wrongPasscodeRetry.ok, false);
    assert.equal(wrongPasscodeRetry.userAction.code, "app-access-key-required");
    assert.equal(wrongPasscodeVerificationCalls, 0);
    assert.equal(readProviderLog().length, providerLogBeforeWrongPasscode);

    const providerLogBeforeVerificationRetry = readProviderLog().length;
    const verifiedRetry = await publishSiteAgentApp({
      projectId: project.id,
      provider: "vercel",
      llmProvider: "google",
      appAccessKey,
      consent: {
        providerAccountReady: false,
        providerTermsHandledByUser: false,
        planConfirmedByUser: false,
        deploymentApproved: false,
        llmKeyTransferApproved: false,
      },
    }, {
      verifyDeployment: async (provider, url, receivedAccessKey) => {
        assert.equal(provider, "vercel");
        assert.equal(url, "https://native-approval-test.vercel.app/");
        assert.equal(receivedAccessKey, appAccessKey);
        return {
          ok: true,
          pageStatus: 200,
          healthStatus: 200,
          apiStatus: 400,
          apiErrorCode: "invalid-input",
          reason: null,
        };
      },
    });
    assert.equal(verifiedRetry.ok, true, JSON.stringify(verifiedRetry));
    assert.equal(verifiedRetry.status, "published");
    assert.equal(verifiedRetry.providerProjectId, "prj-native-approval");
    assert.equal(readProviderLog().length, providerLogBeforeVerificationRetry,
      "verification retry must not create, link, configure, or deploy another provider resource");
    const verifiedReceipt = getSiteProject(project.id).agentAppArtifact?.publish;
    assert.equal(verifiedReceipt?.status, "published");
    assert.equal(verifiedReceipt?.llmProvider, "openai", "verification retry must retain the deployed LLM selector");

    const beforeRebuild = getSiteProject(project.id);
    const deploymentHistoryLength = beforeRebuild.agentAppDeployments.length;
    const publishedArtifact = beforeRebuild.agentAppArtifact;
    const publishedEvent = beforeRebuild.agentAppDeployments.at(-1);
    assert.deepEqual(publishedArtifact.publishBinding, {
      deploymentId: publishedEvent.deploymentId,
      artifactDigest: publishedEvent.artifactDigest,
      intentDigest: publishedEvent.intentDigest,
    }, "the current publish badge must be bound to the exact artifact and provider intent digests");
    updateSiteAgentAppArtifact(project.id, {
      ...publishedArtifact,
      publish: null,
      updatedAt: new Date().toISOString(),
    });
    const afterRebuild = getSiteProject(project.id);
    assert.equal(afterRebuild.agentAppDeployments.length, deploymentHistoryLength,
      "Agent App rebuild must not clear the project-owned deployment ledger");
    assert.equal(afterRebuild.agentAppArtifact.publish, null,
      "a rebuilt current artifact must not inherit a stale Live or pending badge from historical provider state");
    assert.equal(afterRebuild.agentAppArtifact.publishBinding, null,
      "rebuild must clear the current-artifact deployment binding without deleting history");
    assert.ok(afterRebuild.agentAppDeployments.some((event) => event.providerProjectId === "prj-native-approval"),
      "rebuild must retain the prior provider ID");

    // Simulate a provider accepting the secret write but losing the CLI
    // response. The pre-write ledger must retain the env name and the retry
    // must stop before creating a duplicate resource.
    await setSecret("site-publish:vercel:access-token", providerTokenA);
    fs.writeFileSync(fakeProviderFailureMode, "llm-secret-response-lost", "utf8");
    const providerLogBeforeResponseLoss = readProviderLog().length;
    const responseLost = await publishSiteAgentApp({ ...request, appAccessKey }, {
      confirmNativeApproval: async () => true,
    });
    assert.equal(responseLost.ok, false);
    assert.equal(responseLost.status, "needs-user-action");
    assert.equal(responseLost.userAction.code, "provider-action-required");
    assert.equal(responseLost.providerProjectId, "prj-mid-deploy-failure");
    const afterResponseLoss = getSiteProject(project.id);
    const failedEvent = afterResponseLoss.agentAppDeployments.at(-1);
    assert.equal(failedEvent.status, "failed");
    assert.equal(failedEvent.providerProjectId, "prj-mid-deploy-failure");
    assert.ok(failedEvent.transferredSecrets.includes("AGENTLAS_APP_ACCESS_KEY"));
    assert.ok(failedEvent.transferredSecrets.includes("OPENAI_API_KEY"),
      "a secret whose response was lost must be treated as possibly retained provider-side");
    const failedAttemptEvents = afterResponseLoss.agentAppDeployments.filter((event) => event.deploymentId === failedEvent.deploymentId);
    assert.ok(failedAttemptEvents.some((event) =>
      event.phase === "secret-transfer-attempted" && event.transferredSecrets.includes("OPENAI_API_KEY")));
    assert.equal(JSON.stringify(failedAttemptEvents).includes(appAccessKey), false);
    assert.equal(JSON.stringify(failedAttemptEvents).includes(llmKeyForDeploy), false);
    const providerLogAfterResponseLoss = readProviderLog().length;
    assert.ok(providerLogAfterResponseLoss > providerLogBeforeResponseLoss);
    const blockedDuplicateRetry = await publishSiteAgentApp({ ...request, appAccessKey }, {
      confirmNativeApproval: async () => {
        throw new Error("an incomplete provider mutation must block before native approval");
      },
    });
    assert.equal(blockedDuplicateRetry.ok, false);
    assert.equal(blockedDuplicateRetry.userAction.code, "provider-action-required");
    assert.equal(readProviderLog().length, providerLogAfterResponseLoss,
      "ambiguous provider mutation retry must not execute another provider command");
    fs.rmSync(fakeProviderFailureMode, { force: true });
    await deleteSecret("site-publish:vercel:access-token");

    const renderLlmSentinel = "sk-render-boundary-sentinel-never-transfer";
    const originalFetch = global.fetch;
    let renderCreateBody = null;
    let renderStatusRequests = 0;
    let renderCreateRequests = 0;
    const renderTokenA = "rnd_render_provider_token_A_123456789";
    const renderTokenB = "rnd_render_provider_token_B_987654321";
    await saveApiKey("openai", renderLlmSentinel);
    await setSecret("site-publish:render:api-key", renderTokenA);
    global.fetch = async (url, init = {}) => {
      const endpoint = String(url);
      const method = init.method || "GET";
      if (endpoint === "https://api.render.com/v1/services?limit=1" && method === "GET") {
        renderStatusRequests += 1;
        return { ok: true, status: 200, text: async () => "[]" };
      }
      if (endpoint === "https://api.render.com/v1/services" && method === "POST") {
        renderCreateRequests += 1;
        renderCreateBody = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({
            service: {
              id: "srv-render-boundary-test",
              serviceDetails: { url: "https://agentlas-render-boundary.onrender.com" },
            },
          }),
        };
      }
      throw new Error(`unexpected Render API request: ${method} ${endpoint}`);
    };
    try {
      const renderRequest = {
        projectId: project.id,
        provider: "render",
        llmProvider: "openai",
        consent: { ...CONSENT, llmKeyTransferApproved: false },
        renderRepositoryUrl: "https://github.com/example/agentlas-render-boundary",
        renderOwnerId: "tea-render-boundary",
        renderBranch: "main",
        renderRootDir: "astryx-app",
        renderRepositoryContainsValidatedPackage: true,
      };

      let cancelledRenderApproval = null;
      const cancelledRender = await publishSiteAgentApp(renderRequest, {
        confirmNativeApproval: async (approval) => {
          cancelledRenderApproval = approval;
          assert.equal(isSitePublishProviderCredentialLocked("render"), true);
          assert.equal(isSitePublishLlmCredentialLocked("openai"), false,
            "Render must not lock or read the LLM credential it never transfers");
          await assert.rejects(
            saveSitePublishProviderToken("render", renderTokenB),
            /native 게시 승인|credential/i,
          );
          return false;
        },
      });
      assert.equal(cancelledRender.ok, false);
      assert.equal(cancelledRender.userAction.code, "native-approval-required");
      assert.equal(renderCreateRequests, 0, "renderer consent plus a cancelled native dialog must create nothing");
      assert.ok(cancelledRenderApproval);
      assert.equal(cancelledRenderApproval.provider, "render");
      assert.equal(cancelledRenderApproval.providerAccountLabel, "owner:tea-render-boundary");
      assert.equal(cancelledRenderApproval.providerApiKeyIdentity, "OS credential vault / secret:site-publish:render:api-key");
      assert.equal(cancelledRenderApproval.providerApiKeyFingerprint, sha256(renderTokenA));
      assert.match(cancelledRenderApproval.artifactDigest, /^[a-f0-9]{64}$/);
      assert.match(cancelledRenderApproval.intentDigest, /^[a-f0-9]{64}$/);
      assert.deepEqual({
        repositoryUrl: cancelledRenderApproval.renderIntent.repositoryUrl,
        ownerId: cancelledRenderApproval.renderIntent.ownerId,
        branch: cancelledRenderApproval.renderIntent.branch,
        rootDir: cancelledRenderApproval.renderIntent.rootDir,
      }, {
        repositoryUrl: "https://github.com/example/agentlas-render-boundary",
        ownerId: "tea-render-boundary",
        branch: "main",
        rootDir: "astryx-app",
      });
      assert.match(cancelledRenderApproval.renderIntent.serviceName, /^agentlas-research-agent-/);
      assert.equal(cancelledRenderApproval.llmKeyFingerprint, null);
      assert.equal(cancelledRenderApproval.appAccessKeyFingerprint, null);
      assert.equal(JSON.stringify(cancelledRenderApproval).includes(renderLlmSentinel), false);
      assert.equal(JSON.stringify(cancelledRenderApproval).includes(renderTokenA), false);

      const tokenSwapRender = await publishSiteAgentApp(renderRequest, {
        confirmNativeApproval: async () => {
          await setSecret("site-publish:render:api-key", renderTokenB);
          return true;
        },
      });
      assert.equal(tokenSwapRender.ok, false);
      assert.equal(tokenSwapRender.userAction.code, "provider-login-required");
      assert.equal(renderCreateRequests, 0,
        "a Render Keychain token swap after approval must fail before service POST");
      await setSecret("site-publish:render:api-key", renderTokenA);

      let approvedRenderSummary = null;
      const renderResult = await publishSiteAgentApp(renderRequest, {
        confirmNativeApproval: async (approval) => {
          approvedRenderSummary = approval;
          return true;
        },
      });
      assert.equal(renderResult.ok, false, "Render remains incomplete until the user configures its LLM key");
      assert.equal(renderResult.status, "needs-user-action");
      assert.equal(renderResult.packageValidated, true);
      assert.equal(renderResult.userAction.code, "render-llm-key-required");
      assert.equal(renderResult.providerProjectId, "srv-render-boundary-test");
      assert.equal(renderResult.url, "https://agentlas-render-boundary.onrender.com/");
      assert.equal(approvedRenderSummary.providerApiKeyFingerprint, sha256(renderTokenA));
      assert.equal(approvedRenderSummary.renderIntent.ownerId, "tea-render-boundary");
      assert.ok(renderCreateBody, "Render service creation body must be captured");
      assert.deepEqual(renderCreateBody.envVars, [
        { key: "AGENTLAS_LLM_PROVIDER", value: "openai" },
        { key: "AGENTLAS_APP_INSTANCE_DAILY_BUDGET", value: "100" },
      ]);
      assert.equal(JSON.stringify(renderCreateBody).includes(renderLlmSentinel), false, "stored LLM secret must never enter a Render API request");
      assert.equal(renderCreateBody.envVars.some((entry) => entry.key === "OPENAI_API_KEY"), false, "Render env must omit the selected LLM secret variable");
      assert.equal(renderCreateBody.envVars.some((entry) => entry.key === "AGENTLAS_APP_ACCESS_KEY"), false, "Render env must omit the app access secret for manual configuration");
      assert.match(renderResult.reason, /OPENAI_API_KEY.*AGENTLAS_APP_ACCESS_KEY/, "Render must request manual configuration of both secrets");

      const storedReceipt = getSiteProject(project.id).agentAppArtifact?.publish;
      assert.equal(storedReceipt?.status, "configuration-required", "created Render service must persist as configuration-required, not published");
      assert.equal(storedReceipt?.providerProjectId, "srv-render-boundary-test");
      assert.equal(storedReceipt?.url, "https://agentlas-render-boundary.onrender.com/");
      assert.equal(storedReceipt?.llmProvider, "openai");
      const renderProject = getSiteProject(project.id);
      const renderDeployment = renderProject.agentAppDeployments.at(-1).deploymentId;
      const renderEvents = renderProject.agentAppDeployments.filter((event) => event.deploymentId === renderDeployment);
      assert.ok(renderEvents.some((event) => event.phase === "mutation-attempted"),
        "Render must persist its orphan-risk intent before the service POST");
      assert.ok(renderEvents.some((event) => event.phase === "service-created"));
      assert.equal(renderEvents.at(-1).status, "configuration-required");
      assert.ok(renderEvents.every((event) => event.transferredSecrets.length === 0),
        "Render ledger must never claim local LLM/app secret transfer");

      const renderStatusBeforeRetry = renderStatusRequests;
      const retry = await publishSiteAgentApp({
        projectId: project.id,
        provider: "render",
        llmProvider: "google",
        consent: {
          providerAccountReady: false,
          providerTermsHandledByUser: false,
          planConfirmedByUser: false,
          deploymentApproved: false,
          llmKeyTransferApproved: false,
        },
      });
      assert.equal(retry.ok, false);
      assert.equal(retry.status, "needs-user-action");
      assert.equal(retry.userAction.code, "render-llm-key-required");
      assert.equal(retry.providerProjectId, storedReceipt.providerProjectId, "retry must return the durable Render service ID");
      assert.equal(retry.url, storedReceipt.url, "retry must return the durable Render service URL");
      assert.match(retry.reason, /OPENAI_API_KEY/, "retry must retain the provider selector used by the existing service");
      assert.equal(renderCreateRequests, 1, "retry must not create a duplicate Render service");
      assert.equal(renderStatusRequests, renderStatusBeforeRetry,
        "retry must not require provider credentials or another Render API call");
    } finally {
      global.fetch = originalFetch;
      await deleteSecret("site-publish:render:api-key");
      await deleteApiKey("openai");
    }

    const bindingPath = path.join(scaffold.rootPath, "astryx-app", "public", "agentlas.binding.json");
    const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
    assert.equal("id" in binding.target, false, "the public binding must not expose the local target id");
    binding.target.id = project.agentAppTarget.id;
    fs.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
    const leakedId = await publishSiteAgentApp({ ...request, provider: "railway" });
    assert.equal(leakedId.ok, false);
    assert.equal(leakedId.status, "failed");
    assert.equal(leakedId.packageValidated, false, "preflight must reject a public binding containing the private target id");
    assert.match(leakedId.reason, /binding/i);

    const designChat = getOrCreateSiteSession(project.id);
    let remoteMutationRequests = 0;
    global.fetch = async () => {
      remoteMutationRequests += 1;
      throw new Error("local Site deletion must never call a remote provider API");
    };
    try {
      const deletionBlocked = await deleteSiteProjectWithAssets(project.id);
      assert.equal(deletionBlocked.ok, false);
      assert.equal(deletionBlocked.code, "remote-deployment-acknowledgement-required");
      assert.equal(deletionBlocked.remoteDeploymentRetained.provider, "render");
      assert.equal(deletionBlocked.remoteDeploymentRetained.providerProjectId, "srv-render-boundary-test");
      assert.equal(deletionBlocked.remoteDeploymentsRetained.length, 3,
        "deletion must enumerate every historical remote deployment, not only the latest provider");
      const retainedRender = deletionBlocked.remoteDeploymentsRetained.find((remote) =>
        remote.provider === "render" && remote.providerProjectId === "srv-render-boundary-test");
      const retainedPublishedVercel = deletionBlocked.remoteDeploymentsRetained.find((remote) =>
        remote.provider === "vercel" && remote.providerProjectId === "prj-native-approval");
      const retainedFailedVercel = deletionBlocked.remoteDeploymentsRetained.find((remote) =>
        remote.provider === "vercel" && remote.providerProjectId === "prj-mid-deploy-failure");
      assert.ok(retainedRender);
      assert.ok(retainedPublishedVercel);
      assert.ok(retainedFailedVercel);
      assert.deepEqual(retainedRender.transferredSecrets, []);
      assert.ok(retainedPublishedVercel.transferredSecrets.includes("OPENAI_API_KEY"));
      assert.ok(retainedFailedVercel.transferredSecrets.includes("OPENAI_API_KEY"));
      assert.match(retainedFailedVercel.message, /남아 있을 수 있습니다/);
      assert.ok(fs.existsSync(scaffold.rootPath), "remote acknowledgement gate must not delete the local artifact");
      assert.ok(getAgentApp(record.id), "remote acknowledgement gate must not delete the AppFactory registration");
      assert.ok(getChat(chat.id), "remote acknowledgement gate must not delete the Agent App hidden chat");
      assert.ok(getChat(designChat.id), "remote acknowledgement gate must not delete the Site hidden chat");

      const deleted = await deleteSiteProjectWithAssets(project.id, { acknowledgeRemoteRetained: true });
      assert.equal(deleted.ok, true, JSON.stringify(deleted));
      assert.equal(deleted.remoteDeploymentRetained.provider, "render");
      assert.equal(deleted.remoteDeploymentsRetained.length, 3);
      assert.equal(deleted.localCleanup.artifactRemoved, true);
      assert.equal(deleted.localCleanup.appRegistrationRemoved, true);
      assert.equal(deleted.localCleanup.hiddenSessionsRemoved, 2);
      assert.equal(fs.existsSync(scaffold.rootPath), false, "local generated Agent App artifact must be removed");
      assert.equal(getAgentApp(record.id), null, "AppFactory registration and operation history must cascade away");
      assert.equal(getChat(chat.id), null, "Agent App automation hidden chat must be removed");
      assert.equal(getChat(designChat.id), null, "Site design hidden chat must be removed");
      assert.throws(() => getSiteProject(project.id), /찾을 수 없음/, "Site project metadata must be removed last");
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(remoteMutationRequests, 0, "local deletion must not call a destructive remote provider API");
    assert.equal(renderCreateRequests, 1, "local deletion must not create another remote provider resource");

    console.log("site agent app publish verification + Render boundary + deletion lifecycle ok");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.exit(exitCode);
  }
}).catch((error) => {
  console.error(error);
  fs.rmSync(tempDir, { recursive: true, force: true });
  app.exit(1);
});
