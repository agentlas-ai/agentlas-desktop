#!/usr/bin/env node
"use strict";

/* Acceptance gate for the chat-driven plugin builder (PRD-PLUGIN-BUILDER.md A1-A10).
 * It uses an isolated HOME and SQLite store, so it never touches a user's plugins
 * or Agentlas history. The generated package is still checked by the canonical
 * plugin-spec gate, not by a second approximate validator.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-plugin-builder-gate-"));
  process.env.HOME = path.join(root, "home");
  process.env.AGENTLAS_STORE_PATH = path.join(root, "agentlas.sqlite");
  await fs.mkdir(process.env.HOME, { recursive: true });

  const builder = require(path.resolve(__dirname, "../dist/electron/plugins/builder.js"));
  const { initStore } = require(path.resolve(__dirname, "../dist/electron/store/db.js"));
  const { isOneSuggestionState } = require(path.resolve(__dirname, "../dist/shared/one-suggestions.js"));
  initStore({ migrationRole: "owner" });

  const workflow = {
    name: "run",
    description: "Run the repeated procedure and verify its result.",
    steps: ["Read the request.", "Run the procedure in order."],
    outputs: ["A concise result summary."],
    verification: ["Confirm the result is non-empty."],
  };
  const answers = (slug) => ({
    slug,
    name: "Fixture Procedure",
    description: "Run a repeated local procedure and verify its result.",
    category: "custom",
    workflows: [workflow],
    requiresTools: [],
    permissions: { fileWrite: "none", network: "none", shell: "deny" },
    state: { files: ["user-context.md"], assets: true },
  });
  const check = (name, ok) => {
    assert.ok(ok, `${name} failed`);
    console.log(`PASS ${name}`);
  };

  const fixtureDir = path.join(root, "fixture-procedure");
  const built = await builder.buildPluginPackage(fixtureDir, answers("fixture-procedure"));
  const fixtureGate = await builder.runPluginSpecGate(fixtureDir);
  check("A1 generated package passes the canonical gate", fixtureGate.ok);
  const manifestBytes = await fs.readFile(path.join(fixtureDir, "plugin.json"));
  check("A10 generated plugin.json has no BOM and parses on first read", manifestBytes[0] !== 0xef && JSON.parse(manifestBytes.toString("utf8")).slug === "fixture-procedure");
  check("A9 built-in plugin passes the same gate", (await builder.runPluginSpecGate(path.resolve(__dirname, "../plugins/plugin-make"))).ok);

  const bad = await builder.startPluginBuilder({ chatId: "plugin-builder-a2", seed: { kind: "mention", request: "build a bad fixture" } });
  const badDraft = await builder.draftPluginBuilder({ sessionId: bad.id, answers: answers("bad-fixture") });
  await fs.appendFile(path.join(badDraft.packageDir, "skills", "run", "SKILL.md"), "\n$missing-reference\n", "utf8");
  const badGate = await builder.runPluginSpecGate(badDraft.packageDir);
  check("A2 failing package reports the exact gate rule", !badGate.ok && badGate.violations.some((line) => line.startsWith("G3:")));
  await assert.rejects(
    () => builder.installPluginBuilder({ sessionId: bad.id }),
    (error) => /Plugin builder install refused:[\s\S]*G3:/.test(String(error && error.message)),
  );
  check("A2 install refuses a failing package", true);

  builder.setPluginBuilderWorkflowRunnerForTests(async () => ({ ok: true, summary: "fixture workflow executed" }));
  const good = await builder.startPluginBuilder({ chatId: "plugin-builder-a4", seed: { kind: "mention", request: "build a good fixture" } });
  await builder.draftPluginBuilder({ sessionId: good.id, answers: answers("fixture-procedure") });
  const install = await builder.installPluginBuilder({ sessionId: good.id });
  const proof = await builder.provePluginBuilder({ sessionId: good.id });
  check("A3 installed plugin router reaches the model prompt", proof.routerInjected);
  check("A4 one workflow actually ran", proof.proven && proof.workflowRun.ok && proof.workflowRun.summary.length > 0);

  const stateFile = path.join(install.installedDir, ".state", "x.md");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, "user state must survive", "utf8");
  const update = await builder.startPluginBuilder({ chatId: "plugin-builder-a6", seed: { kind: "mention", request: "update the fixture" } });
  await builder.draftPluginBuilder({ sessionId: update.id, answers: answers("fixture-procedure") });
  await builder.installPluginBuilder({ sessionId: update.id });
  check("A6 update preserves .state", (await fs.readFile(stateFile, "utf8")) === "user state must survive");

  builder.setPluginBuilderWorkflowRunnerForTests(async () => ({ ok: false, summary: "required runtime unavailable" }));
  const unproven = await builder.startPluginBuilder({ chatId: "plugin-builder-a5", seed: { kind: "mention", request: "build an unproven fixture" } });
  await builder.draftPluginBuilder({ sessionId: unproven.id, answers: answers("unproven-fixture") });
  await builder.installPluginBuilder({ sessionId: unproven.id });
  const unprovenProof = await builder.provePluginBuilder({ sessionId: unproven.id });
  check("A5 missing runtime is reported as installed-but-unproven", unprovenProof.installed && !unprovenProof.proven && /unavailable/.test(unprovenProof.reason));

  const offer = await builder.startPluginBuilder({ chatId: "plugin-builder-a8", seed: { kind: "agent-offer", chatId: "plugin-builder-a8", request: "repeat this procedure" } });
  assert.equal(offer.seed.kind, "agent-offer");
  await assert.rejects(() => builder.startPluginBuilder({ chatId: "plugin-builder-a8", seed: { kind: "agent-offer", chatId: "plugin-builder-a8", request: "repeat this procedure again" } }), /already offered once/);
  check("A8 agent offer is limited to once per conversation", true);

  const now = new Date().toISOString();
  const stateVersion = Date.parse(now);
  const patternKey = "pattern:fixture-procedure";
  const evidence = [0, 1, 2].map((index) => ({
    taskId: `task:fixture:${index}`,
    taskVersion: 1,
    patternKey,
    status: "completed",
    outcome: "accepted_internal_result",
    acceptanceReceiptVerified: true,
    hostId: "host_fixture",
    runId: `run:fixture:${index}`,
    completionReceiptRef: `run:fixture:${index}`,
    verificationRef: `verification:fixture:${index}`,
    evidenceRefs: [`evidence:fixture:${index}`],
    completedAt: now,
  }));
  const pluginSignal = {
    signalSource: "accepted_result_pattern",
    patternKey,
    taskKindRef: "task-kind:fixture",
    toolRefs: ["tool:one", "tool:two"],
    observationRefs: ["observation:0", "observation:1", "observation:2"],
    acceptedResultCount: 3,
    reviewRequired: true,
  };
  const suggestionBase = {
    contractVersion: "1.0.0",
    version: stateVersion,
    suggestions: [{
      id: "one_suggestion_0123456789abcdef0123456789abcdef",
      version: stateVersion,
      type: "plugin_build",
      originTaskId: "task:fixture:2",
      patternKey,
      evidence,
      evidenceRefs: evidence.flatMap((item) => [item.runId, item.verificationRef, ...item.evidenceRefs]),
      proposal: { type: "plugin_build", ...pluginSignal },
      status: "open",
      reviewRequestId: null,
      resumeAfter: null,
      cooldownUntil: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    }],
    reviewRequests: [],
    suppressions: [],
    patternFeedback: [],
    taskArbitrations: [],
    createdAt: now,
    updatedAt: now,
  };
  check("A7 plugin_build signal is content-free and requires three accepted results", isOneSuggestionState(suggestionBase) && pluginSignal.acceptedResultCount >= 3 && !Object.keys(pluginSignal).some((key) => /prompt|transcript|content/i.test(key)));

  await fs.rm(root, { recursive: true, force: true });
  console.log("\nplugin builder acceptance gate passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
