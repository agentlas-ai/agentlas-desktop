#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.AGENTLAS_E2E = "1";

const { app } = require("electron");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-secret-isolation-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
const userData = path.join(tempDir, "user-data");
app.setPath("userData", userData);

const ENV_KEY = "OPENAI_API_KEY";
const SECRET = "sk-agentlas-regression-secret-must-not-leak";

function codexProperty(args, serverKey, property) {
  const prefix = `mcp_servers.${serverKey}.${property}=`;
  const item = args.find((value) => typeof value === "string" && value.startsWith(prefix));
  assert.ok(item, `missing Codex MCP property ${property}`);
  return item.slice(prefix.length);
}

(async () => {
  let exitCode = 0;
  try {
    const { initStore } = require("../dist/electron/store/db.js");
    const { installCustomServer } = require("../dist/electron/mcp-tools/registry.js");
    const { buildMcpConfigFile } = require("../dist/electron/mcp-tools/mcp-config.js");
    const { setEnvVar } = require("../dist/electron/secrets/vault.js");

    initStore();
    const nodeBin = process.env.npm_node_execpath || process.env.NODE || "node";
    const installed = installCustomServer({
      name: "Secret Isolation Probe",
      transport: "stdio",
      command: nodeBin,
      args: ["-e", `process.stdout.write(process.env.${ENV_KEY} || "missing")`],
      envKeys: [ENV_KEY],
    });
    await setEnvVar(ENV_KEY, SECRET);

    // 과거 릴리스가 만든 0644 + 평문 파일도 다음 빌드에서 안전하게 교체되는지 검증한다.
    const mcpDir = path.join(userData, "mcp");
    fs.mkdirSync(mcpDir, { recursive: true, mode: 0o755 });
    const staleConfig = path.join(mcpDir, "agentlas-mcp.json");
    fs.writeFileSync(staleConfig, JSON.stringify({ stale: SECRET }), { mode: 0o644 });
    if (process.platform !== "win32") {
      fs.chmodSync(mcpDir, 0o755);
      fs.chmodSync(staleConfig, 0o644);
    }

    const emptyCfg = await buildMcpConfigFile({ catalogIds: ["not-installed"] });
    assert.equal(emptyCfg, null, "empty MCP selection should not produce config");
    assert.equal(fs.existsSync(staleConfig), false, "empty selection must remove a stale plaintext config");
    fs.writeFileSync(staleConfig, JSON.stringify({ stale: SECRET }), { mode: 0o644 });
    if (process.platform !== "win32") fs.chmodSync(staleConfig, 0o644);

    const cfg = await buildMcpConfigFile({ catalogIds: [installed.id] });
    assert.ok(cfg, "selected MCP server should produce config");

    const configText = fs.readFileSync(cfg.configPath, "utf8");
    assert.doesNotMatch(configText, new RegExp(SECRET), "Claude MCP JSON must not contain vault plaintext");
    const parsed = JSON.parse(configText);
    const serverKey = "secret-isolation-probe";
    const claudeServer = parsed.mcpServers[serverKey];
    assert.ok(claudeServer, "Claude MCP config should retain the selected server");
    const reference = claudeServer.env[ENV_KEY];
    assert.match(reference, /^\$\{AGENTLAS_MCP_SECRET_[A-F0-9]{32}\}$/);
    const alias = reference.slice(2, -1);
    assert.equal(cfg.runtimeEnv[alias], SECRET, "vault value should travel only through its opaque runtime alias");
    assert.equal(cfg.runtimeEnv[ENV_KEY], undefined, "LLM auth env name must not be overwritten on the parent CLI");

    const argvText = JSON.stringify(cfg.codexConfigArgs);
    assert.doesNotMatch(argvText, new RegExp(SECRET), "Codex -c argv must not contain vault plaintext");
    const codexCommand = JSON.parse(codexProperty(cfg.codexConfigArgs, serverKey, "command"));
    const codexArgs = JSON.parse(codexProperty(cfg.codexConfigArgs, serverKey, "args"));
    const codexEnvVars = JSON.parse(codexProperty(cfg.codexConfigArgs, serverKey, "env_vars"));
    assert.equal(codexCommand, process.execPath, "secret-bearing Codex MCP should use the local wrapper");
    assert.deepEqual(codexEnvVars, [alias], "Codex should forward only the opaque alias name");
    assert.equal(codexArgs[2], JSON.stringify({ [ENV_KEY]: alias }), "wrapper mapping contains names, never values");

    const wrapperText = fs.readFileSync(codexArgs[0], "utf8");
    assert.doesNotMatch(wrapperText, new RegExp(SECRET), "wrapper source must be secret-free");
    const launched = spawnSync(codexCommand, codexArgs, {
      encoding: "utf8",
      env: {
        ...process.env,
        ...cfg.runtimeEnv,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    assert.equal(launched.status, 0, launched.stderr || "Codex MCP wrapper should launch the original command");
    assert.equal(launched.stdout, SECRET, "wrapper should restore the original env key only inside the MCP server");

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(mcpDir).mode & 0o077, 0, "MCP directory must not be group/world accessible");
      assert.equal(fs.statSync(cfg.configPath).mode & 0o077, 0, "MCP JSON must be mode 0600");
      assert.equal(fs.statSync(codexArgs[0]).mode & 0o077, 0, "Codex wrapper must be mode 0600");
    }

    const remoteUrl = "https://mcp.example.test/stream";
    const remote = installCustomServer({
      name: "Remote HTTP Probe",
      transport: "http",
      url: remoteUrl,
    });
    const remoteCfg = await buildMcpConfigFile({ catalogIds: [remote.id] });
    assert.ok(remoteCfg, "remote MCP selection should produce runtime configs");
    const remoteJson = JSON.parse(fs.readFileSync(remoteCfg.configPath, "utf8"));
    assert.deepEqual(
      remoteJson.mcpServers["remote-http-probe"],
      { type: "http", url: remoteUrl },
      "Claude config must preserve Streamable HTTP transport",
    );
    assert.equal(
      JSON.parse(codexProperty(remoteCfg.codexConfigArgs, "remote-http-probe", "url")),
      remoteUrl,
      "current Codex CLI must keep its supported remote MCP URL",
    );

    const remoteSecret = "remote-bearer-regression-secret";
    await setEnvVar("Authorization", `Bearer ${remoteSecret}`);
    const authenticatedRemote = installCustomServer({
      name: "Authenticated Remote Probe",
      transport: "http",
      url: "https://mcp.example.test/authenticated",
      envKeys: ["Authorization"],
    });
    const authenticatedCfg = await buildMcpConfigFile({ catalogIds: [authenticatedRemote.id] });
    assert.ok(authenticatedCfg);
    const authenticatedJson = JSON.parse(fs.readFileSync(authenticatedCfg.configPath, "utf8"));
    const authenticatedServer = authenticatedJson.mcpServers["authenticated-remote-probe"];
    assert.match(authenticatedServer.headers.Authorization, /^Bearer \$\{AGENTLAS_MCP_SECRET_[A-F0-9]{32}\}$/);
    const remoteAlias = authenticatedServer.headers.Authorization.slice("Bearer ${".length, -1);
    assert.equal(authenticatedCfg.runtimeEnv[remoteAlias], remoteSecret, "remote secret must travel only in runtime env");
    assert.equal(
      JSON.parse(codexProperty(authenticatedCfg.codexConfigArgs, "authenticated-remote-probe", "bearer_token_env_var")),
      remoteAlias,
      "Codex remote auth must reference the opaque bearer env alias",
    );
    assert.doesNotMatch(JSON.stringify(authenticatedJson), new RegExp(remoteSecret));
    assert.doesNotMatch(JSON.stringify(authenticatedCfg.codexConfigArgs), new RegExp(remoteSecret));

    const legacySse = installCustomServer({
      name: "Legacy SSE Probe",
      transport: "sse",
      url: "https://mcp.example.test/legacy-sse",
    });
    const legacySseCfg = await buildMcpConfigFile({ catalogIds: [legacySse.id] });
    assert.equal(JSON.parse(fs.readFileSync(legacySseCfg.configPath, "utf8")).mcpServers["legacy-sse-probe"].type, "sse");
    assert.equal(
      legacySseCfg.codexConfigArgs.some((value) => String(value).includes("mcp_servers.legacy-sse-probe.")),
      false,
      "legacy SSE must remain Claude-only because current Codex --url is Streamable HTTP",
    );
    const clientSource = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp-tools", "client.ts"), "utf8");
    assert.match(clientSource, /StreamableHTTPClientTransport/, "HTTP MCP must not be routed through legacy SSE");
    assert.match(clientSource, /requestInit: \{ headers \}/, "remote transport requests must receive resolved vault headers");

    console.log(JSON.stringify({ ok: true, serverKey, configMode: fs.statSync(cfg.configPath).mode & 0o777 }, null, 2));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
