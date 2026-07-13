#!/usr/bin/env node
const assert = require("node:assert/strict");
const path = require("node:path");

const portable = require("../dist/electron/experience/portable.js");
const fixture = require(path.join(__dirname, "fixtures/portable-experience-bundle-v1-golden.json"));

assert.equal(
  portable.portableExperienceCanonicalJson(fixture.canonicalCases.input),
  fixture.canonicalCases.expectedJson,
  "NFC/emoji/Windows slash/-0/JSON-number canonicalization drifted",
);
assert.equal(portable.portableExperiencePackContentHash(fixture.bundle), fixture.expectedPackContentHash);
assert.equal(portable.portableExperienceBundleHash(fixture.bundle), fixture.expectedBundleHash);
assert.equal(portable.portableExperienceBundleId(fixture.bundle), fixture.expectedBundleId);
assert.equal(portable.validatePortableExperienceBundle(fixture.bundle).bundleId, fixture.expectedBundleId);

function assertInvalid(label, mutate) {
  const value = structuredClone(fixture.bundle);
  mutate(value);
  assert.throws(() => portable.validatePortableExperienceBundle(value), undefined, label);
}

assertInvalid("unknown top-level fields must fail", (value) => { value.unknownField = true; });
assertInvalid("unknown Pack fields must fail", (value) => { value.pack.projectPath = "not-authority"; });
assertInvalid("unknown Item fields must fail", (value) => { value.items[0].sourceMemoryId = "memory-local"; });
assertInvalid("unknown MCP fields must fail", (value) => { value.pack.mcpRequirements[0].command = "npx"; });
assertInvalid("257 items must fail", (value) => {
  value.items = Array.from({ length: 257 }, (_, index) => ({
    ...structuredClone(value.items[0]),
    experienceItemId: `exi_${index.toString(16).padStart(48, "0")}`,
  }));
  value.pack.itemIds = value.items.map((item) => item.experienceItemId);
});
assertInvalid("9 instructions must fail", (value) => {
  value.items[0].instructions = Array.from({ length: 9 }, (_, index) => `instruction-${index}`);
});
assertInvalid("33 task signatures must fail", (value) => {
  value.items[0].taskSignatures = Array.from({ length: 33 }, (_, index) => `task:signature-${index}`);
});
assertInvalid("25 evidence refs must fail", (value) => {
  value.items[0].evidenceReceiptIds = Array.from({ length: 25 }, (_, index) => `evidence:local:${index}`);
});
assertInvalid("65 MCP requirements must fail", (value) => {
  value.pack.mcpRequirements = Array.from({ length: 65 }, (_, index) => ({
    ...structuredClone(value.pack.mcpRequirements[0]),
    requirementId: `mcp:req:browser-${index}`,
    catalogId: `browser-${index}`,
    capabilities: [`page-read-${index}`],
  }));
});
assertInvalid("required MCP must exclude only its Variant", (value) => {
  value.pack.mcpRequirements[0].required = true;
  value.pack.mcpRequirements[0].unavailablePolicy.rental = "continue-degraded";
});
assertInvalid("key-required MCP needs value-free metadata", (value) => {
  value.pack.mcpRequirements[0].requiresKey = true;
});
assertInvalid("confidence bounds must fail", (value) => { value.items[0].confidence = 1.1; });
assertInvalid("privacy flags can never claim raw inclusion", (value) => { value.privacy.rawPromptIncluded = true; });

const oversized = structuredClone(fixture.bundle);
oversized.requestedVisibility = "private";
oversized.pack.visibility = "private";
oversized.pack.status = "draft";
oversized.sourceAttestations = [];
oversized.items = Array.from({ length: 256 }, (_, itemIndex) => ({
  ...structuredClone(fixture.bundle.items[0]),
  experienceItemId: `exi_${itemIndex.toString(16).padStart(48, "0")}`,
  summary: `요약-${itemIndex}-` + "가".repeat(280),
  instructions: Array.from({ length: 8 }, (_, index) => `절차-${index}-` + "나".repeat(580)),
  taskSignatures: ["agentlas.task.v1/document"],
  environmentConstraints: [
    "agentlas.env.v1/os/macos",
    "agentlas.env.v1/arch/arm64",
    "agentlas.env.v1/runtime/codex",
  ],
  evidenceReceiptIds: [`evidence:bulk:${itemIndex}`],
  confidence: itemIndex % 2 ? 0.5 : 1,
}));
oversized.pack.itemIds = oversized.items.map((item) => item.experienceItemId);
oversized.pack.evidenceReceiptIds = oversized.items.flatMap((item) => item.evidenceReceiptIds);
oversized.pack.contentHash = portable.portableExperiencePackContentHash(oversized);
oversized.bundleHash = portable.portableExperienceBundleHash(oversized);
oversized.bundleId = portable.portableExperienceBundleId(oversized);
assert.ok(Buffer.byteLength(portable.portableExperienceCanonicalJson(oversized), "utf8") > 3 * 1024 * 1024);
assert.throws(() => portable.validatePortableExperienceBundle(oversized), /3 MiB canonical limit/, "3 MiB canonical limit must fail closed");

const reordered = structuredClone(fixture.bundle);
reordered.items.reverse();
reordered.pack.itemIds.reverse();
reordered.items[0].taskSignatures.reverse();
assert.equal(portable.portableExperienceBundleHash(reordered), fixture.expectedBundleHash, "set-like array ordering changed identity");

const semanticOrderChanged = structuredClone(fixture.bundle);
semanticOrderChanged.items[1].instructions.reverse();
assert.notEqual(portable.portableExperienceBundleHash(semanticOrderChanged), fixture.expectedBundleHash, "instruction ordering must remain semantic");

const ownerChanged = structuredClone(fixture.bundle);
ownerChanged.pack.ownerRef = "user:different-authenticated-owner";
ownerChanged.requestedVisibility = "private";
ownerChanged.pack.visibility = "private";
ownerChanged.pack.status = "draft";
assert.equal(portable.portableExperienceBundleHash(ownerChanged), fixture.expectedBundleHash, "owner/lifecycle state must not change content identity");

console.log("portable Experience NFC/Korean/emoji/Windows golden hash: PASS");
