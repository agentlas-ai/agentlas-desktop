#!/usr/bin/env node
// Runs the deterministic release-contract gates the way the tag CI runs them,
// BEFORE a tag is pushed.
//
// Why this exists: the release contract asserts things about the pinned
// Agentlas OS runtime, while ./Hephaestus is a git-ignored directory that is,
// on a developer machine, a live working checkout with uncommitted changes.
// `ensure:engine` rightly
// refuses to overwrite it, so the local copy drifts from the pin and the gate
// reports a failure that has nothing to do with the change under test. A gate
// that cries wolf locally stops being run locally, so release-contract misses
// (a missing README or CHANGELOG section, most often) are only ever caught by
// CI twenty minutes after the tag is pushed — over and over.
//
// So this resolves the pin into an immutable per-commit cache and never touches
// the developer's checkout. Same answer as CI, no work destroyed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = pkg.agentlasBundledRuntimeSource;
const workforceContractPath = join(root, "electron", "mcp-tools", "workforce-protocol-contract.json");
const workforceContract = JSON.parse(readFileSync(workforceContractPath, "utf8"));

function fail(message) {
  console.error(`[release-preflight] ${message}`);
  process.exit(1);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  return result.status === 0;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function exactStringSet(actual, expected, label) {
  const left = [...stringArray(actual, label)].sort();
  const right = [...stringArray(expected, `${label} authority`)].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} mismatch: got ${JSON.stringify(left)}, expected ${JSON.stringify(right)}`);
  }
}

function resolveProbePython() {
  const bundled = process.platform === "win32"
    ? join(root, "build-resources", "python-runtime", "python.exe")
    : join(root, "build-resources", "python-runtime", "bin", "python3");
  const candidates = [
    process.env.HEPHAESTUS_PYTHON ? { command: process.env.HEPHAESTUS_PYTHON, prefix: [] } : null,
    existsSync(bundled) ? { command: bundled, prefix: [] } : null,
    ...(process.platform === "win32"
      ? [{ command: "python", prefix: [] }, { command: "py", prefix: ["-3"] }]
      : [{ command: "python3", prefix: [] }, { command: "python", prefix: [] }]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Python 3.9+ is required to probe the exact pinned Agentlas OS MCP contract");
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePinnedWorkforceContract(runtimeRoot, manifestVersion) {
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const python = resolveProbePython();
  const client = new Client(
    { name: "agentlas-release-preflight", version: pkg.version },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: python.command,
    args: [...python.prefix, "-m", "agentlas_cloud", "mcp", "serve"],
    cwd: runtimeRoot,
    stderr: "ignore",
    env: {
      ...getDefaultEnvironment(),
      HEPHAESTUS_RUNTIME_ROOT: runtimeRoot,
      // Probe only the immutable checkout. An inherited PYTHONPATH could
      // shadow a pinned Core dependency with mutable local code and make the
      // release gate attest to something other than the packaged runtime.
      PYTHONPATH: runtimeRoot,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    },
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "pinned Core MCP initialize");
    const serverVersion = client.getServerVersion();
    if (serverVersion?.version !== manifestVersion) {
      throw new Error(`MCP server version ${serverVersion?.version ?? "missing"} does not match manifest ${manifestVersion}`);
    }
    const inventory = await withTimeout(client.listTools(), 20_000, "pinned Core MCP tools/list");
    return inventory.tools;
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((resolveClose) => setTimeout(resolveClose, 2_000)),
    ]);
    await transport.close().catch(() => {});
  }
}

function verifyExactWorkforceContract(tools) {
  const authority = record(workforceContract, "Workforce contract authority");
  if (authority.schemaVersion !== "agentlas.desktop-workforce-protocol-contract.v1") {
    throw new Error("unsupported Desktop Workforce contract authority schema");
  }
  const metadataAuthority = record(authority.protocolMetadata, "Workforce protocol metadata authority");
  const toolsAuthority = record(authority.tools, "Workforce tools authority");
  const prepareAuthority = record(toolsAuthority.prepareExecution, "prepare_execution authority");
  const responseAuthority = record(authority.prepareResponse, "prepare response authority");
  const requiredNames = stringArray(toolsAuthority.requiredNames, "required Workforce tool names");
  exactStringSet(
    tools.filter((tool) => tool.name.startsWith("workforce.")).map((tool) => tool.name),
    requiredNames,
    "pinned Core Workforce tools",
  );

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const prepare = byName.get(prepareAuthority.name);
  if (!prepare) throw new Error("pinned Core is missing workforce.prepare_execution");
  const prepareSchema = record(prepare.inputSchema, "prepare_execution input schema");
  exactStringSet(prepareSchema.required, prepareAuthority.requiredInputFields, "prepare_execution required inputs");
  const prepareProperties = record(prepareSchema.properties, "prepare_execution properties");
  exactStringSet(Object.keys(prepareProperties), prepareAuthority.inputPropertyFields, "prepare_execution input properties");
  const attemptSchema = record(prepareProperties.prepareAttempt, "prepareAttempt schema");
  if (attemptSchema.additionalProperties !== false) {
    throw new Error("prepareAttempt must reject undeclared fields");
  }
  exactStringSet(attemptSchema.required, prepareAuthority.prepareAttemptRequiredFields, "prepareAttempt required fields");
  const attemptProperties = record(attemptSchema.properties, "prepareAttempt properties");
  exactStringSet(
    Object.keys(attemptProperties),
    prepareAuthority.prepareAttemptRequiredFields,
    "prepareAttempt properties",
  );
  if (record(attemptProperties.schemaVersion, "prepareAttempt schemaVersion").const !== metadataAuthority.prepareAttemptSchemaVersion) {
    throw new Error("prepareAttempt schema version does not match the Desktop contract authority");
  }

  const searchAuthority = record(toolsAuthority.searchCandidates, "search_candidates authority");
  const search = byName.get(searchAuthority.name);
  if (!search) throw new Error("pinned Core is missing workforce.search_candidates");
  const searchSchema = record(search.inputSchema, "search_candidates input schema");
  exactStringSet(searchSchema.required, searchAuthority.requiredInputFields, "search_candidates required inputs");
  const searchProperties = record(searchSchema.properties, "search_candidates properties");
  exactStringSet(
    record(searchProperties.sourceScope, "search sourceScope schema").enum,
    searchAuthority.sourceScopeValues,
    "search_candidates sourceScope enum",
  );

  const validateAuthority = record(toolsAuthority.validateSelection, "validate_selection authority");
  const validate = byName.get(validateAuthority.name);
  if (!validate) throw new Error("pinned Core is missing workforce.validate_selection");
  exactStringSet(
    record(validate.inputSchema, "validate_selection input schema").required,
    validateAuthority.requiredInputFields,
    "validate_selection required inputs",
  );

  const require = createRequire(import.meta.url);
  const desktopContract = require(join(root, "dist", "electron", "mcp-tools", "client.js"));
  const contractIssues = desktopContract.workforceMcpContractIssues(tools);
  if (contractIssues.length) {
    throw new Error(`pinned Core is incompatible with Desktop: ${contractIssues.join("; ")}`);
  }
  const expectedDigest = desktopContract.WORKFORCE_EXPECTED_PROTOCOL_DIGEST;
  const expectedMetadataKeys = [...Object.keys(metadataAuthority), "protocolDigest"];
  for (const name of requiredNames) {
    const meta = record(record(byName.get(name)._meta, `${name} _meta`)["agentlas/workforce-protocol"], `${name} Workforce metadata`);
    exactStringSet(Object.keys(meta), expectedMetadataKeys, `${name} Workforce metadata keys`);
    for (const [key, expected] of Object.entries(metadataAuthority)) {
      if (meta[key] !== expected) throw new Error(`${name} ${key} does not exactly match Desktop`);
    }
    if (meta.protocolDigest !== expectedDigest) {
      throw new Error(`${name} protocolDigest ${String(meta.protocolDigest)} does not match Desktop ${expectedDigest}`);
    }
  }

  if (
    metadataAuthority.federatedPreparationSchemaVersion !== "agentlas.workforce-federated-preparation.v1" ||
    metadataAuthority.executionPlanSchemaVersion !== "agentlas.workforce-execution-plan.v5" ||
    stringArray(responseAuthority.requiredFields, "prepare response fields").length === 0 ||
    stringArray(responseAuthority.executionPlanRequiredFields, "execution-plan response fields").length === 0
  ) {
    throw new Error("Desktop prepare response authority is incomplete");
  }
  return {
    protocolVersion: metadataAuthority.protocolVersion,
    protocolDigest: expectedDigest,
    prepareResponseSchema: metadataAuthority.federatedPreparationSchemaVersion,
    executionPlanSchema: metadataAuthority.executionPlanSchemaVersion,
  };
}

if (!source?.repository || !source?.ref || !/^[0-9a-f]{40}$/.test(source.commit ?? "")) {
  fail("package.json agentlasBundledRuntimeSource must pin repository, ref, and a full commit.");
}

// Per-commit path: a cache entry can never be stale for the commit it names, so
// there is no invalidation to get wrong.
const cacheRoot = join(root, "node_modules", ".cache", "agentlas-pinned-runtime");
const pinnedRoot = join(cacheRoot, source.commit);

function checkoutIsPinned(dir) {
  if (!existsSync(join(dir, "manifest.json"))) return false;
  return capture("git", ["-C", dir, "rev-parse", "HEAD^{commit}"]) === source.commit;
}

function checkoutIsClean(dir) {
  const result = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
  return result.status === 0 && String(result.stdout).trim() === "";
}

function releaseSection(sourceText, marker, nextMarker, label) {
  const start = sourceText.indexOf(marker);
  if (start < 0) throw new Error(`${label} is missing ${marker}`);
  const end = sourceText.indexOf(nextMarker, start + marker.length);
  return sourceText.slice(start, end < 0 ? sourceText.length : end);
}

function verifyReleaseSourceContract(runtimeRoot, manifestVersion) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package-lock versions do not match package.json");
  }
  const dbSource = readFileSync(join(root, "electron", "store", "db.ts"), "utf8");
  const schemaVersion = Number(dbSource.match(/const SCHEMA_VERSION = (\d+);/)?.[1]);
  if (schemaVersion !== pkg.agentlasUpdateCompatibility?.targetSchemaVersion) {
    throw new Error("Desktop target schema does not match the database migration target");
  }
  for (const configName of ["electron-builder.yml", "electron-builder.mac-stable.yml"]) {
    const config = readFileSync(join(root, configName), "utf8");
    for (const required of ["from: Hephaestus", "from: build-resources/python-runtime"]) {
      if (!config.includes(required)) throw new Error(`${configName} is missing ${required}`);
    }
  }
  const baseBuilderConfig = readFileSync(join(root, "electron-builder.yml"), "utf8");
  if (!baseBuilderConfig.includes("from: build-resources/node-runtime")) {
    throw new Error("electron-builder.yml is missing the private Windows Node runtime");
  }

  const releaseWorkflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const signedWorkflow = readFileSync(join(root, ".github", "workflows", "release-signed-mac.yml"), "utf8");
  const harnessWorkflow = readFileSync(join(root, ".github", "workflows", "cross-platform-harness.yml"), "utf8");
  for (const [name, workflow] of [["release.yml", releaseWorkflow], ["release-signed-mac.yml", signedWorkflow]]) {
    const refs = [...workflow.matchAll(/HEPHAESTUS_REF:\s*([^\s]+)/g)].map((match) => match[1]);
    const commits = [...workflow.matchAll(/HEPHAESTUS_COMMIT:\s*([^\s]+)/g)].map((match) => match[1]);
    if (!refs.length || refs.some((value) => value !== source.ref)) {
      throw new Error(`${name} does not pin only ${source.ref}`);
    }
    if (!commits.length || commits.some((value) => value !== source.commit)) {
      throw new Error(`${name} does not pin only ${source.commit}`);
    }
  }
  if ((releaseWorkflow.match(/verify-packaged-workforce-runtime\.cjs/g) || []).length !== 2) {
    throw new Error("cross-platform release must verify both packaged Workforce runtimes");
  }
  if (!releaseWorkflow.includes("npm run fetch:python")) {
    throw new Error("cross-platform release does not fetch pinned standalone Python");
  }
  if (!/runner\.os == 'Windows'[\s\S]{0,160}npm run fetch:node/.test(releaseWorkflow)) {
    throw new Error("cross-platform release does not fetch the pinned Windows Node runtime");
  }
  if (!/runner\.os[^\n]*Windows[\s\S]{0,160}npm run fetch:node/.test(harnessWorkflow)) {
    throw new Error("cross-platform package smoke does not fetch the pinned Windows Node runtime");
  }
  if (!signedWorkflow.includes("--public-allowlist") ||
      !signedWorkflow.includes("--verification-file=release/desktop-release-verification.json")) {
    throw new Error("signed release does not enforce the public artifact allowlist and exact web verification file");
  }
  const packageMac = readFileSync(join(root, "scripts", "package-mac.sh"), "utf8");
  if (!/env -i[\s\S]*verify-packaged-workforce-runtime\.cjs/.test(packageMac)) {
    throw new Error("macOS package verifier is not isolated from release credentials");
  }
  const assetVerifier = readFileSync(join(root, "scripts", "verify-release-assets.mjs"), "utf8");
  if (!assetVerifier.includes("publicReleaseAssetNames") || !assetVerifier.includes("--public-allowlist")) {
    throw new Error("release asset verification does not enforce an explicit public allowlist");
  }

  const readme = readFileSync(join(root, "README.md"), "utf8");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const readmeCurrent = releaseSection(readme, `v${pkg.version}`, "\n- **", "README");
  const changelogCurrent = releaseSection(changelog, `## ${pkg.version}`, "\n## ", "CHANGELOG");
  for (const [label, section] of [["README", readmeCurrent], ["CHANGELOG", changelogCurrent]]) {
    if (!section.includes(`Agentlas OS v${manifestVersion}`) || !section.includes(source.commit)) {
      throw new Error(`${label} current release does not bind Agentlas OS v${manifestVersion} at ${source.commit}`);
    }
    if (!/(does not prove|is not proof of|do not themselves publish)/i.test(section)) {
      throw new Error(`${label} current release must distinguish source readiness from a published release`);
    }
  }
}

let runtimeRoot = null;

// Fast path: the developer's own checkout already sits exactly on the pin, so
// use it rather than spending a clone.
const embedded = join(root, "Hephaestus");
if (checkoutIsPinned(embedded) && checkoutIsClean(embedded)) {
  runtimeRoot = embedded;
  console.log(`[release-preflight] embedded checkout is clean and on ${source.ref}`);
} else if (checkoutIsPinned(pinnedRoot) && checkoutIsClean(pinnedRoot)) {
  runtimeRoot = pinnedRoot;
  console.log(`[release-preflight] reusing cached ${source.ref}`);
} else {
  console.log(`[release-preflight] fetching ${source.ref} into an immutable cache (the working checkout is left alone)`);
  mkdirSync(cacheRoot, { recursive: true });
  spawnSync("rm", ["-rf", pinnedRoot]);
  if (!run("git", ["clone", "--quiet", "--depth", "1", "--branch", source.ref, source.repository, pinnedRoot])) {
    fail(`could not clone ${source.repository}@${source.ref}. Network access is required the first time a pin changes.`);
  }
  // The ref is a moving name; the commit is the contract. Fail closed on drift.
  const actual = capture("git", ["-C", pinnedRoot, "rev-parse", "HEAD^{commit}"]);
  if (actual !== source.commit) {
    fail(`${source.ref} resolves to ${actual}, but package.json pins ${source.commit}.`);
  }
  runtimeRoot = pinnedRoot;
}

const manifestVersion = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")).version;
console.log(`[release-preflight] runtime ${manifestVersion} (${source.commit.slice(0, 8)})`);
const expectedRuntimeVersion = pkg.agentlasUpdateCompatibility?.bundledRuntimeVersion;
if (
  typeof expectedRuntimeVersion !== "string" ||
  source.ref !== `v${expectedRuntimeVersion}` ||
  manifestVersion !== expectedRuntimeVersion
) {
  fail(`runtime version pin mismatch: package=${String(expectedRuntimeVersion)}, ref=${source.ref}, manifest=${manifestVersion}`);
}

// The contract gate imports from dist/, so a stale build would test stale code.
if (!run("npm", ["run", "build:electron"], { cwd: root })) {
  fail("build:electron failed; the release contract reads dist/.");
}

try {
  const tools = await probePinnedWorkforceContract(runtimeRoot, manifestVersion);
  const verified = verifyExactWorkforceContract(tools);
  console.log(
    `[release-preflight] Workforce MCP exact contract ${verified.protocolVersion} ` +
      `(${verified.protocolDigest.slice(0, 18)}...) prepare=${verified.prepareResponseSchema} plan=${verified.executionPlanSchema}`,
  );
} catch (error) {
  fail(`pinned Core Workforce MCP contract probe failed: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  verifyReleaseSourceContract(runtimeRoot, manifestVersion);
} catch (error) {
  fail(`release source contract failed for v${pkg.version}: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`[release-preflight] PASS — v${pkg.version} satisfies the release contract`);
