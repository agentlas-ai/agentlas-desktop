#!/usr/bin/env node
/**
 * The macOS publisher is the only process allowed to create or promote a
 * public Desktop release.  Before it performs that write, this checker turns
 * the platform barrier into one value-free manifest.  After upload it can
 * download every required asset again and compare bytes, so a successful
 * local package is never mistaken for the release users actually receive.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_CHECKSUM_FILE,
  assertStableReleaseIdentity,
  buildOutputAssetNames,
  publicReleaseAssetNames,
  requiredReleaseAssetNames,
  userPayloadAssetNames,
} from "./publish-mac-release.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const { loadUpdateCompatibility } = require("../build-resources/update-compatibility.cjs");
const modulePath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANIFEST_FILE = "release-asset-manifest.json";

function run(command, args, { cwd = desktopRoot } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024 * 16,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }
  return output;
}

function parseArgs(argv) {
  const values = new Map();
  for (const raw of argv) {
    if (!raw.startsWith("--")) throw new Error(`Unexpected positional argument: ${raw}`);
    const [key, ...rest] = raw.split("=");
    values.set(key, rest.length ? rest.join("=") : "true");
  }
  return values;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function requireRegularFile(file) {
  if (!existsSync(file)) throw new Error(`Missing required release artifact: ${basename(file)}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Release artifact is not a non-empty regular file: ${basename(file)}`);
  return {
    name: basename(file),
    sizeBytes: stat.size,
    sha256: sha256(file),
    sha512: sha512(file),
  };
}

function requireText(file, expressions) {
  const text = readFileSync(file, "utf8");
  for (const expression of expressions) {
    if (!expression.test(text)) throw new Error(`Release feed contract failed for ${basename(file)}: ${expression}`);
  }
}

function requireVerificationEvidence(releaseDir, version, tag, requirePrivateWebEnv) {
  const verification = JSON.parse(readFileSync(join(releaseDir, "desktop-release-verification.json"), "utf8"));
  assertPublicVerificationShape(verification, version, tag);
  if (
    verification?.ready !== true ||
    verification?.version !== version ||
    verification?.tag !== tag ||
    typeof verification?.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(verification.sourceCommit)
  ) {
    throw new Error("desktop-release-verification.json does not prove the exact ready macOS release.");
  }
  if (!requirePrivateWebEnv) return;
  const env = readFileSync(join(releaseDir, "desktop-release.production.env"), "utf8");
  for (const expected of [
    `AGENTLAS_DESKTOP_VERSION=${version}`,
    `AGENTLAS_DESKTOP_RELEASE_TAG=${tag}`,
    "AGENTLAS_DESKTOP_RELEASE_VERIFIED=true",
    "AGENTLAS_DESKTOP_RELEASE_NOTARIZED=true",
  ]) {
    if (!env.split(/\r?\n/).includes(expected)) {
      throw new Error(`desktop-release.production.env is missing ${expected}`);
    }
  }
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function assertPublicVerificationShape(verification, version, tag) {
  const rootKeys = [
    "schemaVersion", "generatedAt", "sourceCommit", "repo", "tag",
    "version", "ready", "allowUnnotarized", "artifacts",
  ];
  if (!exactKeys(verification, rootKeys) ||
      verification.schemaVersion !== "agentlas.desktop-release-verification.v2" ||
      !isIsoTimestamp(verification.generatedAt) ||
      !/^[0-9a-f]{40}$/i.test(String(verification.sourceCommit || "")) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(verification.repo || "")) ||
      verification.version !== version || verification.tag !== tag || tag !== `v${version}` ||
      typeof verification.ready !== "boolean" || typeof verification.allowUnnotarized !== "boolean") {
    throw new Error("desktop-release-verification.json is not the exact public v2 schema.");
  }
  const artifactKeys = [
    "arch", "fileName", "sizeBytes", "sha256", "sha512", "notarized",
    "gatekeeperAccepted", "innerApp", "url",
  ];
  const innerKeys = ["gatekeeperAccepted", "notarized"];
  const artifacts = verification.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== 2) {
    throw new Error("desktop-release-verification.json must contain exactly two public artifacts.");
  }
  const byArch = Object.fromEntries(artifacts.map((artifact) => [artifact?.arch, artifact]));
  for (const arch of ["arm64", "x64"]) {
    const artifact = byArch[arch];
    const expectedFile = `Agentlas-${version}-${arch}.dmg`;
    const expectedUrl = `https://github.com/${verification.repo}/releases/download/${tag}/${expectedFile}`;
    if (!exactKeys(artifact, artifactKeys) || !exactKeys(artifact?.innerApp, innerKeys) ||
        artifact.fileName !== expectedFile || artifact.url !== expectedUrl ||
        !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(String(artifact.sha256 || "")) ||
        !/^[A-Za-z0-9+/]{86}==$/.test(String(artifact.sha512 || "")) ||
        typeof artifact.notarized !== "boolean" || typeof artifact.gatekeeperAccepted !== "boolean" ||
        typeof artifact.innerApp.notarized !== "boolean" || typeof artifact.innerApp.gatekeeperAccepted !== "boolean") {
      throw new Error(`desktop-release-verification.json public artifact shape failed for ${arch}.`);
    }
  }
}

/**
 * The published checksum document must cover the installable payload set
 * EXACTLY -- not a subset.  A subset check is what let v0.9.63 ship notes
 * saying "checksums are in <file>" while six of eight payloads (both macOS
 * update ZIPs, both Windows executables, the AppImage and the deb) had no
 * published digest at all.  Adding a build target now fails this gate until
 * its evidence exists, and a digest that disagrees with the shipped bytes
 * fails it too.
 */
export function assertPublicChecksumCoverage({ document, version, tag, repo, assetByName }) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      document.schemaVersion !== "agentlas.desktop-release-assets.v1" ||
      document.version !== version || document.tag !== tag || tag !== `v${version}` ||
      document.repo !== repo || document.coverage !== "every-user-installable-payload" ||
      !isIsoTimestamp(document.generatedAt) || !Array.isArray(document.artifacts)) {
    throw new Error(`${PUBLIC_CHECKSUM_FILE} is not the exact public v1 schema.`);
  }
  const expected = new Set(userPayloadAssetNames(version));
  const actual = new Set();
  for (const artifact of document.artifacts) {
    if (!exactKeys(artifact, ["fileName", "sizeBytes", "sha256", "sha512", "url"])) {
      throw new Error(`${PUBLIC_CHECKSUM_FILE} entry shape failed.`);
    }
    if (actual.has(artifact.fileName)) {
      throw new Error(`${PUBLIC_CHECKSUM_FILE} lists ${artifact.fileName} twice.`);
    }
    actual.add(artifact.fileName);
  }
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length || unexpected.length) {
    throw new Error(
      `${PUBLIC_CHECKSUM_FILE} must cover every installable payload exactly ` +
      `(missing=${missing.join(", ") || "none"}; unexpected=${unexpected.join(", ") || "none"}).`,
    );
  }
  for (const artifact of document.artifacts) {
    const measured = assetByName.get(artifact.fileName);
    if (!measured) throw new Error(`${PUBLIC_CHECKSUM_FILE} names an asset this release does not ship: ${artifact.fileName}`);
    if (artifact.sizeBytes !== measured.sizeBytes ||
        artifact.sha256 !== measured.sha256 ||
        artifact.sha512 !== measured.sha512) {
      throw new Error(`${PUBLIC_CHECKSUM_FILE} disagrees with the shipped bytes of ${artifact.fileName}.`);
    }
    if (artifact.url !== `https://github.com/${repo}/releases/download/${tag}/${artifact.fileName}`) {
      throw new Error(`${PUBLIC_CHECKSUM_FILE} download URL is wrong for ${artifact.fileName}.`);
    }
  }
  return { coverage: expected.size, subsetAllowed: false };
}

/**
 * The notes are generated from the checksum document, so every coverage claim
 * in them must still name that document and its exact count at publish time.
 * A hand-edited note that widens the claim fails here.
 */
export function assertReleaseNotesClaims({ notes, document }) {
  const names = document.artifacts.map((artifact) => artifact.fileName);
  const required = [
    `all ${names.length} installable payloads`,
    `are in \`${PUBLIC_CHECKSUM_FILE}\``,
    ...names,
  ];
  for (const fragment of required) {
    if (!notes.includes(fragment)) {
      throw new Error(`Release notes do not state their own checksum coverage: missing "${fragment}".`);
    }
  }
  if (/checksums? and file sizes are in `desktop-release-verification\.json`/i.test(notes)) {
    throw new Error(
      "Release notes claim desktop-release-verification.json holds every checksum; " +
      "that file covers only the two notarized macOS DMGs.",
    );
  }
  return { claimsChecked: required.length };
}

function assertNoAppleDouble(releaseDir) {
  for (const name of readdirSync(releaseDir)) {
    if (name.startsWith("._")) throw new Error(`Release directory contains an AppleDouble sidecar: ${name}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function parseUpdateFeed(file) {
  try {
    const value = yaml.load(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root is not a mapping");
    }
    return value;
  } catch (error) {
    throw new Error(`Release feed is not valid YAML: ${basename(file)} (${error instanceof Error ? error.message : "unknown error"})`);
  }
}

/**
 * Electron-updater trusts the digest and size in latest*.yml, not the visual
 * filename. Verify the complete declared payload set before public upload so
 * a stale or malformed Windows/Linux feed cannot promote otherwise-correct
 * artifacts.
 */
export function validateCrossPlatformUpdateFeed({ feedName, feed, version, compatibility, artifacts }) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) {
    throw new Error(`Release feed is invalid: ${feedName}`);
  }
  if (feed.version !== version) throw new Error(`Release feed version mismatch: ${feedName}`);
  if (!sameJson(feed.agentlasCompatibility, compatibility)) {
    throw new Error(`Release feed compatibility mismatch: ${feedName}`);
  }
  if (Object.hasOwn(feed, "minimumSystemVersion")) {
    throw new Error(`Release feed unexpectedly contains macOS compatibility: ${feedName}`);
  }
  if (!Array.isArray(feed.files) || feed.files.length !== artifacts.length) {
    throw new Error(`Release feed artifact set mismatch: ${feedName}`);
  }

  const expected = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  const seen = new Set();
  for (const entry of feed.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.url !== "string") {
      throw new Error(`Release feed entry is invalid: ${feedName}`);
    }
    const artifact = expected.get(entry.url);
    if (!artifact || seen.has(entry.url)) {
      throw new Error(`Release feed artifact set mismatch: ${feedName}`);
    }
    if (entry.size !== artifact.sizeBytes) {
      throw new Error(`Release feed size mismatch: ${feedName} -> ${entry.url}`);
    }
    if (entry.sha512 !== artifact.sha512) {
      throw new Error(`Release feed digest mismatch: ${feedName} -> ${entry.url}`);
    }
    if (Object.hasOwn(entry, "blockMapSize") &&
      (!Number.isSafeInteger(entry.blockMapSize) || entry.blockMapSize <= 0 || entry.blockMapSize >= artifact.sizeBytes)) {
      throw new Error(`Release feed block map metadata is invalid: ${feedName} -> ${entry.url}`);
    }
    seen.add(entry.url);
  }
  if (seen.size !== expected.size || !expected.has(feed.path)) {
    throw new Error(`Release feed primary artifact mismatch: ${feedName}`);
  }
  const primary = expected.get(feed.path);
  if (feed.sha512 !== primary.sha512) {
    throw new Error(`Release feed primary digest mismatch: ${feedName}`);
  }
  if (typeof feed.releaseDate !== "string" || Number.isNaN(Date.parse(feed.releaseDate))) {
    throw new Error(`Release feed release date is invalid: ${feedName}`);
  }
  return {
    version: true,
    compatibility: true,
    artifactSet: true,
    sizes: true,
    digests: true,
    primaryArtifact: true,
  };
}

export function validateLocalReleaseDirectory({
  releaseDir,
  version,
  tag,
  sourceCommit,
  assetNames,
  requirePrivateWebEnv = false,
}) {
  assertStableReleaseIdentity(version, tag);
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new Error("sourceCommit must be an exact Git commit SHA.");
  if (!existsSync(releaseDir) || !lstatSync(releaseDir).isDirectory()) {
    throw new Error(`Release directory does not exist: ${releaseDir}`);
  }
  assertNoAppleDouble(releaseDir);
  const required = assetNames ?? requiredReleaseAssetNames(version);
  const assets = required.map((name) => requireRegularFile(join(releaseDir, name)));
  const assetByName = new Map(assets.map((asset) => [asset.name, asset]));
  const compatibility = loadUpdateCompatibility(join(desktopRoot, "package.json"));
  validateCrossPlatformUpdateFeed({
    feedName: "latest.yml",
    feed: parseUpdateFeed(join(releaseDir, "latest.yml")),
    version,
    compatibility,
    artifacts: [assetByName.get(`Agentlas-${version}-Windows-x64-Setup.exe`)],
  });
  validateCrossPlatformUpdateFeed({
    feedName: "latest-linux.yml",
    feed: parseUpdateFeed(join(releaseDir, "latest-linux.yml")),
    version,
    compatibility,
    artifacts: [
      assetByName.get(`Agentlas-${version}-Linux-x64.AppImage`),
      assetByName.get(`Agentlas-${version}-Linux-x64.deb`),
    ],
  });
  requireText(join(releaseDir, "latest-mac.yml"), [
    new RegExp(`^version:\\s*${version}\\s*$`, "m"),
    new RegExp(`Agentlas-${version}-arm64\\.zip`),
    new RegExp(`Agentlas-${version}-x64\\.zip`),
  ]);
  requireVerificationEvidence(releaseDir, version, tag, requirePrivateWebEnv);
  const verification = JSON.parse(readFileSync(join(releaseDir, "desktop-release-verification.json"), "utf8"));
  if (verification.sourceCommit.toLowerCase() !== sourceCommit.toLowerCase()) {
    throw new Error("desktop-release-verification.json does not bind this exact Desktop source commit.");
  }
  // 이 문서는 발행기가 만든다. 발행 전 단계(빌드 산출물만 있는 시점)에서는 아직
  // 없는 게 정상이고, 그때 요구하면 릴리스가 구조적으로 불가능해진다(v0.9.64 실패).
  // 단, 있으면 언제나 완전 검사한다 — 조용한 통과는 없다.
  const checksumPath = join(releaseDir, PUBLIC_CHECKSUM_FILE);
  const checksumRequiredNow = required.includes(PUBLIC_CHECKSUM_FILE);
  if (checksumRequiredNow && !existsSync(checksumPath)) {
    throw new Error(`Missing required release artifact: ${PUBLIC_CHECKSUM_FILE}`);
  }
  const checksumDocument = existsSync(checksumPath)
    ? JSON.parse(readFileSync(checksumPath, "utf8"))
    : null;
  if (checksumDocument) {
    assertPublicChecksumCoverage({
      document: checksumDocument,
      version,
      tag,
      repo: verification.repo,
      assetByName: new Map(
        userPayloadAssetNames(version)
          .map((name) => [name, assetByName.get(name) ?? requireRegularFile(join(releaseDir, name))]),
      ),
    });
  }
  // Generated notes are the normal path; a release staged without them is
  // still checked once they exist so a hand-edited body cannot widen the claim.
  const notesFile = join(releaseDir, "github-release-notes.md");
  if (checksumDocument && existsSync(notesFile)) {
    assertReleaseNotesClaims({
      notes: readFileSync(notesFile, "utf8"),
      document: checksumDocument,
    });
  }
  return {
    schemaVersion: 1,
    verificationKind: "all-platform-release-barrier",
    version,
    tag,
    sourceCommit: sourceCommit.toLowerCase(),
    assets,
  };
}

function readRemoteRelease(repo, tag) {
  const raw = run("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "tagName,targetCommitish,isDraft,isPrerelease,assets",
  ]);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Could not parse the staged public release response.");
  }
}

export function assertRemoteReleaseHeader({ remote, manifest, allowDraft = false }) {
  if (
    remote?.tagName !== manifest.tag ||
    (remote?.isDraft === true && !allowDraft)
  ) {
    throw new Error("Staged public release does not bind the exact release tag.");
  }
  const remoteNames = new Set(
    Array.isArray(remote.assets)
      ? remote.assets.map((asset) => asset?.name).filter((name) => typeof name === "string")
      : [],
  );
  for (const asset of manifest.assets) {
    if (!remoteNames.has(asset.name)) throw new Error(`Staged public release is missing ${asset.name}`);
  }
  const expectedNames = new Set(manifest.assets.map((asset) => asset.name));
  const unexpected = [...remoteNames].filter((name) => !expectedNames.has(name)).sort();
  if (unexpected.length > 0) {
    throw new Error(`Staged public release contains assets outside the explicit allowlist: ${unexpected.join(", ")}`);
  }
}

export function compareRemoteAsset({ expected, actual }) {
  if (
    actual.sizeBytes !== expected.sizeBytes ||
    actual.sha256 !== expected.sha256 ||
    actual.sha512 !== expected.sha512
  ) {
    throw new Error(`Remote release bytes differ for ${expected.name}`);
  }
}

function verifyRemoteReleaseBytes({ repo, tag, manifest, allowDraft = false }) {
  const remote = readRemoteRelease(repo, tag);
  assertRemoteReleaseHeader({ remote, manifest, allowDraft });
  const temp = mkdtempSync(join(tmpdir(), "agentlas-release-remote-"));
  try {
    const assets = [];
    for (const expected of manifest.assets) {
      run("gh", [
        "release",
        "download",
        tag,
        "--repo",
        repo,
        "--pattern",
        expected.name,
        "--dir",
        temp,
        "--clobber",
      ]);
      const actual = requireRegularFile(join(temp, expected.name));
      compareRemoteAsset({ expected, actual });
      assets.push(actual);
    }
    return {
      verifiedAt: new Date().toISOString(),
      tag: manifest.tag,
      sourceCommit: manifest.sourceCommit,
      assetCount: assets.length,
      assets,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function currentCommit() {
  return run("git", ["rev-parse", "HEAD"]).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const version = String(args.get("--version") || pkg.version);
  const tag = String(args.get("--tag") || `v${version}`);
  const releaseDir = resolve(desktopRoot, String(args.get("--release-dir") || "release"));
  const sourceCommit = String(args.get("--source-commit") || currentCommit());
  const publicAllowlist = args.get("--public-allowlist") === "true";
  const buildOutputsOnly = args.get("--build-outputs-only") === "true";
  const manifest = validateLocalReleaseDirectory({
    releaseDir,
    version,
    tag,
    sourceCommit,
    // 발행 전 게이트는 빌드 산출물만 본다. 발행기가 스스로 만든 증거를
    // 자기 선행 조건으로 요구하지 않기 위해서다.
    assetNames: buildOutputsOnly
      ? buildOutputAssetNames(version)
      : publicAllowlist ? publicReleaseAssetNames(version) : undefined,
    requirePrivateWebEnv: false,
  });
  if (args.get("--verify-remote") === "true") {
    const repo = args.get("--repo") || process.env.AGENTLAS_DESKTOP_GITHUB_REPO;
    if (!repo) throw new Error("--verify-remote requires --repo or AGENTLAS_DESKTOP_GITHUB_REPO.");
    manifest.remote = verifyRemoteReleaseBytes({
      repo: String(repo),
      tag,
      manifest,
      allowDraft: args.get("--allow-draft") === "true",
    });
  }
  const manifestPath = join(releaseDir, MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    manifest: MANIFEST_FILE,
    version,
    tag,
    sourceCommit: manifest.sourceCommit,
    assetCount: manifest.assets.length,
    remoteVerified: Boolean(manifest.remote),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
