#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const lock = require(path.join(root, "package-lock.json"));
const embeddedRuntimeRoot = path.resolve(
  root,
  process.env.HEPHAESTUS_RUNTIME_ROOT || "Hephaestus",
);
const manifest = require(path.join(embeddedRuntimeRoot, "manifest.json"));
const { parseUpdaterCompatibility } = require("../dist/electron/updater/controller.js");
const {
  MACOS_MINIMUM_SYSTEM_VERSION,
  MAC_UPDATE_MINIMUM_SYSTEM_VERSION,
  stampUpdateCompatibilityFile,
} = require("../build-resources/update-compatibility.cjs");

const compatibility = pkg.agentlasUpdateCompatibility;
const runtimeSource = pkg.agentlasBundledRuntimeSource;
assert.equal(lock.version, pkg.version, "package-lock version must match package.json before tagging");
assert.equal(lock.packages[""].version, pkg.version, "package-lock root package version must match package.json");
assert.match(
  pkg.scripts["test:terminal-ontology-loadout-feed"] ?? "",
  /^npm run build:electron && electron scripts\/test-terminal-ontology-loadout-feed\.cjs$/,
  "terminal ontology release gate must keep its Electron native-module ABI",
);
assert.match(
  pkg.scripts["test:stormbreaker-core:embedded"] ?? "",
  /HEPHAESTUS_RUNTIME_ROOT=Hephaestus[\s\S]*test-stormbreaker-core-harness\.cjs --installed/,
  "Stormbreaker release gate must execute against the embedded Agentlas OS checkout",
);
assert.match(
  pkg.scripts["test:stormbreaker-swarm"] ?? "",
  /^npm run build:electron && electron scripts\/test-stormbreaker-swarm-contract\.cjs$/,
  "Stormbreaker release gate must execute the Desktop host executor, not only the Core planner",
);
assert.equal(
  pkg.scripts["test:hephaestus-settings-migration"],
  "npm run build:electron && electron scripts/test-hephaestus-settings-migration.cjs",
  "release gates must prove fresh Network Workforce defaults and stored opt-outs",
);
assert.equal(
  pkg.scripts["test:auto-router-gates"],
  "npm run build:electron && node scripts/test-auto-router-gates.cjs",
  "release gates must prove ordinary complex prompts enter Workforce only at the top leader turn",
);
assert.equal(
  pkg.scripts["test:packaged-agent-app-mcp"],
  "node scripts/test-packaged-agent-app-mcp.cjs",
  "the packaged fuse and System Time handshake must remain directly executable",
);

function versionTuple(spec) {
  const match = String(spec || "").match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `expected a semantic version in ${spec}`);
  return match.slice(1).map(Number);
}

function assertVersionAtLeast(spec, minimum, label) {
  const actual = versionTuple(spec);
  const floor = versionTuple(minimum);
  const comparison = actual[0] - floor[0] || actual[1] - floor[1] || actual[2] - floor[2];
  assert.ok(comparison >= 0, `${label} must remain at or above ${minimum}; got ${spec}`);
}

assertVersionAtLeast(pkg.engines.node, "22.12.0", "Node runtime");
assertVersionAtLeast(pkg.devDependencies.electron, "43.1.0", "Electron");
assertVersionAtLeast(pkg.devDependencies["electron-builder"], "26.15.6", "electron-builder");
assertVersionAtLeast(pkg.dependencies["better-sqlite3"], "12.11.1", "better-sqlite3");
assert.deepEqual(parseUpdaterCompatibility(compatibility), compatibility, "runtime parser must accept the release manifest exactly");
assert.equal(compatibility.minimumSourceAppVersion, "0.7.0", "known embedded-runtime update floor is desktop v0.7.0");
assert.equal(compatibility.minimumRuntimeVersion, "1.0.4", "v0.7.0 shipped Hephaestus v1.0.4");
assert.equal(compatibility.minimumSchemaVersion, 35, "v0.7.0 shipped SQLite schema 35");
assert.equal(
  compatibility.bundledRuntimeVersion,
  "1.1.38",
  "the next Desktop patch must include the canonical first-contact bootstrap and model allocation contract",
);
assert.equal(runtimeSource.ref, `v${compatibility.bundledRuntimeVersion}`, "runtime source ref must match compatibility");
assert.match(runtimeSource.commit, /^[0-9a-f]{40}$/, "runtime source must pin an immutable full commit");
assert.equal(runtimeSource.commit, "23f441d3f3ea8db126103475a5c4857148c8ce0b", "Agentlas OS v1.1.38 commit drift");
assert.equal(compatibility.bundledRuntimeVersion, manifest.version, "feed runtime must match the bundled Hephaestus manifest");
assert.equal(
  spawnSync("git", ["-C", embeddedRuntimeRoot, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).stdout.trim(),
  runtimeSource.commit,
  "the tested embedded checkout must match the immutable package commit",
);

const dbSource = fs.readFileSync(path.join(root, "electron", "store", "db.ts"), "utf8");
const schemaMatch = dbSource.match(/const SCHEMA_VERSION = (\d+);/);
assert.ok(schemaMatch, "desktop database schema constant must remain discoverable by the release gate");
assert.equal(Number(schemaMatch[1]), compatibility.targetSchemaVersion, "release target schema must match the app migration target");

for (const configName of ["electron-builder.yml", "electron-builder.mac-stable.yml"]) {
  const configSource = fs.readFileSync(path.join(root, configName), "utf8");
  assert.doesNotMatch(
    configSource,
    /afterAllArtifactBuild/,
    `${configName} must not rely on afterAllArtifactBuild because latest*.yml is written later`,
  );
  const config = yaml.load(configSource);
  assert.deepEqual(config.electronFuses, {
    resetAdHocDarwinSignature: true,
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  }, `${configName} must keep the signed/packaged Electron execution boundary identical`);
  assert.equal(
    config.mac.minimumSystemVersion,
    MACOS_MINIMUM_SYSTEM_VERSION,
    `${configName} must encode Electron's macOS 12 runtime floor in Info.plist`,
  );
  const embeddedRuntime = config.extraResources.find((resource) => resource.from === "Hephaestus");
  assert.ok(embeddedRuntime, `${configName} must package the embedded Agentlas OS runtime`);
  assert.deepEqual(
    config.mac.extraResources,
    [{
      from: "build-resources/macos-release-signing-policy.json",
      to: "macos-release-signing-policy.json",
    }],
    `${configName} must package the exact immutable updater trust policy into macOS Resources`,
  );
  for (const deniedPath of [
    "!**/.env",
    "!**/.env.*",
    "!**/*.pem",
    "!**/*.key",
    "!**/*.p12",
    "!**/*.p8",
    "!**/signing/**",
    "!**/credentials/**",
    "!**/.memory.local/**",
    "!.agentlas/ontology-runtime.sqlite*",
    "!.agentlas/career-graph.sqlite*",
    "!.agentlas/experience-relations.jsonl*",
    "!.agentlas/.experience-relations.jsonl.*",
    "!.agentlas/field-test/**",
    "!.agentlas/field-test-report.*",
    "!.agentlas/agent-ontology/**",
    "!**/.ontology-runtime/**",
    "!**/.codex/**",
    "!**/.claude/settings.*.local.json",
  ]) {
    assert.ok(
      embeddedRuntime.filter.includes(deniedPath),
      `${configName} must exclude ignored sensitive runtime path ${deniedPath}`,
    );
  }
  assert.equal(
    embeddedRuntime.filter.includes("!**/.agentlas/**"),
    false,
    `${configName} must preserve tracked .agentlas routing, MCP, and ontology assets`,
  );
}
const crossPlatformHarness = fs.readFileSync(
  path.join(root, ".github", "workflows", "cross-platform-harness.yml"),
  "utf8",
);
assert.doesNotMatch(
  crossPlatformHarness,
  /\bnpx (?:electron|electron-builder)\b/,
  "the 3OS harness must not fetch missing Electron executables from the registry",
);
for (const guardedPath of [
  "electron/runtime/claude-code.ts",
  "electron/runtime/env-resolver.ts",
  "electron/updater.ts",
  "electron/updater/**",
  "electron/main.ts",
  "electron/secrets/vault.ts",
  "electron-builder.yml",
  "electron-builder.mac-stable.yml",
  "electron-builder.mac-local.yml",
  "build-resources/after-pack-clean.cjs",
  "build-resources/after-sign-trust.cjs",
  "build-resources/entitlements.mac.plist",
  "build-resources/macos-release-signing-policy.json",
  "build-resources/update-compatibility.cjs",
  "package-lock.json",
  ".github/workflows/release.yml",
  ".github/workflows/release-signed-mac.yml",
  "scripts/apply-web-release-env.mjs",
  "scripts/atomic-swap-mac.swift",
  "scripts/check-railway-release-access.mjs",
  "scripts/create-apple-csr.sh",
  "scripts/create-p12-from-apple-cert.sh",
  "scripts/ensure-engine.mjs",
  "scripts/install-main-only-git-guard.sh",
  "scripts/install-stable-mac.sh",
  "scripts/mac-install-transaction.mjs",
  "scripts/package-mac.sh",
  "scripts/publish-mac-release.mjs",
  "scripts/release-readiness.mjs",
  "scripts/smoke-signed-mac-python-cache.cjs",
  "scripts/stamp-update-feeds.mjs",
  "scripts/fix-mac-latest-zip.mjs",
  "scripts/verify-local-mac-candidate.mjs",
  "scripts/verify-mac-app-bundle.mjs",
  "scripts/verify-mac-install-boundary.mjs",
  "scripts/verify-mac-release.mjs",
  "scripts/verify-mac-update-lineage.mjs",
  "scripts/verify-release-assets.mjs",
  "scripts/lib/mac-app-signature.mjs",
  "scripts/test-mac-app-trust.cjs",
  "scripts/test-mac-install-transaction.cjs",
  "scripts/test-mac-release-publish-boundary.cjs",
  "scripts/test-mac-update-lineage.cjs",
  "scripts/test-ensure-engine.cjs",
  "scripts/test-install-identity.cjs",
  "scripts/test-release-asset-manifest.cjs",
  "scripts/test-runtime-update-resolution.cjs",
  "scripts/test-update-release-contract.cjs",
  "scripts/test-updater-production-contract.cjs",
  "scripts/test-updater-ui.cjs",
  "scripts/test-packaged-updater-install-e2e.cjs",
  "scripts/test-packaged-agent-app-mcp.cjs",
]) {
  assert.equal(
    crossPlatformHarness.split(`- \"${guardedPath}\"`).length - 1,
    2,
    `${guardedPath} changes must trigger both pull-request and main 3OS gates`,
  );
}
assert.match(
  crossPlatformHarness,
  /npx --no-install electron-builder --dir --publish never[\s\S]{0,500}npm run test:packaged-agent-app-mcp/,
  "the 3OS harness must verify the final packaged fuse wire and System Time child handshake",
);
assert.match(
  crossPlatformHarness,
  /name: Build and verify packaged Agent App MCP boundary[\s\S]{0,180}if: runner\.os != 'macOS'/,
  "the unsigned generic package smoke must not invoke the official macOS signing/trust boundary",
);
for (const stepName of [
  "Verify installed Core on macOS and Windows",
  "Verify Agent App MCP boundary on Linux",
  "Build and verify packaged Agent App MCP boundary",
]) {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    crossPlatformHarness,
    new RegExp(`name: ${escaped}[\\s\\S]{0,180}shell: bash`),
    `${stepName} must fail fast under Git Bash on Windows`,
  );
}
assert.match(
  crossPlatformHarness,
  /name: Verify Agent App MCP boundary on Linux[\s\S]{0,1500}npx --no-install electron --no-sandbox scripts\/test-site-agent-app-runtime\.cjs/,
  "the Linux Agent App gate must execute every Electron contract without the unavailable SUID sandbox",
);
assert.doesNotMatch(
  crossPlatformHarness,
  /name: Verify Agent App MCP boundary on Linux[\s\S]{0,250}npm run test:agent-app-runtime:prepared/,
  "the Linux Agent App gate must not hide Electron flags behind the generic prepared script",
);
for (const [stepName, command] of [
  ["Verify Agent App exact capability on macOS and Windows", "node scripts/test-site-agent-app-isolation.cjs"],
  ["Verify Agent App declared capabilities on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-capabilities.cjs"],
  ["Verify Agent App MCP consent on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-mcp-consent.cjs"],
  ["Verify Agent App prebuild MCP on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-prebuild-mcp.cjs"],
  ["Verify Agent App Claude isolation on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-claude-runtime-isolation.cjs"],
  ["Verify Agent App firm isolation on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-firm-isolation.cjs"],
  ["Verify Agent App group isolation on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-group-isolation.cjs"],
  ["Verify Agent App runtime on macOS and Windows", "npx --no-install electron scripts/test-site-agent-app-runtime.cjs"],
]) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    crossPlatformHarness,
    new RegExp(`name: ${escapedName}[\\s\\S]{0,220}shell: bash[\\s\\S]{0,120}run: ${escapedCommand}`),
    `${stepName} must remain an individually visible Git Bash gate`,
  );
}
assert.doesNotMatch(
  crossPlatformHarness,
  /runner\.os != 'Linux'[\s\S]{0,250}npm run test:agent-app-runtime:prepared/,
  "the macOS/Windows Agent App gates must not leave Electron under the PowerShell/npm wrapper",
);
assert.match(
  crossPlatformHarness,
  /name: Build and verify isolated macOS local-candidate Agent App MCP boundary[\s\S]{0,500}if: runner\.os == 'macOS'[\s\S]{0,500}npx --no-install electron-builder --dir --publish never --config electron-builder\.mac-local\.yml[\s\S]{0,500}agentlas-local-candidate-package-smoke[\s\S]{0,500}npm run test:packaged-agent-app-mcp/,
  "the unsigned macOS harness must package only the isolated local-candidate configuration",
);
assert.doesNotMatch(
  crossPlatformHarness,
  /name: Build and verify isolated macOS local-candidate Agent App MCP boundary[\s\S]{0,700}electron-builder\.mac-stable\.yml/,
  "the unsigned macOS smoke must not invoke the official stable afterSign trust boundary",
);
const crossPlatformWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const signedMacWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release-signed-mac.yml"), "utf8");
const updaterE2eRecheckWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "updater-e2e-recheck.yml"), "utf8");
const webEnvRecoveryWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "apply-desktop-release-web-env.yml"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const publishMacSource = fs.readFileSync(path.join(root, "scripts", "publish-mac-release.mjs"), "utf8");
const packageMacSource = fs.readFileSync(path.join(root, "scripts", "package-mac.sh"), "utf8");
function releaseSection(source, markerCandidates, nextBoundary, label) {
  const marker = markerCandidates.find((candidate) => source.includes(candidate));
  assert.ok(marker, `${label} is missing the current release marker`);
  const start = source.indexOf(marker);
  const next = source.indexOf(nextBoundary, start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}
const readmeReleaseSection = releaseSection(
  readme,
  ["- **Unreleased", `v${pkg.version}`],
  "\n- **",
  "README",
);
const changelogReleaseSection = releaseSection(
  changelog,
  ["## Unreleased", `## ${pkg.version}`],
  "\n## ",
  "CHANGELOG",
);
assert.match(readme, /macOS 12 Monterey or newer/);
assert.match(readme, /macOS 11 Big Sur:[\s\S]*?last compatible Agentlas release[\s\S]*?excluded/);
assert.match(
  readmeReleaseSection,
  new RegExp(`Agentlas OS v${compatibility.bundledRuntimeVersion.replace(/\./g, "\\.")}[\\s\\S]*?${runtimeSource.commit}[\\s\\S]*?(?:does not claim|does not prove|is not proof of)[\\s\\S]*?(?:published installer|public installer|update-feed release)`, "i"),
  "README current release section must bind the exact embedded runtime and keep source-versus-public-installer truth explicit",
);
assert.match(
  changelogReleaseSection,
  new RegExp(`Agentlas OS v${compatibility.bundledRuntimeVersion.replace(/\./g, "\\.")}[\\s\\S]*?${runtimeSource.commit}[\\s\\S]*?(?:do not themselves publish|does not prove|is not proof of)[\\s\\S]*?(?:Git tag|installer|update feed|GitHub release)`, "i"),
  "CHANGELOG current release section must bind the exact runtime and keep source-versus-public-release truth explicit",
);
assert.match(publishMacSource, /Requires macOS 12 Monterey or newer/);
assert.match(publishMacSource, /macOS 11 Big Sur stays on the last compatible release/);
assert.match(packageMacSource, /smoke-signed-mac-python-cache\.cjs/);
assert.match(
  packageMacSource,
  /env -i[\s\S]*\.\/node_modules\/\.bin\/electron scripts\/smoke-signed-mac-python-cache\.cjs/,
  "the signed-app Python smoke must not inherit signing, notarization, publish, or deployment secrets",
);
assert.match(
  packageMacSource,
  /codesign --verify --deep --strict[\s\S]*smoke-signed-mac-python-cache\.cjs[\s\S]*codesign --verify --deep --strict/,
  "the signed macOS app must retain its strict code seal after exercising packaged Agentlas OS Python",
);
assert.match(
  packageMacSource,
  /local builder_args=\([\s\S]*--mac "--\$\{arch\}"[\s\S]*--config electron-builder\.mac-stable\.yml[\s\S]*\)/,
  "the macOS builder command must keep a non-empty Bash 3 compatible argument array",
);
assert.doesNotMatch(
  packageMacSource,
  /local notarize_args=\(\)/,
  "the public notarized build must not expand an empty array under Bash 3 set -u",
);

function parsedWorkflow(source, name) {
  const parsed = yaml.load(source);
  assert.ok(parsed && typeof parsed === "object" && parsed.jobs, `${name} must remain valid workflow YAML`);
  return parsed;
}

function workflowSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => Array.isArray(job.steps) ? job.steps : []);
}

const workflowEntries = [
  ["release.yml", parsedWorkflow(crossPlatformWorkflow, "release.yml")],
  ["release-signed-mac.yml", parsedWorkflow(signedMacWorkflow, "release-signed-mac.yml")],
];
const parsedUpdaterE2eRecheckWorkflow = parsedWorkflow(updaterE2eRecheckWorkflow, "updater-e2e-recheck.yml");
const parsedWebEnvRecoveryWorkflow = parsedWorkflow(webEnvRecoveryWorkflow, "apply-desktop-release-web-env.yml");
const unsafeShellExpression = /\$\{\{[^}]*\b(?:inputs\.(?:tag|version|draft|apply_web_env)|github\.(?:ref_name|event\.inputs\.(?:tag|version)))\b[^}]*\}\}/;
const secretEnvNames = new Set([
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "MAC_DEVELOPER_ID_CERTIFICATE",
  "CSC_KEY_PASSWORD",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_PROJECT_ID",
]);
for (const [name, workflow] of workflowEntries) {
  assert.ok(
    workflowSteps(workflow).some((step) => typeof step.run === "string" && step.run.includes("npm run test:python-cache-boundary")),
    `${name} must execute the signed-resource Python cache boundary before packaging`,
  );
  const runtimePinnedJobs = Object.entries(workflow.jobs).filter(([, job]) => job.env?.HEPHAESTUS_REF || job.env?.HEPHAESTUS_COMMIT);
  assert.ok(runtimePinnedJobs.length > 0, `${name} must expose at least one runtime-pinned packaging job`);
  for (const [jobName, job] of runtimePinnedJobs) {
    assert.equal(
      job.env?.HEPHAESTUS_REF,
      `v${compatibility.bundledRuntimeVersion}`,
      `${name}/${jobName} must fetch the runtime version encoded in the update contract`,
    );
    assert.equal(
      job.env?.HEPHAESTUS_COMMIT,
      runtimeSource.commit,
      `${name}/${jobName} must fetch the immutable runtime commit encoded in the package source pin`,
    );
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const key of Object.keys(job.env ?? {})) {
      assert.equal(secretEnvNames.has(key), false, `${name} must not expose ${key} to the whole job`);
    }
  }
  for (const step of workflowSteps(workflow)) {
    if (typeof step.run !== "string") continue;
    assert.doesNotMatch(
      step.run,
      unsafeShellExpression,
      `${name} step ${step.name ?? "unnamed"} must move untrusted release inputs through step env`,
    );
    assert.doesNotMatch(step.run, /\$\{\{\s*secrets\./, `${name} must never interpolate secrets into shell source`);
  }

  const checkout = workflowSteps(workflow).find((step) => step.uses === "actions/checkout@v4");
  const expectedCheckoutRef = name === "release.yml"
    ? "${{ inputs.tag || github.ref }}"
    : "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}";
  assert.equal(
    checkout?.with?.ref,
    expectedCheckoutRef,
    `${name} manual releases must check out the requested tag rather than the default branch`,
  );
  assert.equal(checkout?.with?.["fetch-depth"], 0, `${name} must fetch tags for exact commit verification`);
  assert.equal(checkout?.with?.["persist-credentials"], false, `${name} must not leave a checkout token in git config for npm/tests`);
}

const crossWorkflow = workflowEntries[0][1];
const signedWorkflow = workflowEntries[1][1];
const harnessWorkflow = parsedWorkflow(crossPlatformHarness, "cross-platform-harness.yml");
const updaterUiJob = harnessWorkflow.jobs["updater-ui"];
assert.ok(updaterUiJob, "PR/main harness must run the updater renderer UI gate");
assert.equal(updaterUiJob["runs-on"], "ubuntu-latest");
const updaterUiStep = updaterUiJob.steps.find((step) => step.name === "Verify updater UI in a production renderer build");
assert.ok(updaterUiStep, "updater UI job must expose a named production-renderer gate");
assert.match(updaterUiStep.run, /npx --no-install playwright install --with-deps chromium/);
assert.match(updaterUiStep.run, /npm run test:updater-ui/);
const updaterE2eSelfTestStep = updaterUiJob.steps.find((step) => step.name === "Verify native updater E2E harness self-test");
assert.ok(updaterE2eSelfTestStep, "PR/main harness must execute the native updater E2E harness self-test");
assert.match(updaterE2eSelfTestStep.run, /node --check scripts\/test-packaged-updater-install-e2e\.cjs/);
assert.match(updaterE2eSelfTestStep.run, /node scripts\/test-packaged-updater-install-e2e\.cjs --selftest/);
const packagedUpdaterE2eSource = fs.readFileSync(path.join(root, "scripts", "test-packaged-updater-install-e2e.cjs"), "utf8");
assert.match(packagedUpdaterE2eSource, /PUBLIC_BASELINE_RELEASE_REPOSITORY = "agentlas-ai\/agentlas-desktop-releases"/);
assert.match(packagedUpdaterE2eSource, /Agentlas-0\.8\.32-Windows-x64-Setup\.exe[\s\S]*?10f17bf1172bbce56f6c54ece3f0edae86d97851d483a809f2d412e2091cb9e7/);
assert.match(packagedUpdaterE2eSource, /Agentlas-0\.8\.32-Linux-x64\.AppImage[\s\S]*?c4e2cf06f1c60f3ce684d6cd51ba87cc4ee013bfaa87786007da9ff6b7306626/);
assert.match(
  packagedUpdaterE2eSource,
  /downloadPinnedPublicBaseline[\s\S]*?assertPinnedArtifact[\s\S]*?SHA-256/,
  "native lifecycle must start from digest-pinned public v0.8.32 artifacts, not a rebuilt source checkout",
);
assert.match(
  packagedUpdaterE2eSource,
  /if \(appEnv\.DISPLAY && appEnv\.DBUS_SESSION_BUS_ADDRESS\)[\s\S]*?return startApp\(launcher, electronArgs/,
  "the Linux baseline must reuse the verifier-owned display instead of nesting a display that dies at handoff",
);
assert.match(
  packagedUpdaterE2eSource,
  /updaterCacheDir: path\.join\(process\.env\.LOCALAPPDATA, APP_NAME\)[\s\S]*?userDataDir: path\.join\(process\.env\.APPDATA, APP_NAME\)/,
  "Windows baseline and NSIS target must share the real disposable runner profile that detached relaunch resolves",
);
assert.match(
  packagedUpdaterE2eSource,
  /\(\) => windowsExecutableVersion\(installedExecutable\) === options\.targetVersion/,
  "Windows replacement must be verified from the installed executable metadata while the relaunched app owns app.asar",
);
assert.match(
  packagedUpdaterE2eSource,
  /const expectedFile = path\.join\(isolation\.userDataDir, "updater", JOURNAL_NAME\)/,
  "the durable journal observer must watch the exact profile shared by baseline and target",
);
assert.equal(
  (packagedUpdaterE2eSource.match(/const journalPromise = observer\.waitForJournal[\s\S]*?window\.agentlas\.updater\.install\(\)/g) || []).length,
  2,
  "Windows and Linux must begin journal observation before the native install handoff can create and clear it",
);
assert.match(
  packagedUpdaterE2eSource,
  /assertOfficialGithubUpdateConfig\(configPath, "installed public v0\.8\.32 baseline"\)[\s\S]*?writeLoopbackUpdateConfig\(configPath, feedUrl\)/,
  "only the disposable installed baseline may be redirected to loopback",
);
assert.match(
  packagedUpdaterE2eSource,
  /assertOfficialGithubUpdateConfig\(baselineConfig, "extracted public v0\.8\.32 baseline"\)[\s\S]*?writeLoopbackUpdateConfig\(baselineConfig, feedUrl\)[\s\S]*?linuxLauncher\(baselineAppImage[\s\S]*?baselineExtract\)/,
  "Linux must run the extracted public AppImage while APPIMAGE still identifies the pinned original",
);
assert.match(
  packagedUpdaterE2eSource,
  /const hasExactTargetIdentity = expectedTarget != null[\s\S]*?appImage[\s\S]*?commandLine[\s\S]*?if \(!hasMarker && !hasExactTargetIdentity\) continue/,
  "Linux relaunch discovery must accept the unique replaced AppImage identity even if the AppImage runtime rewrites the QA marker",
);
assert.match(
  packagedUpdaterE2eSource,
  /Linux relaunch diagnostic processes:[\s\S]*?targetExists=.*journalExists=/,
  "Linux updater failures must retain process and journal evidence instead of returning an opaque timeout",
);
assert.doesNotMatch(
  packagedUpdaterE2eSource,
  /createImmutableBaseline|baseline native package|\.updater-e2e-builder\.yml/,
  "native lifecycle must not replace the public v0.8.32 baseline with a current-CI rebuild",
);
assert.match(
  signedMacWorkflow,
  /Runtime, browser, and renderer UI regression gates[\s\S]*?npm run test:updater-production[\s\S]*?npm run test:updater-ui/,
  "the signed macOS preflight must run the updater UI gate after the updater production contract",
);
assert.equal(
  crossPlatformWorkflow.includes('default: "v0.0.3"'),
  false,
  "manual cross-platform release must require an explicit tag with no stale default",
);
for (const [name, source] of [["release.yml", crossPlatformWorkflow], ["release-signed-mac.yml", signedMacWorkflow]]) {
  assert.equal(
    source.includes('"v[0-9]+.[0-9]+.[0-9]+-*"'),
    false,
    `${name} must not auto-trigger a stable publisher for prerelease tags`,
  );
}
const crossReleaseJob = crossWorkflow.jobs["build-cross-platform"];
assert.ok(crossReleaseJob, "cross-platform workflow must retain the reusable Windows/Linux build matrix");
const crossReleaseSteps = crossReleaseJob.steps;
const boundaryRecheckIndex = crossReleaseSteps.findIndex((step) => step.name === "Reverify embedded engine release boundary");
const packageIndex = crossReleaseSteps.findIndex((step) => step.name === "Package verified Actions artifacts only");
assert.ok(boundaryRecheckIndex >= 0, "cross-platform release must recheck ignored Core files after tests");
assert.equal(crossReleaseSteps[boundaryRecheckIndex].run, "npm run ensure:engine");
assert.ok(
  packageIndex === boundaryRecheckIndex + 1,
  "cross-platform release must recheck Core immediately before electron-builder packages build-only barrier artifacts",
);
assert.match(crossReleaseSteps[packageIndex].run, /--publish never/);
assert.match(crossReleaseSteps[packageIndex].run, /stamp-update-feeds\.mjs --release-dir=release --require/);
assert.doesNotMatch(crossReleaseSteps[packageIndex].run, /--publish\s+always/);
const crossArtifactStep = crossReleaseSteps.find((step) => step.name === "Upload Windows/Linux package set for the release barrier");
assert.ok(crossArtifactStep, "Windows/Linux package matrix must upload Actions artifacts for the sole writer");
assert.equal(crossArtifactStep.uses, "actions/upload-artifact@v4");
assert.match(crossArtifactStep.with.path, /Windows-x64-Setup\.exe[\s\S]*?Linux-x64\.AppImage[\s\S]*?latest\.yml[\s\S]*?latest-linux\.yml/);
const nativeUpdaterE2eJob = crossWorkflow.jobs["updater-install-e2e"];
assert.ok(nativeUpdaterE2eJob, "the all-OS release barrier must include native updater replacement E2E");
assert.equal(nativeUpdaterE2eJob.needs, "build-cross-platform");
assert.equal(nativeUpdaterE2eJob.strategy["fail-fast"], false);
assert.deepEqual(
  nativeUpdaterE2eJob.strategy.matrix.include.map((entry) => [entry.os, entry.platform, entry.artifact_os]),
  [["windows-latest", "win32", "Windows"], ["ubuntu-latest", "linux", "Linux"]],
  "native updater E2E must run the Windows NSIS and Linux AppImage lifecycle on their matching runners",
);
const nativeUpdaterE2eSteps = nativeUpdaterE2eJob.steps;
const nativeUpdaterArtifactStep = nativeUpdaterE2eSteps.find((step) => step.name === "Download exact native release artifact");
const nativeUpdaterHarnessCheckoutStep = nativeUpdaterE2eSteps.find((step) => step.name === "Checkout immutable release verifier");
const nativeUpdaterHarnessIdentityStep = nativeUpdaterE2eSteps.find((step) => step.name === "Verify release verifier identity");
const nativeUpdaterRunStep = nativeUpdaterE2eSteps.find((step) => step.name === "Run v0.8.32 to target native updater lifecycle");
const nativeUpdaterSandboxStep = nativeUpdaterE2eSteps.find((step) => step.name === "Configure Linux updater relaunch sandbox");
assert.ok(nativeUpdaterArtifactStep, "native updater E2E must consume the exact build-barrier artifact");
assert.equal(nativeUpdaterArtifactStep.uses, "actions/download-artifact@v4");
assert.equal(nativeUpdaterArtifactStep.with.name, "agentlas-release-${{ matrix.artifact_os }}");
assert.ok(nativeUpdaterHarnessCheckoutStep, "a post-tag verifier correction must come from an explicit immutable workflow ref");
assert.equal(nativeUpdaterHarnessCheckoutStep.uses, "actions/checkout@v4");
assert.equal(nativeUpdaterHarnessCheckoutStep.with.ref, "${{ inputs.harness_ref || github.sha }}");
assert.equal(nativeUpdaterHarnessCheckoutStep.with.path, ".release-harness");
assert.equal(nativeUpdaterHarnessCheckoutStep.with["sparse-checkout"], "scripts/test-packaged-updater-install-e2e.cjs");
assert.equal(nativeUpdaterHarnessCheckoutStep.with["persist-credentials"], false);
assert.ok(nativeUpdaterHarnessIdentityStep, "the updater E2E must fail closed if the verifier checkout drifts");
assert.match(nativeUpdaterHarnessIdentityStep.run, /git -C \.release-harness rev-parse HEAD/);
assert.match(nativeUpdaterHarnessIdentityStep.run, /does not match immutable ref/);
assert.ok(nativeUpdaterRunStep, "native updater E2E must expose a named lifecycle verifier");
assert.ok(nativeUpdaterSandboxStep, "Linux updater relaunch must receive a working Chromium sandbox on hosted runners");
assert.equal(nativeUpdaterSandboxStep.if, "runner.os == 'Linux'");
assert.match(nativeUpdaterSandboxStep.run, /find node_modules\/electron -maxdepth 4 -name chrome-sandbox -print -quit/);
assert.match(nativeUpdaterSandboxStep.run, /chown root:root/);
assert.match(nativeUpdaterSandboxStep.run, /chmod 4755/);
assert.match(nativeUpdaterSandboxStep.run, /stat -c '%U:%G:%a'/);
assert.match(nativeUpdaterSandboxStep.run, /CHROME_DEVEL_SANDBOX=.*GITHUB_ENV/);
const updaterRecheckSandboxStep = workflowSteps(parsedUpdaterE2eRecheckWorkflow)
  .find((step) => step.name === "Configure Linux updater relaunch sandbox");
assert.ok(updaterRecheckSandboxStep, "artifact-only updater recheck must reproduce the Linux relaunch sandbox boundary");
assert.equal(updaterRecheckSandboxStep.if, "runner.os == 'Linux'");
assert.equal(updaterRecheckSandboxStep.run, nativeUpdaterSandboxStep.run);
assert.equal(nativeUpdaterRunStep.shell, "bash");
assert.equal(nativeUpdaterRunStep.env.CI, "true");
assert.match(
  nativeUpdaterRunStep.run,
  /\.release-harness\/scripts\/test-packaged-updater-install-e2e\.cjs[\s\S]*?--platform="\$\{\{ matrix\.platform \}\}"[\s\S]*?--artifact-dir=release[\s\S]*?--target-version="\$RESOLVED_VERSION"/,
  "native updater E2E must run only the matching package, not a simulated updater",
);
assert.match(
  nativeUpdaterRunStep.run,
  /dbus-run-session -- xvfb-run -a node "\$\{args\[@\]\}"/,
  "Linux target relaunch must inherit X11 and D-Bus sessions that outlive the baseline app",
);
assert.match(
  nativeUpdaterRunStep.run,
  /--timeout-ms=180000/,
  "native updater E2E needs a bounded lifecycle timeout",
);
const linuxContinuityStep = workflowSteps(crossWorkflow).find(
  (step) => step.name === "Linux migration and updater continuity gates",
);
assert.ok(linuxContinuityStep, "cross-platform release must retain the Linux continuity gates");
const linuxElectronInstallIndex = linuxContinuityStep.run.indexOf("node node_modules/electron/install.js");
const linuxSandboxFindIndex = linuxContinuityStep.run.indexOf("find node_modules/electron -maxdepth 4 -name chrome-sandbox");
assert.ok(
  linuxElectronInstallIndex >= 0 && linuxSandboxFindIndex > linuxElectronInstallIndex,
  "Linux setup must install Electron's lazy platform binary before looking for its SUID helper",
);
assert.match(
  linuxContinuityStep.run,
  /find node_modules\/electron -maxdepth 4 -name chrome-sandbox -print -quit/,
  "Linux setup must discover Electron's SUID helper across package layouts",
);
assert.match(
  linuxContinuityStep.run,
  /if \[ -z "\$sandbox_path" \]; then[\s\S]*?exit 1[\s\S]*?chown root:root "\$sandbox_path"/,
  "Linux setup must fail closed when the installed binary lacks its helper, then configure the discovered helper",
);
assert.doesNotMatch(
  linuxContinuityStep.run,
  /chown root:root node_modules\/electron\/dist\/chrome-sandbox/,
  "Linux setup must not assume the pre-Electron-43 sandbox path",
);
for (const requiredGate of [
  "npm run test:cli-version-parser",
  "npm run test:hephaestus-status-version",
  "npm run test:hephaestus-settings-migration",
  "npm run test:auto-router-gates",
  "npm run test:marketplace-cache",
  "npm run test:after-pack-runtime-contract",
  "npm run test:stormbreaker-core:embedded",
  "npm run test:stormbreaker-swarm",
  "npm run test:mobile-bridge-contract",
]) {
  assert.match(
    linuxContinuityStep.run,
    new RegExp(requiredGate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `Linux release must run ${requiredGate} before publishing`,
  );
}
assert.match(
  linuxContinuityStep.run,
  /npm run test:terminal-ontology-loadout-feed/,
  "Linux must run the terminal ontology DB contract through its Electron-backed package script",
);
assert.doesNotMatch(
  linuxContinuityStep.run,
  /(?:^|\n)\s*node scripts\/test-terminal-ontology-loadout-feed\.cjs/,
  "Linux must not load Electron-rebuilt better-sqlite3 from plain Node",
);
const windowsParserStep = workflowSteps(crossWorkflow).find(
  (step) => step.name === "Windows runtime and mobile contracts",
);
assert.ok(windowsParserStep, "Windows release must retain runtime and mobile contract gates");
assert.equal(windowsParserStep.if, "runner.os == 'Windows'");
assert.match(windowsParserStep.run, /npm run test:cli-version-parser/);
assert.match(windowsParserStep.run, /npm run test:after-pack-runtime-contract/);
assert.match(windowsParserStep.run, /npm run test:stormbreaker-core:embedded/);
assert.match(windowsParserStep.run, /npm run test:stormbreaker-swarm/);
assert.match(windowsParserStep.run, /npm run test:mobile-bridge-contract/);
assert.match(
  windowsParserStep.run,
  /npm run test:updater-production/,
  "Windows release artifacts must run the updater production contract before reaching the all-OS barrier",
);
const crossVerifyStep = workflowSteps(crossWorkflow).find((step) => step.name === "Verify tag matches package.json version");
const signedResolveStep = workflowSteps(signedWorkflow).find((step) => step.name === "Resolve release inputs");
for (const [name, step] of [["release.yml", crossVerifyStep], ["release-signed-mac.yml", signedResolveStep]]) {
  assert.ok(step, `${name} must validate its release identity`);
  assert.match(step.run, /semver_tag_re=/, `${name} must reject non-SemVer tag input`);
  assert.match(step.run, /refs\/tags\/\$\{tag\}\^\{commit\}/, `${name} must resolve an exact tag ref`);
  assert.match(step.run, /git rev-parse HEAD/, `${name} must compare the checkout with the tag commit`);
  assert.match(step.run, /head_commit.*tagged_commit/s, `${name} must fail when HEAD is not the tagged commit`);
  assert.match(step.run, /package-lock\.json/, `${name} must validate package-lock release identity`);
  assert.match(step.run, /lockrootver/, `${name} must validate the package-lock root package version`);
  assert.match(step.run, /HEPHAESTUS_REF#v/, `${name} must pin the packaged runtime to the update contract`);

  const regexSource = step.run.match(/semver_tag_re='([^']+)'/)?.[1];
  assert.ok(regexSource, `${name} must expose a testable tag validation expression`);
  for (const validTag of ["v0.7.34", "v1.2.3", "v2.0.0"]) {
    const result = spawnSync("bash", ["-c", '[[ "$RAW_TAG" =~ $SEMVER_TAG_RE ]]'], {
      env: { ...process.env, RAW_TAG: validTag, SEMVER_TAG_RE: regexSource },
    });
    assert.equal(result.status, 0, `${name} must accept ${validTag}`);
  }
  for (const invalidTag of ["v01.2.3", "v1.2.3-beta.1", "v2.0.0-rc-1", "v1.2.3+build", "v1.2.3$(id)", "refs/heads/main"]) {
    const result = spawnSync("bash", ["-c", '[[ "$RAW_TAG" =~ $SEMVER_TAG_RE ]]'], {
      env: { ...process.env, RAW_TAG: invalidTag, SEMVER_TAG_RE: regexSource },
    });
    assert.notEqual(result.status, 0, `${name} must reject ${invalidTag}`);
  }
}
assert.equal(crossVerifyStep.env.RAW_TAG, "${{ inputs.tag || github.ref_name }}");
assert.equal(signedResolveStep.env.RAW_TAG, "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}");
assert.match(signedResolveStep.run, /version.*!=.*\$\{tag#v\}/s, "manual version input must exactly match the validated tag");

const signedSteps = workflowSteps(signedWorkflow);
const stepNamed = (name) => signedSteps.find((step) => step.name === name);
for (const jobName of ["mac-release-preflight", "build-signed-mac-artifacts", "publish-all-platforms"]) {
  const steps = signedWorkflow.jobs[jobName].steps;
  const checkout = steps.find((step) => step.name === "Checkout immutable Mac release tooling");
  const install = steps.find((step) => step.name === "Verify and install immutable Mac release tooling");
  assert.ok(checkout && install, `${jobName} must overlay release-only fixes without moving the app tag`);
  assert.equal(checkout.uses, "actions/checkout@v4");
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with.path, ".release-tooling");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(checkout.with["sparse-checkout"], /scripts\/package-mac\.sh/);
  assert.match(checkout.with["sparse-checkout"], /scripts\/verify-mac-update-lineage\.mjs/);
  assert.match(install.run, /git -C \.release-tooling rev-parse HEAD/);
  assert.match(install.run, /tooling_commit.*GITHUB_SHA/s);
  assert.match(install.run, /cp \.release-tooling\/scripts\/package-mac\.sh scripts\/package-mac\.sh/);
  assert.match(install.run, /cp \.release-tooling\/scripts\/verify-mac-update-lineage\.mjs scripts\/verify-mac-update-lineage\.mjs/);
}
const ontologyReleaseStep = stepNamed("Experience Ontology release gates");
assert.ok(ontologyReleaseStep, "signed release must retain the Experience Ontology release gates");
assert.match(
  ontologyReleaseStep.run,
  /npm run test:terminal-ontology-loadout-feed/,
  "signed macOS must run the terminal ontology DB contract through its Electron-backed package script",
);
assert.doesNotMatch(
  ontologyReleaseStep.run,
  /(?:^|\n)\s*node scripts\/test-terminal-ontology-loadout-feed\.cjs/,
  "signed macOS must not load Electron-rebuilt better-sqlite3 from plain Node",
);
const embeddedStormbreakerStep = stepNamed("Verify embedded Stormbreaker harness");
assert.ok(embeddedStormbreakerStep, "signed macOS release must verify the embedded Stormbreaker command before packaging");
assert.equal(
  embeddedStormbreakerStep.run,
  "npm run test:stormbreaker-core:embedded\nnpm run test:stormbreaker-swarm\n",
  "signed macOS must verify both the immutable Core harness and the Desktop host executor",
);
assert.ok(
  signedSteps.indexOf(embeddedStormbreakerStep) < signedSteps.indexOf(stepNamed("Restore mac signing certificate")),
  "the embedded runtime gate must pass before signing credentials are restored",
);
for (const [name, workflow] of workflowEntries) {
  const auditStep = workflowSteps(workflow).find((step) => step.name === "Dependency security audit");
  assert.ok(auditStep, `${name} must block high-severity dependency vulnerabilities before packaging`);
  assert.equal(auditStep.run, "npm audit --audit-level=high");
}
for (const name of [
  "Ensure embedded engine (Hephaestus)",
  "Install dependencies",
  "Typecheck",
  "Runtime, browser, and renderer UI regression gates",
  "Install pinned Railway CLI",
]) {
  const step = stepNamed(name);
  assert.ok(step, `signed release must retain ${name}`);
  assert.equal(Object.keys(step.env ?? {}).some((key) => secretEnvNames.has(key)), false, `${name} must run with no release secrets`);
}
assert.equal(stepNamed("Install pinned Railway CLI").run, "npm install -g @railway/cli@5.26.0", "Railway CLI must be version-pinned outside credential-bearing steps");
assert.deepEqual(
  Object.keys(stepNamed("Check Railway release credentials").env).sort(),
  ["RAILWAY_PROJECT_ID", "RAILWAY_TOKEN"],
);
const allOsBarrier = signedWorkflow.jobs["release-artifact-barrier"];
const signedArtifactJob = signedWorkflow.jobs["build-signed-mac-artifacts"];
const publicWriterJob = signedWorkflow.jobs["publish-all-platforms"];
assert.ok(allOsBarrier, "signed workflow must retain the all-OS release barrier");
assert.ok(signedArtifactJob, "signed workflow must retain the post-barrier signed Mac artifact job");
assert.ok(publicWriterJob, "signed workflow must retain one public release writer job");
assert.deepEqual(
  allOsBarrier.needs,
  ["cross-platform-release-build", "mac-release-preflight"],
  "the all-OS barrier must wait for the reusable Windows/Linux workflow and macOS preflight",
);
assert.equal(signedArtifactJob.needs, "release-artifact-barrier");
assert.deepEqual(
  publicWriterJob.needs,
  ["release-artifact-barrier", "build-signed-mac-artifacts"],
  "the public writer must wait for every barrier-approved OS artifact",
);
const downloadBarrierArtifactsStep = stepNamed("Download every barrier-approved OS artifact");
const localAssetVerificationStep = stepNamed("Verify local required manifest and hashes before first public write");
const publicWriterStep = stepNamed("Single releases-repository writer and stable promotion");
const productionWebEnvStep = stepNamed("Apply and verify production desktop release metadata");
assert.ok(downloadBarrierArtifactsStep, "the sole writer must download all Actions barrier artifacts");
assert.ok(localAssetVerificationStep, "the sole writer must locally verify the full asset manifest before public mutation");
assert.ok(publicWriterStep, "the sole writer must be the only credential-bearing public mutation step");
assert.ok(productionWebEnvStep, "the sole writer must apply production release metadata after stable promotion");
assert.deepEqual(Object.keys(productionWebEnvStep.env).sort(), ["RAILWAY_PROJECT_ID", "RAILWAY_TOKEN"]);
assert.match(productionWebEnvStep.run, /release:web-env -- --apply --restart[\s\S]*--verify-url=https:\/\/agentlas\.cloud\/api\/desktop\/latest/);
assert.ok(
  signedSteps.indexOf(publicWriterStep) < signedSteps.indexOf(productionWebEnvStep),
  "production web metadata must never lead the public release writer",
);
const recoverySteps = workflowSteps(parsedWebEnvRecoveryWorkflow);
const recoveryDownloadStep = recoverySteps.find((step) => step.name === "Download published verified release metadata");
const recoveryApplyStep = recoverySteps.find((step) => step.name === "Apply and verify production desktop release metadata");
assert.ok(recoveryDownloadStep, "web env recovery must download metadata from the already-published release");
assert.ok(recoveryApplyStep, "web env recovery must apply and verify production metadata");
assert.match(recoveryDownloadStep.run, /gh release download[\s\S]*desktop-release\.production\.env/);
assert.deepEqual(Object.keys(recoveryApplyStep.env).sort(), ["RAILWAY_PROJECT_ID", "RAILWAY_TOKEN"]);
assert.equal(downloadBarrierArtifactsStep.uses, "actions/download-artifact@v4");
assert.equal(downloadBarrierArtifactsStep.with.pattern, "agentlas-release-*");
assert.equal(downloadBarrierArtifactsStep.with["merge-multiple"], true);
assert.match(localAssetVerificationStep.run, /npm run release:assets:verify[\s\S]*?--release-dir=release/);
assert.match(publicWriterStep.run, /npm run release:mac:publish/);
assert.ok(
  signedSteps.indexOf(downloadBarrierArtifactsStep) < signedSteps.indexOf(localAssetVerificationStep) &&
    signedSteps.indexOf(localAssetVerificationStep) < signedSteps.indexOf(publicWriterStep),
  "all barrier artifacts must be downloaded and locally checked before the only release-token step",
);
assert.deepEqual(
  Object.keys(publicWriterStep.env).sort(),
  ["GH_TOKEN", "GITHUB_TOKEN"],
);
assert.equal(
  publicWriterStep.env.GH_TOKEN,
  "${{ secrets.AGENTLAS_DESKTOP_RELEASE_TOKEN }}",
  "cross-repo publish must use the dedicated PAT without a source-repo GITHUB_TOKEN fallback",
);
assert.equal(signedWorkflow.permissions.contents, "read", "the public source workflow must not request source-repository contents:write");
assert.deepEqual(
  Object.keys(stepNamed("Build, sign, notarize, and verify Mac artifacts").env).sort(),
  ["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_ID", "APPLE_TEAM_ID", "CSC_KEY_PASSWORD"],
);
assert.ok(
  signedSteps.indexOf(stepNamed("Restore mac signing certificate")) >
    signedSteps.indexOf(stepNamed("Runtime, browser, and renderer UI regression gates")),
  "the signing certificate must not exist on disk during npm install or regression tests",
);
const signedRegressionRun = stepNamed("Runtime, browser, and renderer UI regression gates").run;
for (const requiredGate of [
  "npm run test:automations-store",
  "npm run test:cli-version-parser",
  "npm run test:hephaestus-status-version",
  "npm run test:marketplace-cache",
  "npm run test:after-pack-runtime-contract",
  "npm run test:mobile-bridge-contract",
  "npm run test:mobile-execution-boundary",
  "npm run test:runtime-resume-contract",
  "npm run test:cli-image-attachments",
  "npm run test:owned-agent-runtime-prompts",
  "npm run test:independent-terminal-boundary",
  "npm run test:grok-runtime-contract",
  "npm run test:grok-auth-source",
  "npm run test:oberon-provider-routing",
  "npm run test:telegram-connect-atomicity",
  "npm run test:telegram-api-timeout",
  "npm run test:document-studio-draft-persistence",
  "npm run test:prompts-start-failure-ui",
  "npm run test:settings-resilience-ui",
  "npm run test:engine-auto-toggle-ui",
  "npm run test:startup-founder-new-idea",
  "npm run test:trex-ui",
  "npm run test:trex-attachments-ui",
  "node scripts/qa-chat-input-routing.cjs",
  "AGENTLAS_QA_LOCALE=en node scripts/qa-chat-input-routing.cjs",
  "npm run test:all-routes-ui",
]) {
  assert.match(signedRegressionRun, new RegExp(requiredGate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const afterPackSource = fs.readFileSync(path.join(root, "build-resources", "after-pack-clean.cjs"), "utf8");
assert.match(afterPackSource, /packagedRoot[\s\S]*?Hephaestus/);
assert.match(afterPackSource, /packagedManifest\.version !== sourceManifest\.version/);
assert.match(afterPackSource, /compatibilityVersion !== sourceManifest\.version/);
assert.match(afterPackSource, /HEPHAESTUS_REF mismatch/);
assert.match(afterPackSource, /agentlas_cloud[\s\S]*?__main__\.py/);
assert.match(
  afterPackSource,
  /MODEL2VEC_ASSET_PARTS = \["assets", "model2vec", "potion-base-8M-int8"\]/,
  "afterPack must verify the exact packaged Model2Vec release directory",
);
for (const requiredModelFile of [
  "manifest.json",
  "embeddings.i8",
  "scales.f32le",
  "tokenizer.json",
  "LICENSE.model.txt",
]) {
  assert.match(
    afterPackSource,
    new RegExp(requiredModelFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `afterPack must require packaged Model2Vec file ${requiredModelFile}`,
  );
}
assert.match(
  afterPackSource,
  /createHash\("sha256"\)[\s\S]*?contentSha256 !== manifest\.contentSha256/,
  "afterPack must hash Model2Vec payloads and verify the manifest content identity",
);
assert.match(
  afterPackSource,
  /packagedModel\.manifestSha256 !== sourceModel\.manifestSha256/,
  "afterPack must reject packaged Model2Vec manifest metadata drift",
);
assert.match(
  afterPackSource,
  /packagedModel\.contentSha256 !== sourceModel\.contentSha256/,
  "afterPack must reject packaged Model2Vec content that drifts from the pinned source runtime",
);
for (const configName of ["electron-builder.yml", "electron-builder.mac-stable.yml"]) {
  const config = yaml.load(fs.readFileSync(path.join(root, configName), "utf8"));
  assert.equal(
    config.afterPack,
    "build-resources/after-pack-clean.cjs",
    `${configName} must run the embedded Agentlas OS gate before publish`,
  );
}

const packageBarrierStep = crossReleaseSteps.find((step) => step.name === "Package verified Actions artifacts only");
assert.match(
  packageBarrierStep.run,
  /npx electron-builder \$\{\{ matrix\.builder_args \}\} --publish never[\s\S]*?node scripts\/stamp-update-feeds\.mjs --release-dir=release --require/,
  "cross-platform feeds must be stamped only after build-only electron-builder output exists",
);
assert.doesNotMatch(
  crossPlatformWorkflow,
  /gh release (?:create|upload|edit)/,
  "the reusable Windows/Linux workflow must contain no public-release mutation path",
);
assert.match(
  signedMacWorkflow,
  /publish-all-platforms:[\s\S]*?Download every barrier-approved OS artifact[\s\S]*?Verify local required manifest and hashes before first public write[\s\S]*?Single releases-repository writer and stable promotion/,
  "only the signed writer job may cross the public release boundary after the full artifact barrier",
);
const mainSource = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
const readyBlock = mainSource.slice(mainSource.indexOf("app.whenReady().then"));
const preflightIndex = readyBlock.indexOf("preflightUpdaterStartup()");
const migrationIndex = readyBlock.indexOf("initStore();");
const fullCheckIndex = readyBlock.indexOf("await initAutoUpdater();");
const materializeIndex = readyBlock.indexOf("materializeAllAgents();");
const backgroundIndex = readyBlock.indexOf("startAutomationScheduler();");
assert.ok(
  preflightIndex >= 0 &&
    migrationIndex > preflightIndex &&
    fullCheckIndex > migrationIndex &&
    materializeIndex > fullCheckIndex &&
    backgroundIndex > fullCheckIndex,
  "startup must gate recovery before migration, then verify continuity before materialization/background writers",
);
const headlessBlock = readyBlock.slice(
  readyBlock.indexOf('if (process.argv.includes("--headless-automations"))'),
  readyBlock.indexOf("registerRendererProtocol();"),
);
assert.match(
  headlessBlock,
  /if \(updatePreflight\.pendingInstall\)[\s\S]*?app\.quit\(\);[\s\S]*?return;[\s\S]*?initStore\(\);/,
  "a pending update must stop the headless runner before it can migrate or run background automations",
);
for (const scriptName of ["stamp-update-feeds.mjs", "fix-mac-latest-zip.mjs"]) {
  const source = fs.readFileSync(path.join(root, "scripts", scriptName), "utf8");
  assert.match(source, /fileURLToPath\(new URL\(/, `${scriptName} must convert file URLs portably on Windows`);
  assert.doesNotMatch(source, /new URL\([^\n]+\.pathname/, `${scriptName} must not treat URL pathnames as filesystem paths`);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-update-feed-"));
  try {
    const releaseDir = path.join(temp, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, `Agentlas-${pkg.version}-arm64.zip`), "arm64-zip");
    fs.writeFileSync(path.join(releaseDir, `Agentlas-${pkg.version}-x64.zip`), "x64-zip");
    const fixed = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "fix-mac-latest-zip.mjs"), `--release-dir=${releaseDir}`],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
    const latestMacPath = path.join(releaseDir, "latest-mac.yml");
    const latestMacSource = fs.readFileSync(latestMacPath, "utf8");
    const latestMac = yaml.load(latestMacSource);
    assert.deepEqual(latestMac.agentlasCompatibility, compatibility);
    assert.equal(
      latestMac.minimumSystemVersion,
      MAC_UPDATE_MINIMUM_SYSTEM_VERSION,
      "mac update feed must use the Darwin 21 kernel floor expected by electron-updater",
    );
    assert.deepEqual(
      latestMac.files.map((file) => file.url).sort(),
      [`Agentlas-${pkg.version}-arm64.zip`, `Agentlas-${pkg.version}-x64.zip`].sort(),
      "mac compatibility stamping must preserve both architecture-specific zip artifacts",
    );
    assert.ok(latestMac.files.every((file) => file.url.endsWith(".zip")), "mac update feed must use Squirrel-compatible zip files");
    assert.equal((latestMacSource.match(/^agentlasCompatibility:/gm) || []).length, 1);
    assert.equal((latestMacSource.match(/^minimumSystemVersion:/gm) || []).length, 1);
    stampUpdateCompatibilityFile(latestMacPath, path.join(root, "package.json"));
    const restampedMacSource = fs.readFileSync(latestMacPath, "utf8");
    assert.equal((restampedMacSource.match(/^agentlasCompatibility:/gm) || []).length, 1, "compatibility stamping must be idempotent");
    assert.equal((restampedMacSource.match(/^minimumSystemVersion:/gm) || []).length, 1, "system compatibility stamping must be idempotent");
    assert.equal(yaml.load(restampedMacSource).minimumSystemVersion, MAC_UPDATE_MINIMUM_SYSTEM_VERSION);

    const crossDir = path.join(temp, "cross-platform");
    fs.mkdirSync(crossDir, { recursive: true });
    const latest = path.join(crossDir, "latest.yml");
    const latestLinux = path.join(crossDir, "latest-linux.yml");
    fs.writeFileSync(latest, `version: ${pkg.version}\npath: Agentlas.exe\nsha512: abc\n`);
    fs.writeFileSync(latestLinux, `version: ${pkg.version}\npath: Agentlas.AppImage\nsha512: def\n`);
    const stamped = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "stamp-update-feeds.mjs"), `--release-dir=${crossDir}`, "--require"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(stamped.status, 0, stamped.stderr || stamped.stdout);
    for (const file of [latest, latestLinux]) {
      const parsed = yaml.load(fs.readFileSync(file, "utf8"));
      assert.deepEqual(parsed.agentlasCompatibility, compatibility);
      assert.equal(parsed.minimumSystemVersion, undefined, "Darwin's kernel floor must not leak into Windows/Linux feeds");
    }

    console.log("test-update-release-contract: PASS (macOS 12/Darwin 21 + mac zip + cross-platform compatibility feeds)");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
