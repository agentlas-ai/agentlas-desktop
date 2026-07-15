#!/usr/bin/env node
const assert = require("node:assert/strict");
const { classifyAutomationOutput } = require("../dist/electron/automation-result.js");

for (const text of [
  "Error: EPERM: operation not permitted, open '/Users/mason/Downloads/no-slop-seeder/ledger.jsonl'",
  "Operation not permitted while writing the workspace ledger",
]) {
  const result = classifyAutomationOutput(text);
  assert.equal(result.status, "error");
  assert.equal(result.outcome, "blocked");
  assert.equal(result.reasonCode, "workspace_permission_denied");
  assert.ok(result.evidence);
}

assert.deepEqual(
  classifyAutomationOutput("NEEDS-INPUT: please choose a browser profile").outcome,
  "needs_input",
);
assert.deepEqual(
  classifyAutomationOutput("Automation execution halted because the browser host is unavailable").outcome,
  "blocked",
);
assert.equal(classifyAutomationOutput("Published 3 approved posts successfully").outcome, "ok");
assert.equal(classifyAutomationOutput("").reasonCode, "missing_result");

console.log("automation typed result contract ok");
