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
const manifest = require(path.join(root, "Hephaestus", "manifest.json"));
const { parseUpdaterCompatibility } = require("../dist/electron/updater/controller.js");
const {
  MACOS_MINIMUM_SYSTEM_VERSION,
  MAC_UPDATE_MINIMUM_SYSTEM_VERSION,
  stampUpdateCompatibilityFile,
} = require("../build-resources/update-compatibility.cjs");

const compatibility = pkg.agentlasUpdateCompatibility;
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
assert.equal(compatibility.bundledRuntimeVersion, manifest.version, "feed runtime must match the bundled Hephaestus manifest");

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
  assert.equal(
    config.mac.minimumSystemVersion,
    MACOS_MINIMUM_SYSTEM_VERSION,
    `${configName} must encode Electron's macOS 12 runtime floor in Info.plist`,
  );
}
const crossPlatformWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const signedMacWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release-signed-mac.yml"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const publishMacSource = fs.readFileSync(path.join(root, "scripts", "publish-mac-release.mjs"), "utf8");
assert.match(readme, /macOS 12 Monterey or newer/);
assert.match(readme, /macOS 11 Big Sur:[\s\S]*?last compatible Agentlas release[\s\S]*?excluded/);
assert.match(publishMacSource, /Requires macOS 12 Monterey or newer/);
assert.match(publishMacSource, /macOS 11 Big Sur stays on the last compatible release/);

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
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(
      job.env?.HEPHAESTUS_REF,
      `v${compatibility.bundledRuntimeVersion}`,
      `${name} must fetch the runtime version encoded in the update contract`,
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
  assert.equal(
    checkout?.with?.ref,
    "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}",
    `${name} manual releases must check out the requested tag rather than the default branch`,
  );
  assert.equal(checkout?.with?.["fetch-depth"], 0, `${name} must fetch tags for exact commit verification`);
  assert.equal(checkout?.with?.["persist-credentials"], false, `${name} must not leave a checkout token in git config for npm/tests`);
}

const crossWorkflow = workflowEntries[0][1];
const signedWorkflow = workflowEntries[1][1];
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
  "npm run test:marketplace-cache",
  "npm run test:after-pack-runtime-contract",
  "npm run test:stormbreaker-core:embedded",
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
assert.match(windowsParserStep.run, /npm run test:mobile-bridge-contract/);
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
  for (const validTag of ["v0.7.34", "v1.2.3-beta.1", "v2.0.0-rc-1"]) {
    const result = spawnSync("bash", ["-c", '[[ "$RAW_TAG" =~ $SEMVER_TAG_RE ]]'], {
      env: { ...process.env, RAW_TAG: validTag, SEMVER_TAG_RE: regexSource },
    });
    assert.equal(result.status, 0, `${name} must accept ${validTag}`);
  }
  for (const invalidTag of ["v01.2.3", "v1.2.3-01", "v1.2.3+build", "v1.2.3$(id)", "refs/heads/main"]) {
    const result = spawnSync("bash", ["-c", '[[ "$RAW_TAG" =~ $SEMVER_TAG_RE ]]'], {
      env: { ...process.env, RAW_TAG: invalidTag, SEMVER_TAG_RE: regexSource },
    });
    assert.notEqual(result.status, 0, `${name} must reject ${invalidTag}`);
  }
}
assert.equal(crossVerifyStep.env.RAW_TAG, "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}");
assert.equal(signedResolveStep.env.RAW_TAG, "${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}");
assert.match(signedResolveStep.run, /version.*!=.*\$\{tag#v\}/s, "manual version input must exactly match the validated tag");

const signedSteps = workflowSteps(signedWorkflow);
const stepNamed = (name) => signedSteps.find((step) => step.name === name);
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
assert.equal(embeddedStormbreakerStep.run, "npm run test:stormbreaker-core:embedded");
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
assert.deepEqual(
  Object.keys(stepNamed("Apply Railway web release env").env).sort(),
  ["RAILWAY_PROJECT_ID", "RAILWAY_TOKEN"],
);
assert.deepEqual(
  Object.keys(stepNamed("Publish verified release (public releases repo)").env).sort(),
  ["GH_TOKEN", "GITHUB_TOKEN"],
);
assert.equal(
  stepNamed("Publish verified release (public releases repo)").env.GH_TOKEN,
  "${{ secrets.AGENTLAS_DESKTOP_RELEASE_TOKEN }}",
  "cross-repo publish must use the dedicated PAT without a source-repo GITHUB_TOKEN fallback",
);
assert.equal(signedWorkflow.permissions.contents, "read", "the private source workflow must not request contents:write");
assert.deepEqual(
  Object.keys(stepNamed("Build, sign, notarize, and verify DMGs").env).sort(),
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
  "npm run test:independent-terminal-boundary",
  "npm run test:grok-runtime-contract",
  "npm run test:grok-auth-source",
  "npm run test:oberon-provider-routing",
  "npm run test:telegram-connect-atomicity",
  "npm run test:telegram-api-timeout",
  "npm run test:document-studio-draft-persistence",
  "npm run test:prompts-start-failure-ui",
  "npm run test:settings-resilience-ui",
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
for (const configName of ["electron-builder.yml", "electron-builder.mac-stable.yml"]) {
  const config = yaml.load(fs.readFileSync(path.join(root, configName), "utf8"));
  assert.equal(
    config.afterPack,
    "build-resources/after-pack-clean.cjs",
    `${configName} must run the embedded Agentlas OS gate before publish`,
  );
}

const publishStep = crossPlatformWorkflow.slice(crossPlatformWorkflow.indexOf("- name: Package and publish"));
const builderIndex = publishStep.indexOf("electron-builder ${{ matrix.builder_args }} --publish always");
const stampIndex = publishStep.indexOf("node scripts/stamp-update-feeds.mjs --release-dir=release --require");
const uploadIndex = publishStep.indexOf('gh release upload "$RESOLVED_TAG"');
assert.ok(builderIndex >= 0 && stampIndex > builderIndex && uploadIndex > stampIndex, "cross-platform feeds must be stamped and clobber-uploaded after electron-builder writes them");
assert.match(publishStep, /gh release upload[\s\S]*?--clobber[\s\S]*?"\$\{update_feeds\[@\]\}"/);
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
