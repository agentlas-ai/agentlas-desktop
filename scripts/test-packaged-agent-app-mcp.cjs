#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");

const root = path.resolve(__dirname, "..");
const packageRoot = path.resolve(process.argv[2] || path.join(root, "release"));
const SYSTEM_TIME_SOURCE_DIGEST = "11f73b8c137b1e52a806667739c89ae1e330ea7f7e9f9d7201ab42f2a042b712";
const CHILD_ENV_ALLOWLIST = [
  "COMSPEC",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
];
const MAC_PACKAGED_APP_EXECUTABLES = Object.freeze({
  "Agentlas.app": "Agentlas",
  "Agentlas-Local-Candidate.app": "Agentlas-Local-Candidate",
});

function packagedChildEnvironment() {
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  assert.deepEqual(
    Object.keys(env).filter((key) => /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|API_KEY)/i.test(key)),
    [],
    "packaged MCP smoke child must not inherit credential-bearing environment variables",
  );
  return env;
}

function macAppBundlesBelow(root) {
  const bundles = [];
  if (path.basename(root).endsWith(".app")) {
    bundles.push(root);
  } else {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(root, entry.name);
      if (entry.name.endsWith(".app")) {
        bundles.push(child);
        continue;
      }
      for (const nested of fs.readdirSync(child, { withFileTypes: true })) {
        if (nested.isDirectory() && nested.name.endsWith(".app")) {
          bundles.push(path.join(child, nested.name));
        }
      }
    }
  }
  return bundles.sort();
}

function packagedMacBinary(root) {
  const bundles = macAppBundlesBelow(root);
  assert.ok(bundles.length > 0, `packaged macOS app bundle not found under ${root}`);

  const identities = new Set();
  const binaries = bundles.map((app) => {
    const appName = path.basename(app);
    const executable = MAC_PACKAGED_APP_EXECUTABLES[appName];
    assert.equal(
      typeof executable,
      "string",
      `unknown macOS app bundle ${appName}; expected one of ${Object.keys(MAC_PACKAGED_APP_EXECUTABLES).join(", ")}`,
    );
    identities.add(appName);
    const binary = path.join(app, "Contents", "MacOS", executable);
    assert.equal(fs.existsSync(binary), true, `packaged executable not found at ${binary}`);
    return binary;
  });

  assert.equal(
    identities.size,
    1,
    `packaged macOS output must not mix app identities: ${[...identities].join(", ")}`,
  );
  return binaries[0];
}

function packagedBinary() {
  if (process.platform === "darwin") return packagedMacBinary(packageRoot);

  const dirs = fs.readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packageRoot, entry.name));
  for (const dir of dirs) {
    if (process.platform === "win32") {
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

function packagedAsar(binary) {
  const asar = process.platform === "darwin"
    ? path.resolve(path.dirname(binary), "..", "Resources", "app.asar")
    : path.join(path.dirname(binary), "resources", "app.asar");
  assert.equal(fs.existsSync(asar), true, `packaged app.asar not found at ${asar}`);
  return asar;
}

function readPackagedSystemTimeContract(binary) {
  const modulePath = path.join(
    packagedAsar(binary),
    "dist",
    "electron",
    "mcp-tools",
    "system-time-server.js",
  );
  const probeSource = [
    `const m = require(${JSON.stringify(modulePath)});`,
    "process.stdout.write(JSON.stringify({",
    "  args: m.systemTimeMcpLaunchArgs(),",
    "  digest: m.systemTimeMcpSourceDigest(),",
    "}));",
  ].join("\n");
  const probe = spawnSync(binary, ["-e", probeSource], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: packagedChildEnvironment(),
    windowsHide: true,
  });
  assert.equal(probe.error, undefined, probe.error?.message);
  assert.equal(probe.status, 0, probe.stderr || `packaged contract probe exited ${probe.status}`);
  const contract = JSON.parse(probe.stdout.trim());
  assert.deepEqual(
    Object.keys(contract).sort(),
    ["args", "digest"],
    "packaged System Time contract must expose only launch args and source digest",
  );
  assert.equal(
    contract.digest,
    SYSTEM_TIME_SOURCE_DIGEST,
    "packaged System Time source must match the audited source digest",
  );
  assert.equal(Array.isArray(contract.args), true, "packaged System Time launch args must be an array");
  assert.equal(contract.args.length >= 2, true, "packaged System Time launch args are incomplete");
  assert.equal(contract.args[0], "-e", "packaged System Time must use the embedded Node bootstrap");
  return contract;
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

  const packagedContract = readPackagedSystemTimeContract(binary);
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
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_current_time", arguments: { timezone: "UTC" } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "convert_time",
        arguments: {
          source_timezone: "Asia/Seoul",
          time: "09:00",
          target_timezone: "UTC",
        },
      },
    },
  ].map(JSON.stringify).join("\n") + "\n";
  const child = spawnSync(binary, packagedContract.args, {
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: packagedChildEnvironment(),
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
  assert.equal(responses[2]?.result?.isError === true, false, "get_current_time must succeed");
  const currentTime = JSON.parse(responses[2]?.result?.content?.[0]?.text);
  assert.equal(currentTime.timezone, "UTC");
  assert.match(currentTime.datetime, /T\d{2}:\d{2}:\d{2}\+00:00$/);
  assert.equal(responses[3]?.result?.isError === true, false, "convert_time must succeed");
  const convertedTime = JSON.parse(responses[3]?.result?.content?.[0]?.text);
  assert.equal(convertedTime.source.timezone, "Asia/Seoul");
  assert.match(convertedTime.source.datetime, /T09:00:00\+09:00$/);
  assert.equal(convertedTime.target.timezone, "UTC");
  assert.match(convertedTime.target.datetime, /T00:00:00\+00:00$/);
  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    binary,
    sourceDigest: packagedContract.digest,
    conversion: "Asia/Seoul 09:00 -> UTC 00:00",
    tools: responses[1].result.tools.map((tool) => tool.name),
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  MAC_PACKAGED_APP_EXECUTABLES,
  macAppBundlesBelow,
  packagedMacBinary,
};
