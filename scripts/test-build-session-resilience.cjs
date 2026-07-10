#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "renderer/lib/build-session.ts"), "utf8");
const ipc = fs.readFileSync(path.join(root, "electron/ipc.ts"), "utf8");

assert.match(renderer, /let buildGeneration = 0;/, "build sessions need a monotonic generation");
assert.match(
  renderer,
  /const listing = await api\.fs\.listDirectory\(workspace, readScope, true\);\s*if \(!isCurrentBuild\(generation\)\) return null;/,
  "workspace disk checks must stop after cancel",
);
assert.match(
  renderer,
  /const sub = await api\.fs\.listDirectory\(dir\.path, readScope, true\);\s*if \(!isCurrentBuild\(generation\)\) return null;/,
  "nested disk checks must stop after cancel",
);
assert.match(
  renderer,
  /if \(!isCurrentBuild\(generation\) \|\| state\.runId !== runId\) return;/,
  "stale build events must not mutate a newer/cancelled session",
);
assert.match(
  renderer,
  /try \{\s*const started = await api\.hephaestus\.build/,
  "build invoke rejection must be caught after phase=running",
);
assert.match(
  renderer,
  /buildGeneration \+= 1;\s*if \(cancelledRunId\)/,
  "cancel must invalidate async work before sending IPC cancellation",
);

assert.match(
  ipc,
  /if \(!ready\) \{\s*readyExpiry = setTimeout/,
  "main must retain early terminal events until renderer buildReady",
);
assert.match(
  ipc,
  /for \(const ev of pending\) sendToWin\(ev\);\s*pending\.length = 0;\s*buildReadySignals\.delete\(runId\);/,
  "buildReady must flush before cleanup",
);
assert.doesNotMatch(
  ipc,
  /runHephaestusBuild[\s\S]{0,500}\.finally\(\(\) => \{[\s\S]{0,180}buildReadySignals\.delete\(runId\);/,
  "build completion must not unconditionally delete an unconsumed ready signal",
);

console.log("build session failure/cancel/handshake guards ok");
