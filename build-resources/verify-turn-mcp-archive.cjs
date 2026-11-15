"use strict";

// Validate the source assembled by the *packaged* turn MCP module, not a
// separately transpiled source file. The real module and its dependencies are
// loaded inside the host Electron; only the final launcher is intercepted so
// this check does not write to the owner's built-in MCP directory.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CAPTURE = String.raw`
const Module = require("node:module");
const load = Module._load;
let source, count = 0;
Module._load = function (name, parent, ...rest) {
  if (name === "../mcp-tools/builtin-mcp-launch" && /[\\/]turn-tools[\\/]mcp-server\.js$/.test(parent.filename)) {
    return { BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS: 4096, defineBuiltinMcpLaunch: (slug, value) => {
      if (slug !== "agentlas-turn" || typeof value !== "string") throw Error("unexpected turn launcher");
      source = value; count++;
      return { launchArgs: () => [], sourceSha256: "", isAuthenticArgs: () => false };
    } };
  }
  return load.apply(this, [name, parent, ...rest]);
};
require(process.argv[1]);
if (count !== 1 || !source) throw Error("packaged turn source was not captured");
process.stdout.write("\nAGENTLAS_TURN_SOURCE=" + JSON.stringify(source) + "\n");
`;

function run(executable, args, options = {}) {
  const env = {};
  for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "PATH", "SystemRoot", "WINDIR", "LANG"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync(executable, args, {
    encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    ...options, env: { ...env, ...options.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || result.signal || result.status).slice(-4000);
    throw new Error(`[afterPack] packaged turn MCP failed: ${detail}`);
  }
  return result.stdout;
}

function verifyPackagedTurnMcp(archive, executable = require("electron")) {
  const packedModule = path.join(path.resolve(archive), "dist", "electron", "turn-tools", "mcp-server.js");
  const capture = run(executable, ["-e", CAPTURE, packedModule]);
  const line = capture.split(/\r?\n/).find((value) => value.startsWith("AGENTLAS_TURN_SOURCE="));
  if (!line) throw new Error("[afterPack] packaged turn MCP source capture missing");
  const source = JSON.parse(line.slice("AGENTLAS_TURN_SOURCE=".length));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-turn-archive-check-"));
  try {
    const child = path.join(dir, "child.cjs"), capability = path.join(dir, "capability.json");
    fs.writeFileSync(child, source, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(capability, JSON.stringify({ schemaVersion: 1, port: 1, token: "test", capabilityId: "test", tools: ["harness_search", "harness_describe", "harness_call"] }), { mode: 0o600, flag: "wx" });
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "package-check", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map(JSON.stringify).join("\n") + "\n";
    const output = run(executable, [child], { input, env: { AGENTLAS_TURN_CONTROL_FILE: capability } });
    const replies = output.trim().split(/\r?\n/).map((value) => JSON.parse(value));
    const initialized = replies.find((value) => value.id === 1)?.result;
    const listed = replies.find((value) => value.id === 2)?.result?.tools;
    if (initialized?.serverInfo?.name !== "agentlas-turn" || !initialized.protocolVersion || !Array.isArray(listed)) throw new Error("[afterPack] packaged turn MCP handshake invalid");
    for (const name of ["harness_search", "harness_describe", "harness_call"]) {
      if (!listed.some((item) => item.name === name)) throw new Error(`[afterPack] packaged turn MCP missing ${name}`);
    }
    return { sourceBytes: Buffer.byteLength(source), harnessTools: 3 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) throw new Error("[afterPack] packaged turn MCP check cleanup failed");
  }
}

module.exports = { verifyPackagedTurnMcp };

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("Usage: node build-resources/verify-turn-mcp-archive.cjs /path/to/app.asar");
    process.exitCode = 2;
  } else {
    try {
      console.log(`Packaged turn MCP verified: ${JSON.stringify(verifyPackagedTurnMcp(process.argv[2]))}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
