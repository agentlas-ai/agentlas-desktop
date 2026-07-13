#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-memory-isolation-"));
  app.setPath("userData", temp);
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const context = require("../dist/electron/memory/context.js");
  store.initStore();
  try {
    memory.insertMemoryEntry({ scope: "agent_repo", kind: "decision", content: "alpha-only-memory", agentId: "agent-alpha" });
    memory.insertMemoryEntry({ scope: "agent_repo", kind: "decision", content: "beta-only-memory", agentId: "agent-beta" });
    memory.insertMemoryEntry({ scope: "agent_team", kind: "decision", content: "shared-team-memory", agentId: null });
    const alpha = context.buildMemoryContext(null, "agent-alpha");
    assert.match(alpha, /alpha-only-memory/);
    assert.doesNotMatch(alpha, /beta-only-memory/);
    assert.match(alpha, /shared-team-memory/);
    const clientSource = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
    assert.match(clientSource, /buildMemoryContext\(activePath, agent\.id\)/);
    console.log(JSON.stringify({ ok: true, checks: 4 }, null, 2));
  } finally {
    store.getDb().close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
