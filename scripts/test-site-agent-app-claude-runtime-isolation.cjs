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
  try {
    exec.probeCliVersion = async () => "9.9.9";
    exec.spawnCli = (command, args, options) => {
      const child = new FakeChild();
      calls.push({ command, args: [...args], options: { ...options } });
      queueMicrotask(() => {
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
    const failureArgs = calls[2].args;
    assert.ok(failureArgs.includes("--system-prompt-file"));
    assert.equal(failureArgs.includes("--append-system-prompt-file"), false);

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
