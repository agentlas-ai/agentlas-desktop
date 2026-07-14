const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

async function main() {
await app.whenReady();
const routing = require("../dist/electron/runtime/workload-routing.js");
const delegation = require("../dist/electron/mcp/delegate.js");
const borrowed = require("../dist/electron/mcp/borrowed-task-force.js");
const swarm = require("../dist/electron/mcp/swarm-run.js");
const cursorRuntime = require("../dist/electron/runtime/cursor.js");

const claude = {
  kind: "claude-code",
  backend: "anthropic",
  source: "/usr/local/bin/claude",
  version: "1",
  active: true,
  model: "opus",
  availableModels: ["opus", "sonnet", "haiku"],
  effort: "high",
  efforts: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
};
const codex = {
  kind: "codex",
  backend: "openai",
  source: "/usr/local/bin/codex",
  version: "1",
  active: true,
  model: "gpt-5.6-sol",
  availableModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
};
const grok = {
  kind: "grok",
  backend: "custom",
  source: "/usr/local/bin/grok",
  version: "1",
  active: false,
  model: "grok-4.5",
  availableModels: ["grok-4.5"],
  efforts: ["low", "medium", "high"].map((id) => ({ id, label: id })),
};
const cursor = {
  kind: "cursor",
  backend: "cursor",
  source: "/usr/local/bin/cursor-agent",
  version: "1",
  active: false,
  model: "auto",
  // Auto is the only account-safe autonomous Cursor selection.
  availableModels: ["auto"],
};

function allocation(tier, effort = "medium", phase = "delegate") {
  return routing.normalizeWorkloadAllocation({
    tier,
    effort,
    phase,
    reasonCodes: ["bounded-scope"],
    rationale: "Small isolated child with bounded output.",
  }, phase);
}

assert.equal(routing.normalizeWorkloadTier("haiku"), "economy");
assert.equal(routing.normalizeWorkloadTier("luna"), "economy");
assert.equal(routing.normalizeWorkloadTier("sonnet"), "balanced");
assert.equal(routing.normalizeWorkloadTier("tera"), "balanced", "user-facing tera alias must map to Terra tier");
assert.equal(routing.normalizeWorkloadTier("terra"), "balanced");
assert.equal(routing.normalizeWorkloadTier("opus"), "frontier");
assert.equal(routing.normalizeWorkloadTier("sol"), "frontier");
assert.equal(
  routing.normalizeWorkloadAllocation({ tier: "opus", effort: "high" }, "delegate").tier,
  "balanced",
  "missing phase must fail validation into the non-frontier fallback",
);

const claudeEconomy = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "low"),
  runtime: claude,
  phase: "delegate",
});
assert.equal(claudeEconomy.runtime.model, "haiku");
assert.equal(claudeEconomy.runtime.effort, "low");

const codexBalanced = routing.resolveWorkloadAllocation({
  allocation: allocation("tera", "max"),
  runtime: codex,
  phase: "delegate",
});
assert.equal(codexBalanced.runtime.model, "gpt-5.6-terra", "same provider-neutral tier must map to Codex Terra");
assert.equal(codexBalanced.runtime.effort, "xhigh", "Codex max must transparently clamp to its supported xhigh");
assert.ok(codexBalanced.resolutionCodes.includes("effort-clamped-to-capability"));

const unavailable = routing.resolveWorkloadAllocation({
  allocation: allocation("frontier", "high"),
  runtime: { ...codex, model: "gpt-5.6-terra", availableModels: ["gpt-5.6-terra", "gpt-5.6-luna"] },
  phase: "delegate",
});
assert.equal(unavailable.runtime.model, "gpt-5.6-terra", "missing tier must preserve active model");
assert.ok(unavailable.resolutionCodes.includes("tier-unavailable-active-preserved"));

const manualOverride = {
  scope: "agent",
  targetId: "agent-1",
  selection: { kind: "codex", backend: "openai", model: "gpt-5.6-sol", effort: "xhigh" },
  updatedAt: new Date(0).toISOString(),
};
const manual = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "low"),
  runtime: codex,
  phase: "delegate",
  manualOverride,
});
assert.equal(manual.runtime.model, "gpt-5.6-sol", "explicit manual model must win");
assert.equal(manual.source, "manual-override");

const receipt = routing.workloadAllocationReceipt({
  ...claudeEconomy,
  allocation: {
    ...claudeEconomy.allocation,
    rationale: "Inspect /Users/private/customer/project and mail owner@example.com with sk-abcdefghijklmnop",
  },
});
const receiptJson = JSON.stringify(receipt);
assert.equal(receipt.schemaVersion, "agentlas.model-allocation-receipt.v1");
assert.equal(receipt.privacy.rawPromptIncluded, false);
assert.deepEqual(Object.keys(receipt).sort(), [
  "decisionId", "independentVerificationRequired", "inputFeatureHash", "packetId", "privacy",
  "reasonCodes", "requested", "resolved", "schemaVersion", "selectorVersion", "status", "validationIssues",
].sort(), "Desktop allocation receipt must match the Core public top-level contract exactly");
assert.doesNotMatch(receiptJson, /\/Users\/private|owner@example\.com|sk-abcdefghijklmnop/);
assert.doesNotMatch(receiptJson, /userPrompt|brief|history|systemPrompt|tool/i, "receipt must contain allocation metadata, not prompts/tools");

const parsedDelegation = delegation.parseDelegations(`Plan\n\n## Delegate\n\`\`\`json
{"delegations":[
  {"target":"Researcher","brief":"Check facts","allocation":{"tier":"economy","effort":"low","phase":"delegate","reasonCodes":["bounded-scope"],"rationale":"bounded lookup"}},
  {"target":"Architect","brief":"Resolve design","allocation":{"tier":"frontier","effort":"xhigh","phase":"delegate","reasonCodes":["high-risk"],"rationale":"cross-system decision"}}
],"synthesis":{"tier":"balanced","effort":"high","phase":"synthesize","reasonCodes":["cross-result-synthesis"],"rationale":"merge two results"}}
\`\`\``);
assert.deepEqual(parsedDelegation.delegations.map((item) => item.allocation.tier), ["economy", "frontier"]);
assert.equal(parsedDelegation.synthesisAllocation.tier, "balanced");
assert.equal(parsedDelegation.cleanedText, "Plan");
const resolvedDelegates = parsedDelegation.delegations.map((item) => routing.resolveWorkloadAllocation({
  allocation: item.allocation,
  runtime: claude,
  phase: "delegate",
}).runtime.model);
assert.deepEqual(resolvedDelegates, ["haiku", "opus"], "different parent allocations must reach different worker models");

const crossRuntimeEconomy = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    tier: "economy", modelClass: "haiku", effort: "low", phase: "delegate",
    reasonCodes: ["bounded-scope"], rationale: "parent selected Haiku",
  }, "delegate"),
  runtimes: [codex, claude, grok, cursor],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(crossRuntimeEconomy.runtime.kind, "claude-code", "economy work can leave the active CLI for live Haiku");
assert.equal(crossRuntimeEconomy.runtime.model, "haiku");
assert.equal(crossRuntimeEconomy.runtime.effort, "low");

const crossRuntimeComposer = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    tier: "balanced", modelClass: "composer", effort: "medium", phase: "delegate",
    reasonCodes: ["cursor-specialist"], rationale: "parent selected Cursor family",
  }, "delegate"),
  runtimes: [codex, claude, cursor],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.notEqual(crossRuntimeComposer.runtime.kind, "cursor", "Cursor catalog names alone must not imply account entitlement");

const crossRuntimeGrok = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    tier: "frontier", modelClass: "grok", effort: "high", phase: "delegate",
    reasonCodes: ["independent-review"], rationale: "parent selected Grok review",
  }, "delegate"),
  runtimes: [claude, codex, grok],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(crossRuntimeGrok.runtime.kind, "grok");
assert.equal(crossRuntimeGrok.runtime.effort, "high");

const liveInventory = routing.workloadRuntimeInventory([codex, claude, grok, cursor]);
assert.deepEqual(liveInventory[1], {
  runtimeId: "runtime-2",
  kind: "claude-code",
  backend: "anthropic",
  models: ["opus", "sonnet", "haiku"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
});
const exactParentChoice = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-2", modelId: "sonnet", tier: "balanced", effort: "high", phase: "delegate",
    reasonCodes: ["parent-live-inventory-choice"], rationale: "parent selected the exact live session/model pair",
  }, "delegate"),
  runtimes: [codex, claude, grok, cursor],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(exactParentChoice.runtime.kind, "claude-code");
assert.equal(exactParentChoice.runtime.model, "sonnet");
assert.equal(exactParentChoice.runtime.effort, "high");
assert.ok(exactParentChoice.resolutionCodes.includes("parent-selected-live-runtime-model"));

const invalidFallback = routing.resolveWorkloadAllocation({
  allocation: routing.normalizeWorkloadAllocation(null, "delegate"),
  runtime: claude,
  phase: "delegate",
});
assert.equal(invalidFallback.runtime.model, "sonnet", "invalid planner output must not silently default a worker to flagship");

const borrowedPlan = borrowed.parseBorrowedWorkloadPlan(`## Agent Input Packets\n\`\`\`json
{"packets":[{"agent":"a","brief":"one","allocation":{"tier":"luna","effort":"low","phase":"delegate","reasonCodes":["bounded-scope"],"rationale":"small"}}],"synthesis":{"tier":"sol","effort":"xhigh","phase":"synthesize","reasonCodes":["high-risk"],"rationale":"final"}}
\`\`\``);
assert.equal(borrowedPlan.packets[0].allocation.tier, "economy");
assert.equal(borrowedPlan.synthesisAllocation.tier, "frontier");

const swarmPlan = swarm.parseSwarmOutput(`root result\n## Spawn\n\`\`\`json
{"tasks":[
  {"role":"worker","brief":"cheap child","allocation":{"tier":"haiku","effort":"low","phase":"delegate","reasonCodes":["parallel-throughput"],"rationale":"small"}},
  {"role":"reviewer","brief":"critical child","allocation":{"tier":"opus","effort":"xhigh","phase":"delegate","reasonCodes":["high-risk"],"rationale":"critical"}}
],"synthesis":{"tier":"sonnet","effort":"high","phase":"synthesize","reasonCodes":["cross-result-synthesis"],"rationale":"merge"}}
\`\`\``);
assert.deepEqual(swarmPlan.spawn.map((item) => item.allocation.tier), ["economy", "frontier"]);
assert.equal(swarmPlan.synthesisAllocation.tier, "balanced");

assert.deepEqual(
  cursorRuntime.parseCursorModelList('{"models":[{"id":"Composer 2.5"},{"id":"GPT-5.6 Sol High Fast"}]}'),
  ["Composer 2.5", "GPT-5.6 Sol High Fast"],
  "Cursor JSON model inventory must retain account-visible model IDs",
);
assert.deepEqual(
  cursorRuntime.parseCursorModelList("Available models\n* Composer 2.5\n* Grok 4.5 (recommended)"),
  ["Composer 2.5", "Grok 4.5"],
  "Cursor text model inventory must preserve model choices and strip presentation markers",
);

const source = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime", "workload-routing.ts"), "utf8");
assert.doesNotMatch(source, /userPrompt|task\.includes|brief\.includes|keyword/i, "host allocator must not judge task text or keywords");
const swarmSource = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp", "swarm-run.ts"), "utf8");
assert.match(swarmSource, /coreHarnessPrompt/);
assert.doesNotMatch(swarmSource, /["`]GOAL MODE:/, "Desktop swarm must not define a local Goal mode prompt");
assert.doesNotMatch(swarmSource, /["`]ULTRACODE MODE:/, "Desktop swarm must not define a local UltraCode mode prompt");
assert.match(swarmSource, /p\.stormbreakerMode \? STORMBREAKER_LOOP_PROTOCOL/);
assert.match(swarmSource, /agentName:\s*"Stormbreaker"/);
assert.match(swarmSource, /role:\s*"Goal · UltraCode"/);
assert.match(swarmSource, /runtime.*model.*effort|런타임.*모델.*effort/s);
assert.match(swarmSource, /WORK ALREADY ASSIGNED TO PEERS/);
assert.match(swarmSource, /HOST-VERIFIED ALLOCATION:/);
const clientSource = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp", "client.ts"), "utf8");
assert.match(clientSource, /stormbreakerMode:\s*stormbreakerSwarm/);
assert.match(clientSource, /stormbreakerHarness/);
assert.match(clientSource, /coreHarness\.system_prompt/);

console.log("workload routing contract ok");
app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
