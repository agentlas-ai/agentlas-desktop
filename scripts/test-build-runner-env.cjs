#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildIsolatedBuildRunnerEnv, isBuildMcpSecretAlias } = require("../dist/electron/runtime/build-env.js");

const alias = `AGENTLAS_MCP_SECRET_${"A".repeat(32)}`;
const host = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/Users/tester",
  USERPROFILE: "C:\\Users\\tester",
  APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  TMPDIR: "/tmp/tester",
  LANG: "en_US.UTF-8",
  CODEX_HOME: "/Users/tester/.codex",
  OPENAI_API_KEY: "runtime-only-openai",
  ANTHROPIC_API_KEY: "wrong-runtime-anthropic",
  GITHUB_TOKEN: "secret-canary-github",
  AWS_SECRET_ACCESS_KEY: "secret-canary-aws",
  SLACK_BOT_TOKEN: "secret-canary-slack",
  DATABASE_URL: "postgres://secret-canary",
  ELECTRON_RUN_AS_NODE: "1",
  NODE_OPTIONS: "--require=/tmp/secret-canary.js",
  HTTPS_PROXY: "https://proxy.example.test:8443",
  HTTP_PROXY: "https://user:secret@proxy.example.test",
};

const env = buildIsolatedBuildRunnerEnv(
  "codex",
  {
    [alias]: "mcp-only-secret",
    GITHUB_TOKEN: "must-not-smuggle",
    AGENTLAS_MCP_SECRET_TOO_SHORT: "must-not-pass",
  },
  host,
);

assert.equal(env.PATH, host.PATH);
assert.equal(env.HOME, host.HOME);
assert.equal(env.USERPROFILE, host.USERPROFILE);
assert.equal(env.APPDATA, host.APPDATA);
assert.equal(env.PATHEXT, host.PATHEXT);
assert.equal(env.CODEX_HOME, host.CODEX_HOME);
assert.equal(env.OPENAI_API_KEY, host.OPENAI_API_KEY, "selected runtime auth may pass");
assert.equal(env.ANTHROPIC_API_KEY, undefined, "another runtime's auth must not pass");
assert.equal(env[alias], "mcp-only-secret", "Main-generated MCP alias must pass");
assert.equal(env.HTTPS_PROXY, "https://proxy.example.test:8443/");
assert.equal(env.HTTP_PROXY, undefined, "credential-bearing proxy URLs must not pass");
for (const key of [
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "SLACK_BOT_TOKEN",
  "DATABASE_URL",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "AGENTLAS_MCP_SECRET_TOO_SHORT",
]) {
  assert.equal(env[key], undefined, `${key} must not reach Build/MCP children`);
}
assert.equal(isBuildMcpSecretAlias(alias), true);
assert.equal(isBuildMcpSecretAlias("AGENTLAS_MCP_SECRET_short"), false);
assert.doesNotMatch(JSON.stringify(env), /secret-canary|must-not-smuggle|wrong-runtime-anthropic/);

const claudeEnv = buildIsolatedBuildRunnerEnv("claude-code", {}, host);
assert.equal(claudeEnv.ANTHROPIC_API_KEY, host.ANTHROPIC_API_KEY);
assert.equal(claudeEnv.OPENAI_API_KEY, undefined);
const byokEnv = buildIsolatedBuildRunnerEnv("byok", {}, host);
assert.equal(byokEnv.OPENAI_API_KEY, undefined);
assert.equal(byokEnv.ANTHROPIC_API_KEY, undefined);

const builderSource = fs.readFileSync(path.join(__dirname, "../electron/hephaestus/builder.ts"), "utf8");
assert.match(builderSource, /buildIsolatedBuildRunnerEnv\(/);
assert.doesNotMatch(builderSource, /env:\s*req\.mcpAttachment\?\.config\s*\?\s*\{\s*\.\.\.process\.env/);

console.log(JSON.stringify({ ok: true, checks: 29 }, null, 2));
