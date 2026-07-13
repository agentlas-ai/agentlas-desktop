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
  assert.throws(
    () => service.start({
      chatId: chat.id,
      userPrompt: "Attempt a Mobile write",
      permissions: "write",
    }, activeBinding),
    /read-only chats/,
  );
  assert.throws(
    () => service.start({
      chatId: chat.id,
      userPrompt: "Attempt full Mobile access",
      permissions: "full",
    }, activeBinding),
    /read-only chats/,
  );
  client.runMcpInvocation = actualRunMcpInvocation;

  // The actual client revalidates the captured directory and gates the runtime
  // after the real runtime/override selection has resolved.
  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  const envResolver = require("../dist/electron/runtime/env-resolver.js");
  const stormbreaker = require("../dist/electron/hephaestus/stormbreaker-supervisor.js");
  let runtimeKind = "codex";
  const runnerRequests = [];
  const mockRunner = async (request) => {
    runnerRequests.push(request);
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
  envResolver.buildRunnerEnv = async () => {
    if (removeBeforeRunnerPath) {
      fs.rmSync(removeBeforeRunnerPath, { recursive: true, force: true });
      removeBeforeRunnerPath = null;
    }
    return { env: {}, injectedKeys: [] };
  };
  stormbreaker.superviseStormbreaker = () => null;

  chats.setChatWorkingFolder(chat.id, otherWorkspace);
  for (const safeKind of ["codex", "byok", "ollama"]) {
    runtimeKind = safeKind;
    const events = [];
    await client.runMcpInvocation({
      chatId: chat.id,
      userPrompt: `Inspect project folder: ${inferredWorkspace}`,
      locale: "en",
    }, (event) => events.push(event), undefined, activeBinding);
    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.equal(runnerRequests.at(-1).permission, "read");
    assert.equal(
      runnerRequests.at(-1).cwd,
      canonicalWorkspace,
      `${safeKind} must use the captured canonical workspace instead of the mutable chat row`,
    );
  }
  assert.equal(fs.existsSync(inferredWorkspace), false, "Mobile must never infer a workspace from prompt text");

  const allowedRunnerCalls = runnerRequests.length;
  for (const unsafeKind of ["claude-code", "gemini", "grok"]) {
    runtimeKind = unsafeKind;
    const events = [];
    await client.runMcpInvocation({
      chatId: chat.id,
      userPrompt: `Inspect with ${unsafeKind}`,
      locale: "en",
    }, (event) => events.push(event), undefined, activeBinding);
    assert.equal(runnerRequests.length, allowedRunnerCalls, `${unsafeKind} must not reach its runner from Mobile`);
    assert.equal(
      events.some((event) => event.kind === "error" && event.error?.code === "mobile-runtime-not-read-sandboxed"),
      true,
    );
  }

  const removedBeforeRunner = path.join(temp, "removed-before-runner");
  fs.mkdirSync(removedBeforeRunner);
  const removedBeforeRunnerBinding = workspaceBoundary.captureInvocationWorkspaceBinding(
    removedBeforeRunner,
  );
  runtimeKind = "codex";
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

  console.log(
    "Mobile execution boundary: PASS (canonical capture/revalidation, read-only authority, queue binding, runtime allowlist)",
  );
}

main()
  .catch((error) => {
    console.error("Mobile execution boundary: FAIL", error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  });
