const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
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
const { loadOrCreateMobileBridgeTls } = require("../dist/electron/mobile-bridge/tls.js");
const {
  createMobileBridgeAuthority,
  projectMobileBridgeInvocationEvent,
} = require("../dist/electron/mobile-bridge/authority.js");
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

async function testWireParsers() {
  const valid = parseMobileBridgeRequest({
    v: 1,
    type: "request",
    id: "request_1",
    method: "team.list",
    params: {},
  });
  assert.equal(valid.ok, true);

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
    params: { chatId: "chat_1", userPrompt: "Change direction", expectedRunId: "run_1" },
  });
  assert.equal(steerWithObservedRun.ok, true);

  const validPair = parseMobileBridgePairExchangeRequest(pairRequest("pair_1", "A".repeat(22)));
  assert.equal(validPair.ok, true);
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
  } finally {
    authority.dispose();
  }
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

    const expiring = new MobileBridgePairingManager(root, { now, ttlMs: 10_000 });
    const expiredChallenge = expiring.issueChallenge();
    clockMs += 10_000;
    expectPairingError(
      () => expiring.exchange(pairRequest("expired", expiredChallenge.code)),
      "pairing_expired",
    );

    const manager = new MobileBridgePairingManager(root, { now });
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
    const nextMessage = createMessageInbox(socket);
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

async function main() {
  await testWireParsers();
  await testTlsIdentity();
  testInvocationEventProjection();
  await testAuthoritySteerGuard();
  await testPairingLifecycle();
  await testServerBoundary();
  console.log("Mobile Bridge contract, pairing, authenticated transport, event ordering, and safe projection tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
