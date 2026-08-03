#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

process.env.AGENTLAS_E2E = "1";

const {
  MobileBridgePairingManager,
  createMobileBridgePairingPayload,
  loadOrCreateMobileBridgeHostIdentity,
} = require("../dist/electron/mobile-bridge/pairing.js");
const {
  loadOrCreateMobileBridgeTls,
} = require("../dist/electron/mobile-bridge/tls.js");
const {
  MobileBridgeRequestReplayStore,
} = require("../dist/electron/mobile-bridge/replay.js");
const {
  AgentlasMobileBridgeServer,
} = require("../dist/electron/mobile-bridge/server.js");
const {
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
} = require("../dist/shared/mobile-bridge.js");

const bridgePort = Number.parseInt(
  process.env.AGENTLAS_RECONNECT_QA_BRIDGE_PORT || "17889",
  10,
);
const controlPort = Number.parseInt(
  process.env.AGENTLAS_RECONNECT_QA_CONTROL_PORT || "17890",
  10,
);
for (const [name, value] of Object.entries({ bridgePort, controlPort })) {
  assert.ok(Number.isInteger(value) && value > 1024 && value < 65536, `${name} is invalid`);
}
assert.notEqual(bridgePort, controlPort, "QA ports must differ");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-reconnect-qa-"));
const accountSubject = `mps_${"A".repeat(43)}`;
const accountAuthorityOrigin = "https://agentlas.cloud";
let bridge = null;
let pairing = null;
let hostId = null;
let tls = null;
let exchangeCount = 0;
let restartCount = 0;
let pairingIssueCount = 0;
let operation = Promise.resolve();

function authoritySnapshot() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: {
      id: hostId,
      displayName: "Reconnect QA Desktop",
      platform: "macos",
      appVersion: "0.9.47",
      protocolVersion: 1,
      online: true,
      capabilities: ["agents", "chats", "steering", "oneInvocation"],
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

const authority = {
  async pairingVerification() {
    return {
      hostId,
      sampleTaskId: null,
      sampleTaskVersion: null,
    };
  },
  async snapshot() {
    return authoritySnapshot();
  },
  async request(request) {
    if (request.method === "snapshot.get") return authoritySnapshot();
    return null;
  },
  subscribe() {
    return () => {};
  },
};

function pairingAuthority() {
  return {
    authenticate: (token) => pairing.authenticate(token),
    exchange: async (request) => {
      const credential = await pairing.exchange(request);
      exchangeCount += 1;
      return credential;
    },
    revokeDevice: (deviceId) => pairing.revokeDevice(deviceId),
  };
}

async function startBridge({ restarted = false } = {}) {
  if (bridge) return;
  pairing = new MobileBridgePairingManager(root, {
    consumePairingAssertion: async () => ({
      accountSubject,
      receiptId: `mpr_${"R".repeat(24)}`,
    }),
    validateAccountAuthority: async () => true,
  });
  const replayStore = new MobileBridgeRequestReplayStore(root, {
    instanceId: `reconnect-qa-${restartCount + 1}`,
  });
  bridge = new AgentlasMobileBridgeServer({
    authority,
    pairing: pairingAuthority(),
    replayStore,
    host: "127.0.0.1",
    port: bridgePort,
    tls: tls.serverOptions,
    onError: () => {},
  });
  await bridge.start();
  if (restarted) restartCount += 1;
}

async function stopBridge() {
  const current = bridge;
  bridge = null;
  if (current) await current.close();
}

function pairingPayload() {
  assert.ok(bridge && pairing, "bridge is not running");
  const pairingAttemptId = `pairing_attempt_reconnect_${String(pairingIssueCount + 1).padStart(8, "0")}`;
  const challenge = pairing.issueChallenge({
    hostId,
    pairingAttemptId,
    desktopAccountProof: `${Buffer.from('{"t":"mobile_pair_desktop_proof"}').toString("base64url")}.${"P".repeat(43)}`,
    accountSubject,
    accountAuthorityOrigin,
    expiresIn: 300,
  });
  pairingIssueCount += 1;
  return createMobileBridgePairingPayload(challenge, {
    version: 1,
    hostId,
    displayName: "Reconnect QA Desktop",
    path: "/v1/mobile",
    pairExchangePath: MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
    bindHost: "127.0.0.1",
    port: bridgePort,
    secure: true,
    url: `wss://127.0.0.1:${bridgePort}/v1/mobile`,
    certificateFingerprint: tls.certificateFingerprint,
    certificateDer: tls.certificateDer,
    updatedAt: new Date().toISOString(),
  });
}

function publicStatus() {
  const devices = pairing ? pairing.listDevices() : [];
  return {
    running: Boolean(bridge),
    hostId,
    activeDeviceCount: devices.filter((device) => !device.revokedAt).length,
    exchangeCount,
    restartCount,
    pairingIssueCount,
  };
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

let control = null;
async function closeAll() {
  await stopBridge().catch(() => {});
  await new Promise((resolve) => control?.close(() => resolve())).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  hostId = loadOrCreateMobileBridgeHostIdentity(root).hostId;
  tls = await loadOrCreateMobileBridgeTls(root);
  await startBridge();
  control = http.createServer((request, response) => {
    operation = operation.then(async () => {
      if (request.method === "GET" && request.url === "/pairing") {
        json(response, 200, pairingPayload());
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        json(response, 200, publicStatus());
        return;
      }
      if (request.method === "POST" && request.url === "/stop") {
        await stopBridge();
        json(response, 200, publicStatus());
        return;
      }
      if (request.method === "POST" && request.url === "/start") {
        await startBridge({ restarted: true });
        json(response, 200, publicStatus());
        return;
      }
      json(response, 404, { ok: false });
    }).catch((error) => {
      console.error("[reconnect-qa]", error instanceof Error ? error.message : "control failed");
      if (!response.headersSent) json(response, 500, { ok: false });
      else response.destroy();
    });
  });
  control.listen(controlPort, "127.0.0.1", () => {
    console.log(JSON.stringify({
      ready: true,
      controlUrl: `http://127.0.0.1:${controlPort}`,
    }));
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void closeAll().finally(() => app.quit());
  });
}

app.on("before-quit", () => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});
