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

const { getDb, initStore } = require("../dist/electron/store/db.js");
const { detectRuntimeLabels, importLocalFolder } = require("../dist/electron/agents/import-local.js");
const { readAgentFile, writeAgentFile } = require("../dist/electron/agents/files.js");
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

    const updatedSystemPrompt = "# Updated System Prompt\n\nDB-backed prompt update proof.\n";
    writeAgentFile(single.agent.id, "system-prompt.md", updatedSystemPrompt);
    const promptRow = getDb().prepare("SELECT system_prompt FROM installed_agents WHERE id = ?").get(single.agent.id);
    assert.equal(promptRow.system_prompt, updatedSystemPrompt);
    assert.throws(() => writeAgentFile(single.agent.id, "../escape.md", "nope"), /escapes the agent folder/);
    const escapedRead = await readAgentFile(single.agent.id, "../escape.md");
    assert.equal(escapedRead.content, "");

    const runtimeRoot = path.join(tempDir, "runtime-matrix-agent");
    writeFile(path.join(runtimeRoot, "CLAUDE.md"), "# Runtime Matrix Agent\n\nClaude marker.\n");
    writeFile(path.join(runtimeRoot, "AGENTS.md"), "# Runtime Matrix Agent\n\nCodex marker.\n");
    writeFile(path.join(runtimeRoot, "GEMINI.md"), "# Runtime Matrix Agent\n\nGemini marker.\n");
    fs.mkdirSync(path.join(runtimeRoot, ".cursor"), { recursive: true });
    const runtimeLabels = detectRuntimeLabels(runtimeRoot);
    assert.deepEqual(runtimeLabels, ["claude-code", "codex", "gemini", "cursor"]);
    const runtimeMatrix = await importLocalFolder(runtimeRoot);
    assert.equal(runtimeMatrix.runtime, "claude-code");
    assert.deepEqual(runtimeMatrix.labels, ["claude-code", "codex", "gemini", "cursor"]);

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

    const beforeJunkFirmCount = listFirms().length;
    const junkRoot = path.join(tempDir, "trash");
    writeFile(path.join(junkRoot, "alpha", "AGENT.md"), "# Alpha\n\nFirst loose agent.\n");
    writeFile(path.join(junkRoot, "beta", "AGENT.md"), "# Beta\n\nSecond loose agent.\n");
    const junk = await importLocalFolder(junkRoot);
    assert.equal(junk.kind, "agent", "junk container folders must not become teams without explicit team markers");
    assert.equal(junk.agent.name, "Unnamed (trash)");
    assert.equal(listFirms().length, beforeJunkFirmCount, "junk container import must not create a firm");

    console.log(
      JSON.stringify(
        {
          ok: true,
          importedAgent: single.agent.name,
          importedTeam: team.agent.name,
          runtimeLabels,
          junkKind: junk.kind,
          promptDbUpdated: true,
          escapeWriteBlocked: true,
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
