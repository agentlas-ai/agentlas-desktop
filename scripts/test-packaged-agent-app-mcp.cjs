#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");

const root = path.resolve(__dirname, "..");
const packageRoot = path.resolve(process.argv[2] || path.join(root, "release"));

function packagedBinary() {
  const dirs = fs.readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packageRoot, entry.name));
  for (const dir of dirs) {
    if (process.platform === "darwin") {
      const app = fs.readdirSync(dir, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
      if (app) {
        const binary = path.join(dir, app.name, "Contents", "MacOS", "Agentlas");
        if (fs.existsSync(binary)) return binary;
      }
    } else if (process.platform === "win32") {
      for (const name of ["Agentlas.exe", "agentlas.exe"]) {
        const binary = path.join(dir, name);
        if (fs.existsSync(binary)) return binary;
      }
    } else {
      for (const name of ["agentlas-desktop", "agentlas", "Agentlas"]) {
        const binary = path.join(dir, name);
        if (fs.existsSync(binary)) return binary;
      }
    }
  }
  throw new Error(`packaged Agentlas binary not found under ${packageRoot}`);
}

async function main() {
  const binary = packagedBinary();
  const wire = await getCurrentFuseWire(binary);
  const enabled = "1".charCodeAt(0);
  const disabled = "0".charCodeAt(0);
  assert.equal(wire[FuseV1Options.RunAsNode], enabled, "packaged workers require RunAsNode");
  assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], disabled,
    "packaged binary must ignore NODE_OPTIONS injection");
  assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], disabled,
    "packaged binary must reject Node inspector CLI injection");
  assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], enabled,
    "packaged binary must carry the embedded ASAR integrity fuse");
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], enabled,
    "packaged binary must load the app entry only from ASAR");

  const { systemTimeMcpLaunchArgs } = require("../dist/electron/mcp-tools/system-time-server.js");
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentlas-packaged-gate", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(JSON.stringify).join("\n") + "\n";
  const child = spawnSync(binary, systemTimeMcpLaunchArgs(), {
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || `packaged MCP exited ${child.status}`);
  const responses = child.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses[0]?.result?.serverInfo?.name, "agentlas-system-time");
  assert.deepEqual(
    responses[1]?.result?.tools?.map((tool) => tool.name),
    ["get_current_time", "convert_time"],
  );
  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    binary,
    tools: responses[1].result.tools.map((tool) => tool.name),
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
