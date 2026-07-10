#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  setupMockAgentlasBridge,
  preloadMethodPaths,
  mockBridgeOptions,
} = require("./lib/mock-agentlas-bridge.cjs");

const storage = new Map();
global.window = {
  localStorage: {
    getItem: (key) => storage.get(String(key)) ?? null,
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
  },
  setTimeout,
  clearTimeout,
};

const methods = preloadMethodPaths();
assert.ok(methods.length > 250, `expected the full preload surface, found ${methods.length} methods`);

setupMockAgentlasBridge(mockBridgeOptions());

for (const methodPath of methods) {
  const value = methodPath
    .split(".")
    .reduce((cursor, part) => cursor?.[part], window.agentlas);
  assert.equal(typeof value, "function", `mock bridge is missing ${methodPath}`);
}

assert.deepEqual(window.__qa.missingBridgeCalls, [], "bridge setup must not count missing APIs as calls");
assert.equal(typeof window.agentlas.billing.getCredits, "function");

Promise.resolve(window.agentlas.billing.getCredits())
  .then(async (result) => {
    assert.equal(result, null, "unmodeled async methods must fail safely with a neutral value");
    assert.deepEqual(window.__qa.missingBridgeCalls, [{ path: "billing.getCredits", args: [] }]);

    assert.equal(typeof window.agentlasFiles?.grantForFile, "function", "mock must expose the isolated drop-grant bridge");
    const dropped = await window.agentlasFiles.grantForFile({ name: "agentlas-file.png" });
    assert.equal(dropped.kind, "file");
    assert.equal(dropped.scope.kind, "capability");

    const picked = await window.agentlas.fs.pickDirectory();
    assert.equal(picked.kind, "directory", "folder pickers must return an FsPathGrant, not a raw path");
    assert.equal(picked.path, "/tmp/agentlas-qa");
    await window.agentlas.workspace.set("shape-check", picked);
    assert.equal(await window.agentlas.workspace.get("shape-check"), picked.path, "workspace.get must remain path-shaped after set");

    await window.agentlas.workspace.setFromProject("project-chat", "project-1");
    assert.equal(await window.agentlas.workspace.get("project-chat"), "/tmp/agentlas-qa-project");
    assert.deepEqual(window.__qa.missingBridgeCalls, [{ path: "billing.getCredits", args: [] }]);
    console.log(`mock bridge parity: ${methods.length} preload methods available; fallback telemetry verified`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
