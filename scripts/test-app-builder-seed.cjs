#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
const { ARCHITECTURE_VERSION, BUILTIN_AGENTS } = require("../dist/electron/architecture/manifest.js");
const { listInstalledAgents } = require("../dist/electron/mcp/registry.js");
const { selectAutoRoutedAgent } = require("../dist/electron/agents/auto-router.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-app-builder-seed-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");

let exitCode = 0;
try {
  initStore();
  assert.equal(seedBuiltinAgents(), true, "first seed should write built-ins");

  const db = getDb();
  const rows = db
    .prepare("SELECT id, slug, name, name_en, role, builtin, visibility FROM installed_agents WHERE builtin = 1 ORDER BY slug")
    .all();
  assert.equal(rows.length, BUILTIN_AGENTS.length, "all built-ins should be seeded");

  const builder = rows.find((row) => row.slug === "agentlas-app-builder");
  assert.ok(builder, "seeded DB should contain agentlas-app-builder");
  assert.equal(builder.id, "builtin-agentlas-app-builder");
  assert.equal(builder.role, "builder");
  assert.equal(builder.visibility, "background");

  const meta = db.prepare("SELECT value FROM meta WHERE key = 'architecture_version'").get();
  assert.equal(meta.value, ARCHITECTURE_VERSION, "seed should store the current architecture version");

  const installed = listInstalledAgents();
  const hiddenBuilder = installed.find((agent) => agent.slug === "agentlas-app-builder");
  assert.ok(hiddenBuilder, "registry should retain hidden App Builder for routing");
  assert.equal(hiddenBuilder.visibility, "background");

  const hiddenBackgrounds = installed.filter((agent) =>
    ["agentlas-orchestrator", "agentlas-app-builder", "agentlas-pm-soul", "agentlas-memory-curator", "agentlas-task-bias"].includes(agent.slug),
  );
  assert.equal(hiddenBackgrounds.length, 5, "all built-ins remain routable in the registry");
  assert.ok(hiddenBackgrounds.every((agent) => agent.visibility === "background"), "all built-ins stay hidden/background");

  const choice = selectAutoRoutedAgent(
    "Apps Generate mode is enabled. Create an internal analytics dashboard app.",
    installed,
    "en",
  );
  assert.equal(choice.agent.slug, "agentlas-app-builder");

  const greetingChoice = selectAutoRoutedAgent("안녕", installed, "ko");
  assert.notEqual(greetingChoice.agent.slug, "agentlas-app-builder", "greetings must not trigger App creation consent");

  console.log(`app-builder seed smoke passed (${rows.length} built-ins, v${ARCHITECTURE_VERSION})`);
} catch (err) {
  exitCode = 1;
  console.error(err);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (app && typeof app.quit === "function") app.quit();
  process.exit(exitCode);
}
