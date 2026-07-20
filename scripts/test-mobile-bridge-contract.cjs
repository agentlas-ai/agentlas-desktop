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
  isMobileBridgeOneImprovementProofDto,
  isMobileBridgeOneValueClosureDto,
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
  stripMobileBridgeControlFences,
} = require("../dist/electron/mobile-bridge/sanitize.js");
const {
  projectMobileBridgeAutomation,
  projectMobileBridgeConfirmations,
  projectMobileBridgeHistory,
  projectMobileBridgeOneBriefing,
  projectMobileBridgeOneDecisions,
  projectMobileBridgeOneDecisionsFromCurrent,
  projectMobileBridgeOneImprovementProofsFromState,
  projectMobileBridgeOneProfile,
  projectMobileBridgeOneValueClosuresFromState,
  projectMobileBridgeSnapshot,
  isMobileBridgeOneDecisionDto,
} = require("../dist/electron/mobile-bridge/projector.js");
const {
  isOneDecisionViewV1,
  normalizeOneDecision,
} = require("../dist/shared/one-decision.js");
const {
  createMobileBridgeAuthority,
  enforceMobileInvocationPermissionBoundary,
  projectMobileBridgeInvocationEvent,
} = require("../dist/electron/mobile-bridge/authority.js");
const { adaptLegacySurfaceToOneV1 } = require("../dist/shared/one-surface.js");
const {
  browserRequestApproval,
  browserResolveApproval,
  listPendingBrowserApprovals,
} = require("../dist/electron/browser/connect.js");
const {
  claimPendingConfirmationAnswer,
  listPendingConfirmations,
} = require("../dist/electron/confirm/index.js");
const { initStore, getDb } = require("../dist/electron/store/db.js");
const { createProject } = require("../dist/electron/store/projects.js");
const {
  appendChatMessage,
  createChat,
  getChat,
  getChatWorkingFolder,
} = require("../dist/electron/store/chats.js");
const {
  findCanonicalTaskForChat,
  getCanonicalTask,
  setCanonicalTaskStatus,
} = require("../dist/electron/store/tasks.js");
const { invocationService } = require("../dist/electron/invocation/service.js");
const oneValueClosureRuntime = require("../dist/electron/one/value-closure.js");
const oneImprovementProofRuntime = require("../dist/electron/one/improvement-proof.js");
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
const {
  replaceInstalledAgentHubBinding,
} = require("../dist/electron/ontology/hub-bindings.js");
const { onDesktopStoreChange } = require("../dist/electron/store/change-bus.js");
const {
  onMobileBridgeStateChanged,
  mobileBridgeRuntimeStatus,
  retryAgentlasMobileBridge,
  startAgentlasMobileBridge,
  stopAgentlasMobileBridge,
} = require("../dist/electron/mobile-bridge/runtime.js");
const { WebSocket } = require("ws");

const TEST_PAIRING_ATTEMPT_ID = "pairing_attempt_test_000000000001";
const TEST_DEVICE_NONCE = "D".repeat(43);
const TEST_PAIRING_ASSERTION = `${Buffer.from('{"t":"mobile_pair_assertion"}').toString("base64url")}.${"S".repeat(43)}`;
const TEST_ACCOUNT_SUBJECT = `mps_${"A".repeat(43)}`;
const TEST_RECEIPT_ID = `mpr_${"R".repeat(24)}`;
const TEST_HOST_ID = "host_0123456789abcdef0123456789abcdef";

function accountProof(hostId, pairingAttemptId = TEST_PAIRING_ATTEMPT_ID, overrides = {}) {
  return {
    hostId,
    pairingAttemptId,
    desktopAccountProof: `${Buffer.from('{"t":"mobile_pair_desktop_proof"}').toString("base64url")}.${"P".repeat(43)}`,
    accountSubject: TEST_ACCOUNT_SUBJECT,
    accountAuthorityOrigin: "https://agentlas.cloud",
    expiresIn: 300,
    ...overrides,
  };
}

async function consumeSameAccountAssertion() {
  return { accountSubject: TEST_ACCOUNT_SUBJECT, receiptId: TEST_RECEIPT_ID };
}

function pairingOptions(options = {}) {
  return { consumePairingAssertion: consumeSameAccountAssertion, ...options };
}

function issueTestChallenge(manager, hostId = TEST_HOST_ID, pairingAttemptId = TEST_PAIRING_ATTEMPT_ID) {
  return manager.issueChallenge(accountProof(hostId, pairingAttemptId));
}

function pairRequest(id, code, name = "Mason's iPhone", overrides = {}) {
  return {
    v: 1,
    type: "pair.exchange",
    id,
    code,
    pairingAttemptId: TEST_PAIRING_ATTEMPT_ID,
    deviceNonce: TEST_DEVICE_NONCE,
    pairingAssertion: TEST_PAIRING_ASSERTION,
    audience: "agentlas_desktop_mobile_pair",
    device: { name, platform: "ios", appVersion: "1.0.0" },
    ...overrides,
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
    // Time-bomb guard: a fresh mint reports rotated so the runtime can warn
    // paired phones; a subsequent load must NOT rotate (that reissue was what
    // silently changed the pinned fingerprint and locked every phone out).
    assert.equal(first.rotated, true, "the first mint must report rotation");
    assert.equal(second.rotated, false, "reloading an existing certificate must never rotate");
    const validTo = Date.parse(new (require("node:crypto").X509Certificate)(
      String(first.serverOptions.cert),
    ).validTo);
    const yearsValid = (validTo - Date.now()) / (365 * 24 * 60 * 60 * 1000);
    assert.ok(
      yearsValid > 50,
      `pinned certificate must outlive any renewal window to avoid forced re-pairing; got ${yearsValid.toFixed(1)}y`,
    );
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

function testOneDeviceProjectionBoundary() {
  const version = Date.parse("2026-07-18T09:00:00.000Z");
  const projectedProfile = projectMobileBridgeOneProfile({
    contractVersion: "1.0.0",
    oneId: "one_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version,
    displayName: "Mason /Users/mason/private/profile.txt",
    role: "Personal chief of staff",
    profileContext: "Local-only context must never enter the device DTO.",
    preferredLocale: "ko",
    timeZone: "Asia/Seoul",
    operatingPrinciples: [
      {
        id: "principle_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        content: "Show evidence before a recommendation.",
        scope: "project",
        scopeRef: "project_private_scope",
        approvalSource: "explicit_user",
        approvedAt: "2026-07-18T08:00:00.000Z",
        enabled: true,
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-18T08:00:00.000Z",
        disabledAt: null,
      },
      {
        id: "principle_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        content: "Use token=supersecretvalue for every request.",
        scope: "personal",
        scopeRef: null,
        approvalSource: "explicit_user",
        approvedAt: "2026-07-18T08:30:00.000Z",
        enabled: true,
        createdAt: "2026-07-18T08:30:00.000Z",
        updatedAt: "2026-07-18T08:30:00.000Z",
        disabledAt: null,
      },
    ],
    createdAt: "2026-07-18T08:00:00.000Z",
    updatedAt: new Date(version).toISOString(),
  });
  assert.deepEqual(Object.keys(projectedProfile).sort(), [
    "contractVersion",
    "displayName",
    "omittedOperatingPrincipleCount",
    "oneId",
    "operatingPrinciples",
    "preferredLocale",
    "role",
    "timeZone",
    "updatedAt",
    "version",
  ]);
  assert.equal(projectedProfile.operatingPrinciples.length, 1);
  assert.equal(projectedProfile.omittedOperatingPrincipleCount, 1);
  assert.equal("scopeRef" in projectedProfile.operatingPrinciples[0], false);
  const profileJson = JSON.stringify(projectedProfile);
  assert.equal(profileJson.includes("profileContext"), false);
  assert.equal(profileJson.includes("private_scope"), false);
  assert.equal(profileJson.includes("/Users/mason"), false);
  assert.equal(profileJson.includes("supersecretvalue"), false);

  const projectedBriefing = projectMobileBridgeOneBriefing({
    contractVersion: "1.0.0",
    evaluatedAt: "2026-07-18T09:05:00.000Z",
    preferences: {
      cadence: "daily",
      channels: ["in_app", "desktop_notification", "mobile_push"],
      quietHours: { enabled: true, startHour: 22, endHour: 8 },
      updatedAt: "2026-07-18T09:00:00.000Z",
    },
    candidate: {
      contractVersion: "1.0.0",
      candidateId: "briefing:project:test",
      dedupeKey: "project-folder:test",
      kind: "risk",
      reasonCode: "project_folder_missing",
      severity: 4,
      source: {
        kind: "project_folder",
        refId: "project_test",
        label: "Launch /Users/mason/private token=supersecretvalue",
      },
      detectedAt: "2026-07-18T09:00:00.000Z",
      expiresAt: "2026-07-25T09:00:00.000Z",
      confidence: { level: "high", basis: "A local boundary check ran." },
      discovery: "Raw discovery prose is Main-only.",
      impact: "Raw impact prose is Main-only.",
      prepared: "Raw prepared prose is Main-only.",
      decision: {
        prompt: "Open it?",
        acceptLabel: "Open project",
        dismissLabel: "Later",
      },
      evidence: [{
        label: "Connection check",
        value: "/Users/mason/private/result.txt",
        observedAt: "2026-07-18T09:00:00.000Z",
        freshness: "fresh",
      }],
      preparedAction: {
        kind: "open_project",
        targetId: "project_test",
        label: "Open token=supersecretvalue",
        executionStarted: false,
      },
    },
  });
  assert.deepEqual(projectedBriefing.preferences.channels, ["in_app"]);
  assert.deepEqual(Object.keys(projectedBriefing.candidate).sort(), [
    "candidateId",
    "confidence",
    "contractVersion",
    "detectedAt",
    "expiresAt",
    "kind",
    "preparedAction",
    "reasonCode",
    "severity",
    "source",
  ]);
  assert.equal(projectedBriefing.candidate.preparedAction.executionStarted, false);
  const briefingJson = JSON.stringify(projectedBriefing);
  for (const forbidden of [
    "/Users/mason",
    "supersecretvalue",
    "discovery",
    "impact",
    "prepared\"",
    "evidence",
    "basis",
    "prompt",
    "mobile_push",
    "desktop_notification",
  ]) {
    assert.equal(briefingJson.includes(forbidden), false, `One Briefing leaked ${forbidden}`);
  }
  assert.throws(() => projectMobileBridgeOneBriefing({
    contractVersion: "1.0.0",
    evaluatedAt: "2026-07-18T09:05:00.000Z",
    preferences: {
      cadence: "important_only",
      channels: ["in_app"],
      quietHours: { enabled: false, startHour: 22, endHour: 8 },
      updatedAt: "2026-07-18T09:00:00.000Z",
    },
    candidate: {
      contractVersion: "1.0.0",
      candidateId: "briefing:project:swapped",
      dedupeKey: "project-folder:swapped",
      kind: "risk",
      reasonCode: "project_folder_missing",
      severity: 4,
      source: { kind: "project_folder", refId: "project_test", label: "Launch Plan" },
      detectedAt: "2026-07-18T09:00:00.000Z",
      expiresAt: "2026-07-25T09:00:00.000Z",
      confidence: { level: "high", basis: "Desktop boundary check" },
      discovery: "Folder missing",
      impact: "Context unavailable",
      prepared: "Review only",
      decision: { prompt: "Review?", acceptLabel: "Review", dismissLabel: "Later" },
      evidence: [{
        label: "Project",
        value: "Launch Plan",
        observedAt: "2026-07-18T09:00:00.000Z",
        freshness: "fresh",
      }],
      preparedAction: {
        kind: "open_project",
        targetId: "project_other",
        label: "Open project",
        executionStarted: false,
      },
    },
  }), /Invalid One Briefing snapshot/);
}

function testControlFenceProjection() {
  const fence = '<<agentlas-ask>>{"question":"Publish now?","options":[{"label":"Yes"},{"label":"No"}]}<</agentlas-ask>>';
  assert.equal(stripMobileBridgeControlFences(fence), "");
  assert.equal(
    stripMobileBridgeControlFences(`I checked the draft.\n\n${fence}`),
    "I checked the draft.",
  );
  assert.equal(
    stripMobileBridgeControlFences("Visible answer\n<<agentlas-ask>>{\"question\":"),
    "Visible answer",
    "a streaming partial must never expose a dangling control fence",
  );
  assert.equal(
    stripMobileBridgeControlFences("Visible answer\n<<agentlas-ask"),
    "Visible answer",
    "a split opening marker must never flash as assistant copy",
  );
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

async function expectPairingError(fn, code) {
  await assert.rejects(fn, (error) => error && error.code === code);
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
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("groups.create"), true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("one.invoke.start"), true);
  const validOneStart = {
    v: 1,
    type: "request",
    id: "one_start_valid",
    idempotencyKey: "one-start-valid",
    method: "one.invoke.start",
    params: {
      schemaVersion: 1,
      userPrompt: "Compare these two launch options.",
      permissions: "full",
      images: [{ mediaType: "image/png", name: "launch.png", data: "iVBORw0KGgo=" }],
    },
  };
  assert.equal(parseMobileBridgeRequest(validOneStart).ok, true);
  for (const [field, value] of Object.entries({
    agentId: "agent_hostile",
    firmId: "firm_hostile",
    agentGroupId: "group_hostile",
    projectId: "project_hostile",
    sessionRouting: true,
    hubMode: "auto",
    borrowAgents: ["paid-hub-agent"],
    oneMode: false,
    taskIntent: "task",
    taskId: "task_hostile",
    expectedTaskId: "task_hostile",
    oneProfileContext: "injected profile",
    oneMemoryUseOnceRef: "memory_hostile",
    runId: "run_hostile",
  })) {
    assert.equal(
      parseMobileBridgeRequest({
        ...validOneStart,
        id: `one_start_hostile_${field}`,
        idempotencyKey: `one-start-hostile-${field}`,
        params: { ...validOneStart.params, [field]: value },
      }).ok,
      false,
      `Mobile One must reject renderer-owned ${field}`,
    );
  }
  assert.equal(parseMobileBridgeRequest({
    ...validOneStart,
    id: "one_start_wrong_schema",
    idempotencyKey: "one-start-wrong-schema",
    params: { schemaVersion: 2, userPrompt: "Hello" },
  }).ok, false);
  assert.equal(parseMobileBridgeRequest({
    ...validOneStart,
    id: "one_start_empty_prompt",
    idempotencyKey: "one-start-empty-prompt",
    params: { schemaVersion: 1, userPrompt: "   " },
  }).ok, false);
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
    id: "group_create",
    idempotencyKey: "group-create-stable",
    method: "groups.create",
    params: {
      name: "Social publishing",
      description: "Research\nWrite\nPublish",
      memberAgentIds: ["agent_1", "agent_2"],
    },
  }).ok, true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "group_create_empty",
    idempotencyKey: "group-create-empty",
    method: "groups.create",
    params: { name: "Empty", memberAgentIds: [] },
  }).ok, false);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "global_chat_create",
    method: "chats.create",
    params: { title: "Global Desktop chat" },
  }).ok, true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "ambiguous_chat_create",
    method: "chats.create",
    params: { agentId: "agent_1", agentGroupId: "group_1" },
  }).ok, false);
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
    id: "task_accept_result",
    idempotencyKey: "task-accept-stable",
    method: "tasks.acceptResult",
    params: {
      taskId: "task_chat_1",
      expectedVersion: 1,
      expectedRunId: "run_1",
    },
  }).ok, true);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "task_accept_result_missing_version",
    idempotencyKey: "task-accept-invalid",
    method: "tasks.acceptResult",
    params: { taskId: "task_chat_1", expectedRunId: "run_1" },
  }).ok, false);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "task_latest_result",
    method: "tasks.latestResult",
    params: {
      taskId: "task_chat_1",
      chatId: "chat_1",
      expectedVersion: 1,
    },
  }).ok, true);
  assert.equal(MOBILE_BRIDGE_WRITE_METHODS.has("tasks.latestResult"), false);
  assert.equal(parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "task_latest_result_extra",
    method: "tasks.latestResult",
    params: {
      taskId: "task_chat_1",
      chatId: "chat_1",
      expectedVersion: 1,
      runId: "client_must_not_choose_the_run",
    },
  }).ok, false);
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
      expectedTaskId: "task_question_1",
      expectedTaskVersion: 1,
      expectedDecisionContractVersion: "1.0.0",
    },
  });
  assert.equal(steerWithObservedRun.ok, true);

  const decisionWithoutTaskPrecondition = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "decision_without_task_precondition",
    method: "invoke.start",
    params: {
      chatId: "chat_1",
      userPrompt: "Approve",
      expectedQuestionMessageId: "message_question_1",
    },
  });
  assert.equal(decisionWithoutTaskPrecondition.ok, false);
  assert.equal(decisionWithoutTaskPrecondition.error.error.code, "invalid_params");

  const taskPreconditionWithoutDecision = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "task_precondition_without_decision",
    method: "invoke.start",
    params: {
      chatId: "chat_1",
      userPrompt: "Hello",
      expectedTaskId: "task_question_1",
      expectedTaskVersion: 1,
      expectedDecisionContractVersion: "1.0.0",
    },
  });
  assert.equal(taskPreconditionWithoutDecision.ok, false);
  assert.equal(taskPreconditionWithoutDecision.error.error.code, "invalid_params");

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
  for (const invalid of [
    { ...pairRequest("pair_no_assertion", "A".repeat(22)), pairingAssertion: undefined },
    { ...pairRequest("pair_wrong_audience", "A".repeat(22)), audience: "other" },
    { ...pairRequest("pair_short_nonce", "A".repeat(22)), deviceNonce: "short" },
    { ...pairRequest("pair_unknown", "A".repeat(22)), accountSubject: TEST_ACCOUNT_SUBJECT },
  ]) {
    assert.equal(parseMobileBridgePairExchangeRequest(invalid).ok, false);
  }
}

function testMobileInvocationPermissionBoundary() {
  const base = { chatId: "chat_1", userPrompt: "Inspect safely" };
  assert.equal(
    enforceMobileInvocationPermissionBoundary(base).permissions,
    "read",
    "omitted remote permission must fail closed to read",
  );
  assert.equal(
    enforceMobileInvocationPermissionBoundary({ ...base, permissions: "write" }).permissions,
    "write",
    "a paired Mobile client must forward Desktop write authority",
  );
  assert.equal(
    enforceMobileInvocationPermissionBoundary({ ...base, permissions: "full" }).permissions,
    "full",
    "a paired Mobile client must forward Desktop full authority",
  );
  assert.equal(
    enforceMobileInvocationPermissionBoundary({ ...base, permissions: "unexpected" }).permissions,
    "read",
    "malformed direct calls must remain fail-closed to read",
  );
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

  const rawSurface = {
      version: "0.1",
      kind: "surface",
      title: "Competitor comparison",
      domain: "research",
      layout: "table",
      data: {
        comparison: {
          type: "table",
          columns: ["company", "finding"],
          rows: [
            { company: "A", finding: `Stored at /Users/mason/private/${secret}` },
            { company: "B", finding: "Lower price" },
          ],
        },
      },
      widgets: [{ type: "table", data: "comparison", title: "Comparison" }],
    };
  const canonicalSurface = adaptLegacySurfaceToOneV1({
    manifest: rawSurface,
    surfaceId: "surface_comparison_1",
    taskId: "task_chat_surface_1",
    syncedAt: "2026-07-18T00:00:00.000Z",
  });
  const surfaceEvent = projectMobileBridgeInvocationEvent({
    kind: "surface",
    oneSurface: canonicalSurface,
  }, {
    taskId: "task_chat_surface_1",
    syncedAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(surfaceEvent.surface.contractVersion, "1.0.0");
  assert.equal(surfaceEvent.surface.taskId, "task_chat_surface_1");
  assert.equal(surfaceEvent.surface.blocks[0].type, "Table");
  assert.deepEqual(
    surfaceEvent.surface.recomposition.mobile.blockOrder,
    surfaceEvent.surface.recomposition.desktop.blockOrder,
  );
  const surfaceEncoded = JSON.stringify(surfaceEvent.surface);
  assert.equal(surfaceEncoded.includes(secret), false);
  assert.equal(surfaceEncoded.includes("/Users/mason"), false);
  assert.equal(surfaceEncoded.includes("javascript:"), false);

  const rawLegacyOnly = projectMobileBridgeInvocationEvent({
    kind: "surface",
    surfaceId: "surface_legacy_only",
    surface: rawSurface,
  }, {
    taskId: "task_chat_surface_1",
    syncedAt: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(
    Object.hasOwn(rawLegacyOnly, "surface"),
    false,
    "Mobile must not reinterpret a raw legacy surface after Main's projection boundary",
  );

  const canonicalSurfaceEvent = projectMobileBridgeInvocationEvent({
    kind: "surface",
    oneSurface: surfaceEvent.surface,
    // The raw Work payload may still be present for compatibility. Mobile must
    // project Main's already-normalized manifest without reinterpreting it.
    surface: {
      version: "0.1",
      kind: "surface",
      title: "Different raw payload",
      domain: "must-not-win",
      layout: "report",
      data: { raw: { type: "markdown", value: "This must not replace Main's semantic surface" } },
      widgets: [],
    },
  }, {
    taskId: "task_chat_surface_1",
    syncedAt: "2026-07-18T00:01:00.000Z",
  });
  assert.deepEqual(canonicalSurfaceEvent.surface, surfaceEvent.surface);
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
  assert.equal(confirmations[0].taskId, "task_chat_question_1");
  assert.equal(confirmations[0].decisionId, "message_question_1");
  assert.equal(confirmations[0].sourceMessageId, "message_question_1");
  assert.equal(confirmations[0].options[0].label, "Black and white");
  assert.match(confirmations[0].options[0].description, /\[local-path\]/);
  assert.match(confirmations[0].options[1].description, /\[redacted-secret\]/);
  assert.equal(confirmations[0].optionCount, 2);
}

async function testOneDecisionProjectionBoundary() {
  await app.whenReady();
  initStore();
  const db = getDb();
  const agentId = "agent-mobile-one-decision-fixture";
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role,
      visibility, entity_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    "mobile-one-decision-fixture",
    "Mobile One Decision Fixture",
    "Mobile One Decision Fixture",
    "Closed Main-owned Decision fixture",
    "Closed Main-owned Decision fixture",
    "Private prompt must not cross the bridge.",
    "[]",
    "[]",
    null,
    "A",
    "2026-07-18T00:00:00.000Z",
    "blue",
    0,
    null,
    "visible",
    "agent",
  );
  const hostIdentity = {
    version: 1,
    hostId: "host_0dec15a10dec15a10dec15a10dec15a1",
    createdAt: "2026-07-18T00:00:00.000Z",
  };
  const createDecision = (title, question, options = [
    { label: "Approve", description: "Proceed with the bounded proposal." },
    { label: "Reject", description: "Do not take the proposed action." },
  ]) => {
    const chat = createChat({ agentId, title, taskMode: "task" });
    const message = appendChatMessage(
      chat.id,
      "assistant",
      `<<agentlas-ask>>${JSON.stringify({ question, options })}<</agentlas-ask>>`,
    );
    const task = setCanonicalTaskStatus(chat.taskId, "waiting-decision");
    return { chat, message, task };
  };

  const first = createDecision(
    "Launch review",
    `Review the prepared launch proposal containing sk-proj-${"s".repeat(24)}?`,
  );
  const second = createDecision(
    "Research scope",
    "Choose whether to continue the read-only competitor review.",
    [
      { label: "Continue review", description: "Read and compare the sources." },
      { label: "Reject", description: "Stop this review." },
    ],
  );
  const unsafe = createDecision(
    "Unsafe local path",
    "Approve publishing /Users/mason/private/launch-plan.md?",
  );
  const stale = createDecision("Stale source", "Continue the old review?");
  appendChatMessage(stale.chat.id, "user", "This newer message makes the Decision stale.");

  const wrongOrigin = createChat({ agentId, title: "Wrong origin anchor", taskMode: "task" });
  const wrong = createDecision("Wrong Task binding", "Approve the wrongly bound proposal?");
  const currentConfirmations = listPendingConfirmations();
  db.prepare("UPDATE tasks SET origin_chat_id = ? WHERE id = ?").run(wrongOrigin.id, wrong.task.id);

  const projected = projectMobileBridgeOneDecisionsFromCurrent(hostIdentity, currentConfirmations);
  assert.equal(
    projected.length,
    2,
    `only two current, safe, correctly bound Decisions may cross: ${JSON.stringify({
      projected: projected.map((item) => item.view.taskId),
      first: first.task.id,
      second: second.task.id,
      unsafe: unsafe.task.id,
      stale: stale.task.id,
      wrong: wrong.task.id,
    })}`,
  );
  const projectedByTask = new Map(projected.map((item) => [item.view.taskId, item]));
  for (const fixture of [first, second]) {
    const row = projectedByTask.get(fixture.task.id);
    assert.ok(row, `missing normalized Decision for ${fixture.task.id}`);
    assert.equal(row.authoritativeHostRef, hostIdentity.hostId);
    assert.equal(row.canonicalTaskVersion, fixture.task.version);
    assert.equal(row.view.chatId, fixture.chat.id);
    assert.equal(row.view.decisionId, fixture.message.id);
    const source = listPendingConfirmations().find(
      (item) => item.chatId === fixture.chat.id && item.sourceMessageId === fixture.message.id,
    );
    assert.ok(source);
    assert.deepEqual(
      row.view,
      normalizeOneDecision(source, fixture.task.id),
      "Mobile must receive Main's exact normalized value without recomposition",
    );
    assert.equal(isMobileBridgeOneDecisionDto(row), true);
  }
  assert.equal(projectedByTask.has(unsafe.task.id), false, "a path-bearing Decision must fail closed");
  assert.equal(projectedByTask.has(stale.task.id), false, "a stale source Decision must fail closed");
  assert.equal(projectedByTask.has(wrong.task.id), false, "a wrong-Task Decision must fail closed");
  assert.equal(JSON.stringify(projected).includes("/Users/mason"), false);
  assert.equal(JSON.stringify(projected).includes(`sk-proj-${"s".repeat(24)}`), false);

  const valid = projected[0];
  assert.equal(
    isMobileBridgeOneDecisionDto({ ...valid, unexpectedAuthority: true }),
    false,
    "unknown wrapper fields must not become executable authority",
  );
  assert.equal(
    isOneDecisionViewV1({ ...valid.view, unexpectedAuthority: true }),
    false,
    "unknown Decision fields must fail the closed OneDecisionViewV1 contract",
  );
  assert.deepEqual(
    projectMobileBridgeOneDecisions(hostIdentity, { maxBytes: 1 }),
    [],
    "an insufficient Decision byte budget must omit rows, never truncate authority",
  );

  // Resolve the corrupt-race fixture before a fresh authoritative read. The
  // public projector always reads current confirmations itself.
  db.prepare("UPDATE tasks SET origin_chat_id = ? WHERE id = ?").run(wrong.chat.id, wrong.task.id);
  appendChatMessage(wrong.chat.id, "user", "Resolve wrong-Task test-only Decision.");

  const snapshot = await projectMobileBridgeSnapshot({
    hostIdentity,
    displayName: "One Decision Projection Desktop",
    appVersion: "0.8.99",
  });
  assert.equal(snapshot.host.capabilities.includes("one-decisions-v1"), true);
  assert.deepEqual(snapshot.oneDecisions, projected);

  // Restore the intentionally corrupted fixture, then resolve all test-only
  // questions so later bridge tests observe their own isolated confirmation set.
  for (const fixture of [first, second, unsafe]) {
    appendChatMessage(fixture.chat.id, "user", "Resolve test-only Decision.");
  }
}

function measuredImprovementInput(options) {
  const {
    storeVersion,
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
  } = options;
  const suffix = "mobile-proof";
  const taskKind = "product_comparison";
  const assetId = `asset:${suffix}`;
  const assetVersion = 3;
  const comparisonRef = `comparison:${suffix}`;
  const changeRef = `change:${suffix}`;
  const controls = ["edit", "use_once", "disable", "delete"].map((control) => ({
    control,
    controlRef: `control:${suffix}:${control}`,
  }));
  const common = (kind, name) => ({
    evidenceRef: `evidence:${suffix}:${name}`,
    receiptRef: `receipt:${suffix}:${name}`,
    kind,
    taskKind,
    observedAt: new Date().toISOString(),
    sourceRef: `source:${suffix}:${name}`,
  });
  const verification = (kind, name, taskId, taskVersion) => ({
    ...common(kind, name),
    source: kind === "output_verification" ? "artifact_verifier" : "outcome_verifier",
    taskId,
    taskVersion,
    verificationRef: `verification:${suffix}:${name}`,
  });
  const baselineOutput = verification("output_verification", "baseline-output", baselineTaskId, baselineTaskVersion);
  const baselineOutcome = verification("outcome_verification", "baseline-outcome", baselineTaskId, baselineTaskVersion);
  const currentOutput = verification("output_verification", "current-output", currentTaskId, currentTaskVersion);
  const currentOutcome = verification("outcome_verification", "current-outcome", currentTaskId, currentTaskVersion);
  const reuse = {
    ...common("asset_reuse", "asset-reuse"),
    source: "memory_runtime",
    taskId: currentTaskId,
    taskVersion: currentTaskVersion,
    sourceTaskId: baselineTaskId,
    sourceTaskVersion: baselineTaskVersion,
    assetId,
    assetVersion,
    assetKind: "memory",
    sourceControlRef: `control:${suffix}:source`,
    controlRefs: controls,
    rollbackRef: `rollback:${suffix}`,
    removeRef: `remove:${suffix}`,
  };
  const measurement = (role, value) => ({
    ...common("measurement", `measurement-${role}`),
    source: "measurement_engine",
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    comparisonRef,
    role,
    valueType: "fact",
    value,
    unit: "question_count",
    method: "Count the same observable interaction through the verified outcome.",
    sampleSize: 1,
    comparable: true,
    comparabilityBasis: "Both Tasks use the same kind, unit, method, and completion boundary.",
    comparisonDirection: "lower_is_better",
  });
  const baselineMeasurement = measurement("baseline", 5);
  const currentMeasurement = measurement("current", 2);
  const comparisonEvidence = {
    ...common("comparison_verification", "comparison"),
    source: "comparison_verifier",
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    comparisonRef,
    evidenceType: "measured",
    result: "improved",
    baselineOutputVerificationRef: baselineOutput.verificationRef,
    baselineOutcomeVerificationRef: baselineOutcome.verificationRef,
    currentOutputVerificationRef: currentOutput.verificationRef,
    currentOutcomeVerificationRef: currentOutcome.verificationRef,
    reusedAssetVersions: [{ assetId, assetVersion }],
  };
  const trustedHostEvidence = [
    baselineOutput,
    baselineOutcome,
    currentOutput,
    currentOutcome,
    reuse,
    baselineMeasurement,
    currentMeasurement,
    comparisonEvidence,
  ];
  const evidenceRefs = [
    baselineMeasurement.evidenceRef,
    currentMeasurement.evidenceRef,
    comparisonEvidence.evidenceRef,
  ];
  return {
    expectedStoreVersion: storeVersion,
    trustedHostAttested: true,
    currentTaskId,
    currentTaskVersion,
    taskKind,
    attributionStatus: "not_established",
    reusedAssets: [{
      assetRef: assetId,
      assetType: "memory",
      label: "Previously retained comparison memory",
      sourceTaskRef: baselineTaskId,
      receiptRefs: [reuse.receiptRef],
      controls: controls.map((item) => item.control),
    }],
    changes: [{
      changeRef,
      kind: "instruction_reduction",
      evidenceType: "measured",
      statement: "Verified questions decreased on the same comparison basis.",
      baseline: 5,
      current: 2,
      unit: "question_count",
      comparisonDirection: "lower_is_better",
      evidenceRefs,
    }],
    assetBindings: [{
      assetId,
      assetVersion,
      assetKind: "memory",
      sourceTaskId: baselineTaskId,
      sourceTaskVersion: baselineTaskVersion,
      currentTaskId,
      currentTaskVersion,
      taskKind,
      reuseEvidenceRef: reuse.evidenceRef,
      reuseReceiptRef: reuse.receiptRef,
      sourceControlRef: reuse.sourceControlRef,
      controlRefs: controls,
      rollbackRef: reuse.rollbackRef,
      removeRef: reuse.removeRef,
    }],
    comparisons: [{
      comparisonRef,
      changeRef,
      taskKind,
      baselineTaskId,
      baselineTaskVersion,
      currentTaskId,
      currentTaskVersion,
      evidenceType: "measured",
      result: "improved",
      baselineOutputVerificationRef: baselineOutput.verificationRef,
      baselineOutcomeVerificationRef: baselineOutcome.verificationRef,
      currentOutputVerificationRef: currentOutput.verificationRef,
      currentOutcomeVerificationRef: currentOutcome.verificationRef,
      reusedAssetVersions: [{ assetId, assetVersion }],
      comparisonEvidenceRef: comparisonEvidence.evidenceRef,
      measurementEvidenceRefs: [baselineMeasurement.evidenceRef, currentMeasurement.evidenceRef],
      evidenceRefs,
      receiptRefs: evidenceRefs.map((ref) => trustedHostEvidence.find((item) => item.evidenceRef === ref).receiptRef),
    }],
    receiptRefs: trustedHostEvidence.map((item) => item.receiptRef),
    trustedHostEvidence,
  };
}

async function testOneEvidenceProjectionBoundary() {
  await app.whenReady();
  initStore();
  const db = getDb();
  const agentId = "agent-mobile-one-evidence-fixture";
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role,
      visibility, entity_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    "mobile-one-evidence-fixture",
    "Mobile One Evidence Fixture",
    "Mobile One Evidence Fixture",
    "Main-owned evidence projection fixture",
    "Main-owned evidence projection fixture",
    "Private prompt must not cross the bridge.",
    "[]",
    "[]",
    null,
    "A",
    "2026-07-18T00:00:00.000Z",
    "neutral",
    0,
    null,
    "visible",
    "agent",
  );
  const hostIdentity = {
    version: 1,
    hostId: "host_e11de11de11de11de11de11de11de11d",
    createdAt: "2026-07-18T00:00:00.000Z",
  };

  const valueChat = createChat({ agentId, title: "Partial external verification", taskMode: "task" });
  const valueTask = setCanonicalTaskStatus(valueChat.taskId, "running");
  const valueInitial = oneValueClosureRuntime.getOneValueClosureState();
  const outcomeRef = "outcome:mobile-partial";
  const observation = {
    evidenceRef: "evidence:mobile-partial:observation",
    receiptRef: "receipt:mobile-partial:observation",
    taskId: valueTask.id,
    taskVersion: valueTask.version,
    kind: "outcome_verification",
    source: "explicit_user_observation",
    verificationStatus: "partially_verified",
    observedAt: new Date().toISOString(),
    sourceRef: "source:mobile-partial:observation",
    outcomeRef,
  };
  const baseline = {
    evidenceRef: "evidence:mobile-partial:baseline",
    receiptRef: "receipt:mobile-partial:baseline",
    taskId: valueTask.id,
    taskVersion: valueTask.version,
    kind: "estimate_baseline",
    source: "explicit_user_observation",
    verificationStatus: "partially_verified",
    observedAt: new Date().toISOString(),
    sourceRef: "source:mobile-partial:baseline",
  };
  oneValueClosureRuntime.createOneValueClosure({
    expectedStoreVersion: valueInitial.version,
    trustedHostAttested: true,
    taskId: valueTask.id,
    expectedTaskVersion: valueTask.version,
    outcomeStatus: "partially_verified",
    outcomeRefs: [outcomeRef],
    lifecycleClaims: [
      { phase: "discovery", status: "not_started", summary: "Discovery was outside this check.", evidenceRefs: [] },
      { phase: "preparation", status: "not_started", summary: "Preparation was outside this check.", evidenceRefs: [] },
      { phase: "execution", status: "not_applicable", summary: "No external action was performed.", evidenceRefs: [] },
      { phase: "verification", status: "in_progress", summary: "External verification is still pending.", evidenceRefs: [observation.evidenceRef] },
    ],
    valueItems: [{
      valueItemId: "value:mobile-partial:estimate",
      kind: "estimate",
      statement: "The possible time reduction remains an estimate.",
      estimate: {
        lowerBound: 2,
        upperBound: 4,
        unit: "minutes",
        basis: "The user supplied a rough prior range.",
        method: "The current rough range was compared with that prior range.",
        evidenceRefs: [baseline.evidenceRef],
      },
    }],
    originalPreservation: { status: "not_applicable", artifactRefs: [], receiptRefs: [] },
    remainingWork: [{
      itemRef: "remaining:mobile-partial:external",
      action: "A target-system check is still required.",
      owner: "external",
      status: "pending",
    }],
    receiptRefs: [observation.receiptRef, baseline.receiptRef],
    reflectionEligible: false,
    trustedHostEvidence: [observation, baseline],
  });

  const baselineChat = createChat({ agentId, title: "Improvement baseline", taskMode: "task" });
  const currentChat = createChat({ agentId, title: "Improvement current", taskMode: "task" });
  const baselineTask = setCanonicalTaskStatus(baselineChat.taskId, "completed");
  const currentTask = setCanonicalTaskStatus(currentChat.taskId, "completed");
  const improvementInitial = oneImprovementProofRuntime.getOneImprovementProofState();
  oneImprovementProofRuntime.createOneImprovementProof(measuredImprovementInput({
    storeVersion: improvementInitial.version,
    baselineTaskId: baselineTask.id,
    baselineTaskVersion: baselineTask.version,
    currentTaskId: currentTask.id,
    currentTaskVersion: currentTask.version,
  }));

  const valueState = oneValueClosureRuntime.getOneValueClosureState();
  const improvementState = oneImprovementProofRuntime.getOneImprovementProofState();
  const valueRows = projectMobileBridgeOneValueClosuresFromState(hostIdentity, valueState);
  const proofRows = projectMobileBridgeOneImprovementProofsFromState(hostIdentity, improvementState);
  assert.equal(valueRows.length, 1);
  assert.equal(proofRows.length, 1);

  const valueRow = valueRows[0];
  assert.equal(isMobileBridgeOneValueClosureDto(valueRow), true);
  assert.equal(valueRow.authoritativeHostRef, hostIdentity.hostId);
  assert.equal(valueRow.taskId, valueTask.id);
  assert.equal(valueRow.canonicalTaskVersion, valueTask.version);
  assert.equal(valueRow.verification.outcomeStatus, "partially_verified");
  assert.deepEqual(valueRow.verification.phases.map((item) => [item.phase, item.status]), [
    ["discovery", "not_started"],
    ["preparation", "not_started"],
    ["execution", "not_applicable"],
    ["verification", "in_progress"],
  ]);
  assert.equal(valueRow.remainingWork.pending, 1);
  assert.equal(valueRow.remainingWork.externalOwned, 1);
  assert.equal(JSON.stringify(valueRow).includes(outcomeRef), false, "opaque outcome refs must not become an external completion claim");
  assert.equal(JSON.stringify(valueRow).includes("target-system"), false, "remaining-work prose must remain in Main");
  assert.equal(isMobileBridgeOneValueClosureDto({ ...valueRow, externalOutcomeCompleted: true }), false);

  const proofRow = proofRows[0];
  const proofRecord = improvementState.proofs[0];
  const comparison = proofRecord.comparisons[0];
  assert.equal(isMobileBridgeOneImprovementProofDto(proofRow), true);
  assert.equal(proofRow.authoritativeHostRef, hostIdentity.hostId);
  assert.equal(proofRow.taskId, currentTask.id);
  assert.equal(proofRow.canonicalTaskVersion, currentTask.version);
  assert.equal(proofRow.attributionStatus, "not_established");
  assert.equal(proofRow.compoundingStep, "reused", "an observed improvement without established attribution must not promote on Mobile");
  assert.deepEqual(proofRow.reusedAssets, [{
    assetId: proofRecord.assetBindings[0].assetId,
    assetVersion: proofRecord.assetBindings[0].assetVersion,
    assetKind: proofRecord.assetBindings[0].assetKind,
    sourceTaskId: baselineTask.id,
    sourceTaskVersion: baselineTask.version,
  }]);
  assert.equal(proofRow.comparisons[0].baselineTaskVersion, baselineTask.version);
  assert.equal(proofRow.comparisons[0].currentTaskVersion, currentTask.version);
  assert.deepEqual(proofRow.comparisons[0].receiptRefs, comparison.receiptRefs);
  assert.equal(proofRow.comparisons[0].evidenceCount, comparison.evidenceRefs.length);
  assert.deepEqual(proofRow.comparisons[0].metric, {
    type: "measured",
    changeKind: "instruction_reduction",
    baseline: 5,
    current: 2,
    unit: "question_count",
    comparisonDirection: "lower_is_better",
  });
  for (const forbidden of ["label", "statement", "method", "basis", "surface", "prompt"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(proofRow, forbidden), false);
  }
  assert.equal(isMobileBridgeOneImprovementProofDto({ ...proofRow, sourceSurfaceRef: "surface_fake" }), false);
  assert.equal(isMobileBridgeOneImprovementProofDto({ ...proofRow, attributionStatus: "correlated" }), false);
  assert.equal(isMobileBridgeOneImprovementProofDto({ ...proofRow, attributionStatus: "not_established", compoundingStep: "improved_result" }), false);
  const missingAttribution = { ...proofRow };
  delete missingAttribution.attributionStatus;
  assert.equal(isMobileBridgeOneImprovementProofDto(missingAttribution), false);
  const unsafeMetric = structuredClone(proofRow);
  unsafeMetric.comparisons[0].metric.unit = "/Users/mason/private";
  assert.equal(isMobileBridgeOneImprovementProofDto(unsafeMetric), false);

  const snapshot = await projectMobileBridgeSnapshot({
    hostIdentity,
    displayName: "One Evidence Projection Desktop",
    appVersion: "0.8.99",
  });
  assert.equal(snapshot.host.capabilities.includes("one-value-closures-v1"), true);
  assert.equal(snapshot.host.capabilities.includes("one-improvement-proofs-v1"), true);
  assert.deepEqual(snapshot.oneValueClosures, valueRows);
  assert.deepEqual(snapshot.oneImprovementProofs, proofRows);

  assert.deepEqual(
    projectMobileBridgeOneImprovementProofsFromState(hostIdentity, {
      contractVersion: "1.0.0",
      version: 1,
      evidence: [],
      proofs: [{ surfaceId: "surface_placeholder_only" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    [],
    "a Surface or placeholder must never manufacture an Improvement Proof",
  );

  const wrongValue = structuredClone(valueState);
  wrongValue.closures[0].closure.taskId = currentTask.id;
  assert.deepEqual(projectMobileBridgeOneValueClosuresFromState(hostIdentity, wrongValue), []);
  const wrongProof = structuredClone(improvementState);
  wrongProof.proofs[0].proof.taskId = valueTask.id;
  assert.deepEqual(projectMobileBridgeOneImprovementProofsFromState(hostIdentity, wrongProof), []);

  const unsafeValue = structuredClone(valueState);
  unsafeValue.closures[0].closure.remainingWork[0].action = "/Users/mason/private/result";
  assert.deepEqual(projectMobileBridgeOneValueClosuresFromState(hostIdentity, unsafeValue), []);
  const unsafeProof = structuredClone(improvementState);
  unsafeProof.proofs[0].proof.changes[0].unit = "password=private-value";
  assert.deepEqual(projectMobileBridgeOneImprovementProofsFromState(hostIdentity, unsafeProof), []);

  const duplicateValue = structuredClone(valueState);
  const duplicateValueRecord = structuredClone(duplicateValue.closures[0]);
  duplicateValueRecord.closure.valueClosureId = "value_closure_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  duplicateValue.closures.push(duplicateValueRecord);
  assert.deepEqual(projectMobileBridgeOneValueClosuresFromState(hostIdentity, duplicateValue), []);
  const duplicateProof = structuredClone(improvementState);
  const duplicateProofRecord = structuredClone(duplicateProof.proofs[0]);
  duplicateProofRecord.proof.improvementProofId = "improvement_proof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  duplicateProof.proofs.push(duplicateProofRecord);
  assert.deepEqual(projectMobileBridgeOneImprovementProofsFromState(hostIdentity, duplicateProof), []);

  assert.deepEqual(projectMobileBridgeOneValueClosuresFromState(hostIdentity, valueState, { maxBytes: 1 }), []);
  assert.deepEqual(projectMobileBridgeOneImprovementProofsFromState(hostIdentity, improvementState, { maxBytes: 1 }), []);

  db.prepare("UPDATE tasks SET status = 'archived', archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), valueTask.id);
  assert.deepEqual(projectMobileBridgeOneValueClosuresFromState(hostIdentity, valueState), []);
  db.prepare("UPDATE tasks SET status = 'running', archived_at = NULL WHERE id = ?").run(valueTask.id);
  db.prepare("UPDATE tasks SET status = 'archived', archived_at = ? WHERE id = ?")
    .run(new Date().toISOString(), baselineTask.id);
  assert.deepEqual(projectMobileBridgeOneImprovementProofsFromState(hostIdentity, improvementState), []);
  db.prepare("UPDATE tasks SET status = 'completed', archived_at = NULL WHERE id = ?").run(baselineTask.id);

  const valueUpdatedAt = valueTask.updatedAt;
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .run(new Date(valueTask.version + 1).toISOString(), valueTask.id);
  assert.deepEqual(projectMobileBridgeOneValueClosuresFromState(hostIdentity, valueState), []);
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(valueUpdatedAt, valueTask.id);
  const currentUpdatedAt = currentTask.updatedAt;
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .run(new Date(currentTask.version + 1).toISOString(), currentTask.id);
  assert.deepEqual(projectMobileBridgeOneImprovementProofsFromState(hostIdentity, improvementState), []);
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(currentUpdatedAt, currentTask.id);
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
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "vEthernet (외부 스위치)", address: "192.168.0.17", internal: false },
      { interfaceName: "lo", address: "127.0.0.1", internal: true },
    ]),
    "192.168.0.17",
    "a Hyper-V external vSwitch carrying the machine's only LAN address must stay usable",
  );
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "vEthernet (WSL)", address: "172.20.144.1", internal: false },
      { interfaceName: "Wi-Fi", address: "192.168.1.7", internal: false },
    ]),
    "192.168.1.7",
    "a real adapter must always beat a Windows vSwitch",
  );
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "vEthernet (외부)", address: "192.168.0.17", internal: false },
      { interfaceName: "vEthernet (WSL)", address: "172.20.144.1", internal: false },
    ]),
    "192.168.0.17",
    "a LAN-band vSwitch must beat a 172.x NAT-band vSwitch",
  );
  assert.equal(
    selectPreferredMobileBridgeHost([
      { interfaceName: "docker0", address: "192.168.9.1", internal: false },
    ]),
    null,
    "container bridges stay excluded even on a LAN band",
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
    for (const permissions of ["write", "full"]) {
      await assert.rejects(
        authority.request(
          {
            v: 1,
            type: "request",
            id: `authority_start_${permissions}_forwarded`,
            method: "invoke.start",
            params: {
              chatId: "chat_1",
              userPrompt: "Attempt a remote mutation",
              permissions,
            },
          },
          context,
        ),
        /Chat not found/,
      );
    }
    await assert.rejects(
      authority.request(
        {
          v: 1,
          type: "request",
            id: "authority_steer_write_forwarded",
          method: "invoke.steer",
          params: {
            chatId: "chat_1",
            userPrompt: "Attempt a remote steering mutation",
            permissions: "write",
            expectedRunId: "run_1",
          },
        },
        context,
      ),
      /Steering target is stale/,
    );
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
  replaceInstalledAgentHubBinding({
    installedAgentId: agentId,
    agentDefinitionId: "definition-mobile-sync",
    agentReleaseId: "release-mobile-sync-v1",
    source: "hub-install",
    boundAt: "2026-07-11T00:00:00.000Z",
  });

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
    const pairingSeed = await authority.pairingVerification(context);
    assert.equal(pairingSeed.hostId, "host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(
      pairingSeed.sampleTaskId,
      "task_pairing_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(pairingSeed.sampleTaskVersion, Date.parse(context.connectedAt));
    const reconnectSnapshot = await authority.snapshot(context);
    assert.deepEqual(reconnectSnapshot.pairingVerificationTasks, [{
      hostId: pairingSeed.hostId,
      taskId: pairingSeed.sampleTaskId,
      taskVersion: pairingSeed.sampleTaskVersion,
      updatedAt: context.connectedAt,
    }]);
    assert.equal(
      reconnectSnapshot.chats.some((item) => item.taskId === pairingSeed.sampleTaskId),
      false,
      "pairing verification Task must not pollute user Work chats",
    );
    assert.equal(
      reconnectSnapshot.taskProjections.some((item) => item.taskId === pairingSeed.sampleTaskId),
      false,
      "pairing verification Task must not pollute user One projections",
    );
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
    const mobileCreatedGroup = await authority.request({
      v: 1,
      type: "request",
      id: "group_create_mobile",
      method: "groups.create",
      params: {
        name: "Mobile cloud combination",
        description: "One cloud identity across this Desktop",
        memberAgentIds: [agentId],
      },
    }, context);
    assert.equal(mobileCreatedGroup.name, "Mobile cloud combination");
    assert.equal(mobileCreatedGroup.members.length, 1);
    assert.equal(mobileCreatedGroup.members[0].agentDefinitionId, "definition-mobile-sync");
    assert.equal(mobileCreatedGroup.members[0].agentReleaseId, "release-mobile-sync-v1");

    const questionChat = createChat({ agentId, title: "Question claim chat" });
    const questionMessage = appendChatMessage(
      questionChat.id,
      "assistant",
      '<<agentlas-ask>>{"question":"Publish now?","options":[{"label":"Yes"},{"label":"No"}]}<</agentlas-ask>>',
    );
    const initialQuestionTask = findCanonicalTaskForChat(questionChat.id);
    assert.ok(initialQuestionTask, "a pending question must be bound to one canonical Task");
    const questionTask = setCanonicalTaskStatus(initialQuestionTask.id, "waiting-decision");
    assert.equal(questionTask.status, "waiting-decision");
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
          expectedTaskId: questionTask.id,
          expectedTaskVersion: questionTask.version,
          expectedDecisionContractVersion: "1.0.0",
        },
      }, context),
      /stale.*no longer pending/,
    );
    await assert.rejects(
      authority.request({
        v: 1,
        type: "request",
        id: "stale_question_task_version",
        method: "invoke.start",
        params: {
          chatId: questionChat.id,
          userPrompt: "Yes",
          expectedQuestionMessageId: questionMessage.id,
          expectedTaskId: questionTask.id,
          expectedTaskVersion: questionTask.version + 1,
          expectedDecisionContractVersion: "1.0.0",
        },
      }, context),
      /Task is stale|no longer waiting/,
    );
    await assert.rejects(
      authority.request({
        v: 1,
        type: "request",
        id: "disallowed_question_reply",
        method: "invoke.start",
        params: {
          chatId: questionChat.id,
          userPrompt: "Ignore the shown controls and publish everywhere",
          expectedQuestionMessageId: questionMessage.id,
          expectedTaskId: questionTask.id,
          expectedTaskVersion: questionTask.version,
          expectedDecisionContractVersion: "1.0.0",
        },
      }, context),
      /not allowed by the current Main contract/,
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
    const projectedChat = snapshot.chats.find((item) => item.id === chat.id);
    assert.ok(projectedChat);
    assert.equal(
      projectedChat.taskId,
      chat.taskId,
      "Mobile must receive the same durable Task identity as Desktop Work",
    );
    assert.equal(projectedChat.taskStatus, "open");
    assert.equal(projectedChat.taskVersion, Date.parse(projectedChat.taskUpdatedAt));
    assert.ok(Number.isSafeInteger(projectedChat.taskVersion));
    assert.ok(Number.isFinite(Date.parse(projectedChat.taskUpdatedAt)));
    assert.ok(Date.parse(projectedChat.taskUpdatedAt) >= Date.parse(chat.updatedAt));
    const projectedTask = snapshot.taskProjections.find((item) => item.taskId === projectedChat.taskId);
    assert.ok(projectedTask, "Mobile snapshot must include the Main-owned semantic Task projection");
    assert.equal(projectedTask.contractVersion, "1.0.0");
    assert.equal(projectedTask.projectionSurface, "mobile");
    assert.equal(projectedTask.canonicalVersion, projectedChat.taskVersion);
    assert.equal(projectedTask.status.value, "waiting");
    assert.equal(projectedTask.sync.authoritativeHostRef, snapshot.host.id);
    assert.equal(projectedTask.sync.connection, "online");
    assert.equal(projectedTask.sync.executionAuthorityAvailable, true);
    assert.equal(projectedTask.sync.mutationMode, "direct");
    assert.equal(projectedTask.truth.mayClaimNewCompletion, true);

    const partialTask = setCanonicalTaskStatus(chat.taskId, "partial");
    const restoredSurface = adaptLegacySurfaceToOneV1({
      manifest: {
        version: "0.1",
        kind: "surface",
        title: "Restart-safe result",
        domain: "research",
        layout: "document",
        data: { narrative: "The verified result survived restart." },
        widgets: [{ type: "text", data: "narrative", title: "Summary" }],
      },
      surfaceId: "surface_mobile_restart",
      taskId: partialTask.id,
      syncedAt: partialTask.updatedAt,
    });
    const originalLatestReceipt = invocationService.latestReceipt;
    const originalLatestOneSurface = invocationService.latestOneSurface;
    invocationService.latestReceipt = (chatId) => chatId === chat.id
      ? {
          runId: "run_mobile_restart",
          chatId: chat.id,
          status: "completed",
          startedAt: "2026-07-18T08:00:00.000Z",
          updatedAt: "2026-07-18T08:01:00.000Z",
          finishedAt: "2026-07-18T08:01:00.000Z",
          eventCount: 5,
          resultFolder: "/Users/mason/private/result",
        }
      : null;
    invocationService.latestOneSurface = ({ runId, chatId, taskId }) =>
      runId === "run_mobile_restart" && chatId === chat.id && taskId === partialTask.id
        ? {
            runId,
            chatId,
            taskId,
            recordedAt: "2026-07-18T08:01:00.000Z",
            manifest: restoredSurface,
          }
        : null;
    try {
      const restoredResult = await authority.request({
        v: 1,
        type: "request",
        id: "task_latest_result_live",
        method: "tasks.latestResult",
        params: {
          taskId: partialTask.id,
          chatId: chat.id,
          expectedVersion: partialTask.version,
        },
      }, context);
      assert.equal(restoredResult.taskId, partialTask.id);
      assert.equal(restoredResult.taskVersion, partialTask.version);
      assert.equal(restoredResult.taskStatus, "partial");
      assert.equal(restoredResult.chatId, chat.id);
      assert.equal(restoredResult.runId, "run_mobile_restart");
      assert.equal(restoredResult.receipt.status, "completed");
      assert.equal(restoredResult.surface.taskId, partialTask.id);
      assert.equal(JSON.stringify(restoredResult).includes("/Users/mason"), false);
      assert.equal(await authority.request({
        v: 1,
        type: "request",
        id: "task_latest_result_stale",
        method: "tasks.latestResult",
        params: {
          taskId: partialTask.id,
          chatId: chat.id,
          expectedVersion: partialTask.version - 1,
        },
      }, context), null);
      assert.equal(getCanonicalTask(partialTask.id).version, partialTask.version);
    } finally {
      invocationService.latestReceipt = originalLatestReceipt;
      invocationService.latestOneSurface = originalLatestOneSurface;
    }
    const projectedAutomation = snapshot.automations.find((item) => item.id === automation.id);
    assert.ok(projectedAutomation);
    assert.equal(projectedAutomation.runState, "unknown");
    assert.equal(projectedAutomation.lastError, null);
    assert.deepEqual(
      new Set(changes.map((change) => change.entity)),
      new Set(["agent", "firm", "agent-group", "project", "chat", "automation", "task"]),
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

    // chats.create accepts only a project id from Mobile. Main must resolve the
    // host DB folder, canonicalize it once, and persist that exact folder before
    // the very first invocation captures its main-only workspace capability.
    const unavailableProject = createProject({
      name: "Unavailable Mobile Authority Project",
      defaultAgentId: agentId,
      folderPath: path.join(projectionRoot, "missing-mobile-authority-project"),
    });
    const chatCountBeforeUnavailableProject = db.prepare("SELECT COUNT(*) AS count FROM chats").get().count;
    await assert.rejects(
      authority.request({
        v: 1,
        type: "request",
        id: "chat_create_unavailable_project_workspace",
        method: "chats.create",
        params: {
          agentId,
          projectId: unavailableProject.id,
          title: "Must not degrade into a global chat",
        },
      }, context),
      /working folder is unavailable/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chats").get().count,
      chatCountBeforeUnavailableProject,
      "an unavailable project folder must fail before creating a global chat row",
    );
    const projectWorkspace = path.join(projectionRoot, "mobile-authority-project-real");
    const projectWorkspaceLink = path.join(projectionRoot, "mobile-authority-project-link");
    fs.mkdirSync(projectWorkspace, { recursive: true });
    if (process.platform !== "win32") fs.symlinkSync(projectWorkspace, projectWorkspaceLink, "dir");
    const authorityProject = createProject({
      name: "Mobile Authority Project",
      defaultAgentId: agentId,
      folderPath: process.platform === "win32" ? projectWorkspace : projectWorkspaceLink,
    });
    const createdFromProject = await authority.request({
      v: 1,
      type: "request",
      id: "chat_create_project_workspace",
      method: "chats.create",
      params: {
        agentId,
        projectId: authorityProject.id,
        title: "Project-bound Mobile chat",
      },
    }, context);
    const canonicalProjectWorkspace = fs.realpathSync.native(projectWorkspace);
    assert.equal(getChatWorkingFolder(createdFromProject.id), canonicalProjectWorkspace);
    assert.equal(createdFromProject.workingFolderName, path.basename(canonicalProjectWorkspace));

    const originalInvocationStart = invocationService.start;
    const capturedStarts = [];
    invocationService.start = (invocation, workspaceBinding) => {
      capturedStarts.push({ invocation, workspaceBinding });
      return { runId: `mobile-authority-run-${capturedStarts.length}` };
    };
    try {
      await authority.request({
        v: 1,
        type: "request",
        id: "invoke_first_project_workspace",
        method: "invoke.start",
        params: {
          chatId: createdFromProject.id,
          userPrompt: "Inspect the host-approved project",
        },
      }, context);
      assert.equal(capturedStarts[0].workspaceBinding.canonicalPath, canonicalProjectWorkspace);
      assert.ok(capturedStarts[0].workspaceBinding.directoryIdentity);

      await authority.request({
        v: 1,
        type: "request",
        id: "workspace_clear_project_workspace",
        method: "workspace.clear",
        params: { chatId: createdFromProject.id },
      }, context);
      assert.equal(getChatWorkingFolder(createdFromProject.id), null);
      assert.equal(getChat(createdFromProject.id).projectId, authorityProject.id);

      await authority.request({
        v: 1,
        type: "request",
        id: "invoke_after_project_workspace_clear",
        method: "invoke.start",
        params: {
          chatId: createdFromProject.id,
          userPrompt: "Stay globally unbound after the explicit clear",
        },
      }, context);
      assert.deepEqual(capturedStarts[1].workspaceBinding, {
        source: "mobile",
        canonicalPath: null,
        directoryIdentity: null,
      });

      const acknowledgedDecisionChat = createChat({
        agentId,
        title: "Exact Decision acknowledgement",
      });
      const acknowledgedDecisionMessage = appendChatMessage(
        acknowledgedDecisionChat.id,
        "assistant",
        '<<agentlas-ask>>{"question":"Save the draft?","options":[{"label":"Approve"},{"label":"Reject"}]}<</agentlas-ask>>',
      );
      const acknowledgedDecisionTask = setCanonicalTaskStatus(
        findCanonicalTaskForChat(acknowledgedDecisionChat.id).id,
        "waiting-decision",
      );
      const acknowledgedDecisionView = normalizeOneDecision(
        listPendingConfirmations().find((item) => item.sourceMessageId === acknowledgedDecisionMessage.id),
        acknowledgedDecisionTask.id,
      );
      const decisionResult = await authority.request({
        v: 1,
        type: "request",
        id: "invoke_exact_decision_answer",
        method: "invoke.start",
        params: {
          chatId: acknowledgedDecisionChat.id,
          userPrompt: acknowledgedDecisionView.controls.reject.reply,
          expectedQuestionMessageId: acknowledgedDecisionView.decisionId,
          expectedTaskId: acknowledgedDecisionTask.id,
          expectedTaskVersion: acknowledgedDecisionTask.version,
          expectedDecisionContractVersion: acknowledgedDecisionView.contractVersion,
        },
      }, context);
      assert.equal(decisionResult.runId, "mobile-authority-run-3");
      assert.deepEqual(decisionResult.decisionAcknowledgement, {
        contractVersion: "1.0.0",
        decisionId: acknowledgedDecisionMessage.id,
        taskId: acknowledgedDecisionTask.id,
        taskVersion: acknowledgedDecisionTask.version,
        status: "answer_claimed",
      });
      assert.equal(capturedStarts[2].invocation.userPrompt, acknowledgedDecisionView.controls.reject.reply);
    } finally {
      invocationService.start = originalInvocationStart;
    }
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

    const limited = new MobileBridgePairingManager(root, pairingOptions({ now, ttlMs: 10_000, maxAttempts: 2 }));
    const limitedChallenge = issueTestChallenge(limited, identity.hostId);
    await expectPairingError(() => limited.exchange(pairRequest("wrong_1", "B".repeat(22))), "pairing_denied");
    await expectPairingError(() => limited.exchange(pairRequest("wrong_2", "C".repeat(22))), "pairing_denied");
    await expectPairingError(
      () => limited.exchange(pairRequest("blocked", limitedChallenge.code)),
      "pairing_unavailable",
    );

    const expiryReasons = [];
    const expiring = new MobileBridgePairingManager(root, pairingOptions({
      now,
      ttlMs: 10_000,
      onChanged: (reason) => expiryReasons.push(reason),
    }));
    const expiredChallenge = issueTestChallenge(expiring, identity.hostId);
    clockMs += 10_000;
    await expectPairingError(
      () => expiring.exchange(pairRequest("expired", expiredChallenge.code)),
      "pairing_expired",
    );
    assert.deepEqual(expiryReasons, ["challenge-issued", "challenge-expired"]);

    const pairingReasons = [];
    const manager = new MobileBridgePairingManager(root, pairingOptions({
      now,
      onChanged: (reason) => pairingReasons.push(reason),
    }));
    const challenge = issueTestChallenge(manager, identity.hostId);
    assert.match(challenge.code, /^[A-Za-z0-9_-]{22}$/);

    const manifest = makeManifest(identity.hostId);
    writeMobileBridgeEndpointManifest(root, manifest);
    const payload = createMobileBridgePairingPayload(challenge, manifest);
    assert.equal(payload.code, challenge.code);
    assert.equal(payload.pairingAttemptId, TEST_PAIRING_ATTEMPT_ID);
    assert.equal(payload.desktopAccountProof, challenge.desktopAccountProof);
    assert.equal(payload.accountAuthorityOrigin, "https://agentlas.cloud");
    assert.equal(payload.pairExchangeEndpoint, "http://127.0.0.1:43123/v1/mobile/pair/exchange");
    assert.equal(Object.hasOwn(payload, "token"), false);
    assert.equal(Object.hasOwn(payload, "accountSubject"), false);
    assert.equal(JSON.stringify(payload).includes("agentlas_session"), false);
    assert.equal(JSON.stringify(payload).includes("devBootstrap"), false);

    const issued = await manager.exchange(pairRequest("success", challenge.code));
    assert.match(issued.deviceId, /^device_[a-f0-9]{32}$/);
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    await expectPairingError(
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

async function testPairingQrStaysScannable() {
  // The public certificate still stays out of the QR. Same-account pairing adds
  // only a short-lived opaque Desktop proof and attempt binding; neither the
  // Desktop session cookie nor the stable opaque account subject may appear.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-qr-"));
  try {
    const tls = await loadOrCreateMobileBridgeTls(root);
    const identity = loadOrCreateMobileBridgeHostIdentity(
      root,
      new Date("2026-07-16T00:00:00.000Z"),
    );
    const manifest = {
      version: 1,
      hostId: identity.hostId,
      displayName: "Mason Mac Studio",
      path: "/v1/mobile",
      pairExchangePath: MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
      bindHost: "192.168.200.133",
      port: 53986,
      secure: true,
      url: "wss://192.168.200.133:53986/v1/mobile",
      certificateFingerprint: tls.certificateFingerprint,
      certificateDer: tls.certificateDer,
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    // Writing validates the manifest, so a secure manifest that still carries
    // its certificate stays legal — only the QR sheds it.
    writeMobileBridgeEndpointManifest(root, manifest);

    const manager = new MobileBridgePairingManager(root, pairingOptions({
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    }));
    const payload = createMobileBridgePairingPayload(issueTestChallenge(manager, identity.hostId), manifest);
    const encoded = JSON.stringify(payload);

    assert.equal(payload.certificateDer, null, "the QR must not carry the certificate");
    assert.equal(
      encoded.includes(tls.certificateDer),
      false,
      "no field may smuggle the certificate back into the QR",
    );
    // The pin itself must still be there, or the phone has nothing to verify.
    assert.equal(payload.certificateFingerprint, tls.certificateFingerprint);
    assert.equal(encoded.includes("agentlas_session"), false);
    assert.equal(encoded.includes(TEST_ACCOUNT_SUBJECT), false);
    assert.equal(payload.pairingAttemptId, TEST_PAIRING_ATTEMPT_ID);
    assert.equal(payload.accountAuthorityOrigin, "https://agentlas.cloud");
    // Keep a hard upper bound so a future change cannot add certificates,
    // cookies, or another unbounded authority document to the QR.
    assert.ok(
      encoded.length < 1_500,
      `pairing QR grew to ${encoded.length} chars — authority payload is unexpectedly large`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testServerBoundary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-server-"));
  const hostId = "host_fedcba9876543210fedcba9876543210";
  const pairing = new MobileBridgePairingManager(root, pairingOptions());
  const replayStore = new MobileBridgeRequestReplayStore(root, {
    instanceId: "server-boundary-instance",
  });
  const calls = [];
  const errors = [];
  let eventListener = null;
  let nextSnapshotBlock = null;
  let nextRequestBlock = null;
  let rejectNextPairingVerification = false;
  const authority = {
    async pairingVerification() {
      if (rejectNextPairingVerification) {
        rejectNextPairingVerification = false;
        throw new Error("simulated pairing verification failure");
      }
      return {
        hostId,
        sampleTaskId: "task_pairing_probe",
        sampleTaskVersion: 1721289600000,
      };
    },
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
    relayPairingInfo: () => ({
      endpoint: "wss://agentlas.cloud/v1/mobile/relay",
      secret: "R".repeat(43),
    }),
    onError: (error) => errors.push(error.message),
  });
  let socket = null;
  let socket2 = null;
  try {
    const address = await server.start();
    assert.equal(address.host, "127.0.0.1");
    await expectUnauthorized(address.url);

    const challenge = issueTestChallenge(pairing, hostId);
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

    const failedChallenge = issueTestChallenge(pairing, hostId);
    rejectNextPairingVerification = true;
    const failedVerificationResponse = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pairRequest("pair_verification_failure", failedChallenge.code)),
    });
    assert.equal(failedVerificationResponse.status, 503);
    const rolledBackDevice = pairing.listDevices().at(-1);
    assert.ok(rolledBackDevice?.revokedAt, "post-exchange failure must revoke the issued credential");

    const successChallenge = issueTestChallenge(pairing, hostId);
    const exchangeResponse = await fetch(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pairRequest("pair_ok", successChallenge.code)),
    });
    assert.equal(exchangeResponse.status, 200);
    assert.equal(exchangeResponse.headers.get("cache-control"), "no-store");
    const exchange = await exchangeResponse.json();
    assert.equal(exchange.ok, true);
    assert.equal(exchange.verification.hostId, hostId);
    assert.equal(exchange.verification.issuedAt, exchange.credential.issuedAt);
    assert.equal(exchange.verification.sampleTaskId, "task_pairing_probe");
    assert.equal(exchange.verification.sampleTaskVersion, 1721289600000);
    assert.match(exchange.verification.verificationId, /^pairing_[a-f0-9]{32}$/);
    assert.deepEqual(exchange.relay, {
      endpoint: "wss://agentlas.cloud/v1/mobile/relay",
      secret: "R".repeat(43),
    });
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

    const oneWriteEnvelope = {
      v: 1,
      type: "request",
      id: "one_write_1",
      idempotencyKey: "one-start-stable-key-1",
      method: "one.invoke.start",
      params: { schemaVersion: 1, userPrompt: "Prepare the launch brief." },
    };
    socket.send(JSON.stringify(oneWriteEnvelope));
    const oneFirstWrite = await nextMessage(
      (message) => message.type === "response" && message.id === oneWriteEnvelope.id,
    );
    assert.equal(oneFirstWrite.ok, true);
    assert.equal(calls.length, 3);

    socket.send(JSON.stringify({ ...oneWriteEnvelope, id: "one_write_retry" }));
    const oneReplayedWrite = await nextMessage(
      (message) => message.type === "response" && message.id === "one_write_retry",
    );
    assert.equal(oneReplayedWrite.ok, true);
    assert.equal(calls.length, 3, "replayed One start must not create a second conversation");

    socket.send(JSON.stringify({
      ...oneWriteEnvelope,
      id: "one_write_conflict",
      params: { schemaVersion: 1, userPrompt: "A different launch brief." },
    }));
    const oneConflictedWrite = await nextMessage(
      (message) => message.type === "response" && message.id === "one_write_conflict",
    );
    assert.equal(oneConflictedWrite.ok, false);
    assert.equal(oneConflictedWrite.error.code, "idempotency_conflict");
    assert.equal(calls.length, 3);

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
    const challenge2 = issueTestChallenge(pairing, hostId);
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
    await stopAgentlasMobileBridge();
    const restarted = await startAgentlasMobileBridge({
      userDataPath: root,
      appVersion: "0.8.2",
      displayName: "Runtime Retry Desktop",
    });
    assert.equal(
      restarted.endpoint,
      first.endpoint,
      "a fresh Desktop restart must retain the paired phone endpoint",
    );
    assert.equal(restarted.hostId, first.hostId);
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

async function testMobileBridgeSurvivesMissingLan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-bridge-no-lan-"));
  const previousHost = process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
  const previousPort = process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
  const previousWatch = process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS;
  const originalPreferredHost = mobileBridgeTls.preferredMobileBridgeHost;
  delete process.env.AGENTLAS_MOBILE_BRIDGE_HOST;
  delete process.env.AGENTLAS_MOBILE_BRIDGE_PORT;
  process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS = "1000";
  // A second loopback address (::1) always binds, so use it as the stand-in for
  // "a LAN address appeared". A fabricated 192.168.x would hit EADDRNOTAVAIL on
  // the test host and mask the behavior under test.
  const promotionHost = "::1";
  // Simulate a machine with no routable LAN address (the Windows vEthernet /
  // firewall case): the host selector throws exactly as it does in production.
  let lanAvailable = false;
  mobileBridgeTls.preferredMobileBridgeHost = () => {
    if (!lanAvailable) throw new Error("No usable LAN address");
    return promotionHost;
  };
  try {
    const started = await startAgentlasMobileBridge({
      userDataPath: root,
      appVersion: "0.8.2",
      displayName: "No LAN Desktop",
    });
    // The bridge must NOT die. It binds loopback so the local server and its
    // Cloud Relay tunnel still start — remote access stays possible.
    assert.equal(started.running, true, "the bridge must survive a missing LAN address");
    assert.equal(
      new URL(started.endpoint).hostname,
      "127.0.0.1",
      "with no LAN address the bridge must fall back to a loopback bind, not fail",
    );

    // When an address later becomes routable, the watcher must promote the bind
    // so direct pairing becomes available without a restart.
    lanAvailable = true;
    const promoted = await waitUntil(() => {
      const status = mobileBridgeRuntimeStatus();
      return status.running && status.endpoint?.includes("[::1]") ? status : null;
    });
    assert.equal(new URL(promoted.endpoint).hostname, "[::1]");
    assert.equal(promoted.hostId, started.hostId, "promotion must keep the stable host identity");

    // And if the address disappears again, it must degrade back to loopback
    // rather than tearing the bridge (and relay) down.
    lanAvailable = false;
    const degraded = await waitUntil(() => {
      const status = mobileBridgeRuntimeStatus();
      return status.running && status.endpoint?.includes("127.0.0.1") ? status : null;
    });
    assert.equal(new URL(degraded.endpoint).hostname, "127.0.0.1");
  } finally {
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
  testMobileInvocationPermissionBoundary();
  await testTlsIdentity();
  testAbsolutePathSanitization();
  testOneDeviceProjectionBoundary();
  testControlFenceProjection();
  testUtf16Sanitization();
  testInvocationEventProjection();
  testTranscriptAndConfirmationProjection();
  await testOneDecisionProjectionBoundary();
  await testOneEvidenceProjectionBoundary();
  testLanAddressSelection();
  testDurableReplayLedger();
  await testAuthoritySteerGuard();
  await testReconnectSnapshotAndDesktopMutationInvalidation();
  testAutomationLiveRunProjection();
  await testPairingLifecycle();
  await testPairingQrStaysScannable();
  await testServerBoundary();
  await testRuntimeRetryKeepsStableEndpoint();
  await testAutomaticNetworkRebind();
  await testMobileBridgeSurvivesMissingLan();
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
