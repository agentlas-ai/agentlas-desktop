#!/usr/bin/env node
// gate-args: --source-contract-only
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  MAC_UPDATE_MINIMUM_SYSTEM_VERSION,
  loadUpdateCompatibility,
} = require("../build-resources/update-compatibility.cjs");

const modulePath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(modulePath), "..");
const ARCHES = ["arm64", "x64"];
const EVIDENCE_SCHEMA_VERSION = 1;
const DEFAULT_HISTORY_COUNT = 2;
const MAX_HISTORY_COUNT = 5;

export class LineageVerificationError extends Error {
  constructor(code, subject = "lineage") {
    super(code);
    this.name = "LineageVerificationError";
    this.code = code;
    this.subject = subject;
  }
}

function fail(code, subject) {
  throw new LineageVerificationError(code, subject);
}

export function parseStableVersion(raw) {
  const match = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(String(raw || ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) fail("invalid-stable-version", "version");
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

export function parseHistoryCount(raw = DEFAULT_HISTORY_COUNT) {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_COUNT) {
    fail("history-count-invalid", "previous-release-history");
  }
  return parsed;
}

export function selectPreviousStableReleases(releases, candidateVersion, historyCount = DEFAULT_HISTORY_COUNT) {
  const requestedCount = parseHistoryCount(historyCount);
  if (!Array.isArray(releases) || !parseStableVersion(candidateVersion)) {
    fail("invalid-release-list", "previous-release");
  }
  const stableByVersion = new Map();
  for (const release of releases) {
    if (!release || release.isDraft === true || release.isPrerelease === true) continue;
    const parsed = parseStableVersion(release.tagName);
    // The public releases repository also contains product-extension releases
    // such as `science-v0.1.0`. They are intentionally outside Desktop's
    // stable update lineage and must not invalidate an otherwise valid history.
    if (!parsed) continue;
    const matches = stableByVersion.get(parsed.version) || [];
    matches.push({ tag: `v${parsed.version}`, version: parsed.version });
    stableByVersion.set(parsed.version, matches);
  }
  const stableGroups = [...stableByVersion.values()]
    .sort((left, right) => compareStableVersions(right[0].version, left[0].version));
  const currentStable = stableGroups[0]?.[0];
  if (!currentStable) fail("previous-stable-history-incomplete", "previous-release-history");
  const comparison = compareStableVersions(candidateVersion, currentStable.version);
  if (comparison === 0) fail("candidate-already-stable", "candidate-release");
  if (comparison < 0) fail("candidate-not-newer-than-current-stable", "lineage");
  const historyGroups = stableGroups.slice(0, requestedCount);
  if (historyGroups.length !== requestedCount) fail("previous-stable-history-incomplete", "previous-release-history");
  // Duplicate releases are ambiguous only when they are part of the exact
  // history window whose artifacts establish update continuity. Historical
  // duplicates outside that bounded window cannot change this candidate's
  // selected predecessors and must not deadlock all future releases.
  if (historyGroups.some((matches) => matches.length !== 1)) {
    fail("stable-release-version-duplicate", "previous-release-history");
  }
  return historyGroups.map(([release]) => release);
}

export function selectPreviousStableRelease(releases, candidateVersion) {
  return selectPreviousStableReleases(releases, candidateVersion, 1)[0];
}

export function selectRequiredHistoricalReleases(releases, candidateVersion, rawTags = "") {
  const tags = String(rawTags || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (new Set(tags).size !== tags.length) fail("required-history-tag-duplicate", "previous-release-history");
  return tags.map((tag) => {
    const parsed = parseStableVersion(tag);
    const matches = Array.isArray(releases) ? releases.filter((release) => release?.tagName === tag) : [];
    if (!parsed || tag !== `v${parsed.version}` || matches.length !== 1) {
      fail("required-history-tag-unavailable", "previous-release-history");
    }
    if (compareStableVersions(parsed.version, candidateVersion) >= 0) {
      fail("required-history-tag-not-older", "previous-release-history");
    }
    return { tag, version: parsed.version };
  });
}

export function historyVerificationPlan(history) {
  if (!Array.isArray(history) || history.length === 0) {
    fail("previous-stable-history-incomplete", "previous-release-history");
  }
  return history.flatMap((release, releaseIndex) => ARCHES.map((architecture) => ({
    release,
    releaseIndex,
    architecture,
  })));
}

function sha512(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateMacUpdateFeed({
  feed,
  candidateVersion,
  compatibility,
  zipArtifacts,
  minimumSystemVersion = MAC_UPDATE_MINIMUM_SYSTEM_VERSION,
}) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) {
    fail("feed-invalid", "latest-mac.yml");
  }
  if (feed.version !== candidateVersion) fail("feed-version-mismatch", "latest-mac.yml");
  if (feed.minimumSystemVersion !== minimumSystemVersion) {
    fail("feed-system-compatibility-mismatch", "latest-mac.yml");
  }
  if (!sameJson(feed.agentlasCompatibility, compatibility)) {
    fail("feed-agentlas-compatibility-mismatch", "latest-mac.yml");
  }
  if (!Array.isArray(feed.files) || feed.files.length !== ARCHES.length) {
    fail("feed-zip-set-invalid", "latest-mac.yml");
  }

  const expected = new Map(
    ARCHES.map((arch) => {
      const artifact = zipArtifacts[arch];
      if (
        !artifact ||
        typeof artifact.fileName !== "string" ||
        artifact.fileName !== `Agentlas-${candidateVersion}-${arch}.zip` ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size <= 0 ||
        typeof artifact.sha512 !== "string" ||
        artifact.sha512.length === 0
      ) {
        fail("candidate-zip-metadata-invalid", `candidate-zip-${arch}`);
      }
      return [artifact.fileName, artifact];
    }),
  );

  const seen = new Set();
  for (const entry of feed.files) {
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string") {
      fail("feed-zip-entry-invalid", "latest-mac.yml");
    }
    const artifact = expected.get(entry.url);
    if (!artifact || seen.has(entry.url) || !entry.url.endsWith(".zip")) {
      fail("feed-zip-set-invalid", "latest-mac.yml");
    }
    if (entry.size !== artifact.size) fail("feed-zip-size-mismatch", entry.url);
    if (entry.sha512 !== artifact.sha512) fail("feed-zip-sha512-mismatch", entry.url);
    seen.add(entry.url);
  }
  if (seen.size !== expected.size) fail("feed-zip-set-invalid", "latest-mac.yml");

  const primary = expected.get(feed.path);
  if (!primary) fail("feed-primary-zip-invalid", "latest-mac.yml");
  if (feed.sha512 !== primary.sha512) fail("feed-primary-sha512-mismatch", "latest-mac.yml");
  if (typeof feed.releaseDate !== "string" || Number.isNaN(Date.parse(feed.releaseDate))) {
    fail("feed-release-date-invalid", "latest-mac.yml");
  }

  return {
    version: true,
    compatibility: true,
    zipSet: true,
    zipSizes: true,
    zipDigests: true,
    primaryZip: true,
    remoteFeedBytes: false,
    remoteZipSizes: false,
    remoteZipDigests: false,
  };
}

export function validateRemoteCandidateMatchesLocal({
  localFeedBytes,
  remoteFeedBytes,
  localZipArtifacts,
  remoteZipArtifacts,
}) {
  if (!Buffer.isBuffer(localFeedBytes) || !Buffer.isBuffer(remoteFeedBytes) || !localFeedBytes.equals(remoteFeedBytes)) {
    fail("remote-feed-bytes-mismatch", "latest-mac.yml");
  }
  for (const architecture of ARCHES) {
    const local = localZipArtifacts?.[architecture];
    const remote = remoteZipArtifacts?.[architecture];
    if (!local || !remote || local.fileName !== remote.fileName) {
      fail("remote-zip-set-mismatch", `candidate-zip-${architecture}`);
    }
    if (local.size !== remote.size) fail("remote-zip-size-mismatch", `candidate-zip-${architecture}`);
    if (local.sha512 !== remote.sha512) fail("remote-zip-sha512-mismatch", `candidate-zip-${architecture}`);
  }
  return {
    remoteFeedBytes: true,
    remoteZipSizes: true,
    remoteZipDigests: true,
  };
}

export function normalizeDesignatedRequirement(raw) {
  if (typeof raw !== "string") return null;
  const normalized = raw
    .replace(/^\s*designated\s*=>\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

export function buildValueFreeEvidence({
  ready,
  repo,
  previous,
  history = previous ? [previous] : [],
  historyCountRequested = history.length,
  candidate,
  artifacts = [],
  feed = null,
  candidateDesignatedRequirementConsistent = false,
  historicalRequirementTextEqual = false,
  failure = null,
  generatedAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    ready: ready === true,
    verificationKind: "signed-artifact-lineage",
    actualShipItReplacement: false,
    repository: repo,
    lineage: {
      previousTag: history[0]?.tag || null,
      previousVersion: history[0]?.version || null,
      previousReleases: history.map((release) => ({ tag: release.tag, version: release.version })),
      historyCountRequested,
      historyCountVerified: history.length,
      candidateTag: candidate?.tag || null,
      candidateVersion: candidate?.version || null,
      strictlyIncreasing: Boolean(
        history.length === historyCountRequested &&
        candidate?.version &&
        history.every((release) => compareStableVersions(release.version, candidate.version) < 0)
      ),
    },
    trust: {
      candidateDesignatedRequirementConsistent: candidateDesignatedRequirementConsistent === true,
      historicalRequirementTextEqual: historicalRequirementTextEqual === true,
      artifacts: artifacts.map((artifact) => ({
        source: artifact.source,
        container: artifact.container,
        architecture: artifact.architecture,
        officialBundleIdentity: artifact.officialBundleIdentity === true,
        developerId: artifact.developerId === true,
        pinnedDesignatedRequirement: artifact.pinnedDesignatedRequirement === true,
        gatekeeper: artifact.gatekeeper === true,
        notarization: artifact.notarization === true,
        previousDesignatedRequirements: artifact.source === "candidate"
          ? artifact.previousDesignatedRequirements === true
          : null,
        updaterTrustPolicyResource: artifact.source === "candidate"
          ? artifact.updaterTrustPolicyResource === true
          : null,
        bundleVersion: artifact.bundleVersion === true,
        containerIntegrity: artifact.containerIntegrity !== false,
      })),
    },
    feed: feed
      ? {
        version: feed.version === true,
        compatibility: feed.compatibility === true,
        zipSet: feed.zipSet === true,
        zipSizes: feed.zipSizes === true,
        zipDigests: feed.zipDigests === true,
        primaryZip: feed.primaryZip === true,
        remoteFeedBytes: feed.remoteFeedBytes === true,
        remoteZipSizes: feed.remoteZipSizes === true,
        remoteZipDigests: feed.remoteZipDigests === true,
        remoteVerificationDeferred: feed.remoteVerificationDeferred === true,
      }
      : null,
    failure: failure
      ? { code: String(failure.code || "lineage-verification-failed"), subject: String(failure.subject || "lineage") }
      : null,
  };
}

function run(command, args, { cwd = desktopRoot, capture = false, captureCombined = false, code, subject } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
    stdio: capture || captureCombined ? "pipe" : "ignore",
  });
  if (result.status !== 0) fail(code || "command-failed", subject || basename(command));
  if (captureCombined) return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return capture ? String(result.stdout || "").trim() : "";
}

function readArgs(argv) {
  return new Map(
    argv.map((arg) => {
      const [key, ...rest] = arg.split("=");
      return [key, rest.length ? rest.join("=") : "1"];
    }),
  );
}

function findOfficialApp(directory, subject) {
  const entry = readdirSync(directory, { withFileTypes: true })
    .find((candidate) => candidate.isDirectory() && candidate.name === "Agentlas.app");
  if (!entry) fail("official-app-missing", subject);
  return join(directory, entry.name);
}

function readOfficialBundleIdentifier(appPath, subject) {
  return run(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")],
    { capture: true, code: "bundle-identity-unreadable", subject },
  );
}

function readOfficialBundleVersion(appPath, subject) {
  return run(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")],
    { capture: true, code: "bundle-version-unreadable", subject },
  );
}

function verifyOuterDmg(dmgPath, subject) {
  run("hdiutil", ["verify", dmgPath], { code: "dmg-integrity-rejected", subject });
  run("codesign", ["--verify", "--strict", dmgPath], { code: "dmg-signature-rejected", subject });
  run("xcrun", ["stapler", "validate", dmgPath], { code: "dmg-notarization-rejected", subject });
  run(
    "spctl",
    ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmgPath],
    { code: "dmg-gatekeeper-rejected", subject },
  );
}

function safeArtifact({ source, container, architecture, updaterTrustPolicyResource = null }) {
  return {
    source,
    container,
    architecture,
    officialBundleIdentity: true,
    developerId: true,
    pinnedDesignatedRequirement: true,
    gatekeeper: true,
    notarization: true,
    previousDesignatedRequirements: source === "candidate" ? true : null,
    bundleVersion: true,
    containerIntegrity: true,
    updaterTrustPolicyResource,
  };
}

function verifyAgainstPreviousRequirements(appPath, previousRequirements, subject) {
  for (const requirement of previousRequirements) {
    run(
      "codesign",
      ["--verify", "--deep", "--strict", `-R=${requirement}`, appPath],
      { code: "previous-designated-requirement-rejected", subject },
    );
  }
}

function inspectApp({
  appPath,
  source,
  container,
  architecture,
  policy,
  policyPath,
  verifyMacAppBundle,
  inspectPackagedMacSigningPolicy,
  previousRequirements = [],
  expectedVersion,
}) {
  const subject = `${source}-${container}-${architecture}`;
  const trust = verifyMacAppBundle({
    appPath,
    policyPath,
    requireStapledNotarization: source !== "previous",
  });
  if (!trust?.developerId) fail("app-developer-id-rejected", subject);
  if (!trust?.checks?.codesign?.ok) fail("app-designated-requirement-rejected", subject);
  if (!trust?.gatekeeperAccepted) fail("app-gatekeeper-rejected", subject);
  if (!trust?.notarized) fail("app-notarization-rejected", subject);
  if (source !== "previous" && !trust?.stapledNotarization) fail("app-notarization-rejected", subject);
  if (!trust?.ok) fail("app-trust-rejected", subject);
  if (
    trust.bundleIdentifier !== policy.bundleIdentifier ||
    readOfficialBundleIdentifier(appPath, subject) !== policy.bundleIdentifier
  ) {
    fail("official-bundle-identity-rejected", subject);
  }
  if (readOfficialBundleVersion(appPath, subject) !== expectedVersion) {
    fail("bundle-version-mismatch", subject);
  }
  const requirement = normalizeDesignatedRequirement(trust.designatedRequirement);
  if (!requirement) fail("designated-requirement-unreadable", subject);
  let updaterTrustPolicyResource = null;
  if (source === "candidate") {
    verifyAgainstPreviousRequirements(appPath, previousRequirements, subject);
    const packagedPolicy = inspectPackagedMacSigningPolicy({ appPath, policyPath });
    if (!packagedPolicy.ok) fail("candidate-updater-trust-policy-mismatch", subject);
    updaterTrustPolicyResource = true;
  }
  return {
    requirement,
    evidence: safeArtifact({ source, container, architecture, updaterTrustPolicyResource }),
  };
}

function extractZip(zipPath, destination, subject) {
  mkdirSync(destination, { recursive: true });
  run("ditto", ["-x", "-k", zipPath, destination], { code: "zip-extraction-failed", subject });
  return findOfficialApp(destination, subject);
}

// The required-history tags (v0.8.59/v0.8.60) are fixed while the release
// count grows by one per publish. With `--limit 100`, Desktop 1.0.20 was the
// release that pushed v0.8.59 to position 101 — the writer then failed with
// required-history-tag-unavailable after every build had already succeeded
// (run 31924954976, 2026-08-16). The list must cover the whole history.
const RELEASE_LIST_LIMIT = "1000";

function readReleaseList(repo) {
  const output = run(
    "gh",
    ["release", "list", "--repo", repo, "--limit", RELEASE_LIST_LIMIT, "--json", "tagName,isDraft,isPrerelease,publishedAt"],
    { capture: true, code: "release-list-unavailable", subject: "previous-release" },
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("release-list-invalid", "previous-release");
  }
  // A saturated window would silently hide older required tags again; say so
  // instead of reporting the required tag as missing.
  if (Array.isArray(parsed) && parsed.length >= Number(RELEASE_LIST_LIMIT)) {
    fail("release-list-window-saturated", "previous-release");
  }
  return parsed;
}

function downloadPreviousArtifact({ repo, previous, architecture, extension, destination }) {
  const fileName = `Agentlas-${previous.version}-${architecture}.${extension}`;
  mkdirSync(destination, { recursive: true });
  const file = join(destination, fileName);
  if (existsSync(file) && statSync(file).size > 0) return file;
  run(
    "gh",
    ["release", "download", previous.tag, "--repo", repo, "--dir", destination, "--pattern", fileName],
    { code: "previous-artifact-unavailable", subject: `previous-${extension}-${architecture}` },
  );
  if (!existsSync(file) || statSync(file).size <= 0) fail("previous-artifact-unavailable", `previous-${extension}-${architecture}`);
  return file;
}

function candidateZipMetadata(releaseDir, version) {
  return Object.fromEntries(
    ARCHES.map((architecture) => {
      const fileName = `Agentlas-${version}-${architecture}.zip`;
      const file = join(releaseDir, fileName);
      if (!existsSync(file)) fail("candidate-updater-zip-missing", `candidate-zip-${architecture}`);
      const buffer = readFileSync(file);
      if (buffer.length === 0) fail("candidate-updater-zip-empty", `candidate-zip-${architecture}`);
      return [architecture, { file, fileName, size: buffer.length, sha512: sha512(buffer) }];
    }),
  );
}

function downloadRemoteCandidate({ repo, candidate, destination }) {
  mkdirSync(destination, { recursive: true });
  const feedName = "latest-mac.yml";
  run(
    "gh",
    ["release", "download", candidate.tag, "--repo", repo, "--dir", destination, "--pattern", feedName],
    { code: "remote-candidate-feed-unavailable", subject: feedName },
  );
  const feedPath = join(destination, feedName);
  if (!existsSync(feedPath)) fail("remote-candidate-feed-unavailable", feedName);

  const zipArtifacts = Object.fromEntries(
    ARCHES.map((architecture) => {
      const fileName = `Agentlas-${candidate.version}-${architecture}.zip`;
      run(
        "gh",
        ["release", "download", candidate.tag, "--repo", repo, "--dir", destination, "--pattern", fileName],
        { code: "remote-candidate-zip-unavailable", subject: `candidate-zip-${architecture}` },
      );
      const file = join(destination, fileName);
      if (!existsSync(file)) fail("remote-candidate-zip-unavailable", `candidate-zip-${architecture}`);
      const buffer = readFileSync(file);
      if (buffer.length === 0) fail("remote-candidate-zip-empty", `candidate-zip-${architecture}`);
      return [architecture, { fileName, size: buffer.length, sha512: sha512(buffer) }];
    }),
  );
  return { feedBytes: readFileSync(feedPath), zipArtifacts };
}

function mountDmg(dmgPath, mountPoint, subject) {
  mkdirSync(mountPoint, { recursive: true });
  run(
    "hdiutil",
    ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath],
    { code: "dmg-mount-failed", subject },
  );
}

function unmountDmg(mountPoint) {
  const result = spawnSync("hdiutil", ["detach", mountPoint], { stdio: "ignore", encoding: "utf8" });
  return result.status === 0;
}

function writeEvidence(evidencePath, evidence) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const candidateVersion = String(args.get("--version") || pkg.version);
  const candidateTag = String(args.get("--tag") || process.env.AGENTLAS_DESKTOP_RELEASE_TAG || `v${candidateVersion}`);
  const repo = String(args.get("--repo") || process.env.AGENTLAS_DESKTOP_GITHUB_REPO || "agentlas-ai/agentlas-desktop-releases");
  const releaseDir = resolve(desktopRoot, String(args.get("--release-dir") || "release"));
  const evidencePath = resolve(
    desktopRoot,
    String(args.get("--evidence") || join("release", "update-lineage-verification.json")),
  );
  const rawHistoryCount = args.get("--history-count") || process.env.AGENTLAS_MAC_UPDATE_HISTORY_COUNT || DEFAULT_HISTORY_COUNT;
  const requiredHistoryTags = args.get("--required-history-tags") || process.env.AGENTLAS_MAC_UPDATE_REQUIRED_HISTORY_TAGS || "";
  let historyCount = DEFAULT_HISTORY_COUNT;
  let historyCountRequested = DEFAULT_HISTORY_COUNT;
  const candidate = { tag: candidateTag, version: candidateVersion };
  let history = [];
  let feedEvidence = null;
  let candidateDesignatedRequirementConsistent = false;
  let historicalRequirementTextEqual = false;
  const artifactEvidence = [];
  const previousRequirements = [];
  const candidateRequirements = [];
  const mounted = [];
  const scratch = mkdtempSync(join(tmpdir(), "agentlas-update-lineage-"));

  try {
    historyCount = parseHistoryCount(rawHistoryCount);
    if (process.platform !== "darwin") fail("macos-required", "host-platform");
    const parsedCandidate = parseStableVersion(candidateVersion);
    if (!parsedCandidate || candidateTag !== `v${parsedCandidate.version}`) {
      fail("candidate-version-tag-invalid", "candidate-release");
    }

    const releaseList = readReleaseList(repo);
    history = selectPreviousStableReleases(releaseList, candidateVersion, historyCount);
    for (const required of selectRequiredHistoricalReleases(releaseList, candidateVersion, requiredHistoryTags)) {
      if (!history.some((release) => release.tag === required.tag)) history.push(required);
    }
    history.sort((left, right) => compareStableVersions(right.version, left.version));
    historyCountRequested = history.length;

    const policyPath = join(desktopRoot, "build-resources", "macos-release-signing-policy.json");
    const {
      inspectPackagedMacSigningPolicy,
      readMacReleaseSigningPolicy,
      verifyMacAppBundle,
    } = await import("./lib/mac-app-signature.mjs");
    const policy = readMacReleaseSigningPolicy(policyPath);

    const previousDownloadDir = resolve(
      String(
        args.get("--history-cache-dir") ||
        process.env.AGENTLAS_MAC_UPDATE_HISTORY_CACHE_DIR ||
        join(scratch, "previous-download")
      ),
    );
    mkdirSync(previousDownloadDir, { recursive: true });
    const historyPlan = historyVerificationPlan(history);
    for (const { release, releaseIndex, architecture } of historyPlan) {
      const zipPath = downloadPreviousArtifact({
        repo,
        previous: release,
        architecture,
        extension: "zip",
        destination: previousDownloadDir,
      });
      const appPath = extractZip(
        zipPath,
        join(scratch, `previous-${releaseIndex}-${architecture}`),
        `previous-${releaseIndex}-zip-${architecture}`,
      );
      const inspected = inspectApp({
        appPath,
        source: "previous",
        container: "zip",
        architecture,
        policy,
        policyPath,
        verifyMacAppBundle,
        inspectPackagedMacSigningPolicy,
        expectedVersion: release.version,
      });
      previousRequirements.push(inspected.requirement);
      artifactEvidence.push(inspected.evidence);

      const dmgPath = downloadPreviousArtifact({
        repo,
        previous: release,
        architecture,
        extension: "dmg",
        destination: previousDownloadDir,
      });
      verifyOuterDmg(dmgPath, `previous-${releaseIndex}-dmg-${architecture}`);
      const mountPoint = join(scratch, `previous-mounted-${releaseIndex}-${architecture}`);
      mountDmg(dmgPath, mountPoint, `previous-${releaseIndex}-dmg-${architecture}`);
      mounted.push(mountPoint);
      const dmgApp = findOfficialApp(mountPoint, `previous-${releaseIndex}-dmg-${architecture}`);
      const dmgInspected = inspectApp({
        appPath: dmgApp,
        source: "previous",
        container: "dmg",
        architecture,
        policy,
        policyPath,
        verifyMacAppBundle,
        inspectPackagedMacSigningPolicy,
        expectedVersion: release.version,
      });
      previousRequirements.push(dmgInspected.requirement);
      artifactEvidence.push(dmgInspected.evidence);
      if (unmountDmg(mountPoint)) mounted.pop();
    }
    historicalRequirementTextEqual = new Set(previousRequirements).size === 1;

    const zipArtifacts = candidateZipMetadata(releaseDir, candidateVersion);
    for (const architecture of ARCHES) {
      const zip = zipArtifacts[architecture];
      const zipApp = extractZip(zip.file, join(scratch, `candidate-zip-${architecture}`), `candidate-zip-${architecture}`);
      const zipInspected = inspectApp({
        appPath: zipApp,
        source: "candidate",
        container: "zip",
        architecture,
        policy,
        policyPath,
        verifyMacAppBundle,
        inspectPackagedMacSigningPolicy,
        previousRequirements,
        expectedVersion: candidateVersion,
      });
      candidateRequirements.push(zipInspected.requirement);
      artifactEvidence.push(zipInspected.evidence);

      const dmgPath = join(releaseDir, `Agentlas-${candidateVersion}-${architecture}.dmg`);
      if (!existsSync(dmgPath)) fail("candidate-dmg-missing", `candidate-dmg-${architecture}`);
      verifyOuterDmg(dmgPath, `candidate-dmg-${architecture}`);
      const mountPoint = join(scratch, `mounted-${architecture}`);
      mountDmg(dmgPath, mountPoint, `candidate-dmg-${architecture}`);
      mounted.push(mountPoint);
      const dmgApp = findOfficialApp(mountPoint, `candidate-dmg-${architecture}`);
      const dmgInspected = inspectApp({
        appPath: dmgApp,
        source: "candidate",
        container: "dmg",
        architecture,
        policy,
        policyPath,
        verifyMacAppBundle,
        inspectPackagedMacSigningPolicy,
        previousRequirements,
        expectedVersion: candidateVersion,
      });
      candidateRequirements.push(dmgInspected.requirement);
      artifactEvidence.push(dmgInspected.evidence);
      if (unmountDmg(mountPoint)) mounted.pop();
    }

    candidateDesignatedRequirementConsistent =
      candidateRequirements.length === 4 && new Set(candidateRequirements).size === 1;
    if (!candidateDesignatedRequirementConsistent) {
      fail("candidate-designated-requirement-mismatch", "candidate-release");
    }

    const feedPath = join(releaseDir, "latest-mac.yml");
    if (!existsSync(feedPath)) fail("feed-missing", "latest-mac.yml");
    let feed;
    try {
      const yaml = require("js-yaml");
      feed = yaml.load(readFileSync(feedPath, "utf8"));
    } catch {
      fail("feed-invalid", "latest-mac.yml");
    }
    feedEvidence = validateMacUpdateFeed({
      feed,
      candidateVersion,
      compatibility: loadUpdateCompatibility(join(desktopRoot, "package.json")),
      zipArtifacts,
    });
    if (args.has("--skip-remote-candidate")) {
      feedEvidence.remoteVerificationDeferred = true;
    } else {
      const remote = downloadRemoteCandidate({
        repo,
        candidate,
        destination: join(scratch, "remote-candidate"),
      });
      Object.assign(
        feedEvidence,
        validateRemoteCandidateMatchesLocal({
          localFeedBytes: readFileSync(feedPath),
          remoteFeedBytes: remote.feedBytes,
          localZipArtifacts: zipArtifacts,
          remoteZipArtifacts: remote.zipArtifacts,
        }),
      );
    }

    const evidence = buildValueFreeEvidence({
      ready: true,
      repo,
      history,
      historyCountRequested,
      candidate,
      artifacts: artifactEvidence,
      feed: feedEvidence,
      candidateDesignatedRequirementConsistent,
      historicalRequirementTextEqual,
    });
    writeEvidence(evidencePath, evidence);
    console.log(JSON.stringify({ ready: true, evidence: basename(evidencePath) }));
  } catch (error) {
    const failure = error instanceof LineageVerificationError
      ? error
      : new LineageVerificationError("lineage-verification-failed", "lineage");
    writeEvidence(
      evidencePath,
      buildValueFreeEvidence({
        ready: false,
        repo,
        history,
        historyCountRequested,
        candidate,
        artifacts: artifactEvidence,
        feed: feedEvidence,
        candidateDesignatedRequirementConsistent,
        historicalRequirementTextEqual,
        failure,
      }),
    );
    console.error(JSON.stringify({ ready: false, code: failure.code, subject: failure.subject }));
    process.exitCode = 1;
  } finally {
    for (const mountPoint of mounted.reverse()) unmountDmg(mountPoint);
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A cleanup-only failure must not overwrite the value-free verification
      // result already emitted for the release gate.
    }
  }
}

/**
 * The differential baseline survives an accepted install.
 *
 * electron-updater computes a differential download against a fixed name at the
 * cache ROOT — MacUpdater: `path.join(cacheDir, "update.zip")` — not the payload
 * under `pending/`. Our stale-artifact sweep used to remove both, and two of its
 * callers run on the success path, so every completed update destroyed the
 * baseline the next one needed and every release pulled the full ~340MB.
 *
 * Preservation belongs to exactly one call site: the accept-after-successful
 * install. The `install-not-applied` branch immediately below it reads almost
 * identically and must keep discarding — there the target version is not
 * running, so that payload is precisely the one that failed.
 */
export function verifyDifferentialBaselineContract(
  sourcePath = new URL("../electron/updater/controller.ts", import.meta.url),
) {
  const source = readFileSync(sourcePath, "utf8");
  const problems = [];
  if (!/if \(!options\?\.keepDifferentialBaseline\) sweepTargets\.push\(path\.join\(updaterCache, "update\.zip"\)\)/.test(source)) {
    problems.push("the sweep no longer honours keepDifferentialBaseline for <cache>/update.zip");
  }
  const preserving = (source.match(/keepDifferentialBaseline: true/g) || []).length;
  if (preserving !== 1) {
    problems.push(
      `expected exactly 1 call site to preserve the differential baseline, found ${preserving}`
        + " — only the accept-after-successful-install path may preserve it",
    );
  }
  if (!/cleanupOrBlock\(journal\.targetVersion, journal, \{ keepDifferentialBaseline: true \}\)/.test(source)) {
    problems.push("the accept-after-successful-install call site no longer preserves the baseline");
  }
  if (problems.length > 0) {
    throw new Error(`differential baseline contract broken:\n  - ${problems.join("\n  - ")}`);
  }
  return { ok: true, preservingCallSites: preserving };
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  console.log(JSON.stringify(verifyDifferentialBaselineContract()));
  if (process.argv.includes("--source-contract-only")) {
    console.log("NATIVE MAC UPDATE LINEAGE: NOT VERIFIED — source-contract-only mode did not inspect releases, signatures, notarization, feeds, or artifacts.");
  } else {
    await main();
  }
}
