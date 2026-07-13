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

const source = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime", "workload-routing.ts"), "utf8");
assert.doesNotMatch(source, /userPrompt|task\.includes|brief\.includes|keyword/i, "host allocator must not judge task text or keywords");

console.log("workload routing contract ok");
app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
