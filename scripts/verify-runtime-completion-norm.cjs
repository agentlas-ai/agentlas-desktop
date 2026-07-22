#!/usr/bin/env node
// Regression guard: write/full-permission chat runs must carry the agentic
// completion norm. Without it, the same Claude/Codex runtime that finishes
// diagnose→fix→verify in its own CLI answers "the cause is X" and stops when
// wrapped in Agentlas chat framing (real user report, 2026-07-22, One and Work).
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("electron/runtime/runner.ts", "utf8");
assert.match(source, /Finish the loop\./, "write/full runs must carry the completion norm");
assert.match(source, /cause-only answer is a failure/i, "explaining-only must remain a named failure mode");
assert.match(source, /name exactly what is missing/, "a blocked run must ask for the missing attachment/access instead of dead-ending");
assert.match(source, /: tStatus\(locale, "sysToolsOff"\)/, "read mode must keep tools off unchanged");
process.stdout.write(`${JSON.stringify({ ok: true, completionNorm: true })}\n`);
