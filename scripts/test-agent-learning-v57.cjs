#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-learning-v57-"));
app.setPath("userData", temp);
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

function memoryReply(content) {
  return [
    "Completed.",
    "",
    "## Memory Events",
    "```json",
    JSON.stringify([{
      memory_kind: "procedure",
      content,
      suggested_scope: "agent_repo",
      confidence: "high",
      sensitivity: "internal",
      evidence_refs: ["run:test-v57"],
      request_context: { user_intent: "Debug the API workflow", trigger_terms: ["debug", "api"] },
    }]),
    "```",
  ].join("\n");
}

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  try {
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(process.env.AGENTLAS_STORE_PATH).mode & 0o077, 0, "private store must be 0600");
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${process.env.AGENTLAS_STORE_PATH}${suffix}`;
        if (fs.existsSync(sidecar)) assert.equal(fs.statSync(sidecar).mode & 0o077, 0, `${suffix} must be private`);
      }
    }
    const now = new Date().toISOString();
    const insertAgent = db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
    );
    insertAgent.run("agent-orchestrator", "agentlas-orchestrator", "Orchestrator", "Orchestrator", "Routes", "Routes", "Route work.", now);
    insertAgent.run("agent-worker", "debug-worker", "Debug Worker", "Debug Worker", "Debugs", "Debugs", "Debug safely.", now);

    const routes = require("../dist/electron/agents/routes.js");
    const files = require("../dist/electron/agents/files.js");
    const baseHash = "a".repeat(64);
    const workerRoot = path.join(temp, "worker");
    fs.mkdirSync(workerRoot, { recursive: true });
    fs.writeFileSync(path.join(workerRoot, "AGENT.md"), "# Debug Worker\n", "utf8");
    routes.setRoute({
      agentId: "agent-worker",
      path: workerRoot,
      runtime: "codex",
      labels: ["codex"],
      kind: "agent",
      importedAt: now,
      source: "local-import",
      packageHash: baseHash,
    });
    files.materializeAgentFiles("agent-orchestrator");
    files.writeAgentFile("agent-orchestrator", "system-prompt.md", "# Orchestrator\n");
    files.writeAgentFile("agent-worker", "memory.md", [
      "# Memory",
      "## Decisions",
      "- **Use retries**: Retry idempotently.",
      "## Gotchas",
      "- **No guessing**: Keep attribution exact.",
      "",
    ].join("\n"));

    const registry = require("../dist/electron/mcp/registry.js");
    const worker = registry.getAgentById("agent-worker");
    assert.ok(worker?.packageHash === baseHash);

    const active = {
      kind: "ollama", backend: null, source: "v57-test", ready: true, active: true,
      model: "mock-v57", longContextEnabled: false,
    };
    let firmMode = false;
    const runner = async () => ({
      text: memoryReply(firmMode
        ? "Debug firm API failures with a bounded retry procedure."
        : "Debug API failures with an idempotent retry procedure."),
      sessionId: firmMode ? undefined : "session-v57-auto-route",
      tokens: 12,
    });
    const picked = { runner, label: "V57 Test Runner" };
    const detect = require("../dist/electron/runtime/detect.js");
    const selection = require("../dist/electron/runtime/selection.js");
    const envResolver = require("../dist/electron/runtime/env-resolver.js");
    detect.detectRuntimes = async () => [active];
    selection.selectRuntimeForTargets = () => ({ active, picked, override: null, unavailableOverride: null });
    envResolver.buildRunnerEnv = async () => ({ env: {}, injectedKeys: [] });
    const autoRouter = require("../dist/electron/agents/auto-router.js");
    autoRouter.selectAutoRoutedAgent = () => ({ agent: worker, score: 100, reason: "test exact route", matchedTerms: ["debug"] });
    const compaction = require("../dist/electron/memory/compaction-harvest.js");
    let compactionCtx = null;
    compaction.harvestCompactionSummaries = (input) => {
      compactionCtx = input.ctx;
      return { scanned: 0, curated: 0 };
    };

    const chats = require("../dist/electron/store/chats.js");
    const chat = chats.createChat({ agentId: "agent-orchestrator", title: "Attribution" });
    const { invocationService } = require("../dist/electron/invocation/service.js");
    const terminal = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("invocation timed out")), 5_000);
      const off = invocationService.onEvent(({ event }) => {
        if (event.kind === "final" || event.kind === "error") {
          clearTimeout(timeout);
          off();
          event.kind === "error" ? reject(new Error(event.error?.message || "run failed")) : resolve(event);
        }
      });
    });
    // 00768a3 governed-memory boundary: read-permission turns are memory
    // read-only (no durable curation). Interactive learning is asserted under
    // write authority; the read/restricted boundaries keep their own asserts.
    const started = invocationService.start({ chatId: chat.id, userPrompt: "Debug the API retry failure", locale: "en", permissions: "write" });
    const finalEvent = await terminal;
    assert.equal(finalEvent.runtimeAgentId, "agent-worker");
    assert.equal(compactionCtx?.agentId, "agent-worker", "compaction must use the actual auto-routed executor");

    const workerMemory = db.prepare("SELECT * FROM memory_entries WHERE agent_id = ? ORDER BY created_at").all("agent-worker");
    assert.equal(workerMemory.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = ?").get("agent-orchestrator").n, 0);
    const terminalRows = db.prepare(
      "SELECT kind, agent_id FROM run_events WHERE run_id = ? AND kind IN ('mcp_final','invoke_completed') ORDER BY seq",
    ).all(started.runId);
    assert.ok(terminalRows.length >= 2);
    assert.ok(terminalRows.every((row) => row.agent_id === "agent-worker"));

    const experience = require("../dist/electron/experience/store.js");
    let ontology = experience.getExperienceOntologySummary("agent-worker");
    assert.equal(ontology.autoIntake.candidateCreated, 1);
    // v74: a successful interactive turn with a durable invoke_started receipt
    // outcome-promotes its own candidates via 'local-run-receipt'. Intake alone
    // still never promotes — the promotion evidence must be the run ledger.
    assert.equal(ontology.promotedCount, 1, "durable-receipt interactive run must outcome-promote");
    const autoPack = db.prepare("SELECT * FROM experience_packs WHERE agent_id = ? AND auto_managed = 1").get("agent-worker");
    assert.ok(autoPack);
    const autoCandidate = db.prepare("SELECT * FROM experience_candidates WHERE pack_id = ?").get(autoPack.id);
    assert.equal(autoCandidate.status, "promoted");
    assert.equal(autoCandidate.public_safe, 0, "outcome promotion must never mark public-safe");
    const candidateTasks = JSON.parse(autoCandidate.task_terms_json);
    assert.ok(candidateTasks.includes("agentlas.task.v1/debugging"));
    assert.ok(candidateTasks.every((task) => /^agentlas\.task\.v1\/[a-z0-9-]+$/.test(task)));
    const autoPromotionReceipts = db.prepare("SELECT * FROM experience_promotion_receipts").all();
    assert.equal(autoPromotionReceipts.length, 1);
    assert.equal(autoPromotionReceipts[0].verification_method, "local-run-receipt");
    assert.equal(autoPromotionReceipts[0].verification_status, "attested");
    assert.equal(autoPromotionReceipts[0].public_safe, 0);
    assert.equal(
      db.prepare(
        "SELECT run_id FROM experience_auto_intake_receipts WHERE candidate_id = ?",
      ).get(autoCandidate.id).run_id,
      started.runId,
      "intake receipts must link candidates to the durable run that created them",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_export_intents").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM experience_cloud_uploads").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_evolution_proposals").get().n, 0);

    const curator = require("../dist/electron/memory/curator.js");
    const intakeContext = {
      projectPath: null,
      projectId: null,
      agentId: "agent-worker",
      chatId: chat.id,
      experienceIntake: {
        platform: process.platform,
        arch: process.arch,
        runtimeKind: active.kind,
        basePackageHash: baseHash,
        taskHint: "Debug API files",
      },
    };
    const privateLocationReport = curator.curateEvents([{
      memory_kind: "risk",
      content: "Debug by reading /Users/operator/private/customer@example.com before retrying.",
      suggested_scope: "agent_repo",
      confidence: "high",
      sensitivity: "internal",
      evidence_refs: [],
    }], intakeContext);
    curator.curateEvents([{
      memory_kind: "preference",
      content: "Prefer concise debugging summaries.",
      suggested_scope: "agent_repo",
      confidence: "high",
      sensitivity: "internal",
      evidence_refs: [],
    }], intakeContext);
    ontology = experience.getExperienceOntologySummary("agent-worker");
    assert.equal(privateLocationReport.sessionOnly, 1, "machine-specific memory without a project must not persist");
    assert.equal(ontology.autoIntake.blocked, 0, "session-only memory must never reach Experience intake");
    assert.equal(ontology.autoIntake.skipped, 1);
    assert.equal(ontology.tasteDraftCount, 1);
    assert.equal(ontology.tasteNeedsEvidenceCount, 1);
    assert.equal(ontology.tasteUnclassifiedCount, 1);
    assert.ok(ontology.autoIntake.reasons.some((row) => row.code === "preference-captured-as-private-taste-draft"));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE content LIKE '%/Users/%' OR content LIKE '%@example.com%'").get().n,
      0,
      "machine paths and identifiers must not be written before Experience intake",
    );

    firmMode = true;
    const firm = require("../dist/electron/mcp/firm-orchestrator.js");
    const firmChat = chats.createChat({ agentId: "agent-worker", title: "Firm attribution" });
    const firmEvents = [];
    await firm.runFirmInvocation({
      req: { runId: "firm-learning-v57", chatId: firmChat.id, userPrompt: "Debug the firm API", locale: "en", permissions: "write" },
      chat: { id: firmChat.id, projectId: null, firmId: null },
      org: {
        source: "resolver",
        ceo: { id: "org-node-not-agent-id", agentId: "agent-worker", name: "Worker Node", role: "CEO" },
        divisions: [],
      },
      ceoAgent: worker,
      active,
      runtimes: [active],
      picked,
      locale: "en",
      sink: (event) => firmEvents.push(event),
    });
    assert.ok(firmEvents.some((event) => event.agentId === "org-node-not-agent-id" && event.runtimeAgentId === "agent-worker"));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = 'org-node-not-agent-id'").get().n,
      0,
      "firm org-node ids must not own installed-agent Memory",
    );
    assert.ok(
      db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = 'agent-worker'").get().n >= 3,
      "portable procedure, preference, and firm learning must persist while the machine-specific item remains session-only",
    );

    const memoryAfterInteractiveFirmRead = db.prepare(
      "SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = 'agent-worker'",
    ).get().n;
    const restrictedFirmChat = chats.createChat({
      agentId: "agent-worker",
      title: "Restricted firm attribution",
    });
    const restrictedFirmEvents = [];
    await firm.runFirmInvocation({
      req: {
        runId: "restricted-firm-learning-v57",
        chatId: restrictedFirmChat.id,
        userPrompt: "Inspect without learning from this unattended read",
        locale: "en",
        permissions: "read",
      },
      chat: { id: restrictedFirmChat.id, projectId: null, firmId: null },
      org: {
        source: "resolver",
        ceo: { id: "restricted-org-node", agentId: "agent-worker", name: "Restricted Node", role: "CEO" },
        divisions: [],
      },
      ceoAgent: worker,
      active,
      runtimes: [active],
      picked,
      locale: "en",
      restrictedReadBoundary: true,
      sink: (event) => restrictedFirmEvents.push(event),
    });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = 'agent-worker'").get().n,
      memoryAfterInteractiveFirmRead,
      "restricted firm reads must remain ephemeral",
    );
    assert.equal(
      restrictedFirmEvents.some((event) => /## Memory Events/.test(event.text ?? "")),
      false,
      "restricted firm replies must strip memory controls before reaching the UI",
    );

    curator.curateReply("Completed without a durable learning event.", {
      ...intakeContext,
      runId: "no-memory-learning-v57",
    });

    // v53 and earlier kept the selected agent on chats but did not persist the
    // executor on run_events. Surface that exact relation as legacy chat-linked
    // activity without rewriting history or calling it executor proof.
    const legacyChat = chats.createChat({ agentId: "agent-worker", title: "Legacy exact chat link" });
    db.prepare(
      `INSERT INTO run_events (id, run_id, seq, ts, kind, chat_id, automation_id, node_id, agent_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '{}')`,
    ).run("legacy-linked-event", "legacy-linked-run", 1, now, "invoke_completed", legacyChat.id);
    db.prepare(
      `INSERT INTO failure_events (id, run_id, ts, source, chat_id, automation_id, node_id, agent_id, error_code, error_message, payload_json)
       VALUES (?, ?, ?, 'legacy-test', ?, NULL, NULL, NULL, 'legacy_failure', 'legacy linked failure', '{}')`,
    ).run("legacy-linked-failure", "legacy-linked-run", now, legacyChat.id);

    const ambiguousChat = chats.createChat({ agentId: "agent-worker", title: "Legacy conflicting executor" });
    const insertLegacyEvent = db.prepare(
      `INSERT INTO run_events (id, run_id, seq, ts, kind, chat_id, automation_id, node_id, agent_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, '{}')`,
    );
    insertLegacyEvent.run("legacy-ambiguous-null", "legacy-ambiguous-run", 1, now, "invoke_completed", ambiguousChat.id, null);
    insertLegacyEvent.run("legacy-ambiguous-direct", "legacy-ambiguous-run", 2, now, "invoke_completed", ambiguousChat.id, "agent-orchestrator");
    insertLegacyEvent.run("legacy-unattributed", "legacy-unattributed-run", 1, now, "invoke_completed", null, null);

    const learning = require("../dist/electron/agents/learning-summary.js");
    const summary = await learning.getAgentLearningSummary("agent-worker");
    assert.equal(summary.runCount, 1);
    assert.ok(summary.lastRunAt);
    assert.equal(summary.legacyChatLinkedRunCount, 1, "one exact legacy chat relation should be visible");
    assert.equal(summary.legacyChatLinkedLastRunAt, now);
    assert.equal(summary.legacyChatLinkedFailureCount, 1);
    assert.equal(summary.legacyUnattributedCount, 1, "only the no-chat legacy run remains globally unattributed");
    assert.ok(summary.durableMemoryCount >= 3);
    assert.equal(summary.curationTurnCount, 4);
    assert.equal(summary.noNewMemoryTurnCount, 2);
    assert.equal(summary.memoryEventCount, 3);
    assert.equal(summary.memoryWrittenCount, 2);
    assert.equal(summary.memoryDedupedCount, 0);
    assert.equal(summary.memoryRedactedCount, 0);
    assert.equal(summary.memorySessionOnlyCount, 0);
    assert.equal(summary.memoryDiscardedCount, 1);
    const curationReceipts = db.prepare(
      "SELECT payload_json FROM run_events WHERE agent_id = ? AND kind = 'memory_curation' ORDER BY ts",
    ).all("agent-worker");
    assert.equal(curationReceipts.length, 4);
    assert.doesNotMatch(JSON.stringify(curationReceipts), /Debug firm|bounded retry|\/Users\//);
    const curationPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT payload_json FROM run_events WHERE agent_id = ? AND kind = 'memory_curation' ORDER BY ts DESC",
    ).all("agent-worker");
    assert.match(
      JSON.stringify(curationPlan),
      /idx_run_events_agent_kind_ts/,
      "per-agent curation summaries must use the v58 agent-kind index",
    );
    assert.equal(summary.memoryMarkdownCount, 2);
    assert.equal(summary.failureCount, 0);
    assert.equal(summary.evolutionProposalCount, 0);
    assert.ok(summary.localFileCount >= 1);
    assert.ok(summary.localReceiptCount >= 3);

    registry.setAgentLocalDisplayName("agent-worker", "Cafe\u0301 Worker");
    assert.equal(registry.getAgentById("agent-worker").localDisplayName, "Café Worker");
    db.prepare("UPDATE installed_agents SET name = 'Refreshed Source Name' WHERE id = 'agent-worker'").run();
    assert.equal(registry.getAgentById("agent-worker").localDisplayName, "Café Worker", "source refresh must preserve the local alias");
    assert.throws(() => registry.setAgentLocalDisplayName("agent-worker", "bad\u0007name"), /control/i);
    assert.throws(() => registry.setAgentLocalDisplayName("agent-worker", "safe\u202Eeman"), /hidden-direction/i);
    assert.throws(() => registry.setAgentLocalDisplayName("agent-worker", "가".repeat(81)), /80/);
    registry.setAgentLocalDisplayName("agent-worker", "   ");
    assert.equal(registry.getAgentById("agent-worker").localDisplayName, undefined);

    console.log(JSON.stringify({
      ok: true,
      actualAgentId: "agent-worker",
      runs: summary.runCount,
      durableMemory: summary.durableMemoryCount,
      autoIntake: ontology.autoIntake,
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
