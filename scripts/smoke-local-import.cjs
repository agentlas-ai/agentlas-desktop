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
const { listRoutes, setRoute, reconcileLocalRouteDefinitionHashes } = require("../dist/electron/agents/routes.js");
const { getFirmBySlug, listFirms } = require("../dist/electron/store/firms.js");
const { getResolvedOrg, resolveFromOrgChart } = require("../dist/electron/store/org-spec.js");

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

    // Regression: the same agent imported from a DIFFERENT path is still the
    // same agent. Matching on the folder string alone silently duplicated it as
    // local-...-2 — real installs accumulated 11 such pairs (cardnews-maker,
    // electron-expert, pitch-deck-architect...) whose definition hashes were
    // identical and only the checkout location differed. Kept on its own agent
    // so relocating its route cannot disturb the other assertions.
    const originRoot = path.join(tempDir, "relocatable-agent");
    writeFile(path.join(originRoot, "AGENTS.md"), "# Relocatable Agent\n\nSame definition, two checkouts.\n");
    const origin = await importLocalFolder(originRoot);
    const copiedRoot = path.join(tempDir, "elsewhere", "relocatable-agent");
    fs.mkdirSync(path.dirname(copiedRoot), { recursive: true });
    fs.cpSync(originRoot, copiedRoot, { recursive: true });
    const copyImport = await importLocalFolder(copiedRoot);
    assert.equal(
      copyImport.agent.id,
      origin.agent.id,
      "an identical agent imported from another path must update, not duplicate",
    );
    const duplicateSlugs = getDb()
      .prepare("SELECT COUNT(*) AS count FROM installed_agents WHERE slug LIKE ?")
      .get(`${origin.agent.slug}-%`);
    assert.equal(duplicateSlugs.count, 0, "no -2 slug may be minted for an identical agent");
    // The route follows the folder the user actually pointed at.
    assert.equal(copyImport.agent.localPath, copiedRoot);

    // A genuinely different agent must still get its own identity.
    const distinctRoot = path.join(tempDir, "distinct-agent");
    writeFile(path.join(distinctRoot, "AGENTS.md"), "# Distinct Agent\n\nA different definition entirely.\n");
    const distinct = await importLocalFolder(distinctRoot);
    assert.notEqual(distinct.agent.id, origin.agent.id, "a different definition must not collapse into an existing agent");

    // Two unrelated teams that share a boilerplate README must stay two teams.
    // The identity fingerprint used to walk only 8 of the 12 roster containers and
    // never entered `.claude`, so both of these hashed their README and nothing
    // else, collided, and the second import overwrote the first — one team
    // vanished from the library while its chats stayed attached to the other.
    const writerTeamRoot = path.join(tempDir, "writer-team");
    writeFile(path.join(writerTeamRoot, "README.md"), "# Team\n");
    writeFile(path.join(writerTeamRoot, ".claude", "agents", "writer.md"), "You are a writer.\n");
    const lawyerTeamRoot = path.join(tempDir, "lawyer-team");
    writeFile(path.join(lawyerTeamRoot, "README.md"), "# Team\n");
    writeFile(path.join(lawyerTeamRoot, ".claude", "agents", "lawyer.md"), "You are a lawyer.\n");
    const writerTeam = await importLocalFolder(writerTeamRoot);
    const lawyerTeam = await importLocalFolder(lawyerTeamRoot);
    assert.notEqual(
      lawyerTeam.agent.id,
      writerTeam.agent.id,
      "teams sharing only a boilerplate README must not collapse into one agent",
    );

    // A roster container the scanner accepts must not make the import throw.
    // `crew/` (and members/roles/squad/staff/subagents/sub-agents) reached the
    // fingerprint's traversal set as "not a definition directory", so a team the
    // Agentlas-OS gate certifies with PASS(team) never entered the library.
    const crewTeamRoot = path.join(tempDir, "crew-team");
    writeFile(path.join(crewTeamRoot, "crew", "00-orchestrator", "agent.md"), "Orchestrate the crew.\n");
    writeFile(path.join(crewTeamRoot, "crew", "researcher", "agent.md"), "Research things.\n");
    const crewTeam = await importLocalFolder(crewTeamRoot);
    assert.ok(crewTeam.agent.id, "a crew/ roster team must import");

    // The declared manager wins over the guessed one. verify-team-package.sh and
    // the Hub runtime both read these two declarations; reading neither here is
    // how a certified team ran on its README instead of its orchestrator.
    const declaredTeamRoot = path.join(tempDir, "declared-team");
    writeFile(path.join(declaredTeamRoot, "README.md"), "# Ignore me, I am documentation.\n");
    writeFile(path.join(declaredTeamRoot, "AGENTS.md"), "Run /example-team. See agents/ for roles.\n");
    writeFile(
      path.join(declaredTeamRoot, "agents", "00-orchestrator", "agent.md"),
      "DECLARED-ORCHESTRATOR-BODY: adjudicate between the workers.\n",
    );
    writeFile(path.join(declaredTeamRoot, "agents", "10-researcher", "agent.md"), "Research.\n");
    writeFile(path.join(declaredTeamRoot, "manifest.json"), JSON.stringify({
      entrypoints: { orchestrator: "agents/00-orchestrator/agent.md" },
      roster: ["agents/10-researcher/agent.md"],
    }, null, 2));
    const declaredTeam = await importLocalFolder(declaredTeamRoot);
    const declaredPrompt = getDb()
      .prepare("SELECT system_prompt FROM installed_agents WHERE id = ?")
      .get(declaredTeam.agent.id).system_prompt;
    assert.ok(
      declaredPrompt.includes("DECLARED-ORCHESTRATOR-BODY"),
      "the manager declared in manifest.json must become the team brain",
    );

    // Same, declared in the blueprint the team builder is told to emit.
    const blueprintTeamRoot = path.join(tempDir, "blueprint-team");
    writeFile(path.join(blueprintTeamRoot, "AGENTS.md"), "Adapter doc, not a brain.\n");
    writeFile(
      path.join(blueprintTeamRoot, "agents", "00-orchestrator", "agent.md"),
      "BLUEPRINT-ORCHESTRATOR-BODY: run the room.\n",
    );
    writeFile(path.join(blueprintTeamRoot, "agents", "10-research-hq", "agent.md"), "Lead research.\n");
    writeFile(path.join(blueprintTeamRoot, "agents", "20-analyst", "agent.md"), "Analyze.\n");
    writeFile(path.join(blueprintTeamRoot, ".agentlas", "company-blueprint.json"), JSON.stringify({
      topology: "hub-and-spoke",
      orchestrator: "00-orchestrator",
      nodes: [
        { id: "00-orchestrator", path: "agents/00-orchestrator/agent.md" },
        { id: "10-research-hq", role: "Research HQ", path: "agents/10-research-hq/agent.md", reportsTo: "00-orchestrator" },
        { id: "20-analyst", role: "Analyst", path: "agents/20-analyst/agent.md", reportsTo: "10-research-hq" },
      ],
      divisions: [{
        id: "10-research-hq",
        name: "Research HQ",
        role: "Research HQ",
        reportsTo: "00-orchestrator",
        agent: "agents/10-research-hq/agent.md",
        agents: [{
          id: "20-analyst",
          name: "Analyst",
          role: "Analyst",
          reportsTo: "10-research-hq",
          agent: "agents/20-analyst/agent.md",
        }],
      }],
    }, null, 2));
    const blueprintTeam = await importLocalFolder(blueprintTeamRoot);
    const blueprintPrompt = getDb()
      .prepare("SELECT system_prompt FROM installed_agents WHERE id = ?")
      .get(blueprintTeam.agent.id).system_prompt;
    assert.ok(
      blueprintPrompt.includes("BLUEPRINT-ORCHESTRATOR-BODY"),
      "the manager declared in company-blueprint.json must become the team brain",
    );
    const blueprintFirm = getFirmBySlug(`firm-${blueprintTeam.agent.slug}`);
    assert.ok(blueprintFirm, "a hierarchy blueprint must register a firm");
    assert.equal(blueprintFirm.orgChart.length, 3, "the imported chart must be CEO -> HQ -> specialist");
    assert.ok(blueprintFirm.orgChart.every((node) => node.agentId), "every hierarchy node must bind a real installed agent");
    const chartOrg = resolveFromOrgChart(blueprintFirm);
    assert.equal(chartOrg.divisions.length, 1);
    assert.equal(chartOrg.divisions[0].specialists.length, 1);
    assert.ok(chartOrg.divisions[0].agentId, "HQ render data must carry its installed agent id");
    assert.ok(chartOrg.divisions[0].specialists[0].agentId, "specialist render data must carry its installed agent id");
    const savedOrg = getResolvedOrg(blueprintFirm);
    assert.equal(savedOrg.divisions.length, 1);
    assert.equal(savedOrg.divisions[0].specialists.length, 1);
    assert.equal(savedOrg.divisions[0].agentId, chartOrg.divisions[0].agentId);
    assert.equal(savedOrg.divisions[0].specialists[0].agentId, chartOrg.divisions[0].specialists[0].agentId);

    const localizedRoot = path.join(tempDir, "localized-agent");
    writeFile(path.join(localizedRoot, "AGENTS.md"), "# 증거 분석가\n\n증거를 분석합니다.\n");
    writeFile(path.join(localizedRoot, "agentlas.json"), JSON.stringify({
      name: "증거 분석가",
      localized: {
        titleEn: "Evidence Analyst",
        titleKo: "증거 분석가",
        descriptionEn: "Analyzes evidence with explicit source boundaries.",
        descriptionKo: "출처 경계를 명확히 하며 증거를 분석합니다.",
      },
    }, null, 2));
    const localizedImport = await importLocalFolder(localizedRoot);
    assert.equal(localizedImport.agent.name, "증거 분석가");
    assert.equal(localizedImport.agent.nameEn, "Evidence Analyst", "packaged bilingual metadata must survive local import");
    assert.equal(localizedImport.agent.taglineEn, "Analyzes evidence with explicit source boundaries.");

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
    assert.ok(team.firmId, "team import receipt must include the durable firm projection");
    assert.equal(team.agent.name, "Proof Founder Team");
    assert.equal(team.agent.localPath, teamRoot);
    assert.equal(
      getDb().prepare("SELECT entity_kind FROM installed_agents WHERE id = ?").get(team.agent.id).entity_kind,
      "team",
      "team kind must survive even if the route projection is unavailable",
    );
    assert.ok(listRoutes().some((route) => route.agentId === team.agent.id && route.path === teamRoot && route.kind === "team"));
    const teamFirms = listFirms();
    assert.ok(teamFirms.some((firm) => firm.slug === `firm-${team.agent.slug}` && firm.ceoAgentId === team.agent.id));
    const flatFirm = getFirmBySlug(`firm-${team.agent.slug}`);
    assert.ok(flatFirm);
    const flatCeo = flatFirm.orgChart.find((node) => node.reportsTo === null);
    const flatMembers = flatFirm.orgChart.filter((node) => node.reportsTo === flatCeo.agentSlug);
    assert.equal(flatMembers.length, 2, "a blueprint without hierarchy must keep its genuine flat shape");
    assert.equal(
      flatFirm.orgChart.some((node) => flatMembers.some((member) => node.reportsTo === member.agentSlug)),
      false,
      "flat fallback must not invent HQ nesting",
    );

    const concurrentRoot = path.join(tempDir, "concurrent-agent");
    writeFile(path.join(concurrentRoot, "AGENT.md"), "# Concurrent Agent\n\nSingle-flight import proof.\n");
    const [concurrentA, concurrentB] = await Promise.all([
      importLocalFolder(concurrentRoot),
      importLocalFolder(concurrentRoot),
    ]);
    assert.equal(concurrentA.agent.id, concurrentB.agent.id, "concurrent import requests must share one durable commit");

    const danglingRoot = path.join(tempDir, "dangling-route-agent");
    writeFile(path.join(danglingRoot, "AGENT.md"), "# Dangling Route Agent\n\nRepair an orphaned route.\n");
    setRoute({ agentId: "missing-agent-row", path: danglingRoot, runtime: "codex", labels: ["codex"], kind: "agent", importedAt: new Date().toISOString() });
    const repaired = await importLocalFolder(danglingRoot);
    assert.notEqual(repaired.agent.id, "missing-agent-row");
    assert.equal(listRoutes().some((route) => route.agentId === "missing-agent-row"), false, "successful import must remove the dangling route identity");

    fs.rmSync(path.join(teamRoot, "TEAM.md"), { force: true });
    fs.rmSync(path.join(teamRoot, "ceo"), { recursive: true, force: true });
    fs.rmSync(path.join(teamRoot, "agents"), { recursive: true, force: true });
    writeFile(path.join(teamRoot, "AGENT.md"), "# Proof Founder Team\n\nNow intentionally a single agent.\n");
    const convertedSingle = await importLocalFolder(teamRoot);
    assert.equal(convertedSingle.agent.id, team.agent.id, "team-to-single conversion must preserve the owned agent identity");
    assert.equal(convertedSingle.kind, "agent");
    assert.equal(getFirmBySlug(`firm-${team.agent.slug}`), null, "team-to-single conversion must remove the stale firm projection");

    // A deleted source folder must be REPORTED, not silently ignored. Before
    // this, the reconcile pass only counted the failure, so an agent whose
    // folder was gone (e.g. imported from trash/ and later emptied) stayed in
    // the roster forever with no explanation and no repair path.
    const vanishRoot = path.join(tempDir, "vanishing-agent");
    writeFile(path.join(vanishRoot, "AGENTS.md"), "# Vanishing Agent\n\nIts folder will be deleted.\n");
    const vanish = await importLocalFolder(vanishRoot);
    assert.equal(listRoutes().find((r) => r.agentId === vanish.agent.id).missingSince, undefined);
    fs.rmSync(vanishRoot, { recursive: true, force: true });
    const gone = reconcileLocalRouteDefinitionHashes();
    assert.ok(gone.missing >= 1, "a deleted source folder must be counted as missing");
    const goneRoute = listRoutes().find((r) => r.agentId === vanish.agent.id);
    assert.ok(goneRoute.missingSince, "a deleted source folder must be marked with missingSince");
    // Never auto-delete: absence can be temporary (external disk, cloud sync).
    assert.ok(
      getDb().prepare("SELECT 1 FROM installed_agents WHERE id = ?").get(vanish.agent.id),
      "a missing folder must never silently delete the user's agent",
    );
    // Restoring the folder must clear the mark without user action.
    writeFile(path.join(vanishRoot, "AGENTS.md"), "# Vanishing Agent\n\nIts folder will be deleted.\n");
    reconcileLocalRouteDefinitionHashes();
    assert.equal(
      listRoutes().find((r) => r.agentId === vanish.agent.id).missingSince,
      undefined,
      "a recovered folder must clear the missing mark",
    );

    const routes = listRoutes();
    assert.ok(routes.some((route) => route.agentId === single.agent.id && route.path === agentRoot && route.kind === "agent"));
    assert.ok(routes.some((route) => route.agentId === team.agent.id && route.path === teamRoot && route.kind === "agent"));

    const firms = listFirms();

    const beforeJunkFirmCount = listFirms().length;
    const junkRoot = path.join(tempDir, "trash");
    writeFile(path.join(junkRoot, "AGENT.md"), "# Trash Agent\n\nA valid root definition for the loose-agent guard.\n");
    writeFile(path.join(junkRoot, "alpha", "AGENT.md"), "# Alpha\n\nFirst loose agent.\n");
    writeFile(path.join(junkRoot, "beta", "AGENT.md"), "# Beta\n\nSecond loose agent.\n");
    const junk = await importLocalFolder(junkRoot);
    assert.equal(junk.kind, "agent", "junk container folders must not become teams without explicit team markers");
    assert.equal(junk.agent.name, "Trash Agent");
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
          firms: teamFirms.length,
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
