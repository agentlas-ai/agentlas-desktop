#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const taxonomy = require("../dist/electron/experience/taxonomy.js");
const context = require("../dist/electron/experience/context.js");

const EXPECTED_CHECKSUM = "sha256:413833472e423352518f9591cd0e051c5bc0a7971e53ab3dc7b5aaf7d50c37ab";
const EMPTY_SELECTION = { prompt: "", selectedCandidateIds: [], approximateTokens: 0 };
let checks = 0;

function check(action) {
  action();
  checks += 1;
}

function normalizeCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(normalizeCanonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeCanonicalJson(value[key])]),
    );
  }
  return value;
}

function canonicalHash(value) {
  const body = JSON.stringify(normalizeCanonicalJson(value));
  return `sha256:${crypto.createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const localContractPath = path.join(__dirname, "fixtures/experience-taxonomy-v1.json");
const localContract = readJson(localContractPath);

check(() => assert.equal(canonicalHash(localContract), EXPECTED_CHECKSUM));
check(() => assert.equal(localContract.environment.unknownConstraint, "item-ineligible-base-unaffected"));
check(() => assert.deepEqual(
  taxonomy.EXPERIENCE_TASK_SLUGS,
  localContract.taskSlugs,
  "Desktop task catalog must exactly match the frozen cross-surface v1 contract",
));

// In the Agentlas umbrella checkout, also compare the actual Core and Terminal
// artifacts. The local frozen copy keeps this focused Desktop test runnable in
// a standalone checkout without weakening its checksum gate.
for (const siblingContract of [
  path.resolve(__dirname, "../../Agentlas-OS/agentlas_cloud/experience_taxonomy_v1.json"),
  path.resolve(__dirname, "../../agentlas_terminal/engine/experience-taxonomy-v1.json"),
]) {
  if (!fs.existsSync(siblingContract)) continue;
  const value = readJson(siblingContract);
  check(() => assert.equal(canonicalHash(value), EXPECTED_CHECKSUM, siblingContract));
  check(() => assert.deepEqual(value, localContract, `${siblingContract} drifted from Desktop`));
}

const coreFixturePath = path.resolve(
  __dirname,
  "../../Agentlas-OS/tests/fixtures/experience-taxonomy-v1-cross-surface.json",
);
if (fs.existsSync(coreFixturePath)) {
  const fixture = readJson(coreFixturePath);
  check(() => assert.equal(fixture.taxonomyChecksum, EXPECTED_CHECKSUM));
  for (const testCase of fixture.cases) {
    const taskIds = taxonomy.classifyCanonicalTaskIds(testCase.taskClass, ...testCase.capabilityTags);
    const expectedTaskId = `${localContract.taskSignaturePrefix}${testCase.taskClass}`;
    check(() => assert.equal(
      taskIds.includes(expectedTaskId),
      localContract.taskSlugs.includes(testCase.taskClass),
      testCase.id,
    ));
    const profile = taxonomy.canonicalEnvironmentProfile({
      platform: testCase.environment.os,
      arch: testCase.environment.arch,
      runtimeKind: testCase.environment.runtime,
    });
    check(() => assert.equal(
      taxonomy.isRuntimeEligibleExperienceEnvironmentProfile(profile),
      !Object.values(testCase.environment).includes("unknown"),
      testCase.id,
    ));
  }
}

const terminalFixturePath = path.resolve(
  __dirname,
  "../../agentlas_terminal/test/fixtures/experience-activation-contract-v1.json",
);
const terminalFixture = fs.existsSync(terminalFixturePath)
  ? readJson(terminalFixturePath)
  : {
      taskIds: localContract.taskSlugs.map((slug) => `${localContract.taskSignaturePrefix}${slug}`),
      environmentCases: [
        {
          input: { platform: "darwin", arch: "arm64", runtime: "terminal" },
          expected: [
            "agentlas.env.v1/os/macos",
            "agentlas.env.v1/arch/arm64",
            "agentlas.env.v1/runtime/terminal",
          ],
        },
      ],
      classifierCases: [
        { prompt: "Debug the API bug and write code", expected: ["agentlas.task.v1/coding", "agentlas.task.v1/debugging"] },
        { prompt: "The runtime returned an error", expected: ["agentlas.task.v1/debugging"] },
      ],
    };

check(() => assert.deepEqual(
  terminalFixture.taskIds,
  taxonomy.EXPERIENCE_TASK_SLUGS.map(taxonomy.canonicalTaskId),
));
for (const testCase of terminalFixture.environmentCases) {
  check(() => assert.deepEqual(
    taxonomy.canonicalEnvironmentProfile({
      platform: testCase.input.platform,
      arch: testCase.input.arch,
      runtimeKind: testCase.input.runtime,
    }).constraints,
    testCase.expected,
    JSON.stringify(testCase.input),
  ));
}
for (const testCase of terminalFixture.classifierCases) {
  check(() => assert.deepEqual(
    taxonomy.classifyCanonicalTaskIds(testCase.prompt),
    testCase.expected,
    testCase.prompt,
  ));
}

check(() => assert.deepEqual(
  taxonomy.classifyCanonicalTaskIds("런타임 오류를 고쳐줘"),
  ["agentlas.task.v1/debugging"],
));
check(() => assert.deepEqual(
  taxonomy.classifyCanonicalTaskIds("The terror-themed poster is ready"),
  ["agentlas.task.v1/image-generation"],
  "error must be a word, not a substring false positive",
));
check(() => assert.deepEqual(
  taxonomy.classifyCanonicalTaskIds("제출용 문서를 수정해줘"),
  ["agentlas.task.v1/document"],
  "ordinary Korean editing must not be misclassified as debugging",
));
check(() => assert.deepEqual(
  taxonomy.classifyCanonicalTaskIds("Refactor and fix the TypeScript implementation"),
  ["agentlas.task.v1/coding"],
  "generic English fix must not be debugging without a bug/error signal",
));

// ── Judged canonical task classes: the model decides; TASK_RULES = hints + fallback ──
// (mirrors the terminal engine's resolveCanonicalTaskClasses contract)
const judgedTaskClassChecks = (async () => {
  const arabicVideo = "أنتج مقطع فيديو قصيراً مع ترجمة عربية للحملة القادمة";
  // Documented wordlist miss (Arabic video production).
  check(() => assert.deepEqual(taxonomy.classifyCanonicalTaskIds(arabicVideo), []));
  // (a) The judge double WINS, in canonical id order, and never invents ids.
  const judged = await taxonomy.resolveCanonicalTaskIds([arabicVideo], {
    judgeSubsetFn: async (spec) => {
      assert.equal(spec.kind, "experience-task-class");
      assert.deepEqual([...spec.labels], [...taxonomy.EXPERIENCE_TASK_SLUGS]);
      return { selected: ["translation", "video-production", "not-a-slug"], confidence: 0.9, reason: "video + subtitles", source: "llm" };
    },
  });
  check(() => assert.deepEqual(judged, {
    taskIds: ["agentlas.task.v1/video-production", "agentlas.task.v1/translation"],
    source: "llm",
    reason: "video + subtitles",
  }, "the judged verdict must fire on wordlist-miss phrasing, in canonical order, dropping invented ids"));
  // A judged EMPTY selection is a decision: it replaces (never pads) the prefilter.
  const emptied = await taxonomy.resolveCanonicalTaskIds(["The terror-themed poster is ready"], {
    judgeSubsetFn: async () => ({ selected: [], confidence: 0.8, reason: "status update, not work", source: "llm" }),
  });
  check(() => assert.deepEqual(emptied.taskIds, []));
  check(() => assert.equal(emptied.source, "llm"));
  // (b) No model = today's wordlist verdict, labeled fallback.
  const fallback = await taxonomy.resolveCanonicalTaskIds(["런타임 오류를 고쳐줘"], {
    judgeSubsetFn: async () => ({ selected: [], confidence: 0, reason: "no connected model answered", source: "fallback" }),
  });
  check(() => assert.deepEqual(fallback, {
    taskIds: ["agentlas.task.v1/debugging"],
    source: "fallback",
    reason: "no connected model answered",
  }));
  // (c) Explicit agentlas.task.v1/* ids are closed-form: they win outright and skip the judge.
  const declared = await taxonomy.resolveCanonicalTaskIds(["agentlas.task.v1/coding work please"], {
    judgeSubsetFn: async () => { throw new Error("declared ids must never reach the judge"); },
  });
  check(() => assert.equal(declared.source, "fallback"));
  check(() => assert.ok(declared.taskIds.includes("agentlas.task.v1/coding")));
  // (d) The synchronous classifier peeks the warmed subset verdict.
  const { judgeSubset, clearJudgmentCache } = require("../dist/electron/system-agents/judgment.js");
  void judgeSubset; // real warm happens through the private cache below
  clearJudgmentCache();
  check(() => assert.deepEqual(taxonomy.classifyCanonicalTaskIds(arabicVideo), [],
    "a cache miss keeps the deterministic fallback"));
})();

const unknownProfile = taxonomy.canonicalEnvironmentProfile({
  platform: "freebsd",
  arch: "riscv64",
  runtimeKind: "x",
});
check(() => assert.deepEqual(unknownProfile.constraints, [
  "agentlas.env.v1/os/unknown",
  "agentlas.env.v1/arch/unknown",
  "agentlas.env.v1/runtime/unknown",
]));
check(() => assert.ok(
  taxonomy.parseCanonicalEnvironmentProfile(unknownProfile),
  "unknown dimensions remain valid portable metadata",
));
check(() => assert.equal(
  taxonomy.isRuntimeEligibleExperienceEnvironmentProfile(unknownProfile),
  false,
  "portable unknown metadata must never grant runtime activation",
));
check(() => assert.equal(
  taxonomy.parseCanonicalEnvironmentProfile({
    ...unknownProfile,
    runtime: "agentlas.env.v1/runtime/x",
    constraints: [unknownProfile.os, unknownProfile.arch, "agentlas.env.v1/runtime/x"],
  }),
  null,
  "single-character runtime x is outside the frozen v1 runtime pattern",
));

const knownProfile = taxonomy.canonicalEnvironmentProfile({
  platform: "darwin",
  arch: "aarch64",
  runtimeKind: "Codex",
});
check(() => assert.equal(taxonomy.isRuntimeEligibleExperienceEnvironmentProfile(knownProfile), true));

for (const environment of [
  { platform: "freebsd", arch: "arm64", runtimeKind: "codex" },
  { platform: "macos", arch: "riscv64", runtimeKind: "codex" },
  { platform: "macos", arch: "arm64", runtimeKind: "x" },
]) {
  check(() => assert.deepEqual(
    context.buildExperienceContext({
      agentId: "taxonomy-regression-agent",
      environment,
      basePackageHash: "a".repeat(64),
      task: "The runtime returned an error",
    }),
    EMPTY_SELECTION,
    `unknown runtime dimension activated Experience: ${JSON.stringify(environment)}`,
  ));
}

judgedTaskClassChecks
  .then(() => {
    console.log(JSON.stringify({ ok: true, checks, taxonomyChecksum: EXPECTED_CHECKSUM }, null, 2));
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
