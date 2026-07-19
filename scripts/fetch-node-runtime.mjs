#!/usr/bin/env node
// Fetch the immutable official Node.js distribution used only as Agentlas's
// private CLI bootstrap runtime. It is not installed into Windows, does not
// require UAC, and never changes the user's system PATH.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.18.0";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "build-resources", "node-runtime");

const LOCKED_ASSETS = {
  "win32:x64": {
    name: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    nodeSha256: "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
    npmCliSha256: "3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e",
    runtimeTreeSha256: "ced095085eece2e24bb5fe957ab94253b6983729f66df9e112b79d5144116eb6",
  },
  "win32:arm64": {
    name: `node-v${NODE_VERSION}-win-arm64.zip`,
    sha256: "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
    nodeSha256: "c7225670c3f477778e18c43a55867f7a0d76468221245e5981ab80eb953c8102",
    npmCliSha256: "3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e",
    runtimeTreeSha256: "893e18bdab084c0af59c27eb8573f2bd3d2917b76919336efe97f9440039fb97",
  },
};

function fail(message) {
  console.error(`[fetch-node] ${message}`);
  process.exit(1);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function runtimeTreeSha256(root) {
  const records = [];
  const walk = (relative = "") => {
    const absolute = path.join(root, ...relative.split("/").filter(Boolean));
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (childRelative === ".gitkeep" || childRelative === "agentlas-node-runtime.json") continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = lstatSync(childAbsolute);
      if (stat.isDirectory()) walk(childRelative);
      else if (stat.isSymbolicLink()) {
        records.push({ kind: "L", relative: childRelative, target: readlinkSync(childAbsolute) });
      } else if (stat.isFile()) {
        records.push({ kind: "F", relative: childRelative, absolute: childAbsolute, size: stat.size });
      } else {
        fail(`unsupported Node runtime entry: ${childRelative}`);
      }
    }
  };
  walk();
  const digest = createHash("sha256");
  for (const record of records.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    if (record.kind === "L") {
      digest.update("L\0").update(record.relative).update("\0").update(record.target).update("\n");
    } else {
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(record.size)).update("\0").update(await sha256File(record.absolute)).update("\n");
    }
  }
  return digest.digest("hex");
}

function parseArg(name) {
  const prefixed = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return prefixed ? prefixed.slice(name.length + 3) : undefined;
}

const targetPlatform = parseArg("platform") || process.env.NODE_RUNTIME_PLATFORM || process.platform;
const targetArch = parseArg("arch") || process.env.NODE_RUNTIME_ARCH || process.arch;
if (process.env.AGENTLAS_NODE_VERSION && process.env.AGENTLAS_NODE_VERSION !== NODE_VERSION) {
  fail(`AGENTLAS_NODE_VERSION must stay pinned to ${NODE_VERSION}`);
}
const asset = LOCKED_ASSETS[`${targetPlatform}:${targetArch}`];
if (!asset) fail(`unsupported Node bootstrap target: ${targetPlatform}/${targetArch}`);

const tempRoot = path.join(os.tmpdir(), `agentlas-node-${process.pid}-${Date.now()}`);
const archive = path.join(tempRoot, asset.name);
mkdirSync(tempRoot, { recursive: true });

try {
  console.log(`[fetch-node] pinned ${asset.name}`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${asset.name}`, {
        headers: { "User-Agent": "agentlas-desktop-build" },
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      rmSync(archive, { force: true });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  if (lastError) fail(`download failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);

  const archiveSha256 = await sha256File(archive);
  if (archiveSha256 !== asset.sha256) {
    fail(`SHA-256 mismatch for ${asset.name}: expected=${asset.sha256} observed=${archiveSha256}`);
  }
  console.log(`[fetch-node] sha256 verified ${archiveSha256}`);

  const extractRoot = path.join(tempRoot, "extract");
  mkdirSync(extractRoot, { recursive: true });
  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (!existsSync(powershell)) fail("Windows PowerShell was not found");
    const expandScript = path.join(tempRoot, "expand-node-runtime.ps1");
    writeFileSync(
      expandScript,
      "param([string]$Archive, [string]$Destination)\r\n"
        + "$ErrorActionPreference = 'Stop'\r\n"
        + "Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\r\n",
      { encoding: "utf8", mode: 0o600 },
    );
    execFileSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      expandScript,
      archive,
      extractRoot,
    ], { stdio: "inherit", windowsHide: true });
  } else {
    // Developer/CI cross-target verification on macOS or Linux.
    execFileSync("unzip", ["-q", archive, "-d", extractRoot], { stdio: "inherit" });
  }

  const topLevel = readdirSync(extractRoot).filter((entry) => entry !== "__MACOSX");
  if (topLevel.length !== 1) fail(`unexpected Node archive layout: ${topLevel.join(", ")}`);
  const extracted = path.join(extractRoot, topLevel[0]);
  if (!lstatSync(extracted).isDirectory()) fail("Node archive root is not a directory");

  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (entry !== ".gitkeep") rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(extracted)) {
    cpSync(path.join(extracted, entry), path.join(outDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }

  const nodeRelativePath = "node.exe";
  const npmCliRelativePath = "node_modules/npm/bin/npm-cli.js";
  const nodePath = path.join(outDir, nodeRelativePath);
  const npmCliPath = path.join(outDir, ...npmCliRelativePath.split("/"));
  if (!existsSync(nodePath) || !existsSync(npmCliPath)) fail("Node archive does not contain node.exe and npm CLI");
  const nodeSha256 = await sha256File(nodePath);
  const npmCliSha256 = await sha256File(npmCliPath);
  if (nodeSha256 !== asset.nodeSha256 || npmCliSha256 !== asset.npmCliSha256) {
    fail("extracted Node executable or npm CLI does not match the immutable file pins");
  }
  const runtimeTreeDigest = await runtimeTreeSha256(outDir);
  if (runtimeTreeDigest !== asset.runtimeTreeSha256) {
    fail(`extracted Node runtime tree mismatch: expected=${asset.runtimeTreeSha256} observed=${runtimeTreeDigest}`);
  }
  const manifest = {
    schemaVersion: "agentlas.node-runtime.v1",
    nodeVersion: NODE_VERSION,
    platform: targetPlatform,
    arch: targetArch,
    archiveName: asset.name,
    archiveSha256: asset.sha256,
    nodeRelativePath,
    nodeSha256,
    npmCliRelativePath,
    npmCliSha256,
    runtimeTreeSha256: runtimeTreeDigest,
  };
  writeFileSync(
    path.join(outDir, "agentlas-node-runtime.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );

  if (targetPlatform === process.platform && targetArch === process.arch) {
    const nodeVersion = execFileSync(nodePath, ["--version"], { windowsHide: true }).toString().trim();
    const npmVersion = execFileSync(nodePath, [npmCliPath, "--version"], { windowsHide: true }).toString().trim();
    if (nodeVersion !== `v${NODE_VERSION}`) fail(`Node version mismatch after extraction: ${nodeVersion}`);
    console.log(`[fetch-node] ready ${nodeVersion}, npm ${npmVersion}`);
  } else {
    console.log(`[fetch-node] ready for cross-target ${targetPlatform}/${targetArch}`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
