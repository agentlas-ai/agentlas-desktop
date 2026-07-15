#!/usr/bin/env node
"use strict";

/**
 * Native packaged updater E2E.
 *
 * This downloads the actual public v0.8.32 binary under its pinned digest,
 * points only a disposable installed/extracted copy at a loopback generic
 * feed, and installs the already-built current artifact. It never rewrites a
 * public feed, public release asset, or the caller's checkout.
 *
 * Windows: silently installs public v0.8.32 NSIS, then verifies the NSIS
 * updater replaces that install with the supplied target installer.
 * Linux: extracts and runs public v0.8.32 AppImage, then verifies AppImageUpdater moves
 * the supplied target AppImage into place and relaunches it.
 *
 * Usage (run on the matching native runner):
 *   node scripts/test-packaged-updater-install-e2e.cjs \
 *     --platform win32|linux --artifact-dir <Release dir> \
 *     --target-version 0.8.33 [--baseline-ref v0.8.32] [--feed-port 0]
 *
 * Environment equivalents:
 *   AGENTLAS_UPDATER_E2E_PLATFORM
 *   AGENTLAS_UPDATER_E2E_ARTIFACT_DIR
 *   AGENTLAS_UPDATER_E2E_TARGET_VERSION
 *   AGENTLAS_UPDATER_E2E_BASELINE_REF
 *   AGENTLAS_UPDATER_E2E_BASELINE_VERSION
 *   AGENTLAS_UPDATER_E2E_FEED_PORT
 *   AGENTLAS_UPDATER_E2E_TIMEOUT_MS
 *
 * `--selftest` is native-free: it only exercises argument, manifest, generic
 * config, pinned-artifact, and loopback-server behavior using files under the
 * OS temp directory.
 */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const yaml = require("js-yaml");
const { extractFile } = require("@electron/asar");
const WebSocket = require("ws");

const REQUIRED_BASELINE_VERSION = "0.8.32";
const DEFAULT_BASELINE_REF = "v0.8.32";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 240_000;
const BASELINE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const JOURNAL_NAME = "install-journal.v1.json";
const APP_NAME = "Agentlas";
const APP_ID = "com.agentlas.desktop";
const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
const PUBLIC_BASELINE_RELEASE_REPOSITORY = "agentlas-ai/agentlas-desktop-releases";
const PUBLIC_BASELINE_ARTIFACTS = Object.freeze({
  win32: Object.freeze({
    fileName: "Agentlas-0.8.32-Windows-x64-Setup.exe",
    sha256: "10f17bf1172bbce56f6c54ece3f0edae86d97851d483a809f2d412e2091cb9e7",
    size: 169530943,
  }),
  linux: Object.freeze({
    fileName: "Agentlas-0.8.32-Linux-x64.AppImage",
    sha256: "c4e2cf06f1c60f3ce684d6cd51ba87cc4ee013bfaa87786007da9ff6b7306626",
    size: 171596890,
  }),
});
const OFFICIAL_UPDATE_REPOSITORY = Object.freeze({
  owner: "agentlas-ai",
  private: false,
  provider: "github",
  repo: "agentlas-desktop-releases",
});

function usage() {
  return [
    "Usage: node scripts/test-packaged-updater-install-e2e.cjs --platform win32|linux --artifact-dir <Release dir> --target-version <version> [--baseline-ref v0.8.32] [--baseline-version 0.8.32] [--feed-port 0] [--timeout-ms 120000]",
    "       node scripts/test-packaged-updater-install-e2e.cjs --selftest",
  ].join("\n");
}

function readCli(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const bare = token.slice(2);
    const equals = bare.indexOf("=");
    if (equals >= 0) {
      values[bare.slice(0, equals)] = bare.slice(equals + 1);
      continue;
    }
    if (["selftest", "help", "keep-temp"].includes(bare)) {
      values[bare] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      throw new Error(`Missing value for --${bare}`);
    }
    values[bare] = next;
    index += 1;
  }
  return values;
}

function firstValue(cli, keys, envKeys, fallback) {
  for (const key of keys) {
    if (cli[key] != null && cli[key] !== "") return String(cli[key]);
  }
  for (const key of envKeys) {
    if (process.env[key] != null && process.env[key] !== "") return String(process.env[key]);
  }
  return fallback;
}

function normalizePlatform(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["win", "windows", "win32"].includes(normalized)) return "win32";
  if (["linux", "linux-x64"].includes(normalized)) return "linux";
  throw new Error(`--platform must be win32 or linux (received ${JSON.stringify(value)})`);
}

function positiveInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function assertReleaseVersion(value, label) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${label} must be a semver release version (received ${JSON.stringify(value)})`);
  }
  return version;
}

function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw new Error(`Cannot compare non-semver value ${JSON.stringify(value)}`);
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] || null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease == null) return 1;
  if (b.prerelease == null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function parseOptions(argv) {
  const cli = readCli(argv);
  if (cli.help) return { help: true };
  if (cli.selftest) return { selftest: true };

  const platform = normalizePlatform(firstValue(cli, ["platform"], ["AGENTLAS_UPDATER_E2E_PLATFORM"]));
  const artifactDir = firstValue(
    cli,
    ["artifact-dir", "artifact"],
    ["AGENTLAS_UPDATER_E2E_ARTIFACT_DIR", "AGENTLAS_UPDATER_E2E_ARTIFACT"],
  );
  const targetVersion = assertReleaseVersion(
    firstValue(cli, ["target-version", "version"], ["AGENTLAS_UPDATER_E2E_TARGET_VERSION", "AGENTLAS_UPDATER_E2E_VERSION"]),
    "target version",
  );
  const baselineRef = firstValue(cli, ["baseline-ref", "baseline"], ["AGENTLAS_UPDATER_E2E_BASELINE_REF"], DEFAULT_BASELINE_REF);
  const baselineVersion = assertReleaseVersion(
    firstValue(cli, ["baseline-version"], ["AGENTLAS_UPDATER_E2E_BASELINE_VERSION"], REQUIRED_BASELINE_VERSION),
    "baseline version",
  );
  const feedPort = positiveInteger(
    firstValue(cli, ["feed-port", "port"], ["AGENTLAS_UPDATER_E2E_FEED_PORT"], "0"),
    "feed port",
    0,
    65535,
  );
  const timeoutMs = positiveInteger(
    firstValue(cli, ["timeout-ms"], ["AGENTLAS_UPDATER_E2E_TIMEOUT_MS"], String(DEFAULT_TIMEOUT_MS)),
    "timeout",
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  if (!artifactDir) throw new Error("--artifact-dir (or AGENTLAS_UPDATER_E2E_ARTIFACT_DIR) is required");
  if (baselineVersion !== REQUIRED_BASELINE_VERSION) {
    throw new Error(`This P0 harness is intentionally pinned to baseline ${REQUIRED_BASELINE_VERSION}, not ${baselineVersion}`);
  }
  if (baselineRef !== DEFAULT_BASELINE_REF) {
    throw new Error(`This P0 harness uses the pinned public ${DEFAULT_BASELINE_REF} artifacts, not ${baselineRef}`);
  }
  if (compareReleaseVersions(targetVersion, baselineVersion) <= 0) {
    throw new Error(`Target ${targetVersion} must be newer than baseline ${baselineVersion}`);
  }

  return {
    artifactDir: path.resolve(artifactDir),
    baselineRef,
    baselineVersion,
    feedPort,
    keepTemp: Boolean(cli["keep-temp"]),
    platform,
    repoDir: path.resolve(firstValue(cli, ["repo-dir"], ["AGENTLAS_UPDATER_E2E_REPO_DIR"], process.cwd())),
    targetVersion,
    timeoutMs,
  };
}

function targetSpec(platform, version) {
  if (platform === "win32") {
    return {
      manifestName: "latest.yml",
      payloadName: `Agentlas-${version}-Windows-x64-Setup.exe`,
      type: "nsis",
    };
  }
  return {
    manifestName: "latest-linux.yml",
    payloadName: `Agentlas-${version}-Linux-x64.AppImage`,
    type: "appimage",
  };
}

function log(message) {
  process.stdout.write(`[packaged-updater-e2e] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[packaged-updater-e2e] ${message}\n`);
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(" ");
}

function uuidV5(name, namespace) {
  const namespaceHex = String(namespace).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(namespaceHex)) throw new Error(`Invalid UUID namespace ${JSON.stringify(namespace)}`);
  const digest = crypto.createHash("sha1")
    .update(Buffer.from(namespaceHex, "hex"))
    .update(Buffer.from(String(name), "utf8"))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function windowsInstallRegistryKey() {
  return `Software\\${uuidV5(APP_ID, ELECTRON_BUILDER_NS_UUID)}`;
}

function readWindowsInstallLocation() {
  const script = [
    "$key = 'HKCU:\\' + $env:AGENTLAS_UPDATER_E2E_REGISTRY_KEY",
    "if (-not (Test-Path -LiteralPath $key)) { exit 3 }",
    "$location = (Get-ItemProperty -LiteralPath $key -Name InstallLocation -ErrorAction Stop).InstallLocation",
    "if ([string]::IsNullOrWhiteSpace($location)) { exit 4 }",
    "[Console]::Out.Write($location)",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, AGENTLAS_UPDATER_E2E_REGISTRY_KEY: windowsInstallRegistryKey() },
    windowsHide: true,
  });
  if (result.status === 3) return null;
  if (result.status !== 0) {
    throw new Error(`Unable to read the Agentlas per-user NSIS registration (exit ${result.status}): ${String(result.stderr || "").trim()}`);
  }
  return path.resolve(String(result.stdout || "").trim());
}

function windowsExecutableVersion(executable) {
  const script = [
    "$version = (Get-Item -LiteralPath $env:AGENTLAS_UPDATER_E2E_EXE).VersionInfo.ProductVersion",
    "if ([string]::IsNullOrWhiteSpace($version)) { exit 3 }",
    "[Console]::Out.Write($version)",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, AGENTLAS_UPDATER_E2E_EXE: executable },
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim().replace(/\.0$/, "");
}

function assertDefaultWindowsInstallLocation(installDir, tempRoot) {
  const expected = defaultWindowsInstallLocation();
  const actual = path.resolve(installDir);
  assert.equal(actual.toLowerCase(), expected.toLowerCase(), "NSIS registration did not use the real per-user default installation directory");
  assert.ok(!actual.toLowerCase().startsWith(`${path.resolve(tempRoot).toLowerCase()}${path.sep}`), "NSIS baseline must not use an ad-hoc E2E installation directory");
}

function defaultWindowsInstallLocation() {
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required to verify the real per-user NSIS default location");
  return path.resolve(path.join(process.env.LOCALAPPDATA, "Programs", APP_NAME));
}

function runCommand(command, args, options = {}) {
  const { cwd, env, label = command, stdio = "inherit" } = options;
  log(`running ${label}: ${displayCommand(command, args)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio, windowsHide: true });
    child.once("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
      }
    });
  });
}

function assertFile(file, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} is missing: ${file}`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`);
  return stat;
}

async function digestFile(file, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest(encoding)));
  });
}

function sha512Base64(file) {
  return digestFile(file, "sha512", "base64");
}

function sha256Hex(file) {
  return digestFile(file, "sha256", "hex");
}

function requireHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return parsed;
}

function downloadHttpsFile(url, destination, redirectsRemaining = 5) {
  const parsed = requireHttpsUrl(url, "pinned public baseline URL");
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "agentlas-desktop-updater-e2e",
      },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error("Pinned public baseline download exceeded the redirect limit"));
          return;
        }
        let next;
        try {
          next = new URL(response.headers.location, parsed).toString();
        } catch {
          reject(new Error("Pinned public baseline redirect is invalid"));
          return;
        }
        downloadHttpsFile(next, destination, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Pinned public baseline download returned HTTP ${status}`));
        return;
      }

      const partial = `${destination}.partial`;
      fs.rmSync(partial, { force: true });
      const output = fs.createWriteStream(partial, { mode: 0o600 });
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { output.destroy(); } catch {}
        try { response.destroy(); } catch {}
        fs.rmSync(partial, { force: true });
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      output.once("error", fail);
      response.once("error", fail);
      output.once("finish", () => {
        output.close((error) => {
          if (error) return fail(error);
          if (settled) return;
          settled = true;
          try {
            fs.renameSync(partial, destination);
            resolve();
          } catch (renameError) {
            fs.rmSync(partial, { force: true });
            reject(renameError);
          }
        });
      });
      response.pipe(output);
    });
    request.setTimeout(BASELINE_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error("Pinned public baseline download timed out"));
    });
    request.once("error", reject);
  });
}

async function assertPinnedArtifact(file, expected, label) {
  const stat = assertFile(file, label);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch (${stat.size} != ${expected.size})`);
  }
  const digest = await sha256Hex(file);
  if (digest !== expected.sha256) {
    throw new Error(`${label} SHA-256 mismatch`);
  }
}

async function downloadPinnedPublicBaseline(options, tempRoot) {
  const expected = PUBLIC_BASELINE_ARTIFACTS[options.platform];
  if (!expected) throw new Error(`No pinned public v${REQUIRED_BASELINE_VERSION} artifact for ${options.platform}`);
  const spec = targetSpec(options.platform, REQUIRED_BASELINE_VERSION);
  if (expected.fileName !== spec.payloadName) {
    throw new Error(`Pinned public baseline filename drift (${expected.fileName} != ${spec.payloadName})`);
  }
  const directory = path.join(tempRoot, "public-v0.8.32");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, expected.fileName);
  const url = `https://github.com/${PUBLIC_BASELINE_RELEASE_REPOSITORY}/releases/download/${DEFAULT_BASELINE_REF}/${expected.fileName}`;
  log(`downloading pinned public ${DEFAULT_BASELINE_REF} ${expected.fileName}`);
  await downloadHttpsFile(url, file);
  await assertPinnedArtifact(file, expected, `public ${DEFAULT_BASELINE_REF} ${expected.fileName}`);
  log(`verified public ${DEFAULT_BASELINE_REF} ${expected.fileName} SHA-256 and size`);
  return file;
}

async function inspectTargetRelease(options) {
  const spec = targetSpec(options.platform, options.targetVersion);
  const manifestPath = path.join(options.artifactDir, spec.manifestName);
  const payloadPath = path.join(options.artifactDir, spec.payloadName);
  const payloadStat = assertFile(payloadPath, "current target payload");
  assertFile(manifestPath, "current target update manifest");

  let manifest;
  try {
    manifest = yaml.load(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${spec.manifestName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object") throw new Error(`${spec.manifestName} is not a YAML object`);
  if (String(manifest.version || "") !== options.targetVersion) {
    throw new Error(`${spec.manifestName} version must be ${options.targetVersion}, received ${JSON.stringify(manifest.version)}`);
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const entry = files.find((file) => file && typeof file === "object" && file.url === spec.payloadName)
    || (manifest.path === spec.payloadName ? manifest : null);
  if (!entry) throw new Error(`${spec.manifestName} does not reference the exact target payload ${spec.payloadName}`);
  if (manifest.path != null && manifest.path !== spec.payloadName) {
    throw new Error(`${spec.manifestName} path must be ${spec.payloadName}, received ${JSON.stringify(manifest.path)}`);
  }

  const declaredSha512 = entry.sha512 || manifest.sha512;
  const declaredSize = entry.size == null ? manifest.size : entry.size;
  if (typeof declaredSha512 !== "string" || !declaredSha512) {
    throw new Error(`${spec.manifestName} has no sha512 for ${spec.payloadName}`);
  }
  if (!Number.isInteger(Number(declaredSize)) || Number(declaredSize) !== payloadStat.size) {
    throw new Error(`${spec.manifestName} size for ${spec.payloadName} does not match the artifact (${declaredSize} vs ${payloadStat.size})`);
  }
  const actualSha512 = await sha512Base64(payloadPath);
  if (actualSha512 !== declaredSha512) {
    throw new Error(`${spec.manifestName} sha512 for ${spec.payloadName} does not match the supplied artifact`);
  }

  return { manifestPath, payloadPath, spec };
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };
  let start;
  let end;
  if (match[1] === "" && match[2] === "") return { invalid: true };
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return { invalid: true };
  }
  return { end: Math.min(end, size - 1), start };
}

function writeFileResponse(req, res, file, contentType) {
  const stat = fs.statSync(file);
  const range = parseRange(req.headers.range, stat.size);
  if (range && range.invalid) {
    res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(end - start + 1),
    "Content-Type": contentType,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { end, start });
  stream.once("error", (error) => {
    if (!res.headersSent) res.writeHead(500, { "Cache-Control": "no-store" });
    res.end(`loopback feed read failed: ${error.message}`);
  });
  stream.pipe(res);
}

async function startLoopbackFeed({ manifestPath, payloadPath, spec, requestedPort }) {
  const allowed = new Map([
    [`/${spec.manifestName}`, { contentType: "text/yaml; charset=utf-8", file: manifestPath, kind: "manifest" }],
    [`/${spec.payloadName}`, { contentType: "application/octet-stream", file: payloadPath, kind: "payload" }],
  ]);
  const requests = [];
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400, { "Cache-Control": "no-store" });
      res.end("bad request path");
      return;
    }
    const target = allowed.get(pathname);
    if (!target) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end("not part of updater E2E feed");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    requests.push({ kind: target.kind, method: req.method, pathname, range: req.headers.range || null });
    writeFileResponse(req, res, target.file, target.contentType);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: requestedPort }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Loopback update feed did not bind to a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  log(`loopback feed listening at ${url}; only ${spec.manifestName} and ${spec.payloadName} are exposed`);
  return {
    requests,
    url,
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function assertFeedAndPayloadRequested(feed) {
  const manifestGet = feed.requests.some((request) => request.kind === "manifest" && request.method === "GET");
  const payloadGet = feed.requests.some((request) => request.kind === "payload" && request.method === "GET");
  assert.ok(manifestGet, "Baseline did not request the loopback update manifest");
  assert.ok(payloadGet, "Baseline did not request the loopback target payload");
}

function normalizedUrl(value) {
  const parsed = new URL(String(value));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

function assertGenericUpdateConfig(appUpdatePath, feedUrl) {
  assertFile(appUpdatePath, "isolated baseline resources/app-update.yml");
  let config;
  try {
    config = yaml.load(fs.readFileSync(appUpdatePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse isolated baseline ${appUpdatePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== "object") throw new Error(`Isolated baseline ${appUpdatePath} is not a YAML object`);
  if (config.provider !== "generic") {
    throw new Error(`Isolated baseline ${appUpdatePath} provider must be generic, received ${JSON.stringify(config.provider)}`);
  }
  if (normalizedUrl(config.url) !== normalizedUrl(feedUrl)) {
    throw new Error(`Isolated baseline ${appUpdatePath} points at ${JSON.stringify(config.url)}, not the private loopback feed ${feedUrl}`);
  }
  log(`verified isolated baseline resources/app-update.yml uses generic ${feedUrl}`);
}

function writeLoopbackUpdateConfig(appUpdatePath, feedUrl) {
  assertFile(appUpdatePath, "isolated baseline resources/app-update.yml before loopback injection");
  fs.writeFileSync(appUpdatePath, yaml.dump({ provider: "generic", url: feedUrl }, { lineWidth: -1 }), { mode: 0o600 });
}

function assertOfficialGithubUpdateConfig(appUpdatePath, label = "installed target") {
  assertFile(appUpdatePath, `${label} resources/app-update.yml`);
  let config;
  try {
    config = yaml.load(fs.readFileSync(appUpdatePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${label} ${appUpdatePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== "object") throw new Error(`${label} ${appUpdatePath} is not a YAML object`);
  for (const [key, expected] of Object.entries(OFFICIAL_UPDATE_REPOSITORY)) {
    if (config[key] !== expected) {
      throw new Error(`${label} ${appUpdatePath} ${key} must be ${JSON.stringify(expected)}, received ${JSON.stringify(config[key])}`);
    }
  }
  if (typeof config.url === "string" && config.url.trim()) {
    throw new Error(`${label} ${appUpdatePath} must not retain a generic or loopback url`);
  }
  log(`verified ${label} resources/app-update.yml uses the public Agentlas GitHub feed`);
}

function createRuntimeIsolation(platform, tempRoot) {
  const root = path.join(tempRoot, "runtime-isolation");
  const home = path.join(root, "home");
  const temp = path.join(root, "tmp");
  const marker = crypto.randomUUID();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  const env = { ...process.env, AGENTLAS_UPDATER_E2E_RUN_ID: marker, HOME: home, NODE_ENV: "production", TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.AGENTLAS_QA_USER_DATA_DIR;
  delete env.ELECTRON_START_URL;

  if (platform === "win32") {
    if (!process.env.APPDATA || !process.env.LOCALAPPDATA) {
      throw new Error("APPDATA and LOCALAPPDATA are required for the native Windows updater lifecycle");
    }
    // Detached NSIS relaunches resolve Windows known folders independently of
    // a baseline-only --user-data-dir. Use the disposable hosted runner's real
    // default profile for both processes, require it to be absent, and scrub it
    // after the lifecycle instead of manufacturing a split profile.
    return {
      env,
      marker,
      root,
      updaterCacheDir: path.join(process.env.LOCALAPPDATA, APP_NAME),
      userDataDir: path.join(process.env.APPDATA, APP_NAME),
    };
  }

  const config = path.join(root, "xdg-config");
  const data = path.join(root, "xdg-data");
  const cache = path.join(root, "xdg-cache");
  for (const directory of [config, data, cache]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  env.XDG_CONFIG_HOME = config;
  env.XDG_DATA_HOME = data;
  env.XDG_CACHE_HOME = cache;
  // As above, Electron's default appData is XDG_CONFIG_HOME and the official
  // install identity is Agentlas. This survives AppImageUpdater's relaunch.
  return { env, marker, root, userDataDir: path.join(config, APP_NAME) };
}

function startApp(command, args, { cwd, env, logPath, label }) {
  const logFd = fs.openSync(logPath, "a");
  log(`launching ${label}: ${displayCommand(command, args)}`);
  const child = spawn(command, args, {
    cwd,
    detached: false,
    env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  return child;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, { intervalMs = 200, label, timeoutMs }) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${label} timed out after ${timeoutMs}ms.${suffix}`);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`baseline app did not exit within ${timeoutMs}ms after native install handoff`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(new Error(`baseline app process errored while exiting: ${error.message}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function httpRequest(url, options = {}) {
  const { headers = {}, method = "GET" } = options;
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers, method, timeout: 5_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve({ body: Buffer.concat(chunks), headers: response.headers, statusCode: response.statusCode }));
    });
    request.once("timeout", () => request.destroy(new Error(`request timed out: ${url}`)));
    request.once("error", reject);
    request.end();
  });
}

async function cdpPage(port) {
  const response = await httpRequest(`http://127.0.0.1:${port}/json/list`);
  if (response.statusCode !== 200) throw new Error(`CDP /json/list returned HTTP ${response.statusCode}`);
  const targets = JSON.parse(response.body.toString("utf8"));
  if (!Array.isArray(targets)) throw new Error("CDP /json/list did not return an array");
  const page = targets.find((target) => target && target.type === "page" && target.webSocketDebuggerUrl && !String(target.url || "").startsWith("devtools://"));
  if (!page) throw new Error("CDP has no renderer page target yet");
  return page;
}

function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const socket = new WebSocket(wsUrl);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      callback(value);
    };
    const fail = (error) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    timeout = setTimeout(() => fail(new Error("CDP Runtime.evaluate timed out")), 15_000);
    socket.once("error", fail);
    socket.once("open", () => {
      try {
        socket.send(JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { awaitPromise: true, expression, returnByValue: true },
        }));
      } catch (error) {
        fail(error);
      }
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(Buffer.from(raw).toString("utf8"));
      } catch (error) {
        fail(new Error(`Invalid CDP message: ${error.message}`));
        return;
      }
      if (message.id !== 1) return;
      if (message.error) {
        fail(new Error(`CDP Runtime.evaluate failed: ${message.error.message || JSON.stringify(message.error)}`));
        return;
      }
      if (message.result && message.result.exceptionDetails) {
        const detail = message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text || "unknown renderer exception";
        fail(new Error(`Renderer updater call threw: ${detail}`));
        return;
      }
      const result = message.result?.result || {};
      finish(resolve, Object.prototype.hasOwnProperty.call(result, "value") ? result.value : undefined);
    });
    socket.once("close", () => {
      if (!settled) fail(new Error("CDP connection closed before Runtime.evaluate completed"));
    });
  });
}

async function evaluateInApp(cdpPort, expression) {
  const page = await cdpPage(cdpPort);
  return cdpEvaluate(page.webSocketDebuggerUrl, expression);
}

async function waitForUpdaterBridge(cdpPort, timeoutMs) {
  await waitUntil(
    async () => evaluateInApp(cdpPort, "Boolean(window.agentlas && window.agentlas.updater && typeof window.agentlas.updater.check === 'function' && typeof window.agentlas.updater.install === 'function' && typeof window.agentlas.updater.getState === 'function')"),
    { intervalMs: 250, label: "packaged renderer updater bridge", timeoutMs },
  );
}

function stringifyState(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function waitForDownloaded(cdpPort, targetVersion, timeoutMs) {
  return waitUntil(
    async () => {
      const state = await evaluateInApp(cdpPort, "window.agentlas.updater.getState()");
      if (state && ["error", "manual", "recovery-required"].includes(state.status)) {
        throw new Error(`updater entered terminal state ${stringifyState(state)}`);
      }
      return state && state.status === "downloaded" && state.version === targetVersion ? state : null;
    },
    { intervalMs: 250, label: `download of target ${targetVersion}`, timeoutMs },
  );
}

function createJournalObserver(isolation) {
  let observed = null;
  const expectedFile = path.join(isolation.userDataDir, "updater", JOURNAL_NAME);
  return {
    async waitForJournal(timeoutMs) {
      return waitUntil(
        () => {
          if (observed) return observed;
          if (!fs.existsSync(expectedFile)) return null;
          try {
            const contents = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
            observed = { contents, file: expectedFile };
            return observed;
          } catch {
            return null;
          }
        },
        { intervalMs: 50, label: "durable updater install journal", timeoutMs },
      );
    },
  };
}

function appAsarVersion(asarPath) {
  assertFile(asarPath, "packaged app.asar");
  let packageJson;
  try {
    packageJson = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to read package.json from ${asarPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return assertReleaseVersion(packageJson.version, `version embedded in ${asarPath}`);
}

async function extractAppImage(appImagePath, outputDir, label) {
  assertFile(appImagePath, `${label} AppImage`);
  fs.chmodSync(appImagePath, 0o755);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  delete env.AGENTLAS_QA_USER_DATA_DIR;
  delete env.APPIMAGE;
  delete env.APPIMAGE_EXTRACT_AND_RUN;
  await runCommand(appImagePath, ["--appimage-extract"], { cwd: outputDir, env, label: `${label} AppImage extraction` });
  return path.join(outputDir, "squashfs-root");
}

async function allocateLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("Unable to allocate a loopback CDP port");
  return address.port;
}

function executableOnPath(name) {
  const lookup = spawnSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return lookup.status === 0 ? lookup.stdout.trim() : null;
}

function linuxLauncher(appImage, electronArgs, isolation, logPath, extractedRoot = null) {
  const appEnv = { ...isolation.env };
  let launcher = appImage;
  let cwd = path.dirname(appImage);
  if (extractedRoot) {
    launcher = path.join(extractedRoot, "AppRun");
    assertFile(launcher, "extracted public baseline AppRun");
    fs.chmodSync(launcher, 0o755);
    appEnv.APPDIR = extractedRoot;
    appEnv.APPIMAGE = path.resolve(appImage);
    // The public baseline is deliberately launched from its inspected extract,
    // but AppImageUpdater later execs the downloaded target AppImage itself.
    // GitHub's Ubuntu runner does not provide the FUSE 2 mount required by that
    // native entrypoint. Keep the AppImage runtime's documented extraction mode
    // in the inherited environment so the updater-spawned target really starts;
    // this does not replace or simulate AppImageUpdater's move/exec lifecycle.
    appEnv.APPIMAGE_EXTRACT_AND_RUN = "1";
    cwd = extractedRoot;
  } else {
    appEnv.APPIMAGE_EXTRACT_AND_RUN = "1";
  }

  // The release workflow owns X11 and D-Bus for the lifetime of this entire
  // verifier so the updater-spawned target inherits sessions that outlive the
  // baseline. Never nest xvfb-run here: its child is the baseline app, so it
  // would tear the inner display down at precisely the native update handoff.
  if (appEnv.DISPLAY && appEnv.DBUS_SESSION_BUS_ADDRESS) {
    return startApp(launcher, electronArgs, { cwd, env: appEnv, label: "baseline AppImage", logPath });
  }

  const xvfb = executableOnPath("xvfb-run");
  if (!xvfb) {
    throw new Error("Linux native updater E2E requires xvfb-run on the runner (install xvfb); refusing to substitute a simulated lifecycle");
  }
  const dbus = executableOnPath("dbus-run-session");
  const command = xvfb;
  const args = dbus
    ? ["-a", dbus, "--", launcher, ...electronArgs]
    : ["-a", launcher, ...electronArgs];
  return startApp(command, args, { cwd, env: appEnv, label: "baseline AppImage", logPath });
}

async function stopWindowsInstall(executable) {
  const script = [
    "$target = [IO.Path]::GetFullPath($env:AGENTLAS_UPDATER_E2E_EXE)",
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, AGENTLAS_UPDATER_E2E_EXE: executable },
    label: "stop temporary installed Agentlas target",
    stdio: "ignore",
  }).catch((error) => logError(`cleanup warning: ${error.message}`));
}

async function uninstallWindowsInstall(installDir) {
  if (!installDir) return;
  const uninstaller = path.join(installDir, `Uninstall ${APP_NAME}.exe`);
  if (!fs.existsSync(uninstaller)) {
    logError(`cleanup warning: temporary Agentlas uninstaller is missing: ${uninstaller}`);
    return;
  }
  await runCommand(uninstaller, ["/S", "/currentuser"], {
    label: "uninstall temporary per-user Agentlas installation",
    stdio: "ignore",
  }).catch((error) => logError(`cleanup warning: ${error.message}`));
  await waitUntil(
    () => readWindowsInstallLocation() == null,
    { intervalMs: 250, label: "temporary Agentlas NSIS registration cleanup", timeoutMs: 30_000 },
  ).catch((error) => logError(`cleanup warning: ${error.message}`));
}

function logWindowsInstallDiagnostics(initialInstallDir) {
  const registered = readWindowsInstallLocation();
  logError(`Windows diagnostic: initial InstallLocation=${initialInstallDir}; current InstallLocation=${registered || "<missing>"}`);
  const processScript = [
    "Get-CimInstance Win32_Process",
    "Where-Object { $_.Name -match 'Agentlas|Setup|Uninstall' -or $_.CommandLine -match 'Agentlas.*Windows.*Setup' }",
    "Select-Object ProcessId,Name,ExecutablePath,CommandLine",
    "Format-List | Out-String -Width 4096",
  ].join(" | ");
  const processes = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", processScript], {
    encoding: "utf8",
    windowsHide: true,
  });
  logError(`Windows diagnostic processes:\n${String(processes.stdout || "<none>").trim() || "<none>"}`);

  const programsRoot = path.dirname(defaultWindowsInstallLocation());
  const stack = [{ directory: programsRoot, depth: 0 }];
  const asars = [];
  while (stack.length > 0) {
    const { directory, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) stack.push({ directory: candidate, depth: depth + 1 });
      if (entry.isFile() && entry.name === "app.asar" && path.basename(directory).toLowerCase() === "resources") {
        let version = "unreadable";
        try { version = appAsarVersion(candidate); } catch (error) { version = `error:${error instanceof Error ? error.message : String(error)}`; }
        asars.push(`${candidate} => ${version}`);
      }
    }
  }
  logError(`Windows diagnostic packaged app.asar files:\n${asars.join("\n") || "<none>"}`);
}

function linuxMarkedProcesses(marker) {
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return []; }
  const processes = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environment = fs.readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      if (!environment.includes(`AGENTLAS_UPDATER_E2E_RUN_ID=${marker}`)) continue;
      const appImageEntry = environment.find((value) => value.startsWith("APPIMAGE="));
      const commandLine = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      processes.push({
        appImage: appImageEntry ? appImageEntry.slice("APPIMAGE=".length) : null,
        commandLine,
        pid: Number(entry),
      });
    } catch {
      // A process can exit between readdir and read; that is harmless cleanup.
    }
  }
  return processes;
}

async function waitForLinuxTargetRelaunch(marker, targetAppImage, timeoutMs) {
  const expected = path.resolve(targetAppImage);
  return waitUntil(
    () => linuxMarkedProcesses(marker).find((candidate) => (
      candidate.appImage && path.resolve(candidate.appImage) === expected
    )),
    { intervalMs: 100, label: "updater-spawned target AppImage process", timeoutMs },
  );
}

async function stopLinuxMarkedProcesses(marker) {
  const pids = linuxMarkedProcesses(marker).map(({ pid }) => pid);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  if (pids.length > 0) await wait(500);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

function tail(file, bytes = 8_000) {
  try {
    const data = fs.readFileSync(file, "utf8");
    return data.length > bytes ? data.slice(-bytes) : data;
  } catch {
    return "";
  }
}

async function runWindowsE2E({ baselineInstaller, feedUrl, feed, isolation, options, target, tempRoot }) {
  assertFile(baselineInstaller, "pinned public baseline NSIS installer");
  if (readWindowsInstallLocation() != null) {
    throw new Error("Refusing to overwrite an existing per-user Agentlas NSIS registration on the native updater runner");
  }
  if (fs.existsSync(defaultWindowsInstallLocation())) {
    throw new Error("Refusing to overwrite an unregistered Agentlas directory at the per-user NSIS default location");
  }
  for (const [label, directory] of [["userData", isolation.userDataDir], ["updater cache", isolation.updaterCacheDir]]) {
    if (!directory || fs.existsSync(directory)) {
      throw new Error(`Refusing to overwrite an existing default Windows ${label} directory: ${directory || "<missing>"}`);
    }
  }
  // The updater launches the target installer without /D unless the app itself
  // sets NsisUpdater.installDirectory. Installing the baseline into an ad-hoc
  // /D path therefore does not model a real user update (and assisted NSIS may
  // append APP_FILENAME to such a path on the updated run). Use the registered
  // current-user default so both installers exercise the production contract.
  await runCommand(baselineInstaller, ["/S", "/currentuser"], { label: "silent baseline NSIS install at the per-user default" });

  const installDir = readWindowsInstallLocation();
  if (!installDir) throw new Error("Baseline NSIS install did not create its per-user InstallLocation registration");
  assertDefaultWindowsInstallLocation(installDir, tempRoot);
  const installedExecutable = path.join(installDir, `${APP_NAME}.exe`);
  assertFile(installedExecutable, "installed baseline Agentlas.exe");
  const configPath = path.join(installDir, "resources", "app-update.yml");
  assertOfficialGithubUpdateConfig(configPath, "installed public v0.8.32 baseline");
  writeLoopbackUpdateConfig(configPath, feedUrl);
  assertGenericUpdateConfig(configPath, feedUrl);

  const cdpPort = await allocateLoopbackPort();
  const appLog = path.join(tempRoot, "baseline-app.log");
  const child = startApp(
    installedExecutable,
    ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*"],
    { cwd: installDir, env: isolation.env, label: "installed baseline", logPath: appLog },
  );

  try {
    await waitForUpdaterBridge(cdpPort, options.timeoutMs);
    const checkResult = await evaluateInApp(cdpPort, "window.agentlas.updater.check()");
    assert.ok(
      checkResult && !["error", "manual", "manual-required", "recovery-required"].includes(checkResult.status),
      `Updater check did not reach a usable state: ${stringifyState(checkResult)}`,
    );
    await waitForDownloaded(cdpPort, options.targetVersion, options.timeoutMs);
    assertFeedAndPayloadRequested(feed);

    const observer = createJournalObserver(isolation);
    const journalPromise = observer.waitForJournal(Math.min(options.timeoutMs, 45_000));
    const installResult = await evaluateInApp(cdpPort, "window.agentlas.updater.install()");
    assert.ok(installResult && installResult.accepted === true, `Updater install was not accepted: ${stringifyState(installResult)}`);
    const journal = await journalPromise;
    const expectedJournal = path.join(isolation.userDataDir, "updater", JOURNAL_NAME);
    assert.equal(path.resolve(journal.file), path.resolve(expectedJournal), "baseline journal was not written under the isolated default userData path");
    assert.equal(journal.contents.sourceVersion, options.baselineVersion, "journal source version is wrong");
    assert.equal(journal.contents.targetVersion, options.targetVersion, "journal target version is wrong");

    await waitForChildExit(child, Math.min(options.timeoutMs, 90_000));
    await waitUntil(
      () => windowsExecutableVersion(installedExecutable) === options.targetVersion,
      { intervalMs: 500, label: "NSIS target replacement", timeoutMs: options.timeoutMs },
    );
    assertOfficialGithubUpdateConfig(path.join(installDir, "resources", "app-update.yml"));
    await waitUntil(
      () => !fs.existsSync(expectedJournal),
      { intervalMs: 250, label: "target relaunch journal reconciliation", timeoutMs: options.timeoutMs },
    );
    assertFeedAndPayloadRequested(feed);
    log(`Windows native install passed: ${options.baselineVersion} exited, ${options.targetVersion} replaced the install, and target relaunch cleared its journal`);
  } catch (error) {
    logWindowsInstallDiagnostics(installDir);
    const output = tail(appLog);
    if (output) logError(`baseline app log tail:\n${output}`);
    throw error;
  } finally {
    await stopWindowsInstall(installedExecutable);
    await uninstallWindowsInstall(installDir);
    for (const directory of [isolation.userDataDir, isolation.updaterCacheDir]) {
      if (!directory) continue;
      await fsp.rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 250 })
        .catch((error) => logError(`cleanup warning for ${directory}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

async function runLinuxE2E({ baselineAppImage, feedUrl, feed, isolation, options, target, tempRoot }) {
  assertFile(baselineAppImage, "pinned public baseline AppImage");
  fs.chmodSync(baselineAppImage, 0o755);

  const baselineExtract = await extractAppImage(baselineAppImage, path.join(tempRoot, "baseline-image-inspection"), "baseline");
  const baselineConfig = path.join(baselineExtract, "resources", "app-update.yml");
  assertOfficialGithubUpdateConfig(baselineConfig, "extracted public v0.8.32 baseline");
  writeLoopbackUpdateConfig(baselineConfig, feedUrl);
  assertGenericUpdateConfig(baselineConfig, feedUrl);

  const cdpPort = await allocateLoopbackPort();
  const appLog = path.join(tempRoot, "baseline-app.log");
  const electronArgs = [
    `--user-data-dir=${isolation.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*",
    "--no-sandbox",
  ];
  const child = linuxLauncher(baselineAppImage, electronArgs, isolation, appLog, baselineExtract);
  const targetAppImage = path.join(path.dirname(baselineAppImage), target.spec.payloadName);

  try {
    await waitForUpdaterBridge(cdpPort, options.timeoutMs);
    const checkResult = await evaluateInApp(cdpPort, "window.agentlas.updater.check()");
    assert.ok(
      checkResult && !["error", "manual", "manual-required", "recovery-required"].includes(checkResult.status),
      `Updater check did not reach a usable state: ${stringifyState(checkResult)}`,
    );
    await waitForDownloaded(cdpPort, options.targetVersion, options.timeoutMs);
    assertFeedAndPayloadRequested(feed);

    const observer = createJournalObserver(isolation);
    const journalPromise = observer.waitForJournal(Math.min(options.timeoutMs, 45_000));
    const installResult = await evaluateInApp(cdpPort, "window.agentlas.updater.install()");
    assert.ok(installResult && installResult.accepted === true, `Updater install was not accepted: ${stringifyState(installResult)}`);
    const journal = await journalPromise;
    const expectedJournal = path.join(isolation.userDataDir, "updater", JOURNAL_NAME);
    assert.equal(path.resolve(journal.file), path.resolve(expectedJournal), "baseline journal was not written under the isolated default userData path");
    assert.equal(journal.contents.sourceVersion, options.baselineVersion, "journal source version is wrong");
    assert.equal(journal.contents.targetVersion, options.targetVersion, "journal target version is wrong");

    await waitForChildExit(child, Math.min(options.timeoutMs, 90_000));
    await waitUntil(
      () => fs.existsSync(targetAppImage) && !fs.existsSync(baselineAppImage),
      { intervalMs: 250, label: "AppImage target replacement", timeoutMs: options.timeoutMs },
    );
    const relaunchedTarget = await waitForLinuxTargetRelaunch(isolation.marker, targetAppImage, options.timeoutMs);
    assert.ok(relaunchedTarget.pid > 0, "AppImageUpdater did not leave a live target process");
    const targetExtract = await extractAppImage(targetAppImage, path.join(tempRoot, "target-image-inspection"), "target");
    assert.equal(appAsarVersion(path.join(targetExtract, "resources", "app.asar")), options.targetVersion, "AppImage target version is wrong");
    assertOfficialGithubUpdateConfig(path.join(targetExtract, "resources", "app-update.yml"));
    await waitUntil(
      () => !fs.existsSync(expectedJournal),
      { intervalMs: 250, label: "target relaunch journal reconciliation", timeoutMs: options.timeoutMs },
    );
    assertFeedAndPayloadRequested(feed);
    log(`Linux native install passed: ${options.baselineVersion} exited, ${options.targetVersion} replaced the AppImage, target PID ${relaunchedTarget.pid} started, and target relaunch cleared its journal`);
  } catch (error) {
    const output = tail(appLog);
    if (output) logError(`baseline app log tail:\n${output}`);
    throw error;
  } finally {
    await stopLinuxMarkedProcesses(isolation.marker);
  }
}

function assertSafeExecutionContext(options) {
  if (process.env.AGENTLAS_QA_USER_DATA_DIR) {
    throw new Error("Refusing to run with AGENTLAS_QA_USER_DATA_DIR set: packaged updater is intentionally disabled in that QA mode");
  }
  if (process.platform !== options.platform) {
    throw new Error(`Native ${options.platform} updater E2E must run on a ${options.platform} runner; host is ${process.platform}`);
  }
  if (process.env.CI !== "true" && process.env.AGENTLAS_UPDATER_E2E_ALLOW_LOCAL !== "1") {
    throw new Error("Refusing a destructive native install outside CI. Set AGENTLAS_UPDATER_E2E_ALLOW_LOCAL=1 only on a disposable matching host.");
  }
  assertFile(path.join(options.repoDir, "package.json"), "caller repository package.json");
  assertFile(path.join(options.repoDir, "electron-builder.yml"), "caller repository electron-builder.yml");
}

async function runE2E(options) {
  assertSafeExecutionContext(options);
  const target = await inspectTargetRelease(options);
  const tempParent = process.env.RUNNER_TEMP && fs.existsSync(process.env.RUNNER_TEMP)
    ? process.env.RUNNER_TEMP
    : os.tmpdir();
  const tempRoot = fs.mkdtempSync(path.join(tempParent, "agentlas-updater-e2e-"));
  let feed;
  let isolation;
  try {
    feed = await startLoopbackFeed({ ...target, requestedPort: options.feedPort });
    const baselineArtifact = await downloadPinnedPublicBaseline(options, tempRoot);
    isolation = createRuntimeIsolation(options.platform, tempRoot);
    if (options.platform === "win32") {
      await runWindowsE2E({ baselineInstaller: baselineArtifact, feedUrl: feed.url, feed, isolation, options, target, tempRoot });
    } else {
      await runLinuxE2E({ baselineAppImage: baselineArtifact, feedUrl: feed.url, feed, isolation, options, target, tempRoot });
    }
  } finally {
    if (isolation && options.platform === "linux") await stopLinuxMarkedProcesses(isolation.marker);
    if (feed) await feed.close();
    if (options.keepTemp) {
      log(`kept isolated E2E directory for diagnosis: ${tempRoot}`);
    } else {
      try {
        await fsp.rm(tempRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 250 });
      } catch (error) {
        logError(`temporary E2E cleanup warning for ${tempRoot}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function runSelfTest() {
  const parsed = parseOptions([
    "--platform=linux",
    "--artifact-dir=/tmp/agentlas-artifacts",
    "--target-version=0.8.33",
    "--baseline-ref=v0.8.32",
    "--feed-port=0",
  ]);
  assert.equal(parsed.platform, "linux");
  assert.equal(parsed.baselineVersion, REQUIRED_BASELINE_VERSION);
  assert.equal(targetSpec("win32", "0.8.33").manifestName, "latest.yml");
  assert.equal(targetSpec("linux", "0.8.33").payloadName, "Agentlas-0.8.33-Linux-x64.AppImage");
  assert.ok(compareReleaseVersions("0.8.33", "0.8.32") > 0);
  assert.equal(windowsInstallRegistryKey(), "Software\\3bb4af84-8cbc-5026-96a0-bcbe1970587f");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-updater-e2e-selftest-"));
  let feed;
  try {
    const spec = targetSpec("linux", "0.8.33");
    const payloadPath = path.join(root, spec.payloadName);
    const manifestPath = path.join(root, spec.manifestName);
    fs.writeFileSync(payloadPath, Buffer.from("updater-e2e-selftest-payload"));
    const sha512 = await sha512Base64(payloadPath);
    fs.writeFileSync(manifestPath, yaml.dump({
      files: [{ sha512, size: fs.statSync(payloadPath).size, url: spec.payloadName }],
      path: spec.payloadName,
      releaseDate: "2026-07-15T00:00:00.000Z",
      sha512,
      version: "0.8.33",
    }));
    const checked = await inspectTargetRelease({ artifactDir: root, platform: "linux", targetVersion: "0.8.33" });
    feed = await startLoopbackFeed({ ...checked, requestedPort: 0 });
    const manifestResponse = await httpRequest(`${feed.url}/${spec.manifestName}`);
    assert.equal(manifestResponse.statusCode, 200);
    const rangeResponse = await httpRequest(`${feed.url}/${spec.payloadName}`, { headers: { Range: "bytes=0-6" } });
    assert.equal(rangeResponse.statusCode, 206);
    assert.equal(rangeResponse.body.toString("utf8"), "updater");
    const denied = await httpRequest(`${feed.url}/not-a-release-file`);
    assert.equal(denied.statusCode, 404);
    assertFeedAndPayloadRequested(feed);

    const pinnedFixture = path.join(root, "pinned-public-baseline.bin");
    fs.writeFileSync(pinnedFixture, "pinned-public-baseline");
    const pinnedExpectation = {
      sha256: await sha256Hex(pinnedFixture),
      size: fs.statSync(pinnedFixture).size,
    };
    await assertPinnedArtifact(pinnedFixture, pinnedExpectation, "selftest pinned public baseline");
    fs.appendFileSync(pinnedFixture, "-drift");
    await assert.rejects(
      () => assertPinnedArtifact(pinnedFixture, pinnedExpectation, "selftest drifted public baseline"),
      /size mismatch/,
      "a public baseline whose pinned bytes drift must fail before installation",
    );
    assert.equal(PUBLIC_BASELINE_ARTIFACTS.linux.fileName, targetSpec("linux", REQUIRED_BASELINE_VERSION).payloadName);
    assert.equal(PUBLIC_BASELINE_ARTIFACTS.win32.fileName, targetSpec("win32", REQUIRED_BASELINE_VERSION).payloadName);
    const appUpdatePath = path.join(root, "resources", "app-update.yml");
    fs.mkdirSync(path.dirname(appUpdatePath), { recursive: true });
    fs.writeFileSync(appUpdatePath, yaml.dump(OFFICIAL_UPDATE_REPOSITORY));
    assertOfficialGithubUpdateConfig(appUpdatePath, "selftest public baseline");
    writeLoopbackUpdateConfig(appUpdatePath, feed.url);
    assertGenericUpdateConfig(appUpdatePath, feed.url);
    fs.writeFileSync(appUpdatePath, yaml.dump(OFFICIAL_UPDATE_REPOSITORY));
    assertOfficialGithubUpdateConfig(appUpdatePath, "selftest target");
    fs.writeFileSync(appUpdatePath, yaml.dump({ ...OFFICIAL_UPDATE_REPOSITORY, repo: "loopback" }));
    assert.throws(
      () => assertOfficialGithubUpdateConfig(appUpdatePath),
      /repo must be "agentlas-desktop-releases"/,
      "a target that does not rejoin the public release feed must fail the E2E gate",
    );
    log("selftest passed (no Electron, native installer, AppImage, source checkout, or public feed was touched)");
  } finally {
    if (feed) await feed.close();
    await fsp.rm(root, { force: true, recursive: true });
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.selftest) {
    await runSelfTest();
    return;
  }
  await runE2E(options);
}

main().catch((error) => {
  logError(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
