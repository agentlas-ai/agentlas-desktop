#!/usr/bin/env node
"use strict";

// Desktop-level Stormbreaker proof. This drives the real chat entrypoint with
// a deterministic local runner: slash routing, Core harness injection, child
// model allocation, durable chat history, and the final-gate truth boundary.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-stormbreaker-swarm-"));
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
app.setPath("userData", path.join(temp, "user-data"));

const allocation = (modelId, tier, effort, phase) => ({
  runtimeId: "runtime-1",
  modelId,
  tier,
  effort,
  phase,
  requirements: {
    inputTokens: 400,
    expectedOutputTokens: 300,
    toolRequired: false,
    multimodalRequired: false,
  },
  reasonCodes: ["fixture-bounded-work"],
  rationale: "A bounded fixture packet selected from the live runtime inventory.",
});

const coreHarness = {
  schema_version: "agentlas.stormbreaker.goal-ultracode-harness.v1",
  harness_id: "agentlas-core/stormbreaker-goal-ultracode",
  owner: "Agentlas Core",
  mode: "stormbreaker-goal-ultracode",
  system_prompt: [
    "You are executing inside the Agentlas-owned STORMBREAKER GOAL + ULTRACODE HARNESS.",
    "GOAL MODE: fixture keeps a durable goal ledger.",
    "ULTRACODE MODE: fixture verifies concrete work before success.",
  ].join("\n"),
  prompt_sha256: "fixture-hash-not-validated-by-client-mock",
  host_rule: "fixture",
  inventory_rule: "fixture",
  completion_rule: "fixture",
};

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  store.getDb()
    .prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "stormbreaker-swarm-fixture",
      "stormbreaker-swarm-fixture",
      "Stormbreaker Swarm Fixture",
      "Stormbreaker Swarm Fixture",
      "Deterministic orchestration fixture",
      "Deterministic orchestration fixture",
      "Execute only concrete fixture work.",
      "[]",
      "[]",
      null,
      "A",
      "2026-07-15T00:00:00.000Z",
      "neutral",
      0,
      null,
      "visible",
    );

  const active = {
    kind: "ollama",
    backend: null,
    source: "stormbreaker-swarm-fixture",
    version: "1",
    ready: true,
    active: true,
    model: "fixture-balanced",
    allocationModels: ["fixture-economy", "fixture-balanced"],
    allocationModelProfiles: {
      "fixture-economy": {
        costTier: "economy",
        contextWindow: 32768,
        capabilities: ["tools"],
        supportsTools: true,
        efforts: ["low", "medium"],
      },
      "fixture-balanced": {
        costTier: "balanced",
        contextWindow: 65536,
        capabilities: ["tools"],
        supportsTools: true,
        efforts: ["medium", "high"],
      },
    },
    efforts: ["low", "medium", "high"].map((id) => ({ id, label: id })),
  };

  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  const envResolver = require("../dist/electron/runtime/env-resolver.js");
  const commands = require("../dist/electron/hephaestus/commands.js");
  const ontology = require("../dist/electron/ontology/runtime-context.js");
  detect.detectRuntimes = async () => [active];
  envResolver.buildRunnerEnv = async () => ({ env: {}, injectedKeys: [] });
  commands.stormbreakerHarness = async () => coreHarness;
  ontology.buildAgentRuntimeOntologyContext = async () => ({
    operationalPrompt: "",
    tasteDirective: "",
    prompt: "",
    operationalApproxTokens: 0,
    tasteApproxTokens: 0,
    combinedApproxTokens: 0,
    tasteReleaseId: null,
  });

  const chats = require("../dist/electron/store/chats.js");
  const client = require("../dist/electron/mcp/client.js");
  const agentId = "stormbreaker-swarm-fixture";

  async function invoke({ title, prompt, worker }) {
    const requests = [];
    selection.selectRuntimeForTargets = () => ({
      active,
      picked: {
        label: "Stormbreaker fixture runner",
        runner: async (request) => {
          requests.push(request);
          return worker(request, requests.length);
        },
      },
      override: null,
      unavailableOverride: null,
    });
    const chat = chats.createChat({ agentId, title });
    const events = [];
    const response = await client.runMcpInvocation(
      { chatId: chat.id, userPrompt: prompt, locale: "en", permissions: "read" },
      (event) => events.push(event),
    );
    return { chat, events, response, requests, messages: chats.listChatMessages(chat.id, 20) };
  }

  const success = await invoke({
    title: "Slash Storm success",
    prompt: "/hep-storm repair the desktop updater contract and verify the resulting release gate",
    worker: (request) => {
      if (/synthesizer of an agent swarm/i.test(request.systemPrompt)) {
        assert.equal(request.model, "fixture-balanced");
        assert.equal(request.effort, "high");
        return { text: "Verified synthesis: every required packet passed.", tokens: 1 };
      }
      if (request.userPrompt === "verify the updater release gate") {
        assert.equal(request.model, "fixture-economy", "child must use the parent-selected exact live model");
        assert.equal(request.effort, "low", "child effort must use the selected model capability");
        return { text: "Release gate verified.", tokens: 1 };
      }
      assert.equal(
        request.userPrompt,
        "repair the desktop updater contract and verify the resulting release gate",
        "workers receive the goal, never the /hep-storm route slug",
      );
      assert.match(request.systemPrompt, /GOAL MODE: fixture keeps a durable goal ledger/);
      assert.match(request.systemPrompt, /ULTRACODE MODE: fixture verifies concrete work before success/);
      assert.match(request.systemPrompt, /LIVE_RUNTIME_INVENTORY/);
      return {
        text: [
          "Updater contract inspected.",
          "## Spawn",
          "```json",
          JSON.stringify({
            tasks: [{ title: "verify the updater release gate", brief: "verify the updater release gate", allocation: allocation("fixture-economy", "economy", "low", "delegate") }],
            synthesis: allocation("fixture-balanced", "balanced", "high", "synthesize"),
          }),
          "```",
        ].join("\n"),
        tokens: 1,
      };
    },
  });
  assert.equal(success.requests.length, 3, "root, child, and synthesis must each execute through the selected runtime");
  assert.equal(success.response.finalText, "Verified synthesis: every required packet passed.");
  assert.equal(success.messages.length, 2, "orchestrated calls must persist both the raw command and final result");
  assert.equal(success.messages[0].role, "user");
  assert.match(success.messages[0].text, /^\/hep-storm /);
  assert.equal(success.messages[1].role, "assistant");
  assert.ok(success.events.some((event) => event.kind === "thinking" && /final gate passed/i.test(event.status ?? "")));
  assert.ok(!success.events.some((event) => event.kind === "thinking" && /final gate blocked/i.test(event.status ?? "")));

  const blocked = await invoke({
    title: "Slash Storm blocked",
    prompt: "/hep-storm inspect updater integrity, then run a deliberately failing verifier packet",
    worker: (request) => {
      if (/synthesizer of an agent swarm/i.test(request.systemPrompt)) {
        return { text: "Partial synthesis from the surviving packet.", tokens: 1 };
      }
      if (request.userPrompt === "deliberately fail the verifier packet") {
        throw new Error("fixture verifier failure");
      }
      return {
        text: [
          "Integrity inspected.",
          "## Spawn",
          "```json",
          JSON.stringify({
            tasks: [{ title: "deliberately fail the verifier packet", brief: "deliberately fail the verifier packet", allocation: allocation("fixture-economy", "economy", "low", "delegate") }],
            synthesis: allocation("fixture-balanced", "balanced", "high", "synthesize"),
          }),
          "```",
        ].join("\n"),
        tokens: 1,
      };
    },
  });
  assert.match(blocked.response.finalText ?? "", /^Stormbreaker final gate blocked:/);
  assert.match(blocked.response.finalText ?? "", /partial output, not proof that the goal completed/i);
  assert.ok(blocked.events.some((event) => event.kind === "thinking" && /final gate blocked/i.test(event.status ?? "")));
  assert.ok(!blocked.events.some((event) => event.kind === "thinking" && /final gate passed/i.test(event.status ?? "")));
  assert.equal(blocked.messages.length, 2, "a blocked orchestration still preserves the original user request and diagnostic result");

  const finalReceipts = store.getDb()
    .prepare("SELECT payload_json FROM run_events WHERE kind = 'swarm_finished' ORDER BY seq DESC")
    .all()
    .map((row) => JSON.parse(row.payload_json))
    .map((payload) => ({
      ...payload,
      finalGate: typeof payload.finalGate === "string" ? JSON.parse(payload.finalGate) : payload.finalGate,
    }));
  assert.ok(finalReceipts.some((payload) => payload.finalGate?.canReportSuccess === true));
  assert.ok(finalReceipts.some((payload) => payload.finalGate?.canReportSuccess === false && payload.finalGate?.status === "blocked"));

  console.log("desktop Stormbreaker swarm contract: PASS");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
