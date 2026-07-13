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

const claude = {
  kind: "claude-code",
  backend: "anthropic",
  source: "/usr/local/bin/claude",
  version: "1",
  active: true,
  model: "model-frontier",
  availableModels: ["model-frontier", "model-balanced", "model-economy"],
  allocationModels: ["model-frontier", "model-balanced", "model-economy"],
  effort: "high",
  efforts: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
};
const codex = {
  kind: "codex",
  backend: "openai",
  source: "/usr/local/bin/codex",
  version: "1",
  active: true,
  model: "compute-frontier",
  availableModels: ["compute-frontier", "compute-balanced", "compute-economy"],
  allocationModels: ["compute-frontier", "compute-balanced", "compute-economy"],
};

function allocation(tier, effort = "medium", phase = "delegate", exactModelId) {
  return routing.normalizeWorkloadAllocation({
    tier,
    exactModelId,
    effort,
    phase,
    reasonCodes: ["bounded-scope"],
    rationale: "Small isolated child with bounded output.",
  }, phase);
}

assert.equal(routing.normalizeWorkloadTier("economy"), "economy");
assert.equal(routing.normalizeWorkloadTier("balanced"), "balanced");
assert.equal(routing.normalizeWorkloadTier("frontier"), "frontier");
assert.equal(routing.normalizeWorkloadTier("haiku"), null, "vendor model names must not imply a cost tier");
assert.equal(routing.normalizeWorkloadTier("terra"), null, "host model ids must come from live inventory only");
assert.equal(routing.normalizeWorkloadTier("opus"), null, "vendor model names must not imply a cost tier");
assert.equal(
  routing.normalizeWorkloadAllocation({ tier: "vendor-model-name", effort: "high" }, "delegate").tier,
  "balanced",
  "missing phase must fail validation into the non-frontier fallback",
);

const claudeEconomy = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "low", "delegate", "model-economy"),
  runtime: claude,
  phase: "delegate",
});
assert.equal(claudeEconomy.runtime.model, "model-economy");
assert.equal(claudeEconomy.runtime.effort, "low");

const codexBalanced = routing.resolveWorkloadAllocation({
  allocation: allocation("balanced", "max", "delegate", "compute-balanced"),
  runtime: codex,
  phase: "delegate",
});
assert.equal(codexBalanced.runtime.model, "compute-balanced", "parent exact id from live inventory must be selected");
assert.equal(codexBalanced.runtime.effort, "xhigh", "Codex max must transparently clamp to its supported xhigh");
assert.ok(codexBalanced.resolutionCodes.includes("effort-clamped-to-capability"));

const unavailable = routing.resolveWorkloadAllocation({
  allocation: allocation("frontier", "high", "delegate", "compute-frontier"),
  runtime: { ...codex, model: "compute-balanced", availableModels: ["compute-balanced", "compute-economy"], allocationModels: ["compute-balanced", "compute-economy"] },
  phase: "delegate",
});
assert.equal(unavailable.runtime.model, "compute-balanced", "missing exact model must preserve active model");
assert.ok(unavailable.resolutionCodes.includes("parent-model-not-in-live-inventory-active-preserved"));

const manualOverride = {
  scope: "agent",
  targetId: "agent-1",
  selection: { kind: "codex", backend: "openai", model: "compute-frontier", effort: "xhigh" },
  updatedAt: new Date(0).toISOString(),
};
const manual = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "low"),
  runtime: codex,
  phase: "delegate",
  manualOverride,
});
assert.equal(manual.runtime.model, "compute-frontier", "explicit manual model must win");
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
  {"target":"Researcher","brief":"Check facts","allocation":{"exactModelId":"model-economy","tier":"economy","effort":"low","phase":"delegate","reasonCodes":["bounded-scope"],"rationale":"bounded lookup"}},
  {"target":"Architect","brief":"Resolve design","allocation":{"exactModelId":"model-frontier","tier":"frontier","effort":"xhigh","phase":"delegate","reasonCodes":["high-risk"],"rationale":"cross-system decision"}}
],"synthesis":{"exactModelId":"model-balanced","tier":"balanced","effort":"high","phase":"synthesize","reasonCodes":["cross-result-synthesis"],"rationale":"merge two results"}}
\`\`\``);
assert.deepEqual(parsedDelegation.delegations.map((item) => item.allocation.tier), ["economy", "frontier"]);
assert.equal(parsedDelegation.synthesisAllocation.tier, "balanced");
assert.equal(parsedDelegation.cleanedText, "Plan");
const resolvedDelegates = parsedDelegation.delegations.map((item) => routing.resolveWorkloadAllocation({
  allocation: item.allocation,
  runtime: claude,
  phase: "delegate",
}).runtime.model);
assert.deepEqual(resolvedDelegates, ["model-economy", "model-frontier"], "different parent allocations must reach different worker models");

const invalidFallback = routing.resolveWorkloadAllocation({
  allocation: routing.normalizeWorkloadAllocation(null, "delegate"),
  runtime: claude,
  phase: "delegate",
});
assert.equal(invalidFallback.runtime.model, "model-frontier", "invalid planner output must preserve the active model instead of manufacturing one");

const borrowedPlan = borrowed.parseBorrowedWorkloadPlan(`## Agent Input Packets\n\`\`\`json
{"packets":[{"agent":"a","brief":"one","allocation":{"exactModelId":"model-economy","tier":"economy","effort":"low","phase":"delegate","reasonCodes":["bounded-scope"],"rationale":"small"}}],"synthesis":{"exactModelId":"model-frontier","tier":"frontier","effort":"xhigh","phase":"synthesize","reasonCodes":["high-risk"],"rationale":"final"}}
\`\`\``);
assert.equal(borrowedPlan.packets[0].allocation.tier, "economy");
assert.equal(borrowedPlan.synthesisAllocation.tier, "frontier");

const swarmPlan = swarm.parseSwarmOutput(`root result\n## Spawn\n\`\`\`json
{"tasks":[
  {"role":"worker","brief":"cheap child","allocation":{"exactModelId":"model-economy","tier":"economy","effort":"low","phase":"delegate","reasonCodes":["parallel-throughput"],"rationale":"small"}},
  {"role":"reviewer","brief":"critical child","allocation":{"exactModelId":"model-frontier","tier":"frontier","effort":"xhigh","phase":"delegate","reasonCodes":["high-risk"],"rationale":"critical"}}
],"synthesis":{"exactModelId":"model-balanced","tier":"balanced","effort":"high","phase":"synthesize","reasonCodes":["cross-result-synthesis"],"rationale":"merge"}}
\`\`\``);
assert.deepEqual(swarmPlan.spawn.map((item) => item.allocation.tier), ["economy", "frontier"]);
assert.equal(swarmPlan.synthesisAllocation.tier, "balanced");

const source = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime", "workload-routing.ts"), "utf8");
assert.doesNotMatch(source, /userPrompt|task\.includes|brief\.includes|keyword/i, "host allocator must not judge task text or keywords");
assert.doesNotMatch(source, /function chooseSameTierModel|same-tier-model-selected|preferredAliasOrder/, "Desktop allocator must not translate tiers into provider model ids");
assert.doesNotMatch(source, /TIER_ALIASES|\["haiku"|\["sonnet"|\["opus"/, "Desktop allocator must not embed vendor model class tables");

console.log("workload routing contract ok");
app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
