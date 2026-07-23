#!/usr/bin/env node
// Regression guard for the official v2 beta cut feedback
// (betatester/03-audit/official-v2-cut-feedback.md), fix items #1, #2, #7:
//   - Internal runtime/CLI/agent/schema vocabulary must never reach a One surface.
//   - An English run must not end with Korean product copy.
// Two layers: (A) behavioral test of the shared customer-safe boundary, and
// (B) a source guard that the One display paths no longer carry the leaked copy.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

// ---- (A) Behavioral: load the pure sanitizer and exercise the real leaks ----
function loadCustomerSafe() {
  const src = fs.readFileSync("shared/one-customer-safe.ts", "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "require", out)(mod, mod.exports, require);
  return mod.exports;
}
const { customerSafeProgressDetail, toCustomerSafeText, isInternalProgressStatus } = loadCustomerSafe();

// Progress leaks captured verbatim in U02 findings must collapse to nothing,
// since One always shows a calm five-stage label as the real progress signal.
for (const leak of [
  "Meme Shorts Studio · Calling Codex CLI...",
  "Calling Codex CLI...",
  "runtime-session 8c9c-8837ece927ea",
  "Agentlas Orchestrator",
  "Codex CLI 호출 중...",
  "scope-lock acquired",
]) {
  assert.equal(customerSafeProgressDetail(leak), "", `progress leak survived: ${leak}`);
  assert.equal(isInternalProgressStatus(leak), true, `not flagged internal: ${leak}`);
}

// Result/error schema copy must never read as product copy; it collapses to
// neutral, locale-correct copy that states facts without commanding a retry.
const enSchema = toCustomerSafeText(
  "The team run completed, but its structured result was not displayed because it did not validate as exactly one safe Surface.",
  "en",
);
assert.doesNotMatch(enSchema, /structured result|safe Surface|safe One Surface|manifest/i, "en schema leak survived");
assert.match(enSchema, /not completed here/i, "en schema leak did not fall back to neutral copy");
assert.doesNotMatch(enSchema, /try again|ask me/i, "fallback copy must not command the user to retry");

const enWorkbench = toCustomerSafeText("Automatic App/workbench generation is disabled. Showing chat output only.", "en");
assert.doesNotMatch(enWorkbench, /workbench|Automatic App/i, "workbench copy survived");

// Locale is pinned to the rendered surface: an English run never yields Korean.
assert.doesNotMatch(enSchema, /[가-힣]/, "English run leaked Korean characters");
const koSchema = toCustomerSafeText("The structured result could not be safely validated, so it was not displayed.", "ko");
assert.match(koSchema, /[가-힣]/, "Korean run must stay Korean");

// A clean customer answer must pass through byte-for-byte (no formatting damage).
const cleanSign = "Oat Latte — $4\n7:00–10:00 AM\nUsually $5 — save $1";
assert.equal(toCustomerSafeText(cleanSign, "en"), cleanSign, "clean copy must not be altered");
const cleanKo = "요청하신 카페 7일 프로모션을 정리했어요.";
assert.equal(toCustomerSafeText(cleanKo, "ko"), cleanKo, "clean Korean copy must not be altered");

// ---- (B) Source guard: the One display paths no longer carry the leaked copy ----
const bannedInDisplayPaths = [
  /Automatic App\/workbench generation is disabled/,
  /One completed a structured result/,
  /The team completed a structured result/,
  /did not validate as exactly one safe Surface/,
  /did not validate as a safe One Surface/,
  /A structured result manifest was produced/,
];
for (const file of [
  "electron/mcp/client.ts",
  "electron/mcp/borrowed-task-force.ts",
  "electron/invocation/service.ts",
]) {
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of bannedInDisplayPaths) {
    assert.doesNotMatch(source, pattern, `leaked customer copy still present in ${file}: ${pattern}`);
  }
}

// OneShell must route progress and message text through the customer-safe boundary
// and must not rebuild the agent-name-prefixed raw status that leaked before.
const shell = fs.readFileSync("renderer/components/one/OneShell.tsx", "utf8");
assert.match(shell, /from "@shared\/one-customer-safe"/, "OneShell must import the customer-safe boundary");
assert.match(shell, /customerSafeProgressDetail\(event\.status\)/, "progress status must be sanitized");
assert.doesNotMatch(shell, /`\$\{event\.agentName\} · \$\{event\.status\}`/, "agent-name-prefixed status must be gone");

process.stdout.write(`${JSON.stringify({ ok: true, behavioralChecks: true, displayPathsGuarded: 3 })}\n`);
