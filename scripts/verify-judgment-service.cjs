#!/usr/bin/env node
// Deterministic contract for the resident judgment service (electron/system-agents/judgment.ts)
// and its first consumer (automation-result). These checks are hermetic — they exercise only the
// parts that must hold WITHOUT a connected model: the secret-value safety floor and the
// structured-marker short-circuit. The meaning-aware LLM path is proven by a separate live smoke.
const assert = require("node:assert/strict");
const path = require("node:path");

const { secretValueFloor } = require(path.join(__dirname, "..", "dist", "electron", "system-agents", "judgment.js"));
const { classifyAutomationOutcome, classifyAutomationOutput } = require(path.join(__dirname, "..", "dist", "electron", "automation-result.js"));

(async () => {
  // 1. Secret-value floor — the one deterministic line — always masks credential shapes.
  for (const secret of [
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_0123456789012345678901234567890123",
    "-----BEGIN OPENSSL PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36",
  ]) {
    const { redacted, containedSecret } = secretValueFloor(`config: ${secret} end`);
    assert.equal(containedSecret, true, `floor must flag: ${secret}`);
    assert.ok(!redacted.includes(secret), `floor must redact: ${secret}`);
    assert.ok(redacted.includes("config:") && redacted.includes("end"), "floor must preserve surrounding text");
  }
  // Plain prose that merely resembles a key-word is left intact (floor matches shapes, not words).
  {
    const plain = "the token expires tomorrow and the password policy changed";
    const { containedSecret } = secretValueFloor(plain);
    // assignment pattern (password: ...) not present here, so no secret shape.
    assert.equal(containedSecret, false, "plain prose must not trip the floor");
  }

  // 2. Structured error-code markers stay authoritative — no model is consulted, result is exact.
  const structured = await classifyAutomationOutcome("Workforce failed: agent_not_found for the pinned release");
  assert.equal(structured.outcome, "blocked", "structured agent_not_found must stay blocked");
  assert.equal(structured.reasonCode, "agent_not_found");

  const ask = await classifyAutomationOutcome("progress...\n<<agentlas-ask>> which folder?");
  assert.equal(ask.outcome, "needs_input", "structured unattended question must stay needs_input");

  // 3. Empty result never becomes success.
  const empty = await classifyAutomationOutcome("   ");
  assert.equal(empty.outcome, "error");

  // 4. Pure deterministic classifier is unchanged for a clean success with no markers.
  assert.equal(classifyAutomationOutput("Posted 3 updates and finished.").outcome, "ok");

  console.log("judgment service deterministic contract ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
