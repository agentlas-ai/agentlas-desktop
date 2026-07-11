#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const manifest = require(path.join(root, "Hephaestus", "manifest.json"));
const { parseUpdaterCompatibility } = require("../dist/electron/updater/controller.js");
const { stampUpdateCompatibilityFile } = require("../build-resources/update-compatibility.cjs");

const compatibility = pkg.agentlasUpdateCompatibility;
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
  const config = fs.readFileSync(path.join(root, configName), "utf8");
  assert.doesNotMatch(
    config,
    /afterAllArtifactBuild/,
    `${configName} must not rely on afterAllArtifactBuild because latest*.yml is written later`,
  );
}
const crossPlatformWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const signedMacWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release-signed-mac.yml"), "utf8");

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
const crossVerifyStep = workflowSteps(crossWorkflow).find((step) => step.name === "Verify tag matches package.json version");
const signedResolveStep = workflowSteps(signedWorkflow).find((step) => step.name === "Resolve release inputs");
for (const [name, step] of [["release.yml", crossVerifyStep], ["release-signed-mac.yml", signedResolveStep]]) {
  assert.ok(step, `${name} must validate its release identity`);
  assert.match(step.run, /semver_tag_re=/, `${name} must reject non-SemVer tag input`);
  assert.match(step.run, /refs\/tags\/\$\{tag\}\^\{commit\}/, `${name} must resolve an exact tag ref`);
  assert.match(step.run, /git rev-parse HEAD/, `${name} must compare the checkout with the tag commit`);
  assert.match(step.run, /head_commit.*tagged_commit/s, `${name} must fail when HEAD is not the tagged commit`);

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
assert.match(stepNamed("Runtime, browser, and renderer UI regression gates").run, /npm run test:automations-store/);

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
    assert.ok(latestMac.files.every((file) => file.url.endsWith(".zip")), "mac update feed must use Squirrel-compatible zip files");
    assert.equal((latestMacSource.match(/^agentlasCompatibility:/gm) || []).length, 1);
    stampUpdateCompatibilityFile(latestMacPath, path.join(root, "package.json"));
    assert.equal(
      (fs.readFileSync(latestMacPath, "utf8").match(/^agentlasCompatibility:/gm) || []).length,
      1,
      "compatibility stamping must be idempotent",
    );

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
      assert.deepEqual(yaml.load(fs.readFileSync(file, "utf8")).agentlasCompatibility, compatibility);
    }

    console.log("test-update-release-contract: PASS (mac zip + cross-platform compatibility feeds)");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
