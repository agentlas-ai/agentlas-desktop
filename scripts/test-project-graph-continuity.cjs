#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { app } = require("electron");

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "keytar") {
    return { getPassword: async () => null, setPassword: async () => undefined, deletePassword: async () => true, findCredentials: async () => [] };
  }
  if (request === "../main" && parent?.filename.includes(`${path.sep}dist${path.sep}electron${path.sep}`)) {
    return { currentUiLocale: () => "en" };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-graph-continuity-"));
process.env.AGENTLAS_STORE_PATH = path.join(temp, "store.sqlite");
app.setPath("userData", path.join(temp, "user-data"));

async function main() {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    const chats = require("../dist/electron/store/chats.js");
    const kinds = require("../dist/electron/agents/entity-kind.js");
    store.initStore();
    const db = store.getDb();
    const insertAgent = db.prepare(`
      INSERT INTO installed_agents
        (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
         env_requirements_json, trust_grade, installed_at, tone, builtin, visibility, entity_kind)
      VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', 'A', ?, 'blue', 0, 'visible', 'agent')
    `);
    const now = new Date().toISOString();
    insertAgent.run("agent-a", "agent-a", "Agent A", "Agent A", now);
    insertAgent.run("agent-b", "agent-b", "Agent B", "Agent B", now);

    const legacy = chats.createChat({ agentId: "agent-a", title: "⟦automation⟧auto-1", kind: "division" });
    const migrated = chats.getOrCreateAutomationSession({ automationId: "auto-1", agentId: "agent-a" });
    assert.equal(migrated.id, legacy.id, "matching legacy target should migrate in place");
    assert.match(migrated.title, /::target:agent:/);

    const changed = chats.getOrCreateAutomationSession({ automationId: "auto-1", agentId: "agent-b" });
    assert.notEqual(changed.id, migrated.id, "changed target needs an independent durable session");
    assert.equal(changed.agentId, "agent-b");
    assert.equal(chats.getOrCreateAutomationSession({ automationId: "auto-1", agentId: "agent-a" }).id, migrated.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE title LIKE '⟦automation⟧auto-1%' ").get().n, 2);

    assert.equal(kinds.entityKindAfterRefresh("team", { entityKind: "agent", agentCount: 1 }), "team");
    assert.equal(kinds.entityKindAfterRefresh("agent", { entityKind: "team", agentCount: 8 }), "agent");
    assert.equal(kinds.entityKindAfterRefresh(null, { entityKind: "team", agentCount: 8 }), "team");
    const registrySource = fs.readFileSync(path.join(__dirname, "../electron/mcp/registry.ts"), "utf8");
    assert.match(registrySource, /entityKindAfterRefresh\(existing\.entity_kind, listing\)/);

    console.log(JSON.stringify({ ok: true, checks: 10 }, null, 2));
  } finally {
    try { require("../dist/electron/store/db.js").getDb().close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
