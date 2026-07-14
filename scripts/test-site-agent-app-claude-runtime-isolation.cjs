#!/usr/bin/env node
// Executes the Claude runner against a fake child process. This proves the
// argument and failure boundaries without invoking Claude, a provider, MCP,
// the network, or any user credential.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-claude-isolation-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
app.setPath("userData", path.join(tmp, "user-data"));
app.setPath("home", home);
process.env.AGENTLAS_E2E = "1";

const SENTINELS = [
  "SENTINEL_STDERR_DO_NOT_EXPOSE",
  "/Users/sentinel/private-workspace",
  "/private/tmp/sentinel-agent-app.mcp.json",
  "sk-sentinel_123456789012345678901234",
];

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.pid = undefined;
  }

  kill() {
    return true;
  }
}

async function main() {
  await app.whenReady();
  const exec = require("../dist/electron/runtime/exec.js");
  const originalProbeCliVersion = exec.probeCliVersion;
  const originalSpawnCli = exec.spawnCli;
  const calls = [];
  let childMode = "success";
  let mcpFatalRemaining = 0;
  try {
    exec.probeCliVersion = async () => "9.9.9";
    exec.spawnCli = (command, args, options) => {
      const child = new FakeChild();
      calls.push({ command, args: [...args], options: { ...options } });
      queueMicrotask(() => {
        if (childMode === "mcp-fatal" && mcpFatalRemaining > 0) {
          mcpFatalRemaining -= 1;
          child.stderr.write("MCP agentlas-time startup failed: transport error");
          child.stderr.end();
          child.emit("close", 17);
          return;
        }
        if (childMode === "failure") {
          child.stderr.write(`${SENTINELS.join(" | ")} | config=${args.join(" ")}`);
          child.stderr.end();
          child.emit("close", 17);
          return;
        }
        child.stdout.write(`${JSON.stringify({
          type: "result",
          result: "SAFE_RESULT",
          session_id: "session-must-not-be-resumed",
          usage: { output_tokens: 1 },
        })}\n`);
        child.stdout.end();
        child.emit("close", 0);
      });
      return child;
    };

    const { runClaudeCode } = require("../dist/electron/runtime/claude-code.js");
    const events = { onStatus() {}, onPartial() {} };
    const base = {
      systemPrompt: "Return the declared output only.",
      history: [],
      userPrompt: "Browser input",
      backendLabel: "Claude Code fixture",
      permission: "read",
      locale: "en",
      env: { PATH: "/fixture/bin", AGENTLAS_UNTRUSTED_NO_TOOLS: "1" },
    };

    const isolated = await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      chatId: "site-agent-app:sentinel-single-run",
      runtimeSessionId: "must-never-resume",
    }, events);
    assert.equal(isolated.text, "SAFE_RESULT");
    const isolatedArgs = calls[0].args;
    assert.ok(isolatedArgs.includes("--system-prompt-file"), "untrusted first run must replace Claude's default system prompt");
    assert.equal(isolatedArgs.includes("--append-system-prompt-file"), false, "untrusted first run must not append to Claude's host prompt");
    assert.equal(isolatedArgs.includes("--resume"), false, "untrusted run must ignore a supplied runtime session id");
    assert.equal(isolatedArgs.includes("--fork-session"), false, "untrusted run must never fork a persisted session");
    assert.ok(isolatedArgs.includes("--no-session-persistence"));
    assert.equal(isolatedArgs.some((value) => /exclude-dynamic/i.test(value)), false);

    await runClaudeCode({
      ...base,
      env: { PATH: "/fixture/bin" },
      untrustedNoTools: false,
      chatId: undefined,
      runtimeSessionId: undefined,
    }, events);
    const trustedArgs = calls[1].args;
    assert.ok(trustedArgs.includes("--append-system-prompt-file"), "trusted first run must retain append behavior");
    assert.equal(trustedArgs.includes("--system-prompt-file"), false, "trusted run must not replace Claude's normal prompt");

    childMode = "mcp-fatal";
    mcpFatalRemaining = 1;
    let runtimeDowngrades = 0;
    const secretAlias = "AGENTLAS_MCP_SECRET_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const recovered = await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      mcpConfigPath: SENTINELS[2],
      mcpAllowedTools: ["mcp__agentlas-time__get_current_time", "mcp__agentlas-time__convert_time"],
      untrustedAllowedMcpTools: ["mcp__agentlas-time__get_current_time", "mcp__agentlas-time__convert_time"],
      env: {
        ...base.env,
        [secretAlias]: "opaque-secret-value",
      },
      onAgentAppMcpRuntimeUnavailable: () => { runtimeDowngrades += 1; },
    }, events);
    assert.equal(recovered.text, "SAFE_RESULT", "an MCP startup fatal must recover in stateless no-tool mode");
    assert.equal(runtimeDowngrades, 1);
    const mcpAttempt = calls[2];
    const noToolRetry = calls[3];
    assert.ok(mcpAttempt.args.includes("--mcp-config"));
    assert.ok(mcpAttempt.args.includes(SENTINELS[2]));
    assert.equal(noToolRetry.args.includes("--mcp-config"), false);
    assert.equal(noToolRetry.args.includes("--allowedTools"), false);
    assert.equal(secretAlias in noToolRetry.options.env, false,
      "the no-tool retry must remove every opaque MCP secret alias");
    assert.equal(noToolRetry.options.env.AGENTLAS_UNTRUSTED_NO_TOOLS, "1");

    childMode = "failure";
    await assert.rejects(
      () => runClaudeCode({
        ...base,
        untrustedNoTools: true,
        cwd: SENTINELS[1],
        mcpConfigPath: SENTINELS[2],
        chatId: "site-agent-app:sentinel-failure-run",
      }, events),
      (error) => {
        assert.equal(error.code, "agent-app-runtime-failed");
        assert.equal(error.message, "Agent App runtime failed.");
        const projected = `${error.name} ${error.code} ${error.message}`;
        for (const sentinel of SENTINELS) assert.equal(projected.includes(sentinel), false);
        return true;
      },
    );
    const failureArgs = calls[4].args;
    assert.ok(failureArgs.includes("--system-prompt-file"));
    assert.equal(failureArgs.includes("--append-system-prompt-file"), false);

    childMode = "success";
    const timeTools = [
      "mcp__agentlas-time__get_current_time",
      "mcp__agentlas-time__convert_time",
    ];
    await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      mcpConfigPath: "/fixture/time-only.json",
      mcpAllowedTools: timeTools,
      untrustedAllowedMcpTools: timeTools,
    }, events);
    const timeArgs = calls[5].args;
    assert.ok(timeArgs.includes("--mcp-config"), "time-only must retain the exact MCP config");
    const timeAllowed = timeArgs[timeArgs.indexOf("--allowedTools") + 1].split(",");
    assert.deepEqual(timeAllowed, timeTools, "time-only runner args must preserve the exact tool set");

    const combinedTools = ["mcp__brave-search__brave_web_search", ...timeTools];
    await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      mcpConfigPath: "/fixture/brave-plus-time.json",
      mcpAllowedTools: combinedTools,
      untrustedAllowedMcpTools: combinedTools,
    }, events);
    const combinedArgs = calls[6].args;
    assert.equal(combinedArgs.includes("--mcp-config"), false,
      "unprovenance Brave mixed with time must drop the entire MCP grant");
    assert.equal(combinedArgs.includes("--allowedTools"), false);

    const unsafeTools = [...timeTools, "mcp__agentlas-time__write_file"];
    await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      mcpConfigPath: "/fixture/unsafe.json",
      mcpAllowedTools: unsafeTools,
      untrustedAllowedMcpTools: unsafeTools,
    }, events);
    assert.equal(calls[7].args.includes("--mcp-config"), false, "one unsafe tool must drop all MCP authority");
    assert.equal(calls[7].args.includes("--allowedTools"), false);

    console.log("site agent app Claude runtime isolation behavior ok");
  } finally {
    exec.probeCliVersion = originalProbeCliVersion;
    exec.spawnCli = originalSpawnCli;
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(1);
});
