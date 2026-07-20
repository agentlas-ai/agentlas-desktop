#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-execution-boundary-"));
const userData = path.join(temp, "user-data");
const workspace = path.join(temp, "workspace");
const otherWorkspace = path.join(temp, "other-workspace");
const workspaceLink = path.join(temp, "workspace-link");
const inferredWorkspace = path.join(temp, "must-not-be-inferred");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(otherWorkspace, { recursive: true });
if (process.platform !== "win32") fs.symlinkSync(workspace, workspaceLink, "dir");
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_RUNTIME_DETECT_CACHE_MS = "0";
app.setPath("userData", userData);
let testDb = null;
let exitCode = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Mobile execution boundary state");
}

async function main() {
  await app.whenReady();

  const store = require("../dist/electron/store/db.js");
  store.initStore();
  testDb = store.getDb();
  store.getDb().prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    "mobile-execution-boundary-agent",
    "mobile-execution-boundary-agent",
    "Mobile Execution Boundary Agent",
    "Mobile Execution Boundary Agent",
    "Host authority fixture",
    "Host authority fixture",
    "Answer concisely and never widen host permissions.",
    "2026-07-14T00:00:00.000Z",
  );

  const chats = require("../dist/electron/store/chats.js");
  const chat = chats.createChat({
    agentId: "mobile-execution-boundary-agent",
    title: "Mobile execution boundary",
  });
  const globalChat = chats.createChat({
    agentId: "mobile-execution-boundary-agent",
    title: "Mobile global read boundary",
  });
  const automationChat = chats.createChat({
    agentId: "mobile-execution-boundary-agent",
    title: "Unattended read automation boundary",
  });
  store.getDb().prepare("UPDATE chats SET kind = 'division' WHERE id = ?").run(automationChat.id);

  const workspaceBoundary = require("../dist/electron/invocation/workspace-binding.js");
  const canonicalWorkspace = fs.realpathSync.native(workspace);
  const capturedFromLink = workspaceBoundary.captureInvocationWorkspaceBinding(
    process.platform === "win32" ? workspace : workspaceLink,
  );
  assert.equal(capturedFromLink.canonicalPath, canonicalWorkspace, "authority must resolve symlinks once");
  assert.deepEqual(workspaceBoundary.captureInvocationWorkspaceBinding(null), {
    source: "mobile",
    canonicalPath: null,
    directoryIdentity: null,
  });
  assert.equal(workspaceBoundary.normalizeRemoteInvocationPermission(undefined), "read");
  assert.equal(workspaceBoundary.normalizeRemoteInvocationPermission("write"), "write");
  assert.equal(workspaceBoundary.normalizeRemoteInvocationPermission("full"), "full");

  // There must be no reduced runtime path for a paired remote. This
  // source-level check prevents the old mobile-only runtime refusal from
  // silently returning during future orchestration work.
  const clientSource = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
  assert.match(clientSource, /normalizeRemoteInvocationPermission\(req\.permissions\)/);
  assert.doesNotMatch(clientSource, /mobile-runtime-not-read-sandboxed/);
  assert.doesNotMatch(clientSource, /automation-runtime-not-read-sandboxed/);
  assert.throws(
    () => workspaceBoundary.captureInvocationWorkspaceBinding(path.join(temp, "missing")),
    /unavailable/,
  );
  const nonDirectory = path.join(temp, "not-a-directory.txt");
  fs.writeFileSync(nonDirectory, "file");
  assert.throws(
    () => workspaceBoundary.captureInvocationWorkspaceBinding(nonDirectory),
    /not a directory/,
  );
  const removedWorkspace = path.join(temp, "removed-after-capture");
  fs.mkdirSync(removedWorkspace);
  const removedBinding = workspaceBoundary.captureInvocationWorkspaceBinding(removedWorkspace);
  fs.rmSync(removedWorkspace, { recursive: true, force: true });
  assert.throws(
    () => workspaceBoundary.revalidateInvocationWorkspaceBinding(removedBinding),
    /unavailable/,
  );
  const replacedWorkspace = path.join(temp, "replaced-at-same-path");
  fs.mkdirSync(replacedWorkspace);
  const replacedBinding = workspaceBoundary.captureInvocationWorkspaceBinding(replacedWorkspace);
  let replacementBinding = replacedBinding;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    fs.rmSync(replacedWorkspace, { recursive: true, force: true });
    fs.mkdirSync(path.join(temp, `replacement-identity-decoy-${attempt}`));
    fs.mkdirSync(replacedWorkspace);
    replacementBinding = workspaceBoundary.captureInvocationWorkspaceBinding(replacedWorkspace);
    if (
      replacementBinding.directoryIdentity.inode !== replacedBinding.directoryIdentity.inode ||
      replacementBinding.directoryIdentity.device !== replacedBinding.directoryIdentity.device
    ) break;
  }
  assert.notDeepEqual(
    replacementBinding.directoryIdentity,
    replacedBinding.directoryIdentity,
    "the fixture must produce a different directory identity at the same path",
  );
  assert.equal(
    workspaceBoundary.invocationWorkspaceBindingsEqual(replacedBinding, replacementBinding),
    false,
  );
  assert.throws(
    () => workspaceBoundary.revalidateInvocationWorkspaceBinding(replacedBinding),
    /changed after approval/,
    "deleting and recreating the same path must not preserve Mobile authority",
  );

  // InvocationService must carry the main-only binding through steering without
  // consulting the mutable chat row after the request has been accepted.
  const client = require("../dist/electron/mcp/client.js");
  const actualRunMcpInvocation = client.runMcpInvocation;
  const serviceCalls = [];
  const serviceRuns = [];
  client.runMcpInvocation = (request, _sink, _signal, binding) => {
    const pending = deferred();
    serviceCalls.push({ request, binding });
    serviceRuns.push(pending);
    return pending.promise;
  };
  const { InvocationService } = require("../dist/electron/invocation/service.js");
  const service = new InvocationService();

  chats.setChatWorkingFolder(chat.id, process.platform === "win32" ? workspace : workspaceLink);
  const activeBinding = workspaceBoundary.captureInvocationWorkspaceBinding(
    chats.getChatWorkingFolder(chat.id),
  );
  const started = service.start({
    chatId: chat.id,
    userPrompt: "Inspect the current workspace",
  }, activeBinding);
  assert.equal(serviceCalls[0].request.permissions, "read", "omitted Mobile permission must normalize to read");
  assert.deepEqual(serviceCalls[0].binding, activeBinding);

  chats.setChatWorkingFolder(chat.id, null);
  const clearedBinding = workspaceBoundary.captureInvocationWorkspaceBinding(
    chats.getChatWorkingFolder(chat.id),
  );
  assert.throws(
    () => service.steer({
      chatId: chat.id,
      userPrompt: "Steer after clearing the workspace",
    }, started.runId, clearedBinding),
    /working folder changed/,
    "a clear/set race must not move a queued steer into another workspace",
  );

  chats.setChatWorkingFolder(chat.id, workspace);
  const sameCanonicalBinding = workspaceBoundary.captureInvocationWorkspaceBinding(
    chats.getChatWorkingFolder(chat.id),
  );
  const queued = service.steer({
    chatId: chat.id,
    userPrompt: "Continue against the captured workspace",
  }, started.runId, sameCanonicalBinding);
  assert.equal(queued.queued, true);
  chats.setChatWorkingFolder(chat.id, otherWorkspace);
  serviceRuns[0].resolve({ stormbreakerContinueRequested: false });
  await waitUntil(() => serviceCalls.length === 2);
  assert.deepEqual(
    serviceCalls[1].binding,
    activeBinding,
    "queued steering must retain the accepted canonical binding across later chat mutations",
  );
  assert.equal(serviceCalls[1].request.permissions, "read");
  serviceRuns[1].resolve({ stormbreakerContinueRequested: false });
  await waitUntil(() => service.activeChatIds().length === 0);
  const mobileWrite = service.start({
    chatId: chat.id,
    userPrompt: "Edit through the paired Desktop",
    permissions: "write",
  }, activeBinding);
  assert.equal(serviceCalls.at(-1).request.permissions, "write");
  serviceRuns.at(-1).resolve({ stormbreakerContinueRequested: false });
  await waitUntil(() => service.activeChatIds().length === 0);
  const mobileFull = service.start({
    chatId: chat.id,
    userPrompt: "Run with the paired Desktop authority",
    permissions: "full",
  }, activeBinding);
  assert.equal(serviceCalls.at(-1).request.permissions, "full");
  serviceRuns.at(-1).resolve({ stormbreakerContinueRequested: false });
  await waitUntil(() => service.activeChatIds().length === 0);
  assert.ok(mobileWrite.runId);
  assert.ok(mobileFull.runId);
  client.runMcpInvocation = actualRunMcpInvocation;

  // The actual client revalidates the captured directory and gates the runtime
  // after the real runtime/override selection has resolved.
  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  const envResolver = require("../dist/electron/runtime/env-resolver.js");
  const stormbreaker = require("../dist/electron/hephaestus/stormbreaker-supervisor.js");
  const hephaestusCommands = require("../dist/electron/hephaestus/commands.js");
  const originalBuildRunnerEnv = envResolver.buildRunnerEnv;
  process.env.AGENTLAS_QA_PROCESS_SECRET = "process-secret-must-not-cross";
  fs.writeFileSync(path.join(userData, "credentials.env"), "AGENTLAS_QA_USER_SECRET=user-secret-must-not-cross\n");
  fs.writeFileSync(path.join(workspace, ".env"), "AGENTLAS_QA_PROJECT_SECRET=project-secret-must-not-cross\n");
  const restrictedEnv = await originalBuildRunnerEnv(null, workspace, { restrictedReadBoundary: true });
  for (const key of [
    "AGENTLAS_QA_PROCESS_SECRET",
    "AGENTLAS_QA_USER_SECRET",
    "AGENTLAS_QA_PROJECT_SECRET",
  ]) {
    assert.equal(restrictedEnv.env[key], undefined, `${key} must not cross the restricted read boundary`);
  }
  assert.deepEqual(restrictedEnv.env, {}, "restricted protocol runners must inherit no host environment");
  assert.deepEqual(restrictedEnv.injectedKeys, []);
  const { wrapSystemPrompt } = require("../dist/electron/runtime/runner.js");
  const restrictedSystem = wrapSystemPrompt(
    "Inspect the project carefully.",
    "en",
    "read",
    "What does local.config contain?",
    false,
    true,
  );
  assert.match(restrictedSystem, /no filesystem, shell, web, browser, MCP, plugin, or local tool access/);
  assert.match(restrictedSystem, /Never claim that you opened, searched, or inspected a local file/);
  assert.doesNotMatch(restrictedSystem, /<<surface-intent>>/);
  const restrictedBuildSentinel = wrapSystemPrompt(
    "<!-- agentlas-build-system-prompt/v1 -->\nYou have full file, shell, research, verification, and approved MCP tools.",
    "en",
    "read",
    "Inspect only",
    false,
    true,
  );
  assert.match(restrictedBuildSentinel, /Build-only agent definition was excluded/);
  assert.doesNotMatch(restrictedBuildSentinel, /You have full file, shell/);
  assert.match(restrictedBuildSentinel, /Host-enforced boundary \(final authority\)/);
  const { stripAllMemoryEventBlocks } = require("../dist/electron/memory/events.js");
  const controlsOnly = stripAllMemoryEventBlocks([
    "## Memory Events",
    "```json",
    JSON.stringify([{
      memory_kind: "fact",
      content: "CONTROL_ONLY_ONE",
      suggested_scope: "session",
      confidence: "high",
      sensitivity: "internal",
      evidence_refs: [],
    }]),
    "```",
    "## Memory Events",
    "```json",
    JSON.stringify([{
      memory_kind: "risk",
      content: "CONTROL_ONLY_TWO",
      suggested_scope: "project",
      confidence: "high",
      sensitivity: "internal",
      evidence_refs: [],
    }]),
    "```",
    "## Memory Events",
  ].join("\n"));
  assert.equal(controlsOnly.cleanedText, "", "control-only replies must not be restored by an empty fallback");
  assert.equal(controlsOnly.events.length, 2);
  let runtimeKind = "byok";
  const runnerRequests = [];
  const poisonSentinel = "MOBILE_READ_MUST_NEVER_PERSIST_THIS_MEMORY";
  const secondPoisonSentinel = "SECOND_MEMORY_BLOCK_MUST_NOT_PERSIST_EITHER";
  let restrictedPoisonPass = 0;
  const mockRunner = async (request, runnerEvents) => {
    runnerRequests.push(request);
    if (
      request.userPrompt.includes("Attempt memory poison") ||
      request.userPrompt.includes("Continue Stormbreaker execution pass")
    ) {
      restrictedPoisonPass += 1;
      const poisoned = [
        `Visible restricted pass ${restrictedPoisonPass}`,
        "## Memory Events",
        "```json",
        JSON.stringify([{
          memory_kind: "procedure",
          content: poisonSentinel,
          suggested_scope: "agent_repo",
          confidence: "high",
          sensitivity: "internal",
          evidence_refs: ["mobile-adversarial-qa"],
        }]),
        "```",
        "## Memory Events",
        "```json",
        JSON.stringify([{
          memory_kind: "risk",
          content: secondPoisonSentinel,
          suggested_scope: "project",
          confidence: "high",
          sensitivity: "internal",
          evidence_refs: ["mobile-adversarial-qa-second"],
        }]),
        "```",
        ...(restrictedPoisonPass === 1 ? ["<<stormbreaker-continue>>"] : []),
        ...(restrictedPoisonPass === 2 ? ["## Memory Events", "```json", "[dangling"] : []),
      ].join("\n");
      runnerEvents.onPartial(poisoned);
      return {
        text: poisoned,
        tokens: 1,
      };
    }
    return { text: `safe ${runtimeKind} read`, tokens: 1 };
  };
  const runtime = () => ({
    kind: runtimeKind,
    backend: runtimeKind === "byok" ? "openai" : runtimeKind === "ollama" ? "ollama" : undefined,
    source: runtimeKind === "gemini" ? "agy" : "mobile-execution-boundary-test",
    ready: true,
    active: true,
    model: "mock-mobile-execution-boundary",
  });
  detect.detectRuntimes = async () => [runtime()];
  selection.selectRuntimeForTargets = () => ({
    active: runtime(),
    picked: { runner: mockRunner, label: `Mock ${runtimeKind}` },
    override: null,
    unavailableOverride: null,
  });
  let removeBeforeRunnerPath = null;
  const envResolutionCalls = [];
  envResolver.buildRunnerEnv = async (_agent, _cwd, options) => {
    envResolutionCalls.push(options);
    if (removeBeforeRunnerPath) {
      fs.rmSync(removeBeforeRunnerPath, { recursive: true, force: true });
      removeBeforeRunnerPath = null;
    }
    return { env: envResolver.restrictedRunnerEnv(), injectedKeys: [] };
  };
  let restrictedSupervisorCalls = 0;
  let restrictedHarnessCalls = 0;
  stormbreaker.superviseStormbreaker = () => {
    restrictedSupervisorCalls += 1;
    return null;
  };
  hephaestusCommands.stormbreakerHarness = async () => {
    restrictedHarnessCalls += 1;
    return { system_prompt: "QA Stormbreaker harness" };
  };

  chats.setChatWorkingFolder(chat.id, otherWorkspace);
  for (const remoteRuntime of ["byok", "ollama", "codex", "claude-code", "gemini", "grok"]) {
    runtimeKind = remoteRuntime;
    const events = [];
    await client.runMcpInvocation({
      chatId: chat.id,
      userPrompt: `Inspect project folder: ${inferredWorkspace}`,
      permissions: "full",
      locale: "en",
    }, (event) => events.push(event), undefined, activeBinding);
    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.equal(runnerRequests.at(-1).permission, "full");
    assert.equal(runnerRequests.at(-1).restrictedReadBoundary, undefined);
    assert.equal(
      runnerRequests.at(-1).cwd,
      canonicalWorkspace,
      `${remoteRuntime} must use the captured canonical workspace instead of the mutable chat row`,
    );
  }
  assert.equal(fs.existsSync(inferredWorkspace), false, "Mobile must never infer a workspace from prompt text");
  assert.equal(envResolutionCalls.every((options) => options?.restrictedReadBoundary !== true), true);

  // A removed workspace must still fail closed before the Desktop runner gets
  // it. Remote parity widens capabilities, never the Main-owned path binding.
  const allowedRunnerCalls = runnerRequests.length;
  const removedBeforeRunner = path.join(temp, "removed-before-runner");
  fs.mkdirSync(removedBeforeRunner);
  const removedBeforeRunnerBinding = workspaceBoundary.captureInvocationWorkspaceBinding(
    removedBeforeRunner,
  );
  runtimeKind = "byok";
  removeBeforeRunnerPath = removedBeforeRunner;
  await assert.rejects(
    client.runMcpInvocation({
      chatId: chat.id,
      userPrompt: "Inspect a workspace that disappears during runtime selection",
      locale: "en",
    }, () => {}, undefined, removedBeforeRunnerBinding),
    /unavailable/,
  );
  assert.equal(
    runnerRequests.length,
    allowedRunnerCalls,
    "a workspace removed after runtime selection must fail before the runner",
  );

  const globalBinding = workspaceBoundary.captureInvocationWorkspaceBinding(null);
  const globalEvents = [];
  await client.runMcpInvocation({
    chatId: globalChat.id,
    userPrompt: `Inspect project folder: ${inferredWorkspace}`,
    locale: "en",
  }, (event) => globalEvents.push(event), undefined, globalBinding);
  assert.equal(globalEvents.some((event) => event.kind === "error"), false);
  assert.equal(runnerRequests.at(-1).cwd, undefined, "a global Mobile chat must remain globally unbound");
  assert.equal(fs.existsSync(inferredWorkspace), false);

  // Scheduled work uses the same Desktop runtime contract too; it is not
  // silently substituted or reduced when it originated from Mobile.
  runtimeKind = "gemini";
  // A normal interactive division chat is not an unattended automation and
  // must retain the user's selected runtime.
  await client.runMcpInvocation({
    chatId: automationChat.id,
    userPrompt: "Interactive division read with Gemini",
    permissions: "read",
    locale: "en",
  }, () => {});
  assert.equal(runnerRequests.at(-1).restrictedReadBoundary, undefined);
  const interactiveDivisionRunnerCalls = runnerRequests.length;

  const unattendedEvents = [];
  await client.runMcpInvocation({
    chatId: automationChat.id,
    userPrompt: "Unattended read-only audit",
    permissions: "read",
    locale: "en",
  }, (event) => unattendedEvents.push(event), undefined, undefined, { source: "automation" });
  assert.equal(
    runnerRequests.length,
    interactiveDivisionRunnerCalls + 1,
    "scheduled work must reach the currently selected Desktop runtime",
  );
  assert.equal(unattendedEvents.some((event) => event.kind === "error"), false);
  assert.equal(runnerRequests.at(-1).restrictedReadBoundary, undefined);
  runtimeKind = "ollama";
  await client.runMcpInvocation({
    chatId: automationChat.id,
    userPrompt: "Unattended read-only audit with Ollama",
    permissions: "read",
    locale: "en",
  }, () => {}, undefined, undefined, { source: "automation" });
  assert.equal(runnerRequests.at(-1).restrictedReadBoundary, undefined);
  assert.equal(runnerRequests.at(-1).permission, "read");

  console.log(
    "Mobile remote parity: PASS (canonical capture/revalidation and Desktop runtime/permission forwarding)",
  );
}

main()
  .catch((error) => {
    console.error("Mobile execution boundary: FAIL", error);
    exitCode = 1;
  })
  .finally(() => {
    try {
      testDb?.close();
    } catch (error) {
      console.error("Mobile execution boundary DB cleanup failed", error);
      exitCode = 1;
    }
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      console.error("Mobile execution boundary temp cleanup failed", error);
      exitCode = 1;
    }
    app.exit(exitCode);
  });
