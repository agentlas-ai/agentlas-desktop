#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const SCOPE_KEYS = ["fast", "core", "one", "agent_app", "updater", "packaging"];

const normalizePath = (value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stripReleaseVersion = (file, input) => {
  const copy = structuredClone(input);
  if (file === "package.json") {
    delete copy.version;
    return copy;
  }
  if (file === "package-lock.json") {
    delete copy.version;
    if (copy.packages && copy.packages[""]) delete copy.packages[""].version;
    return copy;
  }
  return copy;
};

const packageJsonChangeIsVersionOnly = (file, before, after) => {
  assert.ok(file === "package.json" || file === "package-lock.json", `unsupported package file: ${file}`);
  return stableJson(stripReleaseVersion(file, before)) === stableJson(stripReleaseVersion(file, after));
};

const allScopes = (reason) => ({
  fast: true,
  core: true,
  one: true,
  agent_app: true,
  updater: true,
  packaging: true,
  metadata_only: false,
  reasons: [reason],
});

const isDocumentation = (file) =>
  /^(?:README(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|docs\/|\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)\/)/i.test(
    file,
  ) || /\.(?:md|mdx|txt)$/i.test(file);

const matchesAny = (file, patterns) => patterns.some((pattern) => pattern.test(file));

const onePatterns = [
  /^electron\/one\//,
  /^renderer\/components\/one\//,
  /^shared\/one-[^/]+\.ts$/,
  /^scripts\/verify-one-[^/]+\.cjs$/,
  /^scripts\/verify-agentlas-one-ui\.cjs$/,
];

const updaterPatterns = [
  /^electron\/updater(?:\.ts|\/)/,
  /^renderer\/components\/(?:UpdateBanner|VersionChip)\.tsx$/,
  /^renderer\/app\/\(shell\)\/settings\/page\.tsx$/,
  /^scripts\/(?:atomic-swap-mac\.swift|install-stable-mac\.sh|mac-install-transaction\.mjs)$/,
  /^scripts\/(?:verify-mac-(?:app-bundle|install-boundary|release|update-lineage)\.mjs)$/,
  /^scripts\/(?:test-(?:mac-app-trust|mac-install-transaction|mac-update-lineage|install-identity|runtime-update-resolution|update-release-contract|updater-production-contract|updater-ui|packaged-updater-install-e2e)\.cjs)$/,
  /^scripts\/lib\/mac-app-signature\.mjs$/,
  /^build-resources\/(?:after-sign-trust\.cjs|entitlements\.mac\.plist|macos-release-signing-policy\.json|update-compatibility\.cjs)$/,
];

const packagingPatterns = [
  /^electron-builder(?:\.[^/]+)?\.yml$/,
  /^build-resources\//,
  /^scripts\/(?:ensure-engine\.mjs|fetch-(?:python|node)-runtime\.mjs|package-mac\.sh)$/,
  /^scripts\/(?:publish-mac-release|release-(?:preflight|readiness)|verify-release-assets|stamp-update-feeds|fix-mac-latest-zip)\.mjs$/,
  /^scripts\/(?:smoke-signed-mac-python-cache|verify-packaged-workforce-runtime)\.cjs$/,
  /^scripts\/(?:test-(?:after-pack-runtime-contract|ensure-engine|release-asset-manifest|mac-release-publish-boundary|packaged-agent-app-mcp)\.cjs)$/,
  /^scripts\/(?:apply-web-release-env|check-railway-release-access)\.mjs$/,
  /^scripts\/(?:create-apple-csr|create-p12-from-apple-cert|install-main-only-git-guard)\.sh$/,
];

const agentAppPatterns = [
  /^electron\/invocation\//,
  /^electron\/site\/agent-app-[^/]+\.ts$/,
  /^electron\/site\/store\.ts$/,
  /^shared\/site-studio\.ts$/,
  /^scripts\/test-site-agent-app-[^/]+\.cjs$/,
  /^scripts\/test-packaged-agent-app-mcp\.cjs$/,
  /^electron\/mcp\/(?:client|borrowed-task-force|workforce-orchestrator|workforce-tool-inventory)\.ts$/,
];

const corePatterns = [
  /^electron\/invocation\//,
  /^electron\/hephaestus\//,
  /^electron\/agents\/auto-router\.ts$/,
  /^electron\/architecture\//,
  /^electron\/memory\//,
  /^electron\/experience\//,
  /^electron\/mcp\//,
  /^electron\/mcp-tools\//,
  /^electron\/runtime\//,
  /^electron\/secrets\/vault\.ts$/,
  // 그래프 커널과 그 둘레(스케줄러·실행 스토어·결과 판정)는 부수효과가 바깥으로 나가는
  // 경로다. 여기 없으면 커널을 고쳐도 CI가 코어 게이트를 돌리지 않는다 — 실제로 그랬다.
  /^electron\/workflow\//,
  /^electron\/automation-scheduler\.ts$/,
  /^electron\/automation-result\.ts$/,
  /^electron\/store\/automations\.ts$/,
  /^electron\/store\/graph-reconciliation\.ts$/,
  // 자연어로 그래프를 만드는 계약. 여기가 갈라지면 표면마다 다른 그래프가 만들어진다.
  /^shared\/graph-blueprint\.ts$/,
  /^shared\/automation-tool-policy\.ts$/,
  /^shared\/graph-tool-binding\.ts$/,
  /^shared\/graph-trigger-input\.ts$/,
  // 도구 중개·바깥 표면·레지스트리·저작 화면도 같은 이유로 코어다 — 여기가 바뀌면
  // 부수효과가 나가는 방식이나 사람이 만들 수 있는 것이 바뀐다.
  /^shared\/graph-tool-broker\.ts$/,
  /^shared\/graph-run-request\.ts$/,
  /^shared\/graph-node-protocol\.ts$/,
  /^shared\/graph-registry\//,
  /^electron\/graph-surface\//,
  /^renderer\/lib\/workflow-validate\.ts$/,
  /^renderer\/components\/automation\//,
  /^renderer\/app\/\(shell\)\/automation\//,
  // 자식 프로세스 출력 디코딩 — 여기가 깨지면 결과물의 한글이 깨진다.
  /^electron\/runtime\//,
  /^scripts\/lib\/agentlas-core-root\.cjs$/,
  /^scripts\/test-(?:project-bootstrap-(?:desktop|core)|project-memory-read-boundary|model2vec-hybrid-parity|memory-hybrid-retrieval|curator-nest-core-query|curator-trust-gate|v56-experience-cloud-migration|codex-model-discovery|workload-routing|build-workload-routing|hephaestus-settings-migration|auto-router-gates|stormbreaker-core-harness|stormbreaker-swarm-contract|swarm-engine|automation-result-contract|graph-kernel-contract|graph-canvas-ui|graph-patch-contract|graph-architect-contract|graph-interview-contract|graph-tool-binding-contract|graph-connections-ui|automation-honesty-contract|graph-describe-ui|stream-decode-contract|owned-agent-runtime-prompts|borrowed-task-force|borrowed-agent-fail-closed|graph-scenarios|graph-loop-authoring|graph-authorability|graph-tool-broker-contract|graph-surface-contract|interview-loop-live|graph-progress-live|graph-registry-conformance|graph-node-protocol-contract|graph-run-request-contract|graph-canvas-parity|graph-progress-contract|run-status-split-contract|run-status-stream-contract)\.cjs$/,
];

const planScopes = (rawFiles, options = {}) => {
  const files = [...new Set(rawFiles.map(normalizePath).filter(Boolean))].sort();
  if (options.forceAll) return { ...allScopes(options.forceReason || "manual or fail-closed full run"), files };
  if (files.length === 0) return { ...allScopes("empty or unavailable diff; fail-closed full run"), files };

  const state = Object.fromEntries(SCOPE_KEYS.map((key) => [key, false]));
  state.metadata_only = false;
  state.reasons = [];
  let meaningfulFiles = 0;

  const enable = (scope, file) => {
    state[scope] = true;
    state.reasons.push(`${scope}:${file}`);
  };

  for (const file of files) {
    if (isDocumentation(file)) continue;
    meaningfulFiles += 1;

    if (file === "package.json" || file === "package-lock.json") {
      if (options.packageMetadataOnly === true) {
        state.reasons.push(`release-metadata:${file}`);
        continue;
      }
      return { ...allScopes(`dependency or package contract changed: ${file}`), files };
    }

    if (
      file.startsWith(".github/workflows/") ||
      file === "scripts/ci-scope-plan.cjs"
    ) {
      return { ...allScopes(`CI control plane changed: ${file}`), files };
    }

    if (
      file === "electron/main.ts" ||
      file === "electron/ipc.ts" ||
      file === "electron/preload.ts" ||
      file === "shared/types.ts"
    ) {
      return { ...allScopes(`cross-cutting Desktop boundary changed: ${file}`), files };
    }

    let matched = false;
    if (matchesAny(file, onePatterns)) {
      enable("one", file);
      matched = true;
    }
    if (matchesAny(file, updaterPatterns)) {
      enable("updater", file);
      matched = true;
    }
    if (matchesAny(file, packagingPatterns)) {
      enable("packaging", file);
      matched = true;
    }
    if (matchesAny(file, agentAppPatterns)) {
      enable("agent_app", file);
      matched = true;
    }
    if (matchesAny(file, corePatterns)) {
      enable("core", file);
      matched = true;
    }

    if (file === "electron/hephaestus/commands.ts") {
      enable("one", file);
      enable("core", file);
      matched = true;
    }

    if (!matched && /^scripts\/(?:test|verify|proof|smoke)-/.test(file)) {
      return { ...allScopes(`unclassified verifier changed: ${file}`), files };
    }

    if (!matched && file.startsWith("scripts/")) {
      return { ...allScopes(`unclassified executable CI input changed: ${file}`), files };
    }

    if (!matched && /^(?:electron|renderer|shared)\//.test(file)) {
      enable("fast", file);
      matched = true;
    }

    if (!matched) return { ...allScopes(`unclassified CI-triggering path changed: ${file}`), files };
  }

  const selectedFeatureScope = SCOPE_KEYS.some((key) => key !== "fast" && state[key]);
  if (selectedFeatureScope && !state.fast) {
    state.fast = true;
    state.reasons.push("fast:shared TypeScript contract for affected source");
  }
  const enabled = SCOPE_KEYS.some((key) => state[key]);
  state.metadata_only = meaningfulFiles > 0 && !enabled;
  if (meaningfulFiles === 0) state.reasons.push("documentation-only change");
  if (state.metadata_only) state.reasons.push("release version metadata only");
  return { ...state, files };
};

const parseArgs = (argv) => {
  const output = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) output[match[1]] = match[2];
    else if (arg.startsWith("--")) output[arg.slice(2)] = true;
  }
  return output;
};

const gitJsonAt = (ref, file) => JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" }));

const packageFilesAreMetadataOnly = (files, base, head) => {
  const packageFiles = files.filter((file) => file === "package.json" || file === "package-lock.json");
  if (packageFiles.length === 0) return false;
  try {
    return packageFiles.every((file) => packageJsonChangeIsVersionOnly(file, gitJsonAt(base, file), gitJsonAt(head, file)));
  } catch {
    return false;
  }
};

const changedFilesBetween = (base, head) => {
  const output = execFileSync("git", ["diff", "--name-only", "-z", base, head], { encoding: "utf8" });
  return output.split("\0").map(normalizePath).filter(Boolean);
};

const writeGithubOutput = (plan) => {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    ...SCOPE_KEYS.map((key) => `${key}=${plan[key] ? "true" : "false"}`),
    `metadata_only=${plan.metadata_only ? "true" : "false"}`,
    `changed_count=${plan.files.length}`,
  ];
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
};

const writeSummary = (plan) => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = SCOPE_KEYS.map((key) => `| ${key} | ${plan[key] ? "run" : "skip"} |`).join("\n");
  const files = plan.files.length ? plan.files.map((file) => `- \`${file}\``).join("\n") : "- none";
  const reasons = plan.reasons.length ? plan.reasons.map((reason) => `- ${reason}`).join("\n") : "- none";
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Desktop CI scope plan\n\n| Scope | Decision |\n| --- | --- |\n${rows}\n\n### Changed files\n${files}\n\n### Reasons\n${reasons}\n`,
  );
};

const selfTest = () => {
  const enabled = (plan) => SCOPE_KEYS.filter((key) => plan[key]);
  assert.deepEqual(enabled(planScopes(["renderer/components/one/OneShell.tsx"])), ["fast", "one"]);
  assert.deepEqual(enabled(planScopes(["electron/updater/controller.ts"])), ["fast", "updater"]);
  assert.deepEqual(enabled(planScopes(["electron/site/agent-app-runtime.ts"])), ["fast", "agent_app"]);
  assert.deepEqual(enabled(planScopes(["electron/memory/store.ts"])), ["fast", "core"]);
  assert.deepEqual(enabled(planScopes(["renderer/components/ChatInput.tsx"])), ["fast"]);
  assert.deepEqual(enabled(planScopes(["electron/mcp/client.ts"])), ["fast", "core", "agent_app"]);
  assert.deepEqual(enabled(planScopes(["electron/invocation/service.ts"])), ["fast", "core", "agent_app"]);
  assert.deepEqual(enabled(planScopes(["electron/preload.ts"])), SCOPE_KEYS);
  assert.deepEqual(enabled(planScopes(["scripts/lib/mock-agentlas-bridge.cjs"])), SCOPE_KEYS);
  assert.deepEqual(enabled(planScopes(["scripts/new-build-input.mjs"])), SCOPE_KEYS);
  assert.deepEqual(enabled(planScopes(["electron-builder.yml"])), ["fast", "packaging"]);
  assert.deepEqual(enabled(planScopes(["electron/one/store.ts", "electron/updater.ts"])), ["fast", "one", "updater"]);
  assert.deepEqual(enabled(planScopes(["electron/main.ts"])), SCOPE_KEYS);
  assert.deepEqual(enabled(planScopes([".github/workflows/cross-platform-harness.yml"])), SCOPE_KEYS);
  assert.deepEqual(enabled(planScopes(["scripts/test-new-unclassified-boundary.cjs"])), SCOPE_KEYS);

  const metadataPlan = planScopes(["package.json", "package-lock.json", "CHANGELOG.md"], {
    packageMetadataOnly: true,
  });
  assert.deepEqual(enabled(metadataPlan), []);
  assert.equal(metadataPlan.metadata_only, true);
  assert.deepEqual(enabled(planScopes(["package.json"], { packageMetadataOnly: false })), SCOPE_KEYS);
  assert.deepEqual(enabled(planScopes(["README.md", "docs/PUBLIC-RELEASE.md"])), []);

  const packageBefore = {
    name: "agentlas-desktop",
    version: "0.8.64",
    dependencies: { electron: "1.0.0" },
  };
  const packageAfter = { ...packageBefore, version: "0.8.65" };
  assert.equal(packageJsonChangeIsVersionOnly("package.json", packageBefore, packageAfter), true);
  packageAfter.dependencies = { electron: "2.0.0" };
  assert.equal(packageJsonChangeIsVersionOnly("package.json", packageBefore, packageAfter), false);

  const lockBefore = {
    name: "agentlas-desktop",
    version: "0.8.64",
    packages: { "": { name: "agentlas-desktop", version: "0.8.64" }, "node_modules/a": { version: "1.0.0" } },
  };
  const lockAfter = structuredClone(lockBefore);
  lockAfter.version = "0.8.65";
  lockAfter.packages[""].version = "0.8.65";
  assert.equal(packageJsonChangeIsVersionOnly("package-lock.json", lockBefore, lockAfter), true);
  lockAfter.packages["node_modules/a"].version = "1.0.1";
  assert.equal(packageJsonChangeIsVersionOnly("package-lock.json", lockBefore, lockAfter), false);
  process.stdout.write("ci-scope-plan self-test: PASS\n");
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args["self-test"] === true) {
    selfTest();
    return;
  }
  const event = String(args.event || process.env.GITHUB_EVENT_NAME || "local");
  const base = String(args.base || "");
  const head = String(args.head || "HEAD");
  const zeroBase = /^0+$/.test(base);
  let files = [];
  let forceAll = args["force-all"] === true || event === "workflow_dispatch" || zeroBase || !base;
  let forceReason = event === "workflow_dispatch" ? "manual full CI requested" : "missing or initial base SHA";

  if (!forceAll) {
    try {
      files = changedFilesBetween(base, head);
    } catch (error) {
      forceAll = true;
      forceReason = `git diff unavailable: ${error.message}`;
    }
  }

  const packageMetadataOnly = !forceAll && packageFilesAreMetadataOnly(files, base, head);
  const plan = planScopes(files, { forceAll, forceReason, packageMetadataOnly });
  writeGithubOutput(plan);
  writeSummary(plan);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
};

if (require.main === module) main();

module.exports = {
  packageJsonChangeIsVersionOnly,
  planScopes,
  stripReleaseVersion,
};
