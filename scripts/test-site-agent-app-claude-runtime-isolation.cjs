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
    this.closed = false;
  }

  kill() {
    queueMicrotask(() => this.closeOnce(null, "SIGTERM"));
    return true;
  }

  closeOnce(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
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
      const systemPromptFlag = args.includes("--system-prompt-file")
        ? "--system-prompt-file"
        : "--append-system-prompt-file";
      const systemPromptIndex = args.indexOf(systemPromptFlag);
      calls.push({
        command,
        args: [...args],
        options: { ...options },
        systemPrompt: systemPromptIndex >= 0 ? fs.readFileSync(args[systemPromptIndex + 1], "utf8") : "",
      });
      queueMicrotask(() => {
        if (childMode === "mcp-pre-init-nonzero" && args.includes("--mcp-config")) {
          child.stderr.write("unknown option --setting-sources");
          child.stderr.end();
          child.closeOnce(17, null);
          return;
        }
        if (childMode === "mcp-fatal" && mcpFatalRemaining > 0) {
          mcpFatalRemaining -= 1;
          child.stderr.write("MCP agentlas-time startup failed: transport error");
          child.stderr.end();
          child.closeOnce(17, null);
          return;
        }
        if (childMode.startsWith("mcp-init-") && childMode !== "mcp-init-absent" && args.includes("--mcp-config")) {
          const mcpServers = childMode === "mcp-init-empty"
            ? []
            : childMode === "mcp-init-missing"
              ? [{ name: "other-server", status: "connected" }]
              : childMode === "mcp-init-duplicate"
                ? [
                    { name: "agentlas-time", status: "connected" },
                    { name: "agentlas-time", status: "failed" },
                  ]
                : [{ name: "agentlas-time", status: "failed" }];
          if (childMode === "mcp-init-extra-server") {
            mcpServers.splice(0, mcpServers.length,
              { name: "agentlas-time", status: "connected" },
              { name: "unexpected-server", status: "connected" });
          }
          const initTools = childMode === "mcp-init-extra-tool"
            ? [
                "mcp__agentlas-time__get_current_time",
                "mcp__agentlas-time__convert_time",
                "Read",
              ]
            : childMode === "mcp-init-duplicate-tool"
              ? [
                  "mcp__agentlas-time__get_current_time",
                  "mcp__agentlas-time__get_current_time",
                ]
              : [
                  "mcp__agentlas-time__get_current_time",
                  "mcp__agentlas-time__convert_time",
                ];
          child.stdout.write(`${JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "failed-mcp-session-must-not-persist",
            mcp_servers: mcpServers,
            tools: initTools,
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "FAILED_INIT_RESULT_MUST_NOT_LEAK" }] },
          })}\n`);
          child.stdout.write(`${JSON.stringify({ type: "result", result: "FAILED_INIT_RESULT_MUST_NOT_LEAK" })}\n`);
          child.stdout.end();
          return;
        }
        if (childMode === "mcp-connected-nonzero" && args.includes("--mcp-config")) {
          child.stdout.write(`${JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "connected-then-failed-session-must-not-persist",
            mcp_servers: [{ name: "agentlas-time", status: "connected" }],
            tools: [
              "mcp__agentlas-time__get_current_time",
              "mcp__agentlas-time__convert_time",
            ],
          })}\n`);
          child.stderr.write("MCP transport failed after the connected receipt");
          child.stderr.end();
          child.closeOnce(17, null);
          return;
        }
        if (childMode === "failure") {
          child.stderr.write(`${SENTINELS.join(" | ")} | config=${args.join(" ")}`);
          child.stderr.end();
          child.closeOnce(17, null);
          return;
        }
        if (args.includes("--mcp-config") && childMode === "success") {
          child.stdout.write(`${JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "connected-mcp-session-must-not-persist",
            mcp_servers: [{ name: "agentlas-time", status: "connected" }],
            tools: [
              "mcp__agentlas-time__get_current_time",
              "mcp__agentlas-time__convert_time",
            ],
          })}\n`);
        }
        const resultText = childMode === "mcp-init-absent" && args.includes("--mcp-config")
          ? "UNVERIFIED_INIT_RESULT_MUST_NOT_LEAK"
          : "SAFE_RESULT";
        child.stdout.write(`${JSON.stringify({
          type: "result",
          result: resultText,
          session_id: "session-must-not-be-resumed",
          usage: { output_tokens: 1 },
        })}\n`);
        child.stdout.end();
        child.closeOnce(0, null);
      });
      return child;
    };

    const { runClaudeCode } = require("../dist/electron/runtime/claude-code.js");
    const { systemTimeMcpLaunchArgs } = require("../dist/electron/mcp-tools/system-time-server.js");
    const canonicalTimeConfig = JSON.stringify({
      mcpServers: {
        "agentlas-time": {
          command: process.execPath,
          args: systemTimeMcpLaunchArgs(),
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    });
    assert.equal(/[\r\n\0]/.test(canonicalTimeConfig), false);
    assert.ok(Buffer.byteLength(canonicalTimeConfig) <= 4_096);
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
    assert.ok(isolatedArgs.includes("--safe-mode"), "the absolute no-tool path must retain Claude safe-mode");
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
      mcpConfigPath: canonicalTimeConfig,
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
    assert.ok(mcpAttempt.args.includes(canonicalTimeConfig));
    assert.equal(mcpAttempt.args.includes("--safe-mode"), false,
      "safe-mode would silently disable the exact explicit MCP config");
    assert.equal(mcpAttempt.args[mcpAttempt.args.indexOf("--setting-sources") + 1], "",
      "exact MCP must disable user/project/local settings without disabling subscription auth");
    assert.equal(noToolRetry.args.includes("--mcp-config"), false);
    assert.equal(noToolRetry.args.includes("--allowedTools"), false);
    assert.ok(noToolRetry.args.includes("--safe-mode"));
    assert.equal(noToolRetry.args.includes("--setting-sources"), false);
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
      mcpConfigPath: canonicalTimeConfig,
      mcpAllowedTools: timeTools,
      untrustedAllowedMcpTools: timeTools,
    }, events);
    const timeArgs = calls[5].args;
    assert.ok(timeArgs.includes("--mcp-config"), "time-only must retain the exact MCP config");
    assert.equal(timeArgs.includes("--safe-mode"), false);
    const timeAllowed = timeArgs[timeArgs.indexOf("--allowedTools") + 1].split(",");
    assert.deepEqual(timeAllowed, timeTools, "time-only runner args must preserve the exact tool set");

    const combinedTools = ["mcp__brave-search__brave_web_search", ...timeTools];
    await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      mcpConfigPath: canonicalTimeConfig,
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
      mcpConfigPath: canonicalTimeConfig,
      mcpAllowedTools: unsafeTools,
      untrustedAllowedMcpTools: unsafeTools,
    }, events);
    assert.equal(calls[7].args.includes("--mcp-config"), false, "one unsafe tool must drop all MCP authority");
    assert.equal(calls[7].args.includes("--allowedTools"), false);

    const maliciousCompactConfig = JSON.stringify({
      mcpServers: {
        "agentlas-time": {
          command: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          args: [],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
      },
    });
    let maliciousDowngrades = 0;
    await runClaudeCode({
      ...base,
      untrustedNoTools: true,
      mcpConfigPath: maliciousCompactConfig,
      mcpAllowedTools: timeTools,
      untrustedAllowedMcpTools: timeTools,
      onAgentAppMcpRuntimeUnavailable: () => { maliciousDowngrades += 1; },
    }, events);
    assert.equal(calls[8].args.includes("--mcp-config"), false,
      "a compact but non-canonical built-in command must not execute");
    assert.equal(maliciousDowngrades, 1, "rejected inline authority must reconcile the UI disclosure");
    assert.equal(calls[8].systemPrompt.includes("mcp__agentlas-time__get_current_time"), false,
      "a rejected config must not leave stale tool authority in the model prompt");
    assert.match(calls[8].systemPrompt, /No file, shell, web, browser, app, MCP/);

    for (const initMode of [
      "mcp-init-failed",
      "mcp-init-empty",
      "mcp-init-missing",
      "mcp-init-duplicate",
      "mcp-init-extra-server",
      "mcp-init-extra-tool",
      "mcp-init-duplicate-tool",
      "mcp-init-absent",
      "mcp-pre-init-nonzero",
    ]) {
      childMode = initMode;
      let initStatusDowngrades = 0;
      const initPartials = [];
      const callStart = calls.length;
      const recoveredFromInitStatus = await runClaudeCode({
        ...base,
        untrustedNoTools: true,
        mcpConfigPath: canonicalTimeConfig,
        mcpAllowedTools: timeTools,
        untrustedAllowedMcpTools: timeTools,
        onAgentAppMcpRuntimeUnavailable: () => { initStatusDowngrades += 1; },
      }, { ...events, onPartial: (text) => initPartials.push(text) });
      assert.equal(recoveredFromInitStatus.text, "SAFE_RESULT");
      assert.equal(initStatusDowngrades, 1, `${initMode} must downgrade the final capability receipt once`);
      assert.equal(calls.length, callStart + 2, `${initMode} must retry exactly once`);
      assert.ok(calls[callStart].args.includes("--mcp-config"));
      assert.equal(calls[callStart + 1].args.includes("--mcp-config"), false,
        `${initMode} must retry with no MCP config`);
      assert.equal(calls[callStart + 1].args.includes("--allowedTools"), false);
      assert.equal(initPartials.join("\n").includes("FAILED_INIT_RESULT_MUST_NOT_LEAK"), false,
        "events queued after a failed init must be dropped before the no-tool retry");
      assert.equal(initPartials.join("\n").includes("UNVERIFIED_INIT_RESULT_MUST_NOT_LEAK"), false,
        "an answer emitted before exact init proof must be dropped before the no-tool retry");
    }

    childMode = "mcp-connected-nonzero";
    const connectedFailureStart = calls.length;
    let connectedFailureDowngrades = 0;
    await assert.rejects(
      () => runClaudeCode({
        ...base,
        untrustedNoTools: true,
        mcpConfigPath: canonicalTimeConfig,
        mcpAllowedTools: timeTools,
        untrustedAllowedMcpTools: timeTools,
        onAgentAppMcpRuntimeUnavailable: () => { connectedFailureDowngrades += 1; },
      }, events),
      (error) => error.code === "agent-app-runtime-failed",
    );
    assert.equal(calls.length, connectedFailureStart + 1,
      "a post-connect runtime failure must not issue a second model request");
    assert.equal(connectedFailureDowngrades, 0,
      "a proven connected receipt must not be rewritten as an MCP startup downgrade");

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
