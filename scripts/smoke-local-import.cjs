#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-local-import-"));
const userDataDir = path.join(tempDir, "user-data");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");

app.setPath("userData", userDataDir);

const { initStore } = require("../dist/electron/store/db.js");
const { importLocalFolder } = require("../dist/electron/agents/import-local.js");
const { listRoutes } = require("../dist/electron/agents/routes.js");
const { listFirms } = require("../dist/electron/store/firms.js");

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

(async () => {
  let exitCode = 0;
  try {
    initStore();

    const agentRoot = path.join(tempDir, "proof-research-agent");
    writeFile(path.join(agentRoot, "AGENTS.md"), "# Proof Research Agent\n\nYou verify local import flows.\n");
    writeFile(path.join(agentRoot, "README.md"), "# Proof Research Agent\n\nLocal import smoke agent.\n");

    const single = await importLocalFolder(agentRoot);
    assert.equal(single.kind, "agent");
    assert.equal(single.runtime, "codex");
    assert.equal(single.agent.name, "Proof Research Agent");
    assert.equal(single.agent.localPath, agentRoot);

    const sameAgain = await importLocalFolder(agentRoot);
    assert.equal(sameAgain.agent.id, single.agent.id, "same folder import must be idempotent");

    const teamRoot = path.join(tempDir, "proof-founder-team");
    writeFile(path.join(teamRoot, "TEAM.md"), "# Proof Founder Team\n\nLocal import smoke team.\n");
    writeFile(path.join(teamRoot, "ceo", "AGENT.md"), "# Proof Founder Team\n\nCoordinate the proof team.\n");
    writeFile(path.join(teamRoot, "agents", "research", "AGENT.md"), "# Research\n\nInspect evidence.\n");
    writeFile(path.join(teamRoot, "agents", "builder", "AGENT.md"), "# Builder\n\nPatch issues.\n");

    const team = await importLocalFolder(teamRoot);
    assert.equal(team.kind, "team");
    assert.equal(team.agent.name, "Proof Founder Team");
    assert.equal(team.agent.localPath, teamRoot);

    const routes = listRoutes();
    assert.ok(routes.some((route) => route.agentId === single.agent.id && route.path === agentRoot && route.kind === "agent"));
    assert.ok(routes.some((route) => route.agentId === team.agent.id && route.path === teamRoot && route.kind === "team"));

    const firms = listFirms();
    assert.ok(firms.some((firm) => firm.slug === `firm-${team.agent.slug}` && firm.ceoAgentId === team.agent.id));

    console.log(
      JSON.stringify(
        {
          ok: true,
          importedAgent: single.agent.name,
          importedTeam: team.agent.name,
          routes: routes.length,
          firms: firms.length,
          storePath: process.env.AGENTLAS_STORE_PATH,
          userDataDir,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
