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

for (const [text, outcome, code] of [
  ["pinned_runtime_contract_invalid: malformed", "needs_input", "pinned_runtime_contract_invalid"],
  ["automation_hub_mode_contract_invalid: future value", "needs_input", "hub_mode_contract_invalid"],
  ["automation_hub_version_pin_unavailable: exact release unavailable", "blocked", "hub_version_pin_temporarily_unavailable"],
  ["automation_hub_version_pin_invalid: latest", "blocked", "hub_version_pin_invalid"],
  ["automation_ambiguous_side_effect: provider outcome unknown", "blocked", "ambiguous_side_effect"],
  ["workforce_session_refresh_exhausted", "blocked", "workforce_session_unavailable"],
]) {
  const result = classifyAutomationOutput(text);
  assert.equal(result.outcome, outcome, text);
  assert.equal(result.reasonCode, code, text);
}

console.log("automation typed result contract ok");
