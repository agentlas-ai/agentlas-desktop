#!/usr/bin/env node
// Root-cause regression (2026-07-22): codex's workspace-write Seatbelt sandbox
// DENIES all network by default, so every write-mode run (all automations, all
// acting chats) could not reach 127.0.0.1:9222 — the local browser it was told
// to drive. The agent then flailed ("no permission", reinstall Chrome) and the
// automation dead-ended. Empirically: `codex exec --sandbox workspace-write`
// curling the CDP port exits 7; adding `sandbox_workspace_write.network_access
// =true` reaches Chrome. This guards that the flag is wired for write + resume,
// and that read stays a no-network conversation mode.
const assert = require("node:assert/strict");
const fs = require("node:fs");

const src = fs.readFileSync("electron/runtime/codex.ts", "utf8");

// write mode: workspace-write sandbox WITH network enabled.
assert.match(
  src,
  /permission === "write"[\s\S]*?"--sandbox", "workspace-write", "-c", "sandbox_workspace_write\.network_access=true"/,
  "codex write mode must enable network so the agent can reach the local browser and HTTP",
);
// resume must carry the same network grant.
assert.match(
  src,
  /permission === "write"[\s\S]*?sandbox_mode="workspace-write"[\s\S]*?sandbox_workspace_write\.network_access=true/,
  "resumed codex write runs must keep network open too",
);
// full stays a full bypass.
assert.match(src, /permission === "full"[\s\S]*?--dangerously-bypass-approvals-and-sandbox/, "full stays bypass");
// read stays read-only (tools/network off — it is the conversation mode).
assert.match(src, /"--sandbox", "read-only"/, "read mode stays read-only");

process.stdout.write(`${JSON.stringify({ ok: true, codexWriteNetwork: true })}\n`);
