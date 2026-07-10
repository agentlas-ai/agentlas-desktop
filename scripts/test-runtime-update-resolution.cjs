#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const before = (text, first, second, label) => {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.notEqual(a, -1, `${label}: missing ${first}`);
  assert.notEqual(b, -1, `${label}: missing ${second}`);
  assert.ok(a < b, `${label}: expected ${first} before ${second}`);
};

// Hephaestus: explicit operator override > updater-managed global current > app bundle.
const engine = read("electron/hephaestus/engine.ts");
before(engine, "candidates.push(process.env.HEPHAESTUS_RUNTIME_ROOT)", 'candidates.push(path.join(os.homedir(), ".agentlas", "runtime", "current"))', "Hephaestus override priority");
before(engine, 'candidates.push(path.join(os.homedir(), ".agentlas", "runtime", "current"))', 'path.join(process.resourcesPath, "Hephaestus")', "Hephaestus global priority");

// Runtime candidates: explicit login-shell PATH is tried first (bare command), while fallback
// additions prefer user standalone over Agentlas npm and stale Homebrew/npm installs.
for (const [rel, bare, standalone, managed, system] of [
  ["electron/runtime/codex.ts", '"codex",', 'path.join(os.homedir(), ".local/bin/codex")', 'path.join(os.homedir(), ".agentlas/npm/bin/codex")', '"/opt/homebrew/bin/codex"'],
  ["electron/runtime/claude-code.ts", '"claude",', 'path.join(os.homedir(), ".local/bin/claude")', 'path.join(os.homedir(), ".agentlas/npm/bin/claude")', '"/opt/homebrew/bin/claude"'],
]) {
  const source = read(rel);
  before(source, bare, standalone, `${rel} respects shell PATH`);
  before(source, standalone, managed, `${rel} standalone priority`);
  before(source, managed, system, `${rel} managed-before-system priority`);
}

const execSource = read("electron/runtime/exec.ts");
before(execSource, 'path.join(home, ".local/bin")', 'path.join(home, ".agentlas/npm/bin")', "GUI PATH standalone priority");
before(execSource, 'path.join(home, ".agentlas/npm/bin")', '"/opt/homebrew/bin"', "GUI PATH managed-before-system priority");

// Exercise the compiled PATH merger as well as guarding source order.
const { withCliPath } = require("../dist/electron/runtime/exec.js");
const shellPath = ["/custom/login/bin", "/opt/homebrew/bin"].join(path.delimiter);
const respected = withCliPath({ PATH: shellPath });
assert.equal(respected.PATH.split(path.delimiter)[0], "/custom/login/bin");
assert.equal(respected.PATH.split(path.delimiter)[1], "/opt/homebrew/bin");

const minimal = withCliPath({ PATH: ["/usr/bin", "/bin"].join(path.delimiter) });
const dirs = minimal.PATH.split(path.delimiter);
assert.ok(dirs.indexOf(path.join(os.homedir(), ".local", "bin")) < dirs.indexOf("/opt/homebrew/bin"));
assert.ok(dirs.indexOf(path.join(os.homedir(), ".agentlas", "npm", "bin")) < dirs.indexOf("/opt/homebrew/bin"));

// A repository/agent .env may override ordinary credentials, but never host identity,
// executable lookup, or global CLI/plugin discovery roots.
const desktopEnv = require("../dist/electron/runtime/env-resolver.js");
const protectedBase = {
  HOME: "/trusted/home",
  PATH: "/trusted/bin",
  CODEX_HOME: "/trusted/codex",
  CLAUDE_CONFIG_DIR: "/trusted/claude",
  GEMINI_CLI_HOME: "/trusted/gemini",
  API_TOKEN: "old",
};
const maliciousDotenv = desktopEnv.parseDotEnv([
  "HOME=/tmp/attacker",
  "PATH=/tmp/attacker/bin",
  "CODEX_HOME=/tmp/attacker/codex",
  "CLAUDE_CONFIG_DIR=/tmp/attacker/claude",
  "GEMINI_CLI_HOME=/tmp/attacker/gemini",
  "GEMINI_CLI_EXTENSION_REGISTRY_URI=https://attacker.invalid/extensions",
  "CLAUDE_CODE_SAFE_MODE=1",
  "NODE_OPTIONS=--require=/tmp/attacker.js",
  "API_TOKEN=new",
].join("\n"));
maliciousDotenv.Path = "/tmp/attacker/windows-bin"; // Windows casing guard.
desktopEnv.mergeRunnerEnvValues(protectedBase, maliciousDotenv, true);
assert.equal(protectedBase.HOME, "/trusted/home");
assert.equal(protectedBase.PATH, "/trusted/bin");
assert.equal(protectedBase.Path, undefined);
assert.equal(protectedBase.CODEX_HOME, "/trusted/codex");
assert.equal(protectedBase.CLAUDE_CONFIG_DIR, "/trusted/claude");
assert.equal(protectedBase.GEMINI_CLI_HOME, "/trusted/gemini");
assert.equal(protectedBase.GEMINI_CLI_EXTENSION_REGISTRY_URI, undefined);
assert.equal(protectedBase.CLAUDE_CODE_SAFE_MODE, undefined);
assert.equal(protectedBase.NODE_OPTIONS, undefined);
assert.equal(protectedBase.API_TOKEN, "new");

// Official Gemini keeps default global extension/skills/MCP discovery. Agy retains its
// compatibility path: no unsupported session flags, but model + headless prompt remain.
const geminiRuntime = require("../dist/electron/runtime/gemini.js");
const officialGeminiArgs = geminiRuntime.buildGeminiSpawnArgs(false, "session-1", undefined, "gemini-2.5-pro");
assert.deepEqual(officialGeminiArgs, ["--resume", "session-1", "--model", "gemini-2.5-pro", "--prompt", ""]);
assert.equal(officialGeminiArgs.includes("--extensions"), false);
const agyArgs = geminiRuntime.buildGeminiSpawnArgs(true, "ignored-session", "ignored-new-session", "gemini-2.5-pro");
assert.deepEqual(agyArgs, ["--model", "gemini-2.5-pro", "--prompt", ""]);
assert.equal(agyArgs.includes("--resume"), false);
assert.equal(agyArgs.includes("--session-id"), false);

// Update routing: agy and Gemini are distinct. Gemini follows its verified original npm/Homebrew
// owner so global extension/config roots survive an in-place CLI update.
const installer = read("electron/runtime/install-cli.ts");
before(installer, 'const gemini = resolveBinary("gemini")', 'const antigravity = resolveBinary("agy")', "Gemini/Antigravity split");
assert.match(installer, /runBinary\(antigravity, \["update"\]/);
assert.match(installer, /isAgentlasManagedNpmBinary\(gemini\).*updateAgentlasManagedGemini/s);
assert.match(installer, /updateSelfManagedGemini\(gemini\)/);
assert.match(installer, /@google\/gemini-cli/);
assert.equal(installer.includes("function installAntigravityViaScript"), false);
assert.match(installer, /kind === "codex".*runBinary\(existing, \["update"\]/s);

const installRuntime = require("../dist/electron/runtime/install-cli.js");
assert.deepEqual(
  installRuntime.classifyGeminiInstallOwner(
    "/opt/homebrew/bin/gemini",
    "/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
  ),
  { kind: "npm", prefix: "/opt/homebrew" },
);
assert.deepEqual(
  installRuntime.classifyGeminiInstallOwner(
    "/opt/homebrew/bin/gemini",
    "/opt/homebrew/Cellar/gemini-cli/0.50.0/bin/gemini",
  ),
  { kind: "homebrew" },
);
assert.deepEqual(
  installRuntime.classifyGeminiInstallOwner(
    "C:\\Users\\mason\\AppData\\Roaming\\npm\\gemini.cmd",
    "C:\\Users\\mason\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js",
  ),
  { kind: "npm", prefix: "C:/Users/mason/AppData/Roaming/npm" },
);
assert.deepEqual(
  installRuntime.classifyGeminiInstallOwner("/custom/bin/gemini", "/custom/bin/gemini"),
  { kind: "unknown" },
);

async function verifyGeminiBinaryFixtures() {
  const candidates = geminiRuntime.geminiCandidatePaths("darwin", "/fixture/home", {});
  const bothInstalled = new Set(["gemini", "agy"]);
  const official = await geminiRuntime.firstAvailableGeminiCandidate(
    candidates,
    async (candidate) => bothInstalled.has(candidate),
  );
  assert.equal(official, "gemini");

  const agyOnly = await geminiRuntime.firstAvailableGeminiCandidate(
    candidates,
    async (candidate) => candidate === "agy",
  );
  assert.equal(agyOnly, "agy");
}

verifyGeminiBinaryFixtures()
  .then(() => console.log(JSON.stringify({ ok: true, checks: 41 }, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
