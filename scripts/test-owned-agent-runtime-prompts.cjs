#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const SKILL_SLUG = "runtime-prompt-proof";
const SKILL_CONTENT = [
  "---",
  `name: ${SKILL_SLUG}`,
  "description: Exact runtime prompt capture proof",
  "---",
  "",
  "# Runtime Prompt Proof",
  "",
  "RUNTIME_SKILL_EXACT_BYTES_7F13",
  "",
].join("\n");
const OWNER_CANONICAL = "# Canonical Owner\n\nCANONICAL_OWNER_PROMPT_EXACT_91C2\n";
const WORKER_CANONICAL = "# Canonical Worker\n\nCANONICAL_WORKER_PROMPT_EXACT_6A44\n";
const NESTED_CANONICAL = "# Nested Restored Owner\n\nNESTED_RESTORED_PROMPT_EXACT_A73D\n";
const NESTED_ROOT_FALLBACK = "# Wrong root fallback\n\nNESTED_ROOT_FALLBACK_MUST_NOT_RUN_F220\n";
const OWNER_STALE_DB = "STALE_DB_OWNER_PROMPT_MUST_NOT_RUN_41E8";
const WORKER_STALE_DB = "STALE_DB_WORKER_PROMPT_MUST_NOT_RUN_2B07";
const NESTED_STALE_DB = "STALE_DB_NESTED_PROMPT_MUST_NOT_RUN_8E19";
const CORE_STORMBREAKER_PROMPT = [
  "You are executing inside the Agentlas-owned STORMBREAKER GOAL + ULTRACODE HARNESS.",
  "GOAL MODE: maintain the goal, constraints, acceptance checks, owners, and unfinished packets until verified completion.",
  "ULTRACODE MODE: inspect real files/state, plan before mutation, implement the smallest complete change, run relevant tests, repair concrete failures, and preserve unrelated work.",
  "CORE_HARNESS_FIXTURE_EXACT_3C91",
].join("\n");
const CORE_STORMBREAKER_HARNESS = {
  schema_version: "agentlas.stormbreaker.goal-ultracode-harness.v1",
  harness_id: "agentlas-core/stormbreaker-goal-ultracode",
  owner: "Agentlas Core",
  mode: "stormbreaker-goal-ultracode",
  system_prompt: CORE_STORMBREAKER_PROMPT,
  prompt_sha256: createHash("sha256").update(CORE_STORMBREAKER_PROMPT).digest("hex"),
  host_rule: "fixture",
  inventory_rule: "fixture",
  completion_rule: "fixture",
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-owned-runtime-prompts-"));
const userData = path.join(temp, "user-data");
const hephaestusRoot = path.join(temp, "hephaestus-runtime");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(path.join(hephaestusRoot, "agentlas_cloud"), { recursive: true });
fs.mkdirSync(path.join(hephaestusRoot, "skills", SKILL_SLUG), { recursive: true });
fs.writeFileSync(
  path.join(hephaestusRoot, "agentlas_cloud", "__main__.py"),
  [
    "import sys",
    "if sys.argv[1:3] == ['stormbreaker', 'harness']:",
    `    print(${JSON.stringify(JSON.stringify(CORE_STORMBREAKER_HARNESS))})`,
  ].join("\n"),
  "utf8",
);
fs.writeFileSync(path.join(hephaestusRoot, "skills", SKILL_SLUG, "SKILL.md"), SKILL_CONTENT, "utf8");

process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.HEPHAESTUS_RUNTIME_ROOT = hephaestusRoot;
process.env.AGENTLAS_RUNTIME_DETECT_CACHE_MS = "0";
app.setPath("userData", userData);

function insertAgent(db, input) {
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    input.id,
    input.slug,
    input.name,
    input.name,
    `${input.name} runtime prompt fixture`,
    `${input.name} runtime prompt fixture`,
    input.stalePrompt,
    "2026-07-11T00:00:00.000Z",
  );
}

function occurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = text.indexOf(needle, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function makeV2Package(entries) {
  const files = Object.entries(entries).map(([filePath, text]) => {
    const content = Buffer.from(text, "utf8");
    return {
      path: filePath,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentBase64: content.toString("base64"),
      executable: false,
    };
  });
  const aggregate = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    aggregate.update(file.path);
    aggregate.update("\0");
    aggregate.update(file.sha256);
    aggregate.update("\0");
    aggregate.update("-");
    aggregate.update("\0");
  }
  return {
    packageHash: aggregate.digest("hex"),
    packageHashVersion: "path-sha256-executable-v2",
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    agentKind: "agent",
    runtimeLabels: ["codex"],
    files,
  };
}

function assertOwnedPrompt(capture, input) {
  assert.ok(capture, `${input.label}: RunnerRequest was not captured`);
  assert.equal(
    occurrences(capture.systemPrompt, input.canonical),
    1,
    `${input.label}: canonical package prompt must be present exactly once`,
  );
  assert.doesNotMatch(
    capture.systemPrompt,
    new RegExp(input.staleDb),
    `${input.label}: stale registry fallback must not re-enter the runtime prompt`,
  );
  assert.equal(
    occurrences(capture.systemPrompt, SKILL_CONTENT),
    input.skillActive ? 1 : 0,
    `${input.label}: exact approved skill activation mismatch`,
  );
}

async function main() {
  await app.whenReady();

  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const files = require("../dist/electron/agents/files.js");
  const evolution = require("../dist/electron/agents/evolution.js");
  const skillCatalog = require("../dist/electron/hephaestus/skill-catalog.js");
  const registry = require("../dist/electron/mcp/registry.js");
  const firms = require("../dist/electron/store/firms.js");
  const groups = require("../dist/electron/store/agent-groups.js");
  const chats = require("../dist/electron/store/chats.js");
  const concurrency = require("../dist/electron/store/concurrency.js");

  insertAgent(db, {
    id: "owned-owner",
    slug: "owned-owner",
    name: "Owned Owner",
    stalePrompt: OWNER_STALE_DB,
  });
  insertAgent(db, {
    id: "owned-worker",
    slug: "owned-worker",
    name: "Owned Worker",
    stalePrompt: WORKER_STALE_DB,
  });
  insertAgent(db, {
    id: "owned-nested-entry",
    slug: "owned-nested-entry",
    name: "Owned Nested Entry",
    stalePrompt: NESTED_STALE_DB,
  });
  files.materializeAgentFiles("owned-owner");
  files.materializeAgentFiles("owned-worker");
  files.writeAgentFile("owned-owner", "system-prompt.md", OWNER_CANONICAL);
  files.writeAgentFile("owned-worker", "system-prompt.md", WORKER_CANONICAL);
  // Deliberately leave stale registry fallbacks behind. Every execution path
  // must read the main-owned canonical file and must not append these bytes.
  db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(OWNER_STALE_DB, "owned-owner");
  db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(WORKER_STALE_DB, "owned-worker");

  const nestedPackage = makeV2Package({
    "agentlas.json": `${JSON.stringify({ entry: "agents/ceo/AGENT.md" }, null, 2)}\n`,
    "agents/ceo/AGENT.md": NESTED_CANONICAL,
    "AGENTS.md": NESTED_ROOT_FALLBACK,
  });
  const nestedDir = path.join(userData, "agents", "owned-nested-entry");
  const { restoreCloudAgentPackage } = require("../dist/electron/cloud-agents/restore.js");
  restoreCloudAgentPackage({
    destinationDir: nestedDir,
    slug: "owned-nested-entry",
    package: nestedPackage,
    restoredAt: "2026-07-11T00:00:00.000Z",
  });
  const routes = require("../dist/electron/agents/routes.js");
  routes.setRoute({
    agentId: "owned-nested-entry",
    path: nestedDir,
    runtime: "codex",
    labels: ["codex"],
    kind: "agent",
    importedAt: "2026-07-11T00:00:00.000Z",
    source: "agent-cloud",
    packageHash: nestedPackage.packageHash,
  });

  const owner = registry.getAgentById("owned-owner");
  const worker = registry.getAgentById("owned-worker");
  const nestedOwner = registry.getAgentById("owned-nested-entry");
  assert.ok(owner && worker && nestedOwner, "owned prompt fixtures must resolve from the real registry");
  assert.equal(owner.systemPrompt, OWNER_STALE_DB, "fixture must prove the DB fallback is stale");
  assert.equal(worker.systemPrompt, WORKER_STALE_DB, "worker fixture must prove the DB fallback is stale");
  concurrency.setAgentConcurrency(1);

  const active = {
    kind: "ollama",
    backend: null,
    source: "runtime-prompt-capture",
    ready: true,
    active: true,
    model: "mock-owned-runtime",
  };
  const captures = [];
  const mockRunner = async (req) => {
    captures.push({
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      chatId: req.chatId,
      permission: req.permission,
    });

    if (req.systemPrompt.includes("## Agentlas Task-Force Orchestrator")) {
      const roster = [...req.userPrompt.matchAll(/^- slug:\s*(.+)$/gm)].map((match) => match[1].trim());
      assert.ok(roster.length > 0, "actual task-force planner prompt must include its live roster");
      const packets = roster.map((slug) => ({
        agent: slug,
        inputType: "review",
        inputKind: "codebase",
        brief: `Verify the owned prompt for ${slug}.`,
        context: ["runtime prompt capture"],
        expectedOutput: "A focused prompt-authority result.",
        constraints: ["Do not synthesize."],
      }));
      return {
        text: `Planner complete.\n\n## Agent Input Packets\n\`\`\`json\n${JSON.stringify(packets)}\n\`\`\``,
      };
    }
    if (req.systemPrompt.includes("## Agentlas Task-Force Agent Host Policy")) {
      return { text: "Owned task-force member completed its packet." };
    }
    if (req.systemPrompt.includes("## Agentlas Task-Force Synthesis")) {
      return { text: "Owned task-force synthesis complete." };
    }
    if (req.systemPrompt.includes("You are one worker in an EMERGENT AGENT SWARM")) {
      return { text: "Owned swarm worker completed the seed task." };
    }
    if (req.systemPrompt.includes("You are the synthesizer of an agent swarm")) {
      return { text: "Owned swarm synthesis complete." };
    }
    if (req.systemPrompt.includes("## Delegation (you orchestrate a team)")) {
      return {
        text: [
          "Delegating to the owned firm specialist.",
          "",
          "## Delegate",
          "```json",
          JSON.stringify([{ target: "QA Specialist", brief: "Verify the firm-node runtime prompt." }]),
          "```",
        ].join("\n"),
      };
    }
    if (req.userPrompt.includes("[Results from your team — synthesize into one final answer for the user]")) {
      return { text: "Owned firm synthesis complete." };
    }
    if (req.systemPrompt.includes("## Firm role context")) {
      return { text: "Owned firm node complete." };
    }
    return { text: "Owned regular chat complete." };
  };
  const picked = { runner: mockRunner, label: "Injected Prompt Capture Runner" };

  // Inject the mock at the runtime boundary before loading the exported client.
  // The exported orchestration functions and all real prompt composers remain intact.
  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  const envResolver = require("../dist/electron/runtime/env-resolver.js");
  const stormbreaker = require("../dist/electron/hephaestus/stormbreaker-supervisor.js");
  detect.detectRuntimes = async () => [active];
  selection.selectRuntimeForTargets = () => ({
    active,
    picked,
    override: null,
    unavailableOverride: null,
  });
  selection.pickRunner = () => picked;
  envResolver.buildRunnerEnv = async () => ({ env: {}, injectedKeys: [] });
  stormbreaker.superviseStormbreaker = () => null;

  // Agent Group resolution must remain local and deterministic for this test.
  const marketplace = require("../dist/electron/marketplace/index.js");
  marketplace.getSource = () => ({ searchAgents: async () => [] });

  const client = require("../dist/electron/mcp/client.js");
  const invoke = async (chatId, userPrompt) => {
    const events = [];
    const result = await client.runMcpInvocation(
      { chatId, userPrompt, locale: "en", permissions: "read" },
      (event) => events.push(event),
    );
    const errors = events.filter((event) => event.kind === "error");
    assert.deepEqual(errors, [], `invocation ${userPrompt} must not emit an error`);
    assert.ok(events.some((event) => event.kind === "final"), `invocation ${userPrompt} must finish`);
    return { result, events };
  };

  const catalogAsset = skillCatalog.readSkillCatalogAsset(SKILL_SLUG);
  assert.equal(catalogAsset.content, SKILL_CONTENT, "catalog fixture must preserve exact bytes");
  assert.equal(
    catalogAsset.contentHash,
    createHash("sha256").update(SKILL_CONTENT, "utf8").digest("hex"),
  );
  const createSkillCandidate = (agentId) => evolution.createAgentEvolutionProposal({
    agentId,
    targetPath: `skills/${SKILL_SLUG}/SKILL.md`,
    currentContent: "",
    proposedContent: catalogAsset.content,
    proposalType: "skill",
    risk: "low",
    summary: "Activate the exact runtime prompt proof skill",
    source: {
      surface: "runtime-prompt-capture-test",
      skillSlug: SKILL_SLUG,
      catalogContentHash: catalogAsset.contentHash,
    },
  });

  const regularChat = chats.createChat({ agentId: owner.id, title: "Regular prompt capture" });
  const nestedChat = chats.createChat({ agentId: nestedOwner.id, title: "Nested restored prompt capture" });
  await invoke(nestedChat.id, "nested-restored-entry");
  const nestedCapture = captures.at(-1);
  assertOwnedPrompt(nestedCapture, {
    label: "restored nested entry regular invocation",
    canonical: NESTED_CANONICAL,
    staleDb: NESTED_STALE_DB,
    skillActive: false,
  });
  assert.equal(
    nestedCapture.systemPrompt.includes(NESTED_ROOT_FALLBACK),
    false,
    "agentlas.json.entry must beat a root canonical fallback during the actual invocation",
  );
  const ownerSkillCandidate = createSkillCandidate(owner.id);
  assert.equal(ownerSkillCandidate.status, "candidate");
  assert.equal(
    fs.existsSync(path.join(userData, "agents", owner.slug, "skills", SKILL_SLUG, "SKILL.md")),
    false,
    "candidate review state must not activate the skill file",
  );
  await invoke(regularChat.id, "regular-before-approval");
  const regularBefore = captures.at(-1);
  assertOwnedPrompt(regularBefore, {
    label: "regular chat before approval",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: false,
  });

  const ownerApplied = evolution.approveAndApplyAgentEvolutionProposal(ownerSkillCandidate.id, "Runtime capture QA approval");
  const workerCandidate = createSkillCandidate(worker.id);
  const workerApplied = evolution.approveAndApplyAgentEvolutionProposal(workerCandidate.id, "Firm/group runtime QA approval");
  assert.equal(ownerApplied.status, "applied");
  assert.equal(workerApplied.status, "applied");
  await invoke(regularChat.id, "regular-after-approval");
  const regularAfter = captures.at(-1);
  assertOwnedPrompt(regularAfter, {
    label: "regular chat after approval",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });

  const firm = firms.upsertLocalTeamFirm({
    slug: "runtime-prompt-firm",
    name: "Runtime Prompt Firm",
    tagline: "Exercises a real firm-node execution path",
    ceoAgentId: owner.id,
    orgChart: [
      { agentSlug: owner.slug, role: "CEO", reportsTo: null, agentId: owner.id },
      { agentSlug: "runtime-qa-division", role: "QA Division", reportsTo: owner.slug, agentId: owner.id },
      { agentSlug: worker.slug, role: "QA Specialist", reportsTo: "runtime-qa-division", agentId: worker.id },
    ],
  });
  const firmChat = chats.createChat({ firmId: firm.id, title: "Firm prompt capture" });
  const firmStart = captures.length;
  await invoke(firmChat.id, "firm-node-runtime-prompt");
  const firmCaptures = captures.slice(firmStart);
  const firmPlan = firmCaptures.find((capture) => capture.systemPrompt.includes("## Delegation (you orchestrate a team)"));
  const firmWorker = firmCaptures.find((capture) => capture.systemPrompt.includes("## Firm role context") && capture.systemPrompt.includes(WORKER_CANONICAL));
  const firmSynthesis = firmCaptures.find((capture) => capture.userPrompt.includes("[Results from your team — synthesize into one final answer for the user]"));
  assertOwnedPrompt(firmPlan, {
    label: "firm CEO planner",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });
  assertOwnedPrompt(firmWorker, {
    label: "firm owned specialist",
    canonical: WORKER_CANONICAL,
    staleDb: WORKER_STALE_DB,
    skillActive: true,
  });
  assertOwnedPrompt(firmSynthesis, {
    label: "firm CEO synthesis",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });

  const group = groups.createAgentGroup({
    name: "Owned Runtime Group",
    description: "Saved group prompt capture",
    orchestratorName: "Owned Runtime Group Orchestrator",
    members: [{
      id: "owned-worker-member",
      source: "installed",
      agentId: worker.id,
      agentSlug: worker.slug,
      addedAt: "2026-07-11T00:00:00.000Z",
      snapshot: {
        name: worker.name,
        nameEn: worker.nameEn,
        tagline: worker.tagline,
        taglineEn: worker.taglineEn,
        routeLabel: "Installed",
        trustGrade: worker.trustGrade,
        entityKind: "agent",
      },
    }],
  });
  const groupChat = chats.createChat({
    agentId: owner.id,
    agentGroupId: group.id,
    title: "Saved group prompt capture",
  });
  const groupStart = captures.length;
  await invoke(groupChat.id, "saved-agent-group-runtime-prompt");
  const groupCaptures = captures.slice(groupStart);
  const groupPlanner = groupCaptures.find((capture) => capture.systemPrompt.includes("## Agentlas Task-Force Orchestrator"));
  const groupWorker = groupCaptures.find((capture) => capture.systemPrompt.includes("## Agentlas Task-Force Agent Host Policy"));
  const groupSynthesis = groupCaptures.find((capture) => capture.systemPrompt.includes("## Agentlas Task-Force Synthesis"));
  assertOwnedPrompt(groupPlanner, {
    label: "saved Agent Group planner",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });
  assertOwnedPrompt(groupWorker, {
    label: "saved Agent Group owned member",
    canonical: WORKER_CANONICAL,
    staleDb: WORKER_STALE_DB,
    skillActive: true,
  });
  assert.match(groupWorker.systemPrompt, /Current route: Installed/, "owned group member must keep its resolved route");
  assertOwnedPrompt(groupSynthesis, {
    label: "saved Agent Group synthesis",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });

  const swarmChat = chats.createChat({ agentId: owner.id, title: "Swarm prompt capture" });
  chats.setChatSwarmMode(swarmChat.id, true);
  const swarmStart = captures.length;
  await invoke(swarmChat.id, "swarm-runtime-prompt");
  const swarmCaptures = captures.slice(swarmStart);
  const swarmWorker = swarmCaptures.find((capture) => capture.systemPrompt.includes("You are one worker in an EMERGENT AGENT SWARM"));
  const swarmSynthesis = swarmCaptures.find((capture) => capture.systemPrompt.includes("You are the synthesizer of an agent swarm"));
  assertOwnedPrompt(swarmWorker, {
    label: "swarm owned worker",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });
  assert.match(swarmWorker.systemPrompt, /SHARED GOAL: swarm-runtime-prompt/, "worker must retain dynamic swarm protocol");
  assertOwnedPrompt(swarmSynthesis, {
    label: "swarm synthesis",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });
  assert.match(swarmSynthesis.systemPrompt, /Integrate them into ONE coherent final answer/, "synthesis must retain dynamic synthesis policy");

  const stormChat = chats.createChat({ agentId: owner.id, title: "Stormbreaker prompt capture" });
  const stormStart = captures.length;
  const stormInvocation = await invoke(stormChat.id, "stormbreaker verify the runtime harness and finish the goal");
  const stormCaptures = captures.slice(stormStart);
  const stormWorker = stormCaptures.find((capture) => capture.systemPrompt.includes("Agentlas-owned STORMBREAKER GOAL + ULTRACODE HARNESS"));
  const stormSynthesis = stormCaptures.find((capture) =>
    capture.systemPrompt.includes("You are the synthesizer of an agent swarm") &&
    capture.systemPrompt.includes("CORE_HARNESS_FIXTURE_EXACT_3C91"),
  );
  assertOwnedPrompt(stormWorker, {
    label: "Stormbreaker owned worker",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });
  assert.equal(occurrences(stormWorker.systemPrompt, CORE_STORMBREAKER_PROMPT), 1, "Stormbreaker worker must receive the exact Core harness once");
  assert.equal(occurrences(stormWorker.systemPrompt, "GOAL MODE:"), 1, "Desktop must not redefine Core Goal mode");
  assert.equal(occurrences(stormWorker.systemPrompt, "ULTRACODE MODE:"), 1, "Desktop must not redefine Core UltraCode mode");
  assert.match(stormWorker.systemPrompt, /Agentlas Desktop host extension/, "Stormbreaker worker must retain only the Desktop continuation extension");
  assertOwnedPrompt(stormSynthesis, {
    label: "Stormbreaker synthesis",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: true,
  });
  assert.equal(occurrences(stormSynthesis.systemPrompt, CORE_STORMBREAKER_PROMPT), 1, "Stormbreaker synthesis must receive the exact Core harness once");
  const visibleStormStatuses = stormInvocation.events
    .filter((event) => event.kind === "thinking" && event.agentName === "Stormbreaker")
    .map((event) => event.status || "");
  assert.ok(visibleStormStatuses.length >= 5, "Stormbreaker must expose a concise visible execution narrative");
  assert.ok(visibleStormStatuses.some((status) => /goal|목표/i.test(status)));
  assert.ok(visibleStormStatuses.some((status) => /runtime|런타임/i.test(status)));
  assert.ok(visibleStormStatuses.some((status) => /model|모델/i.test(status)));
  assert.ok(visibleStormStatuses.some((status) => /final-gate|최종 게이트/i.test(status)));
  assert.equal(stormInvocation.events.some((event) => event.agentName === "Stormbreaker" && event.done === true), true);

  const rolledBack = evolution.rollbackAgentEvolutionProposal(ownerSkillCandidate.id);
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(
    fs.existsSync(path.join(userData, "agents", owner.slug, "skills", SKILL_SLUG, "SKILL.md")),
    false,
    "rollback of an originally absent skill must remove the runtime asset",
  );
  await invoke(regularChat.id, "regular-after-rollback");
  const regularRolledBack = captures.at(-1);
  assertOwnedPrompt(regularRolledBack, {
    label: "regular chat after rollback",
    canonical: OWNER_CANONICAL,
    staleDb: OWNER_STALE_DB,
    skillActive: false,
  });

  console.log(JSON.stringify({
    ok: true,
    captures: captures.length,
    paths: {
      regular: 3,
      firm: firmCaptures.length,
      savedAgentGroupTaskForce: groupCaptures.length,
      swarm: swarmCaptures.length,
      stormbreaker: stormCaptures.length,
    },
    candidateAbsent: true,
    exactSkillActiveAfterApproval: true,
    rollbackRemovedSkill: true,
    canonicalFallbackLeak: false,
    dynamicSwarmProtocolsRetained: true,
    stormbreakerGoalUltraCodeHarnessRetained: true,
    stormbreakerVisibleThinkingNarrative: true,
  }, null, 2));

  fs.rmSync(temp, { recursive: true, force: true });
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      // Best-effort fixture cleanup.
    }
    app.exit(1);
  });
