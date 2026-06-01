#!/usr/bin/env node
const assert = require("node:assert/strict");
const {
  applyJsonPointerPatch,
  valueAtJsonPointer,
} = require("../dist/electron/store/agent-surfaces.js");

const initial = {};
const approved = applyJsonPointerPatch(initial, "/data/shots/rows/0/status", "approved");
assert.equal(valueAtJsonPointer(approved, "/data/shots/rows/0/status"), "approved");
assert.deepEqual(initial, {});

const withPrompt = applyJsonPointerPatch(approved, "/data/shots/rows/0/prompt", "Show product in hand");
assert.equal(valueAtJsonPointer(withPrompt, "/data/shots/rows/0/status"), "approved");
assert.equal(valueAtJsonPointer(withPrompt, "/data/shots/rows/0/prompt"), "Show product in hand");

const nested = applyJsonPointerPatch(withPrompt, "/data/assets/rows/1/status", "rejected");
assert.equal(valueAtJsonPointer(nested, "/data/assets/rows/1/status"), "rejected");
assert.equal(valueAtJsonPointer(nested, "/data/assets/rows/0/status"), undefined);

console.log("surface-state smoke passed");
