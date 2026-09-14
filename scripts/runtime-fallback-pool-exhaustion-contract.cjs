#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: missing start marker ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: missing end marker ${endMarker}`);
  return source.slice(start, end);
}

function assertFiniteFallback(body, attemptedName, label) {
  assert.match(body, new RegExp(`const ${attemptedName}[^;]*= \\[\\]`), `${label}: no invocation-scoped attempted set`);
  assert.match(body, new RegExp(`${attemptedName}\\.push\\(`), `${label}: failed runtime is not remembered`);
  assert.match(body, new RegExp(`exclude:\\s*${attemptedName}`), `${label}: prior failures are not excluded from selection`);
  assert.match(
    body,
    new RegExp(`${attemptedName}\\.some\\([\\s\\S]*?fallback`),
    `${label}: selected fallback is not checked against prior failures`,
  );
}

const firm = read("electron/mcp/firm-orchestrator.ts");
const firmNodeTurn = sliceBetween(
  firm,
  "async function runNodeTurn(",
  "const safeResultText = restrictedFirmText(",
  "firm node runtime fallback",
);
assertFiniteFallback(firmNodeTurn, "failedNodeRuntimes", "firm node runtime fallback");

const swarm = read("electron/mcp/swarm-run.ts");
const swarmWorker = sliceBetween(
  swarm,
  "const runOneTask = async",
  "// 완료된 블랙보드를 하나로 종합",
  "swarm worker runtime fallback",
);
assertFiniteFallback(swarmWorker, "failedWorkerRuntimes", "swarm worker runtime fallback");

const swarmSynthesis = sliceBetween(
  swarm,
  "const synthesize = async",
  "let idCounter = 0;",
  "swarm synthesis runtime fallback",
);
assertFiniteFallback(swarmSynthesis, "failedSynthesisRuntimes", "swarm synthesis runtime fallback");

const direct = read("electron/mcp/client.ts");
assert.match(direct, /DIRECT_RUNTIME_RECOVERY_MAX_ATTEMPTS\s*=\s*4/);
assert.match(direct, /DIRECT_RUNTIME_RECOVERY_MAX_ELAPSED_MS\s*=\s*30_000/);
assert.match(direct, /DIRECT_RUNTIME_RECOVERY_MAX_RETRY_EVENTS\s*=\s*3/);
assert.match(direct, /!attemptedRuntimeKeys\.has\(candidateKey\)/);

const selection = read("electron/runtime/selection.ts");
assert.match(
  selection,
  /excluded\.some\(\(item\) => sameRuntimeIdentity\(candidate, item\) && candidate\.model === item\.model\)/,
  "attempted exclusion must remove one model, not every model on the same executable",
);

const automation = read("electron/automation-scheduler.ts");
assert.match(automation, /!opts\?\.zeroToolRetried/);
assert.match(automation, /zeroToolRetried:\s*true/);

const graph = read("electron/workflow/run-graph.ts");
assert.match(graph, /if \(!loopPlan\.ok\)/);
assert.match(graph, /pending인데 실행도 준비도 안 됨[\s\S]*?무한루프 방지/);

process.stdout.write("runtime-fallback-pool-exhaustion-contract: passed\n");
