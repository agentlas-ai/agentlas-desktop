#!/usr/bin/env node
// Materialize the Playwright-pinned Chrome for Testing into the product
// resources tree. Runtime code never falls back to a system Chrome install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(repoRoot, "build-resources", "browser-runtime");
const manifestName = "agentlas-browser-runtime.json";
const playwrightPackage = require("playwright/package.json");
const playwrightCoreRoot = path.dirname(require.resolve("playwright-core/package.json"));
const browsers = JSON.parse(readFileSync(path.join(playwrightCoreRoot, "browsers.json"), "utf8")).browsers;
const chromiumRecord = browsers.find((record) => record.name === "chromium");
if (!chromiumRecord?.revision || !chromiumRecord.browserVersion) {
  throw new Error("Pinned Playwright Chromium metadata is missing");
}

const targetPlatform = process.env.AGENTLAS_BROWSER_TARGET_PLATFORM || process.platform;
const targetArch = process.env.AGENTLAS_BROWSER_TARGET_ARCH || process.arch;
if (!['darwin', 'win32', 'linux'].includes(targetPlatform)) {
  throw new Error(`Unsupported browser target platform: ${targetPlatform}`);
}
if (!['arm64', 'x64'].includes(targetArch)) {
  throw new Error(`Unsupported browser target architecture: ${targetArch}`);
}
if (targetPlatform === 'win32' && targetArch !== 'x64') {
  throw new Error('Playwright Chrome for Testing for Windows is packaged as x64 only');
}

let isolatedDownloadRoot = null;
if (targetPlatform !== process.platform || targetArch !== process.arch) {
  if (targetPlatform !== 'darwin' || process.platform !== 'darwin') {
    throw new Error(`Cross-platform browser download is unsupported: ${process.platform}/${process.arch} -> ${targetPlatform}/${targetArch}`);
  }
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = targetArch === 'arm64' ? 'mac26-arm64' : 'mac26';
  isolatedDownloadRoot = mkdtempSync(path.join(os.tmpdir(), `agentlas-browser-${targetPlatform}-${targetArch}-`));
  process.env.PLAYWRIGHT_BROWSERS_PATH = isolatedDownloadRoot;
}

function ensureInstalledExecutable() {
  const { chromium } = require("playwright");
  let executable = chromium.executablePath();
  if (!existsSync(executable)) {
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    execFileSync(process.execPath, [cli, "install", "chromium"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    executable = chromium.executablePath();
  }
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Playwright Chrome for Testing executable is missing: ${executable}`);
  }
  return path.resolve(executable);
}

function revisionRoot(executable) {
  const filesystemRoot = path.parse(executable).root;
  const parts = path.relative(filesystemRoot, executable).split(path.sep);
  const index = parts.findIndex((part) => part === `chromium-${chromiumRecord.revision}`);
  if (index < 0) throw new Error(`Unexpected Playwright Chromium layout: ${executable}`);
  return path.join(filesystemRoot, ...parts.slice(0, index + 1));
}

async function sha256File(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function runtimeTreeSha256(root) {
  const records = [];
  const walk = (relative = "") => {
    const absolute = path.join(root, ...relative.split("/").filter(Boolean));
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (childRelative === ".gitkeep" || childRelative === manifestName) continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = lstatSync(childAbsolute);
      if (stat.isDirectory()) walk(childRelative);
      else if (stat.isSymbolicLink()) {
        records.push({ kind: "L", relative: childRelative, target: readlinkSync(childAbsolute) });
      } else if (stat.isFile()) {
        records.push({ kind: "F", relative: childRelative, absolute: childAbsolute, size: stat.size });
      } else {
        throw new Error(`Unsupported browser runtime entry: ${childRelative}`);
      }
    }
  };
  walk();
  const digest = createHash("sha256");
  // Use code-point ordering, not localeCompare: packaging runs on hosts with
  // different locales and the same bytes must produce one release hash.
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

function macBundleId(executable) {
  if (targetPlatform !== "darwin") return undefined;
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const index = executable.lastIndexOf(marker);
  if (index < 0) throw new Error("macOS Chrome for Testing executable is not inside an app bundle");
  const appRoot = executable.slice(0, index);
  const info = readFileSync(path.join(appRoot, "Contents", "Info.plist"), "utf8");
  const bundleId = info.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u)?.[1];
  if (bundleId !== "com.google.chrome.for.testing") {
    throw new Error(`Refusing browser bundle identity: ${bundleId ?? "missing"}`);
  }
  return bundleId;
}

function verifyMacArchitecture(executable) {
  if (process.platform !== "darwin" || targetPlatform !== "darwin") return;
  const arches = execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" })
    .trim()
    .split(/\s+/u);
  const expected = targetArch === "x64" ? "x86_64" : "arm64";
  if (!arches.includes(expected)) {
    throw new Error(`Chrome for Testing architecture mismatch: expected ${expected}, got ${arches.join(",")}`);
  }
}

async function main() {
  const sourceExecutable = ensureInstalledExecutable();
  verifyMacArchitecture(sourceExecutable);
  const sourceRoot = revisionRoot(sourceExecutable);
  const sourceRelative = path.relative(sourceRoot, sourceExecutable);
  if (sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) {
    throw new Error("Playwright executable escapes its revision root");
  }

  mkdirSync(outRoot, { recursive: true });
  for (const entry of readdirSync(outRoot)) {
    if (entry !== ".gitkeep") rmSync(path.join(outRoot, entry), { recursive: true, force: true });
  }
  const destinationRoot = path.join(outRoot, path.basename(sourceRoot));
  cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const executableRelativePath = path.posix.join(
    path.basename(sourceRoot),
    ...sourceRelative.split(path.sep),
  );
  const destinationExecutable = path.join(outRoot, ...executableRelativePath.split("/"));
  const manifest = {
    schemaVersion: "agentlas.browser-runtime.v1",
    runtime: "playwright-chrome-for-testing",
    playwrightVersion: playwrightPackage.version,
    browserRevision: String(chromiumRecord.revision),
    browserVersion: String(chromiumRecord.browserVersion),
    platform: targetPlatform,
    arch: targetArch,
    executableRelativePath,
    executableSha256: await sha256File(destinationExecutable),
    runtimeTreeSha256: await runtimeTreeSha256(outRoot),
    ...(targetPlatform === "darwin" ? { macBundleId: macBundleId(sourceExecutable) } : {}),
  };
  writeFileSync(path.join(outRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`[fetch-browser] Playwright ${manifest.playwrightVersion} Chrome for Testing ${manifest.browserVersion}`);
  console.log(`[fetch-browser] ${destinationExecutable}`);
  console.log(`[fetch-browser] tree ${manifest.runtimeTreeSha256}`);
}

try {
  await main();
} finally {
  if (isolatedDownloadRoot) rmSync(isolatedDownloadRoot, { recursive: true, force: true });
}
