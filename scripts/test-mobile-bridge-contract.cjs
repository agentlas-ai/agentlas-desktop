const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

// Contract tests must never enumerate or mutate the developer's real Keychain.
process.env.AGENTLAS_E2E = "1";

const projectionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-projection-"));
process.env.AGENTLAS_STORE_PATH = path.join(projectionRoot, "agentlas.sqlite");

const {
  MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
  MOBILE_BRIDGE_WRITE_METHODS,
  parseMobileBridgePairExchangeRequest,
  parseMobileBridgeRequest,
} = require("../dist/shared/mobile-bridge.js");
const {
  MobileBridgePairingManager,
  createMobileBridgePairingPayload,
  loadOrCreateMobileBridgeHostIdentity,
  loadOrCreateMobileBridgeCredential,
  mobileBridgeDeviceStorePath,
  mobileBridgeEndpointManifestPath,
  mobileBridgeHostIdentityPath,
  readMobileBridgeEndpointManifest,
  writeMobileBridgeEndpointManifest,
} = require("../dist/electron/mobile-bridge/pairing.js");
const { AgentlasMobileBridgeServer } = require("../dist/electron/mobile-bridge/server.js");
const mobileBridgeTls = require("../dist/electron/mobile-bridge/tls.js");
const {
  loadOrCreateMobileBridgeTls,
  selectPreferredMobileBridgeHost,
} = mobileBridgeTls;
const {
  MobileBridgeRequestReplayStore,
  fingerprintMobileBridgeRequest,
  mobileBridgeReplayStorePath,
} = require("../dist/electron/mobile-bridge/replay.js");
const {
  MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES,
  repairMobileBridgeUtf16,
  sanitizeMobileBridgeText,
} = require("../dist/electron/mobile-bridge/sanitize.js");
const {
  projectMobileBridgeAutomation,
  projectMobileBridgeConfirmations,
  projectMobileBridgeHistory,
} = require("../dist/electron/mobile-bridge/projector.js");
const {
  createMobileBridgeAuthority,
  projectMobileBridgeInvocationEvent,
} = require("../dist/electron/mobile-bridge/authority.js");
const {
  browserRequestApproval,
  browserResolveApproval,
  listPendingBrowserApprovals,
} = require("../dist/electron/browser/connect.js");
const { claimPendingConfirmationAnswer } = require("../dist/electron/confirm/index.js");
const { initStore, getDb } = require("../dist/electron/store/db.js");
const { createProject } = require("../dist/electron/store/projects.js");
const { appendChatMessage, createChat } = require("../dist/electron/store/chats.js");
const { createAgentGroup } = require("../dist/electron/store/agent-groups.js");
const { upsertLocalTeamFirm } = require("../dist/electron/store/firms.js");
const {
  claimAutomationRun,
  createAutomation,
  finishGraphRun,
  getAutomation,
  markAutomationRun,
  releaseAutomationRun,
  startGraphRun,
} = require("../dist/electron/store/automations.js");
const { setAgentEntityKind } = require("../dist/electron/mcp/registry.js");
const { onDesktopStoreChange } = require("../dist/electron/store/change-bus.js");
const {
  onMobileBridgeStateChanged,
  mobileBridgeRuntimeStatus,
  retryAgentlasMobileBridge,
  startAgentlasMobileBridge,
  stopAgentlasMobileBridge,
} = require("../dist/electron/mobile-bridge/runtime.js");
const { WebSocket } = require("ws");

function pairRequest(id, code, name = "Mason's iPhone") {
  return {
    v: 1,
    type: "pair.exchange",
    id,
    code,
    device: { name, platform: "ios", appVersion: "1.0.0" },
  };
}

async function testTlsIdentity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-tls-"));
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-tls-other-"));
  try {
    const first = await loadOrCreateMobileBridgeTls(root);
    const second = await loadOrCreateMobileBridgeTls(root);
    assert.match(first.certificateFingerprint, /^[a-f0-9]{64}$/);
    assert.match(first.certificateDer, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(second.certificateFingerprint, first.certificateFingerprint);
    assert.equal(second.certificateDer, first.certificateDer);
    assert.equal(String(first.serverOptions.key).includes("PRIVATE KEY"), true);
    assert.equal(String(first.serverOptions.cert).includes("CERTIFICATE"), true);
    const directory = path.join(root, "mobile-bridge");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(directory, "server-key.pem")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(directory, "server-cert.pem")).mode & 0o777, 0o600);
    }

    await loadOrCreateMobileBridgeTls(otherRoot);
    fs.copyFileSync(
      path.join(otherRoot, "mobile-bridge", "server-key.pem"),
      path.join(root, "mobile-bridge", "server-key.pem"),
    );
    const recovered = await loadOrCreateMobileBridgeTls(root);
    assert.notEqual(
      recovered.certificateFingerprint,
      first.certificateFingerprint,
      "a mismatched key/certificate pair must rotate instead of becoming a persistent startup failure",
    );
    assert.doesNotThrow(() => https.createServer(recovered.serverOptions));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
}

function testAbsolutePathSanitization() {
  const cases = [
    "/Applications/Agentlas.app/Contents/Resources/app.asar",
    "/System/Library/Keychains/SystemRootCertificates.keychain",
    "/Users/mason/Library/Application Support/Agentlas/dev-bootstrap.json",
    String.raw`C:\Program Files\Agentlas\resources\app.asar`,
    String.raw`\\server\private-share\Agentlas\credential.json`,
  ];
  for (const absolutePath of cases) {
    const projected = sanitizeMobileBridgeText(`Opened ${absolutePath}`, 64 * 1024);
    assert.match(projected, /\[local-path\]/);
    assert.equal(
      projected.includes(absolutePath),
      false,
      `absolute path crossed the Mobile Bridge boundary: ${absolutePath}`,
    );
  }
  const spaced = sanitizeMobileBridgeText(
    "/Users/mason/Library/Application Support/Agentlas/dev-bootstrap.json",
    64 * 1024,
  );
  assert.equal(spaced, "[local-path]", "a path with spaces must be redacted as one path");

  for (const credential of [
    `ghp_${"a".repeat(32)}`,
    `github_pat_${"b".repeat(32)}`,
    `sk_live_${"c".repeat(32)}`,
    `ASIA${"D".repeat(16)}`,
  ]) {
    assert.equal(
      sanitizeMobileBridgeText(credential, 64 * 1024),
      "[redacted-secret]",
      "known credential forms must not cross the Mobile Bridge boundary",
    );
  }
}

function testUtf16Sanitization() {
  const high = String.fromCharCode(0xd83d);
  const low = String.fromCharCode(0xde80);
  const rocket = `${high}${low}`;
  assert.equal(repairMobileBridgeUtf16(high), "\ufffd");
  assert.equal(repairMobileBridgeUtf16(low), "\ufffd");
  assert.equal(repairMobileBridgeUtf16(`a${high}b${low}c`), "a\ufffdb\ufffdc");
  assert.equal(repairMobileBridgeUtf16(rocket), rocket, "valid surrogate pairs must remain intact");
  assert.equal(
    sanitizeMobileBridgeText(`stream:${high}`, 1_024),
    "stream:\ufffd",
    "isolated runtime deltas must not cross the Mobile Bridge boundary",
  );
}

function expectPairingError(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

function makeManifest(hostId, port = 43123) {
  return {
    version: 1,
    hostId,
    displayName: "Mason Mac Studio",
    path: "/v1/mobile",
    pairExchangePath: MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
    bindHost: "127.0.0.1",
    port,
    secure: false,
    url: `ws://127.0.0.1:${port}/v1/mobile`,
    certificateFingerprint: null,
    certificateDer: null,
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function makeSnapshot(hostId) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-11T00:00:00.000Z",
    host: {
      id: hostId,
      displayName: "Mason Mac Studio",
      platform: "macos",
      appVersion: "0.7.38",
      protocolVersion: 1,
      online: true,
      capabilities: ["agents", "chats", "steering"],
    },
    runtimes: [],
    agents: [],
    firms: [],
    groups: [],
    projects: [],
    chats: [],
    messages: {},
    pendingConfirmations: [],
    pendingBrowserApprovals: [],
    automations: [],
    usage: [],
    activeChatIds: [],
  };
}

function createMessageInbox(socket) {
  const queue = [];
  const waiters = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString("utf8"));
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
      return;
    }
    queue.push(value);
  });
  return function next(predicate, timeoutMs = 5_000) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for Mobile Bridge message"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason })));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

async function expectUnauthorized(url) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => reject(new Error("Unauthenticated socket unexpectedly opened")));
    socket.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", () => {});
  });
}

async function expectCredentialRejected(url, token) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.once("open", () => reject(new Error("Revoked credential unexpectedly opened a socket")));
    socket.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", () => {});
  });
}

async function testWireParsers() {
  const valid = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_1",
    method: "team.list",
    params: {},
  });
  assert.equal(valid.ok, true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("automations.runNow"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("device.revokeSelf"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("chats.setSwarmMode"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("chats.setBorrowedAgents"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("chats.switchAgent"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("chats.clearContext"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("workspace.setProject"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("workspace.clear"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("runtime.setActive"), true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "snapshot_read",
    method: "snapshot.get",
    params: {},
  }).ok, true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "workspace_set",
    idempotencyKey: "workspace-set-stable",
    method: "workspace.setProject",
    params: { chatId: "chat_1", projectId: "project_1" },
  }).ok, true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "engine_toggles",
    method: "hephaestus.engineToggles",
    params: {},
  }).ok, true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "self_revoke",
    idempotencyKey: "self-revoke-stable",
    method: "device.revokeSelf",
    params: {},
  }).ok, true);

  const idempotentWrite = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_write_1",
    idempotencyKey: "stable-mobile-write-1",
    method: "automations.runNow",
    params: { id: "automation_1" },
  });
  assert.equal(idempotentWrite.ok, true);
  assert.equal(idempotentWrite.value.idempotencyKey, "stable-mobile-write-1");
  const malformedIdempotency = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_write_2",
    idempotencyKey: "bad\nkey",
    method: "automations.runNow",
    params: { id: "automation_1" },
  });
  assert.equal(malformedIdempotency.ok, false);

  const unknownMethod = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_2",
    method: "desktop.shell",
    params: {},
  });
  assert.equal(unknownMethod.ok, false);
  assert.equal(unknownMethod.error.error.code, "method_not_allowed");

  const extraField = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_3",
    method: "team.list",
    params: {},
    token: "must-not-be-accepted",
  });
  assert.equal(extraField.ok, false);
  assert.equal(extraField.error.error.code, "invalid_envelope");

  const pairAsRpc = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_4",
    method: "pair.exchange",
    params: {},
  });
  assert.equal(pairAsRpc.ok, false);
  assert.equal(pairAsRpc.error.error.code, "method_not_allowed");

  const steerWithoutObservedRun = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "steer_missing_target",
    method: "invoke.steer",
    params: { chatId: "chat_1", userPrompt: "Change direction" },
  });
  assert.equal(steerWithoutObservedRun.ok, false);
  assert.equal(steerWithoutObservedRun.error.error.code, "invalid_params");

  const steerWithObservedRun = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "steer_observed_target",
    method: "invoke.steer",
    params: {
      chatId: "chat_1",
      userPrompt: "Change direction",
      expectedRunId: "run_1",
      expectedQuestionMessageId: "message_question_1",
    },
  });
  assert.equal(steerWithObservedRun.ok, true);

  const invocationWithComposerParity = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "composer_parity",
    method: "invoke.start",
    params: {
      chatId: "chat_1",
      userPrompt: "Inspect this image",
      permissions: "full",
      planMode: true,
      goalMode: true,
      appsGenerateMode: true,
      borrowAgents: ["verified-hub-agent"],
      images: [{
        mediaType: "image/png",
        name: "proof.png",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
      }],
    },
  });
  assert.equal(invocationWithComposerParity.ok, true);
  const oversizedImage = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "composer_bad_image",
    method: "invoke.start",
    params: {
      chatId: "chat_1",
      userPrompt: "Inspect this image",
      images: [{ mediaType: "image/png", data: "A".repeat(7_000_004) }],
    },
  });
  assert.equal(oversizedImage.ok, false);

  const validPair = parseMobileBridgePairExchangeRequest(pairRequest("pair_1", "A".repeat(22)));
  assert.equal(validPair.ok, true);
  const legacyShortCode = parseMobileBridgePairExchangeRequest(pairRequest("pair_short", "123456"));
  assert.equal(legacyShortCode.ok, false);
  assert.equal(legacyShortCode.error.error.code, "invalid_pairing_request");
  const malformedPair = parseMobileBridgePairExchangeRequest({
    ...pairRequest("pair_2", "A".repeat(22)),
    device: { name: "Phone", platform: "ios", admin: true },
  });
  assert.equal(malformedPair.ok, false);
  assert.equal(malformedPair.error.error.code, "invalid_pairing_request");
}

function testInvocationEventProjection() {
  const secret = `sk-${"A".repeat(32)}`;
  const projected = projectMobileBridgeInvocationEvent({
    kind: "tool-use",
    status: `Reading /Users/mason/Documents/private/config.json with ${secret}`,
    text: `Desktop result from /private/var/tmp/agentlas-output: token=supersecretvalue`,
    textLen: 99_999,
    tokens: 42,
    agentId: "agent_1",
    agentName: "Site Design Master",
    role: "Designer",
    phase: "delegate",
    model: "provider-session-must-not-cross",
    surfaceId: "surface_private",
    surface: {
      version: 1,
      title: "must-not-cross",
      root: "/Users/mason/private-surface",
    },
    tool: {
      name: "read_file",
      id: "tool_1",
      isError: false,
      args: JSON.stringify({
        path: "/Users/mason/.ssh/id_ed25519",
        api_key: secret,
        padding: "x".repeat(3_000),
      }),
      result: `authorization=BearerTokenSecret123 /home/mason/private.txt ${"y".repeat(9_000)}`,
    },
  });
  const encoded = JSON.stringify(projected);
  assert.equal(projected.kind, "tool-use");
  assert.equal(projected.tokens, 42);
  assert.equal(projected.textLen, projected.text.length);
  assert.equal(Object.hasOwn(projected, "surface"), false);
  assert.equal(Object.hasOwn(projected, "surfaceId"), false);
  assert.equal(Object.hasOwn(projected, "model"), false);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("supersecretvalue"), false);
  assert.equal(encoded.includes("/Users/mason"), false);
  assert.equal(encoded.includes("/private/var"), false);
  assert.equal(encoded.includes("/home/mason"), false);
  assert.match(encoded, /\[redacted-secret\]/);
  assert.match(encoded, /\[local-path\]/);
  assert.equal(Object.hasOwn(projected.tool, "args"), false);
  assert.equal(Object.hasOwn(projected.tool, "result"), false);
  assert.deepEqual(projected.tool.input, {
    shape: "json-object",
    size: "medium",
    fieldCount: 3,
  });
  assert.deepEqual(projected.tool.output, { shape: "text", size: "large" });
  const toolEncoded = JSON.stringify(projected.tool);
  assert.equal(toolEncoded.includes("redacted"), false);
  assert.equal(toolEncoded.includes("local-path"), false);
  assert.equal(toolEncoded.includes(secret), false);
  assert.equal(toolEncoded.includes("/Users"), false);
  assert.equal(toolEncoded.includes("BearerTokenSecret123"), false);

  const redactedDelta = projectMobileBridgeInvocationEvent({
    kind: "partial",
    delta: "token=anothersecretvalue",
    textLen: 24,
  });
  assert.equal(Object.hasOwn(redactedDelta, "textLen"), false);
  assert.equal(JSON.stringify(redactedDelta).includes("anothersecretvalue"), false);

  const dataUrl = projectMobileBridgeInvocationEvent({
    kind: "final",
    text: `preview data:image/png;base64,${"A".repeat(4096)}`,
  });
  assert.equal(JSON.stringify(dataUrl).includes("base64"), false);
  assert.match(dataUrl.text, /\[redacted-data-url\]/);
}

function testTranscriptAndConfirmationProjection() {
  const history = Array.from({ length: 40 }, (_, index) => ({
    id: `message_${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text:
      `message ${index} token=supersecretvalue /Users/mason/private.txt ` +
      `data:image/png;base64,${"A".repeat(90_000)}`,
    createdAt: new Date(Date.parse("2026-07-11T00:00:00.000Z") + index * 1_000).toISOString(),
  }));
  const projected = projectMobileBridgeHistory(history, 40);
  const encoded = JSON.stringify(projected);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES);
  assert.equal(encoded.includes("supersecretvalue"), false);
  assert.equal(encoded.includes("/Users/mason"), false);
  assert.equal(encoded.includes("data:image"), false);
  assert.equal(projected.at(-1).id, "message_39", "newest transcript rows must survive byte paging");

  const confirmations = projectMobileBridgeConfirmations([{
    chatId: "chat_question_1",
    sourceMessageId: "message_question_1",
    chatTitle: "Design /Users/mason/private",
    question: "Which token=hiddenvalue direction?",
    header: "Direction",
    optionCount: 2,
    multiSelect: false,
    options: [
      { label: "Black and white", description: "Use /Users/mason/brand" },
      { label: "Warm neutral", description: "Use token=anotherhiddenvalue" },
    ],
    agentId: "agent_1",
    firmId: null,
    createdAt: "2026-07-11T00:00:00.000Z",
  }]);
  assert.equal(confirmations[0].options.length, 2);
  assert.equal(confirmations[0].sourceMessageId, "message_question_1");
  assert.equal(confirmations[0].options[0].label, "Black and white");
  assert.match(confirmations[0].options[0].description, /\[local-path\]/);
  assert.match(confirmations[0].options[1].description, /\[redacted-secret\]/);
  assert.equal(confirmations[0].optionCount, 2);
}

function testLanAddressSelection() {
  const selected = selectPreferredMobileBridgeHost([
    { interfaceName: "docker0", address: "172.17.0.1", internal: false },
    { interfaceName: "wlan0", address: "192.168.1.42", internal: false },
    { interfaceName: "lo", address: "127.0.0.1", internal: true },
  ]);
  assert.equal(selected, "192.168.1.42");
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "en0", address: "fe80::1", internal: false },
      { interfaceName: "en0", address: "fd12:3456:789a::42", internal: false },
    ]),
    "fd12:3456:789a::42",
  );
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "docker0", address: "172.17.0.1", internal: false },
      { interfaceName: "lo", address: "127.0.0.1", internal: true },
    ]),
    null,
  );
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "en0", address: "2001:db8::42", internal: false },
    ]),
    null,
    "global IPv6 must require an explicit operator bind override",
  );
}

function testDurableReplayLedger() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-replay-"));
  const deviceId = "device_1234567890abcdef1234567890abcdef";
  const request = {
    v: 1,
    type: "request",
    id: "write_1",
    idempotencyKey: "stable-write-1",
    method: "automations.runNow",
    params: { id: "automation_1" },
  };
  try {
    const fingerprint = fingerprintMobileBridgeRequest(request);
    const first = new MobileBridgeRequestReplayStore(root, { instanceId: "desktop-instance-1" });
    assert.deepEqual(first.begin(deviceId, request.idempotencyKey, fingerprint), { kind: "execute" });
    const response = {
      v: 1,
      type: "response",
      id: request.id,
      ok: true,
      result: { accepted: true, automationId: "automation_1" },
    };
    first.complete(deviceId, request.idempotencyKey, fingerprint, response);

    const restarted = new MobileBridgeRequestReplayStore(root, { instanceId: "desktop-instance-2" });
    assert.deepEqual(restarted.begin(deviceId, request.idempotencyKey, fingerprint), {
      kind: "replay",
      response,
    });
    const changedFingerprint = fingerprintMobileBridgeRequest({
      ...request,
      params: { id: "automation_2" },
    });
    assert.deepEqual(restarted.begin(deviceId, request.idempotencyKey, changedFingerprint), {
      kind: "conflict",
    });

    const pendingFingerprint = fingerprintMobileBridgeRequest({
      ...request,
      id: "write_2",
      idempotencyKey: "stable-write-2",
    });
    assert.deepEqual(
      restarted.begin(deviceId, "stable-write-2", pendingFingerprint),
      { kind: "execute" },
    );
    const secondRestart = new MobileBridgeRequestReplayStore(root, { instanceId: "desktop-instance-3" });
    assert.deepEqual(
      secondRestart.begin(deviceId, "stable-write-2", pendingFingerprint),
      { kind: "uncertain" },
    );
    const bounded = new MobileBridgeRequestReplayStore(root, {
      instanceId: "desktop-instance-4",
      maxEntries: 2,
    });
    assert.throws(
      () => bounded.begin(
        deviceId,
        "stable-write-3",
        fingerprintMobileBridgeRequest({
          ...request,
          id: "write_3",
          idempotencyKey: "stable-write-3",
        }),
      ),
      /ledger is full/,
    );
    assert.equal(fs.existsSync(mobileBridgeReplayStorePath(root)), true);
    assert.equal(
      fs.readFileSync(mobileBridgeReplayStorePath(root), "utf8").includes("stable-write"),
      false,
      "idempotency keys must be hashed at rest",
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(mobileBridgeReplayStorePath(root)).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testAuthoritySteerGuard() {
  const authority = createMobileBridgeAuthority({
    hostIdentity: {
      version: 1,
      hostId: "host_1234567890abcdef1234567890abcdef",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    displayName: "Guard Test Desktop",
    appVersion: "0.7.38",
    onError: () => {},
  });
  const context = {
    connectionId: "connection_guard",
    remoteAddress: "127.0.0.1",
    connectedAt: "2026-07-11T00:00:00.000Z",
    deviceId: "device_guard",
    deviceName: "Guard Test Phone",
    devicePlatform: "dev",
    devBootstrap: true,
  };
  try {
    await assert.rejects(
      authority.request(
        {
          v: 1,
          type: "request",
          id: "authority_steer_missing_target",
          method: "invoke.steer",
          params: { chatId: "chat_1", userPrompt: "Change direction" },
        },
        context,
      ),
      /expectedRunId/,
    );
    await assert.rejects(
      authority.request(
        {
          v: 1,
          type: "request",
          id: "authority_cancel_missing",
          method: "invoke.cancel",
          params: { runId: "run_missing" },
        },
        context,
      ),
      /no longer active/,
    );
    await assert.rejects(
      authority.request(
        {
          v: 1,
          type: "request",
          id: "authority_browser_missing",
          method: "browser.resolveApproval",
          params: { requestId: "approval_missing", decision: "once" },
        },
        context,
      ),
      /no longer pending/,
    );
    await assert.rejects(
      authority.request(
        {
          v: 1,
          type: "request",
          id: "authority_dev_revoke",
          method: "device.revokeSelf",
          params: {},
        },
        context,
      ),
      /Development bootstrap credentials/,
    );
  } finally {
    authority.dispose();
  }

  let revokedDeviceId = null;
  const revokingAuthority = createMobileBridgeAuthority({
    hostIdentity: {
      version: 1,
      hostId: "host_1234567890abcdef1234567890abcdef",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    displayName: "Revoke Test Desktop",
    appVersion: "0.8.2",
    revokeDevice: (deviceId) => {
      revokedDeviceId = deviceId;
      return true;
    },
    onError: () => {},
  });
  try {
    const pairedContext = {
      ...context,
      deviceId: "device_1234567890abcdef1234567890abcdef",
      devicePlatform: "ios",
      devBootstrap: false,
    };
    const result = await revokingAuthority.request({
      v: 1,
      type: "request",
      id: "authority_self_revoke",
      method: "device.revokeSelf",
      params: {},
    }, pairedContext);
    assert.deepEqual(result, { revoked: true });
    assert.equal(revokedDeviceId, pairedContext.deviceId);
  } finally {
    revokingAuthority.dispose();
  }
}

async function testReconnectSnapshotAndDesktopMutationInvalidation() {
  await app.whenReady();
  initStore();
  const db = getDb();
  const agentId = "agent-mobile-sync-fixture";
  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role,
      visibility, entity_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    "mobile-sync-fixture",
    "Mobile Sync Fixture",
    "Mobile Sync Fixture",
    "Desktop projection test",
    "Desktop projection test",
    "Private prompt must not cross the bridge.",
    "[]",
    "[]",
    null,
    "A",
    "2026-07-11T00:00:00.000Z",
    "blue",
    0,
    null,
    "visible",
    "agent",
  );

  const marketplace = require("../dist/electron/marketplace/index.js");
  const originalGetSource = marketplace.getSource;
  marketplace.getSource = () => ({ searchAgents: async () => [] });

  let pendingRequestId = null;
  const approvalResult = browserRequestApproval({
    site: "example.com",
    actionType: "publish",
    summary: "Publish from /Users/mason/private/draft.txt with token=hiddenvalue",
    target: "/Users/mason/private/output.txt",
  });
  const pending = listPendingBrowserApprovals();
  assert.equal(pending.length, 1);
  pendingRequestId = pending[0].requestId;

  const authority = createMobileBridgeAuthority({
    hostIdentity: {
      version: 1,
      hostId: "host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    displayName: "Mutation Sync Desktop",
    appVersion: "0.8.2",
    onError: () => {},
  });
  const context = {
    connectionId: "connection_sync",
    remoteAddress: "127.0.0.1",
    connectedAt: "2026-07-11T00:00:00.000Z",
    deviceId: "device_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    deviceName: "Reconnect Phone",
    devicePlatform: "ios",
    devBootstrap: false,
  };
  const changes = [];
  const offChanges = onDesktopStoreChange((change) => changes.push(change));
  let offAuthority = null;
  try {
    const reconnectSnapshot = await authority.snapshot(context);
    assert.equal(reconnectSnapshot.pendingBrowserApprovals.length, 1);
    const restored = reconnectSnapshot.pendingBrowserApprovals[0];
    assert.equal(restored.status, "pending");
    assert.equal(restored.requestId, pendingRequestId);
    assert.equal(restored.site, "example.com");
    assert.equal(restored.allowAlways, true);
    assert.equal(typeof restored.createdAt, "number");
    assert.equal(typeof restored.expiresAt, "number");
    assert.equal(restored.expiresAt > restored.createdAt, true);
    assert.equal(JSON.stringify(restored).includes("/Users/mason"), false);
    assert.equal(JSON.stringify(restored).includes("hiddenvalue"), false);
    assert.match(restored.summary, /\[local-path\]/);
    assert.equal(restored.target, "[local-path]");

    const canonicalSnapshot = await authority.request({
      v: 1,
      type: "request",
      id: "snapshot_get_reconnect",
      method: "snapshot.get",
      params: {},
    }, context);
    assert.equal(canonicalSnapshot.host.id, reconnectSnapshot.host.id);
    assert.equal(canonicalSnapshot.pendingBrowserApprovals[0].requestId, pendingRequestId);

    const questionChat = createChat({ agentId, title: "Question claim chat" });
    const questionMessage = appendChatMessage(
      questionChat.id,
      "assistant",
      '<<agentlas-ask>>{"question":"Publish now?","options":[{"label":"Yes"},{"label":"No"}]}<</agentlas-ask>>',
    );
    await assert.rejects(
      authority.request({
        v: 1,
        type: "request",
        id: "stale_question_answer",
        method: "invoke.start",
        params: {
          chatId: questionChat.id,
          userPrompt: "Yes",
          expectedQuestionMessageId: "message_stale",
        },
      }, context),
      /stale or no longer pending/,
    );
    const rollbackQuestionClaim = claimPendingConfirmationAnswer(questionChat.id, questionMessage.id);
    assert.throws(
      () => claimPendingConfirmationAnswer(questionChat.id, questionMessage.id),
      /already accepted/,
    );
    rollbackQuestionClaim();
    assert.doesNotThrow(() => {
      const rollback = claimPendingConfirmationAnswer(questionChat.id, questionMessage.id);
      rollback();
    });

    const snapshotEvent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Desktop mutation snapshot")), 20_000);
      offAuthority = authority.subscribe((event) => {
        if (event.event !== "snapshot.updated") return;
        clearTimeout(timer);
        resolve(event);
      });
    });

    setAgentEntityKind(agentId, "team");
    const firm = upsertLocalTeamFirm({
      slug: "firm-mobile-sync",
      name: "Mobile Sync Team",
      tagline: "Mutation projection fixture",
      ceoAgentId: agentId,
      orgChart: [{ agentSlug: "mobile-sync-fixture", agentId, role: "CEO", reportsTo: null }],
    });
    const group = createAgentGroup({
      name: "Mobile Sync Group",
      description: "Mutation projection fixture",
      members: [{
        id: "member-mobile-sync",
        source: "installed",
        agentId,
        agentSlug: "mobile-sync-fixture",
        addedAt: "2026-07-11T00:00:00.000Z",
        snapshot: {
          name: "Mobile Sync Fixture",
          nameEn: "Mobile Sync Fixture",
          tagline: "Desktop projection test",
          taglineEn: "Desktop projection test",
          routeLabel: "Installed",
          trustGrade: "A",
          entityKind: "agent",
        },
      }],
    });
    const project = createProject({
      name: "Mobile Sync Project",
      defaultAgentId: agentId,
      folderPath: "/tmp/mobile-sync-project",
    });
    const chat = createChat({ agentId, projectId: project.id, title: "Mobile Sync Chat" });
    appendChatMessage(chat.id, "user", "Make this chat visible to the recent-chat projection.");
    const automation = createAutomation({
      name: "Mobile Sync Automation",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: agentId,
      promptTemplate: "Run the sync fixture",
    });

    const update = await snapshotEvent;
    const snapshot = update.payload;
    const projectedAgent = snapshot.agents.find((agent) => agent.id === agentId);
    assert.equal(projectedAgent.kind, "team");
    assert.equal(projectedAgent.visibility, "visible");
    assert.equal(projectedAgent.requiresSetup, false);
    assert.equal(snapshot.firms.some((item) => item.id === firm.id), true);
    assert.equal(snapshot.groups.some((item) => item.id === group.id), true);
    assert.equal(snapshot.projects.some((item) => item.id === project.id), true);
    assert.equal(snapshot.projects.find((item) => item.id === project.id).hasWorkingFolder, true);
    assert.equal(snapshot.chats.some((item) => item.id === chat.id), true);
    const projectedAutomation = snapshot.automations.find((item) => item.id === automation.id);
    assert.ok(projectedAutomation);
    assert.equal(projectedAutomation.runState, "unknown");
    assert.equal(projectedAutomation.lastError, null);
    assert.deepEqual(
      new Set(changes.map((change) => change.entity)),
      new Set(["agent", "firm", "agent-group", "project", "chat", "automation"]),
    );

    const workspaceSet = await authority.request({
      v: 1,
      type: "request",
      id: "workspace_set_live",
      method: "workspace.setProject",
      params: { chatId: chat.id, projectId: project.id },
    }, context);
    assert.equal(workspaceSet.projectId, project.id);
    const workspaceSnapshot = await authority.snapshot(context);
    const workspaceChat = workspaceSnapshot.chats.find((item) => item.id === chat.id);
    assert.equal(workspaceChat.workingFolderName, "mobile-sync-project");
    assert.equal(JSON.stringify(workspaceChat).includes("/tmp/"), false);
    await authority.request({
      v: 1,
      type: "request",
      id: "workspace_clear_live",
      method: "workspace.clear",
      params: { chatId: chat.id },
    }, context);
    const clearedSnapshot = await authority.snapshot(context);
    assert.equal(
      clearedSnapshot.chats.find((item) => item.id === chat.id).workingFolderName,
      null,
    );
  } finally {
    offAuthority?.();
    offChanges();
    authority.dispose();
    marketplace.getSource = originalGetSource;
    if (pendingRequestId) browserResolveApproval(pendingRequestId, "deny");
    await approvalResult;
  }
}

function testAutomationLiveRunProjection() {
  initStore();
  const automation = createAutomation({
    name: "Mobile live-state fixture",
    scheduleHuman: "daily-09:00",
    targetType: "agent",
    targetId: "agent-mobile-live-state-fixture",
    promptTemplate: "Keep the runner pending until the contract observes it.",
  });
  const owner = `${process.pid}:gui`;
  let clockMs = Date.now() + 100;
  const project = () => projectMobileBridgeAutomation(getAutomation(automation.id));

  assert.equal(project().runState, "unknown");

  assert.equal(
    claimAutomationRun(automation.id, owner, new Date(clockMs)),
    true,
  );
  assert.equal(project().runState, "queued", "an accepted durable lease must project as queued");

  startGraphRun({
    runId: "mobile-live-state-ok",
    automationId: automation.id,
    nodeIds: ["node"],
    startedAt: new Date(++clockMs).toISOString(),
  });
  assert.equal(project().runState, "running", "a fresh durable graph run must project as running");

  finishGraphRun("mobile-live-state-ok", "ok");
  markAutomationRun(automation.id, new Date(++clockMs), {
    status: "ok",
    advanceSchedule: false,
  });
  assert.equal(
    project().runState,
    "completed",
    "terminal history must beat the short history-write to lease-release window",
  );
  assert.equal(project().lastError, null);
  assert.equal(releaseAutomationRun(automation.id, owner), true);

  clockMs += 1;
  assert.equal(claimAutomationRun(automation.id, owner, new Date(clockMs)), true);
  assert.equal(project().runState, "queued");
  startGraphRun({
    runId: "mobile-live-state-error",
    automationId: automation.id,
    nodeIds: ["node"],
    startedAt: new Date(++clockMs).toISOString(),
  });
  assert.equal(project().runState, "running");
  finishGraphRun("mobile-live-state-error", "error");
  markAutomationRun(automation.id, new Date(++clockMs), {
    status: "error",
    error: "Failed at /Users/private/automation-secret.txt",
    advanceSchedule: false,
  });
  const failed = project();
  assert.equal(failed.runState, "failed");
  assert.equal(failed.lastError, "automation_failed");
  assert.equal(JSON.stringify(failed).includes("/Users/private"), false);
  assert.equal(releaseAutomationRun(automation.id, owner), true);

  clockMs += 1;
  assert.equal(claimAutomationRun(automation.id, owner, new Date(clockMs)), true);
  assert.equal(project().runState, "queued");
  markAutomationRun(automation.id, new Date(++clockMs), {
    status: "skipped",
    error: "Waiting for Desktop permission",
    advanceSchedule: false,
  });
  const idle = project();
  assert.equal(idle.runState, "idle");
  assert.equal(idle.lastError, null);
  assert.equal(releaseAutomationRun(automation.id, owner), true);
}

async function testPairingLifecycle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-pairing-"));
  try {
    let clockMs = Date.parse("2026-07-11T00:00:00.000Z");
    const now = () => new Date(clockMs);
    const identity = loadOrCreateMobileBridgeHostIdentity(root, now());
    assert.match(identity.hostId, /^host_[a-f0-9]{32}$/);
    assert.deepEqual(loadOrCreateMobileBridgeHostIdentity(root, new Date(clockMs + 50_000)), identity);

    const identityPath = mobileBridgeHostIdentityPath(root);
    const identityRaw = fs.readFileSync(identityPath, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(identityRaw)).sort(), ["createdAt", "hostId", "version"]);
    assert.equal(identityRaw.includes("token"), false);
    assert.equal(identityRaw.includes("code"), false);

    const limited = new MobileBridgePairingManager(root, { now, ttlMs: 10_000, maxAttempts: 2 });
    const limitedChallenge = limited.issueChallenge();
    expectPairingError(() => limited.exchange(pairRequest("wrong_1", "B".repeat(22))), "pairing_denied");
    expectPairingError(() => limited.exchange(pairRequest("wrong_2", "C".repeat(22))), "pairing_denied");
    expectPairingError(
      () => limited.exchange(pairRequest("blocked", limitedChallenge.code)),
      "pairing_unavailable",
    );

    const expiryReasons = [];
    const expiring = new MobileBridgePairingManager(root, {
      now,
      ttlMs: 10_000,
      onChanged: (reason) => expiryReasons.push(reason),
    });
    const expiredChallenge = expiring.issueChallenge();
    clockMs += 10_000;
    expectPairingError(
      () => expiring.exchange(pairRequest("expired", expiredChallenge.code)),
      "pairing_expired",
    );
    assert.deepEqual(expiryReasons, ["challenge-issued", "challenge-expired"]);

    const pairingReasons = [];
    const manager = new MobileBridgePairingManager(root, {
      now,
      onChanged: (reason) => pairingReasons.push(reason),
    });
    const challenge = manager.issueChallenge();
    assert.match(challenge.code, /^[A-Za-z0-9_-]{22}$/);

    const manifest = makeManifest(identity.hostId);
    writeMobileBridgeEndpointManifest(root, manifest);
    const payload = createMobileBridgePairingPayload(challenge, manifest);
    assert.equal(payload.code, challenge.code);
    assert.equal(payload.pairExchangeEndpoint, "http://127.0.0.1:43123/v1/mobile/pair/exchange");
    assert.equal(Object.hasOwn(payload, "token"), false);
    assert.equal(JSON.stringify(payload).includes("devBootstrap"), false);

    const issued = manager.exchange(pairRequest("success", challenge.code));
    assert.match(issued.deviceId, /^device_[a-f0-9]{32}$/);
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    expectPairingError(
      () => manager.exchange(pairRequest("reuse", challenge.code)),
      "pairing_unavailable",
    );

    const deviceStorePath = mobileBridgeDeviceStorePath(root);
    const deviceStoreRaw = fs.readFileSync(deviceStorePath, "utf8");
    assert.equal(deviceStoreRaw.includes(issued.token), false);
    assert.equal(deviceStoreRaw.includes(challenge.code), false);
    assert.match(deviceStoreRaw, /"tokenHash": "[a-f0-9]{64}"/);
    assert.equal(manager.authenticate(issued.token).deviceId, issued.deviceId);
    assert.equal(manager.authenticate("Z".repeat(43)), null);
    assert.equal(manager.revokeDevice(issued.deviceId), true);
    assert.equal(manager.authenticate(issued.token), null);
    assert.deepEqual(pairingReasons, ["challenge-issued", "device-paired", "device-revoked"]);

    const manifestRaw = fs.readFileSync(mobileBridgeEndpointManifestPath(root), "utf8");
    assert.equal(manifestRaw.includes(issued.token), false);
    assert.equal(manifestRaw.includes(challenge.code), false);
    assert.equal(Object.hasOwn(JSON.parse(manifestRaw), "token"), false);
    assert.equal(readMobileBridgeEndpointManifest(root).hostId, identity.hostId);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(deviceStorePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(deviceStorePath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(mobileBridgeEndpointManifestPath(root)).mode & 0o777, 0o600);
    }

    assert.throws(
      () => loadOrCreateMobileBridgeCredential(root, now(), false),
      /plaintext bootstrap credential is disabled/,
    );
    const devCredential = loadOrCreateMobileBridgeCredential(root, now(), true);
    assert.equal(devCredential.hostId, identity.hostId);
    assert.equal(devCredential.devOnly, true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(identityPath).mode & 0o777, 0o600);
    }

    assert.throws(
      () => writeMobileBridgeEndpointManifest(root, makeManifest("host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
      /does not match the host identity/,
    );
    assert.throws(
      () => writeMobileBridgeEndpointManifest(root, {
        ...makeManifest(identity.hostId),
        bindHost: "0.0.0.0",
        url: "ws://192.168.1.20:43123/v1/mobile",
      }),
      /requires TLS for non-loopback endpoints/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-corrupt-"));
  try {
    const created = loadOrCreateMobileBridgeHostIdentity(corruptRoot, new Date("2026-07-11T00:00:00.000Z"));
    const target = mobileBridgeHostIdentityPath(corruptRoot);
    const corrupt = JSON.stringify({ ...created, hostId: "host_bad", token: "unexpected" });
    fs.writeFileSync(target, corrupt, { encoding: "utf8", mode: 0o600 });
    assert.throws(
      () => loadOrCreateMobileBridgeHostIdentity(corruptRoot),
      /host identity is invalid; explicit recovery is required/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), corrupt);
  } finally {
    fs.rmSync(corruptRoot, { recursive: true, force: true });
  }
}

async function testServerBoundary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-server-"));
  const hostId = "host_fedcba9876543210fedcba9876543210";
  const pairing = new MobileBridgePairingManager(root);
  const replayStore = new MobileBridgeRequestReplayStore(root, {
    instanceId: "server-boundary-instance",
  });
  const calls = [];
  const errors = [];
  let eventListener = null;
  let nextSnapshotBlock = null;
  let nextRequestBlock = null;
  const authority = {
    async snapshot() {
      const block = nextSnapshotBlock;
      if (block) {
        nextSnapshotBlock = null;
        block.started.resolve();
        await block.release.promise;
      }
      return makeSnapshot(hostId);
    },
    async request(request, context) {
      calls.push({ request, context });
      const block = nextRequestBlock;
      if (block) {
        nextRequestBlock = null;
        block.started.resolve();
        await block.release.promise;
      }
      if (request.method === "invoke.history" && request.params.chatId === "chat_large") {
        return [{
          id: "message_large",
          role: "assistant",
          text: "x".repeat(MOBILE_BRIDGE_MAX_MESSAGE_BYTES + 1),
          createdAt: "2026-07-11T00:00:00.000Z",
        }];
      }
      if (request.method === "device.revokeSelf") {
        pairing.revokeDevice(context.deviceId);
        return { revoked: true };
      }
      return { method: request.method, deviceId: context.deviceId };
    },
    subscribe(listener) {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    },
  };
  assert.throws(
    () => new AgentlasMobileBridgeServer({ authority, pairing, host: "0.0.0.0" }),
    /requires TLS for non-loopback binds/,
  );
  const server = new AgentlasMobileBridgeServer({
    authority,
    pairing,
    replayStore,
    host: "127.0.0.1",
    port: 0,
    pingIntervalMs: 5_000,
    onError: (error) => errors.push(error.message),
  });
  let socket = null;
  let socket2 = null;
  try {
    const address = await server.start();
    assert.equal(address.host, "127.0.0.1");
    await expectUnauthorized(address.url);

    const challenge = pairing.issueChallenge();
    const exchangeUrl = `http://${address.host}:${address.port}${MOBILE_BRIDGE_PAIR_EXCHANGE_PATH}`;
    const wrongCode = "Q".repeat(22);
    const deniedResponse = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pairRequest("pair_wrong", wrongCode)),
    });
    assert.equal(deniedResponse.status, 401);
    const deniedBody = await deniedResponse.text();
    assert.equal(deniedBody.includes(wrongCode), false);
    assert.equal(errors.join("\n").includes(wrongCode), false);

    const exchangeResponse = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pairRequest("pair_ok", challenge.code)),
    });
    assert.equal(exchangeResponse.status, 200);
    assert.equal(exchangeResponse.headers.get("cache-control"), "no-store");
    const exchange = await exchangeResponse.json();
    assert.equal(exchange.ok, true);
    const token = exchange.credential.token;

    socket = new WebSocket(address.url, { headers: { authorization: `Bearer ${token}` } });
    let nextMessage = createMessageInbox(socket);
    await waitForOpen(socket);
    const ready = await nextMessage((message) => message.type === "event" && message.event === "bridge.ready");
    assert.equal(ready.payload.hostId, hostId);
    const snapshot = await nextMessage(
      (message) => message.type === "event" && message.event === "snapshot.updated",
    );
    assert.equal(snapshot.payload.host.id, hostId);
    assert.deepEqual([ready.seq, snapshot.seq], [1, 2]);

    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: "not_allowed",
      method: "desktop.shell",
      params: {},
    }));
    const rejected = await nextMessage((message) => message.type === "response" && message.id === "not_allowed");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "method_not_allowed");
    assert.equal(calls.length, 0);

    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: "team_list",
      method: "team.list",
      params: {},
    }));
    const accepted = await nextMessage((message) => message.type === "response" && message.id === "team_list");
    assert.equal(accepted.ok, true);
    assert.equal(accepted.result.method, "team.list");
    assert.equal(accepted.result.deviceId, exchange.credential.deviceId);
    assert.equal(calls.length, 1);

    const writeEnvelope = {
      v: 1,
      type: "request",
      id: "automation_write_1",
      idempotencyKey: "automation-stable-key-1",
      method: "automations.runNow",
      params: { id: "automation_1" },
    };
    socket.send(JSON.stringify(writeEnvelope));
    const firstWrite = await nextMessage(
      (message) => message.type === "response" && message.id === writeEnvelope.id,
    );
    assert.equal(firstWrite.ok, true);
    assert.equal(calls.length, 2);

    socket.send(JSON.stringify({ ...writeEnvelope, id: "automation_write_retry" }));
    const replayedWrite = await nextMessage(
      (message) => message.type === "response" && message.id === "automation_write_retry",
    );
    assert.equal(replayedWrite.ok, true);
    assert.equal(replayedWrite.id, "automation_write_retry");
    assert.equal(calls.length, 2, "replayed write must not re-enter Desktop authority");

    socket.send(JSON.stringify({
      ...writeEnvelope,
      id: "automation_write_conflict",
      params: { id: "automation_2" },
    }));
    const conflictedWrite = await nextMessage(
      (message) => message.type === "response" && message.id === "automation_write_conflict",
    );
    assert.equal(conflictedWrite.ok, false);
    assert.equal(conflictedWrite.error.code, "idempotency_conflict");
    assert.equal(calls.length, 2);

    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: "history_too_large",
      method: "invoke.history",
      params: { chatId: "chat_large", limit: 200 },
    }));
    const oversized = await nextMessage(
      (message) => message.type === "response" && message.id === "history_too_large",
    );
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error.code, "response_too_large");
    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: "still_connected",
      method: "team.list",
      params: {},
    }));
    const afterOversized = await nextMessage(
      (message) => message.type === "response" && message.id === "still_connected",
    );
    assert.equal(afterOversized.ok, true, "oversized Desktop result must not close the socket");

    eventListener({ event: "invoke.activeChats", payload: { chatIds: ["chat_1"] } });
    const event = await nextMessage(
      (message) => message.type === "event" && message.event === "invoke.activeChats",
    );
    assert.deepEqual(event.payload, { chatIds: ["chat_1"] });
    assert.equal(event.seq, 3);

    // A second client takes a deliberately slow snapshot. Authority events
    // must reach the initialized first client immediately, but remain queued
    // behind ready + snapshot for the second client. Each client owns a
    // contiguous sequence, so one client's initial frames cannot create gaps
    // in another client's stream.
    const challenge2 = pairing.issueChallenge();
    const exchangeResponse2 = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pairRequest("pair_ok_2", challenge2.code, "Mason's Android")),
    });
    assert.equal(exchangeResponse2.status, 200);
    const exchange2 = await exchangeResponse2.json();
    const snapshotStarted = deferred();
    const snapshotRelease = deferred();
    nextSnapshotBlock = { started: snapshotStarted, release: snapshotRelease };

    const seenSecond = [];
    socket2 = new WebSocket(address.url, {
      headers: { authorization: `Bearer ${exchange2.credential.token}` },
    });
    socket2.on("message", (data) => seenSecond.push(JSON.parse(data.toString("utf8"))));
    const nextMessage2 = createMessageInbox(socket2);
    await waitForOpen(socket2);
    await snapshotStarted.promise;

    const queuedOccurredAt = "2026-07-11T12:34:56.000Z";
    eventListener({
      event: "invoke.activeChats",
      payload: { chatIds: ["chat_2"] },
      occurredAt: queuedOccurredAt,
    });
    const firstClientRaceEvent = await nextMessage(
      (message) => message.type === "event" && message.payload?.chatIds?.[0] === "chat_2",
    );
    assert.equal(firstClientRaceEvent.seq, 4);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seenSecond.length, 0);

    snapshotRelease.resolve();
    const ready2 = await nextMessage2(() => true);
    const snapshot2 = await nextMessage2(() => true);
    const queued2 = await nextMessage2(() => true);
    assert.deepEqual(
      [ready2.event, snapshot2.event, queued2.event],
      ["bridge.ready", "snapshot.updated", "invoke.activeChats"],
    );
    assert.deepEqual([ready2.seq, snapshot2.seq, queued2.seq], [1, 2, 3]);
    assert.equal(queued2.occurredAt, queuedOccurredAt);
    assert.deepEqual(queued2.payload, { chatIds: ["chat_2"] });

    eventListener({ event: "invoke.activeChats", payload: { chatIds: ["chat_3"] } });
    const firstClientSharedEvent = await nextMessage(
      (message) => message.type === "event" && message.payload?.chatIds?.[0] === "chat_3",
    );
    const secondClientSharedEvent = await nextMessage2(
      (message) => message.type === "event" && message.payload?.chatIds?.[0] === "chat_3",
    );
    assert.equal(firstClientSharedEvent.seq, 5);
    assert.equal(secondClientSharedEvent.seq, 4);

    // Revocation wins over a request already inside authority. The server marks
    // the connection revoked before terminate, and drops the eventual result.
    const requestStarted = deferred();
    const requestRelease = deferred();
    nextRequestBlock = { started: requestStarted, release: requestRelease };
    socket2.send(JSON.stringify({
      v: 1,
      type: "request",
      id: "revoked_inflight",
      method: "team.list",
      params: {},
    }));
    await requestStarted.promise;
    const seenBeforeRevoke = seenSecond.length;
    const revokedClose = waitForClose(socket2);
    server.disconnectDevice(exchange2.credential.deviceId);
    const revokedClosed = await revokedClose;
    assert.equal(revokedClosed.code, 1006);
    requestRelease.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      seenSecond.slice(seenBeforeRevoke).some((message) => message.id === "revoked_inflight"),
      false,
    );
    socket2 = null;

    const closePromise = waitForClose(socket);
    socket.send("x".repeat(MOBILE_BRIDGE_MAX_MESSAGE_BYTES + 1));
    const closed = await closePromise;
    assert.equal(closed.code, 1009);
    socket = null;

    // The same credential may reconnect after an ordinary transport failure.
    // Its authenticated self-revocation must persist first, ACK exactly once,
    // then close every live socket for that device and reject future upgrades.
    socket = new WebSocket(address.url, { headers: { authorization: `Bearer ${token}` } });
    nextMessage = createMessageInbox(socket);
    await waitForOpen(socket);
    await nextMessage((message) => message.type === "event" && message.event === "bridge.ready");
    await nextMessage((message) => message.type === "event" && message.event === "snapshot.updated");
    const selfRevokedClose = waitForClose(socket);
    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: "self_revoke_1",
      idempotencyKey: "self-revoke-device-1",
      method: "device.revokeSelf",
      params: {},
    }));
    const selfRevoked = await nextMessage(
      (message) => message.type === "response" && message.id === "self_revoke_1",
    );
    assert.deepEqual(selfRevoked.result, { revoked: true });
    const selfRevokedClosed = await selfRevokedClose;
    assert.equal(selfRevokedClosed.code, 1000);
    assert.equal(pairing.authenticate(token), null);
    socket = null;
    await expectCredentialRejected(address.url, token);

    const persisted = fs.readFileSync(mobileBridgeDeviceStorePath(root), "utf8");
    assert.equal(persisted.includes(token), false);
    assert.equal(persisted.includes(exchange2.credential.token), false);
    assert.equal(errors.join("\n").includes(token), false);
    assert.equal(errors.join("\n").includes(challenge.code), false);
  } finally {
    if (socket) socket.terminate();
    if (socket2) socket2.terminate();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRuntimeRetryKeepsStableEndpoint() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-runtime-retry-"));
  const previousHost = process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
  const previousPort = process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
  process.env.AGENTLAS_MOBILE_BRIDGE_HOST = "127.0.0.1";
  delete process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
  const reasons = [];
  const off = onMobileBridgeStateChanged((reason) => reasons.push(reason));
  try {
    const first = await startAgentlasMobileBridge({
      userDataPath: root,
      appVersion: "0.8.2",
      displayName: "Runtime Retry Desktop",
    });
    assert.equal(first.running, true);
    assert.match(first.endpoint, /^wss:\/\/127\.0\.0\.1:\d+\/v1\/mobile$/);
    const retried = await retryAgentlasMobileBridge();
    assert.equal(retried.running, true);
    assert.equal(retried.endpoint, first.endpoint, "manual retry must retain the ephemeral port");
    assert.equal(retried.hostId, first.hostId, "manual retry must retain Desktop identity");
    assert.equal(retried.error, null);
    assert.equal(reasons.includes("runtime-rebinding"), true);
    assert.equal(reasons.includes("runtime-retried"), true);
  } finally {
    off();
    await stopAgentlasMobileBridge();
    if (previousHost === undefined) delete process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
    else process.env.AGENTLAS_MOBILE_BRIDGE_HOST = previousHost;
    if (previousPort === undefined) delete process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
    else process.env.AGENTLAS_MOBILE_BRIDGE_PORT = previousPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testAutomaticNetworkRebind() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-network-rebind-"));
  const previousHost = process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
  const previousPort = process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
  const previousWatch = process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS;
  const originalPreferredHost = mobileBridgeTls.preferredMobileBridgeHost;
  delete process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
  delete process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
  process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS = "1000";
  let selectedHost = "127.0.0.1";
  mobileBridgeTls.preferredMobileBridgeHost = () => selectedHost;
  const reasons = [];
  const off = onMobileBridgeStateChanged((reason) => reasons.push(reason));
  try {
    const first = await startAgentlasMobileBridge({
      userDataPath: root,
      appVersion: "0.8.2",
      displayName: "Network Rebind Desktop",
    });
    const firstUri = new URL(first.endpoint);
    selectedHost = "::1";
    const rebound = await waitUntil(() => {
      const status = mobileBridgeRuntimeStatus();
      return status.running && status.endpoint?.includes("[::1]") ? status : null;
    });
    const reboundUri = new URL(rebound.endpoint);
    assert.equal(reboundUri.hostname, "[::1]");
    assert.equal(reboundUri.port, firstUri.port, "network rebind must retain the listening port");
    assert.equal(rebound.hostId, first.hostId);
    assert.equal(reasons.includes("network-rebound"), true);
  } finally {
    off();
    await stopAgentlasMobileBridge();
    mobileBridgeTls.preferredMobileBridgeHost = originalPreferredHost;
    if (previousHost === undefined) delete process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
    else process.env.AGENTLAS_MOBILE_BRIDGE_HOST = previousHost;
    if (previousPort === undefined) delete process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
    else process.env.AGENTLAS_MOBILE_BRIDGE_PORT = previousPort;
    if (previousWatch === undefined) delete process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS;
    else process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS = previousWatch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await testWireParsers();
  await testTlsIdentity();
  testAbsolutePathSanitization();
  testUtf16Sanitization();
  testInvocationEventProjection();
  testTranscriptAndConfirmationProjection();
  testLanAddressSelection();
  testDurableReplayLedger();
  await testAuthoritySteerGuard();
  await testReconnectSnapshotAndDesktopMutationInvalidation();
  testAutomationLiveRunProjection();
  await testPairingLifecycle();
  await testServerBoundary();
  await testRuntimeRetryKeepsStableEndpoint();
  await testAutomaticNetworkRebind();
  console.log("Mobile Bridge contract, reconnect sync, authenticated revocation, runtime retry, event ordering, and safe projection tests passed.");
}

function cleanupProjectionRoot() {
  try {
    fs.rmSync(projectionRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch (error) {
    // Windows can retain short-lived file handles after the bridge closes.
    // Test success must not turn into a hung Electron process because cleanup
    // could not remove an expendable temporary directory immediately.
    console.warn(`[mobile-bridge] temporary cleanup skipped: ${error.message}`);
  }
}

main().then(
  () => {
    cleanupProjectionRoot();
    process.exit(0);
  },
  (error) => {
    console.error(error);
    cleanupProjectionRoot();
    process.exit(1);
  },
);
