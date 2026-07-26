"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const core = path.resolve(root, "..", "Agentlas-OS");
const contract = JSON.parse(fs.readFileSync(
  path.join(root, "electron", "mcp-tools", "workforce-protocol-contract.json"),
  "utf8",
));
const clientSource = fs.readFileSync(path.join(root, "electron", "mcp", "client.ts"), "utf8");
const continuitySource = fs.readFileSync(
  path.join(root, "electron", "mcp", "workforce-goal-continuity.ts"),
  "utf8",
);

const requiredContinuityTools = [
  "workforce.bind_goal",
  "workforce.goal_context",
  "workforce.goal_runtime",
  "workforce.record_goal_turn",
  "workforce.complete_goal",
];
for (const tool of requiredContinuityTools) {
  assert.ok(contract.tools.requiredNames.includes(tool), `Desktop protocol must require ${tool}`);
}
assert.ok(
  contract.tools.prepareExecution.requiredInputFields.includes("projectDir"),
  "successful preparation must carry the automatic local project binding",
);
assert.ok(
  contract.tools.prepareExecution.inputPropertyFields.includes("goalId"),
  "hosts must be able to pass a canonical Task id without user goal syntax",
);

assert.match(clientSource, /loadDesktopWorkforceGoal\(workforceProjectDir, durableWorkforceGoalId\)/);
assert.match(clientSource, /durableTurnDecision\?\.decision === "reuse"/);
assert.match(clientSource, /explicitWorkforceGoal = req\.userPrompt/);
assert.match(clientSource, /decision: "local-only"/);
assert.match(clientSource, /bindDesktopWorkforceGoal\(\{/);
assert.match(clientSource, /recordDesktopWorkforceTurn\(\{/);
assert.match(continuitySource, /goal:desktop:\$\{sha256\(value\)\.slice\(0, 40\)\}/);
assert.match(continuitySource, /agentlas\.account_context/);
assert.match(continuitySource, /workforce", "goal-complete"/);

const request = [
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
].join("\n") + "\n";
const python = process.env.PYTHON || "python3";
const result = spawnSync(python, ["-m", "agentlas_cloud", "mcp", "serve"], {
  cwd: core,
  input: request,
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: core },
});
assert.equal(result.status, 0, result.stderr);
const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
const inventory = responses.find((row) => row.id === 2)?.result?.tools;
assert.ok(Array.isArray(inventory), "Core must return an MCP tool inventory");
const coreWorkforceNames = inventory
  .map((tool) => tool.name)
  .filter((name) => name.startsWith("workforce."))
  .sort();
assert.deepEqual(coreWorkforceNames, [...contract.tools.requiredNames].sort());
const prepare = inventory.find((tool) => tool.name === "workforce.prepare_execution");
assert.deepEqual(
  [...prepare.inputSchema.required].sort(),
  [...contract.tools.prepareExecution.requiredInputFields].sort(),
);
assert.deepEqual(
  Object.keys(prepare.inputSchema.properties).sort(),
  [...contract.tools.prepareExecution.inputPropertyFields].sort(),
);
assert.equal(
  prepare._meta["agentlas/workforce-protocol"].protocolVersion,
  contract.protocolMetadata.protocolVersion,
);

console.log("workforce goal continuity contract: PASS");
