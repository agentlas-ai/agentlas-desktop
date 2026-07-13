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
      args: ["-e", `process.stdout.write(JSON.stringify({ credential: process.env.${ENV_KEY} || "missing", path: process.env.PATH || "", home: process.env.HOME || process.env.USERPROFILE || "", unrelated: process.env.AGENTLAS_UNRELATED_SECRET_CANARY || "", github: process.env.GITHUB_TOKEN || "", alias: Object.keys(process.env).find((key) => key.startsWith("AGENTLAS_MCP_SECRET_")) || "" }))`],
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
    assert.equal(claudeServer.command, process.execPath, "Claude stdio MCP must also use the isolated child wrapper");
    const claudeAliases = Object.entries(claudeServer.env)
      .filter(([key]) => key.startsWith("AGENTLAS_MCP_SECRET_"));
    assert.equal(claudeAliases.length, 1);
    const [alias, reference] = claudeAliases[0];
    assert.equal(reference, `\${${alias}}`);
    assert.equal(claudeServer.env[ENV_KEY], undefined, "the original credential name exists only inside the MCP child");
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
        AGENTLAS_UNRELATED_SECRET_CANARY: "unrelated-host-secret",
        GITHUB_TOKEN: "unapproved-github-secret",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    assert.equal(launched.status, 0, launched.stderr || "Codex MCP wrapper should launch the original command");
    const childEnv = JSON.parse(launched.stdout);
    assert.equal(childEnv.credential, SECRET, "wrapper should restore the original env key only inside the MCP server");
    assert.ok(childEnv.path, "MCP child keeps PATH");
    assert.ok(childEnv.home, "MCP child keeps HOME/USERPROFILE");
    assert.equal(childEnv.unrelated, "", "unrelated host canary must not reach the MCP child");
    assert.equal(childEnv.github, "", "unapproved host credentials must not reach the MCP child");
    assert.equal(childEnv.alias, "", "opaque aliases must not remain visible inside the MCP child");

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(mcpDir).mode & 0o077, 0, "MCP directory must not be group/world accessible");
      assert.equal(fs.statSync(cfg.configPath).mode & 0o077, 0, "MCP JSON must be mode 0600");
      assert.equal(fs.statSync(codexArgs[0]).mode & 0o077, 0, "Codex wrapper must be mode 0600");
    }

    const keyless = installCustomServer({
      name: "Keyless Child Isolation Probe",
      transport: "stdio",
      command: nodeBin,
      args: ["-e", `process.stdout.write(JSON.stringify({ path: process.env.PATH || "", home: process.env.HOME || process.env.USERPROFILE || "", openai: process.env.OPENAI_API_KEY || "", github: process.env.GITHUB_TOKEN || "", alias: Object.keys(process.env).find((key) => key.startsWith("AGENTLAS_MCP_SECRET_")) || "" }))`],
    });
    const keylessCfg = await buildMcpConfigFile({ catalogIds: [keyless.id] });
    const keylessServer = JSON.parse(fs.readFileSync(keylessCfg.configPath, "utf8")).mcpServers["keyless-child-isolation-probe"];
    assert.equal(keylessServer.command, process.execPath, "even keyless stdio MCPs need the isolated child wrapper");
    assert.equal(keylessServer.args[2], "{}", "keyless MCP wrapper has no credential mapping");
    const keylessLaunch = spawnSync(keylessServer.command, keylessServer.args, {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "llm-runtime-secret-canary",
        GITHUB_TOKEN: "unapproved-github-secret",
        AGENTLAS_MCP_SECRET_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA: "other-mcp-secret-canary",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    assert.equal(keylessLaunch.status, 0, keylessLaunch.stderr || "keyless MCP wrapper should launch");
    const keylessEnv = JSON.parse(keylessLaunch.stdout);
    assert.ok(keylessEnv.path);
    assert.ok(keylessEnv.home);
    assert.equal(keylessEnv.openai, "", "keyless MCP must not inherit LLM runtime authentication");
    assert.equal(keylessEnv.github, "", "keyless MCP must not inherit unrelated host credentials");
    assert.equal(keylessEnv.alias, "", "keyless MCP must not inherit another MCP alias");

    const playwright = installCustomServer({
      name: "Playwright",
      transport: "stdio",
      command: nodeBin,
      args: ["-e", "process.exit(0)"],
    });
    const staleBrowserProfile = path.join(mcpDir, "browser-profiles", "security-audit-profile");
    fs.mkdirSync(staleBrowserProfile, { recursive: true, mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(staleBrowserProfile, 0o755);
    const playwrightCfg = await buildMcpConfigFile({
      catalogIds: [playwright.id],
      browserProfileKey: "security-audit-profile",
    });
    assert.ok(playwrightCfg, "Playwright MCP config should be generated");
    const playwrightServer = JSON.parse(fs.readFileSync(playwrightCfg.configPath, "utf8")).mcpServers.playwright;
    assert.ok(
      playwrightServer.args.includes(staleBrowserProfile),
      "Playwright must receive the exact private persistent profile",
    );
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(staleBrowserProfile).mode & 0o777,
        0o700,
        "persistent browser profile must be repaired to mode 0700",
      );
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
