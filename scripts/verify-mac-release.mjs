#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectPackagedMacSigningPolicy, verifyMacAppBundle } from "./lib/mac-app-signature.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const releaseDir = resolve(desktopRoot, String(args.get("--release-dir") || "release"));
const allowUnnotarized = args.has("--allow-unnotarized");
const writeEnv = args.has("--write-env");
const repo = String(args.get("--repo") || process.env.AGENTLAS_DESKTOP_GITHUB_REPO || "agentlas-ai/agentlas-desktop-releases");
const version = String(args.get("--version") || JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version);
const tag = String(args.get("--tag") || process.env.AGENTLAS_DESKTOP_RELEASE_TAG || `v${version}`);
const arches = ["arm64", "x64"];
const signingPolicyPath = join(desktopRoot, "build-resources", "macos-release-signing-policy.json");

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: desktopRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    ok: result.status === 0,
    status: result.status,
    command: [command, ...commandArgs].join(" "),
    output,
  };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha512(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function makeTreeOwnerWritable(target) {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  chmodSync(target, stat.mode | 0o700);
  for (const entry of readdirSync(target)) makeTreeOwnerWritable(join(target, entry));
}

function envLine(key, value) {
  return `${key}=${String(value).replace(/\n/g, " ")}`;
}

function artifactUrl(arch) {
  return `https://github.com/${repo}/releases/download/${tag}/Agentlas-${version}-${arch}.dmg`;
}

function exactSourceCommit() {
  const result = run("git", ["rev-parse", "HEAD"]);
  const value = result.output.trim();
  if (!result.ok || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("Could not resolve the exact Desktop source commit for release provenance.");
  }
  return value.toLowerCase();
}

function cleanupAppleDouble() {
  if (!existsSync(releaseDir)) return;
  run("find", [releaseDir, "-name", "._*", "-delete"]);
  const dotClean = spawnSync("sh", ["-lc", "command -v dot_clean || test ! -x /usr/sbin/dot_clean || printf /usr/sbin/dot_clean"], {
    cwd: desktopRoot,
    encoding: "utf8",
    env: process.env,
  }).stdout.trim();
  if (dotClean) run(dotClean, ["-m", releaseDir]);
}

function inspectInnerApps({ file, arch }) {
  const root = mkdtempSync(join(tmpdir(), `agentlas-release-${arch}-`));
  const mountPoint = join(root, "mount");
  const zipRoot = join(root, "zip");
  mkdirSync(mountPoint, { recursive: true });
  mkdirSync(zipRoot, { recursive: true });
  const zipFile = join(releaseDir, `Agentlas-${version}-${arch}.zip`);
  const result = {
    zipFile,
    zipExists: existsSync(zipFile),
    attach: null,
    detach: null,
    extract: null,
    dmgApp: null,
    zipApp: null,
    dmgSigningPolicy: null,
    zipSigningPolicy: null,
    designatedRequirementMatches: false,
  };
  try {
    result.attach = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, file]);
    const dmgAppPath = join(mountPoint, "Agentlas.app");
    if (result.attach.ok && existsSync(dmgAppPath)) {
      result.dmgApp = verifyMacAppBundle({ appPath: dmgAppPath, policyPath: signingPolicyPath });
      result.dmgSigningPolicy = inspectPackagedMacSigningPolicy({ appPath: dmgAppPath, policyPath: signingPolicyPath });
    }
    if (result.zipExists) {
      result.extract = run("ditto", ["-x", "-k", zipFile, zipRoot]);
      const zipAppPath = join(zipRoot, "Agentlas.app");
      if (result.extract.ok && existsSync(zipAppPath)) {
        result.zipApp = verifyMacAppBundle({ appPath: zipAppPath, policyPath: signingPolicyPath });
        result.zipSigningPolicy = inspectPackagedMacSigningPolicy({ appPath: zipAppPath, policyPath: signingPolicyPath });
      }
    }
    result.designatedRequirementMatches = Boolean(
      result.dmgApp?.designatedRequirement &&
      result.zipApp?.designatedRequirement &&
      result.dmgApp.designatedRequirement === result.zipApp.designatedRequirement,
    );
  } finally {
    if (result.attach?.ok) result.detach = run("hdiutil", ["detach", mountPoint]);
    if (!result.attach?.ok || result.detach?.ok) {
      makeTreeOwnerWritable(zipRoot);
      makeTreeOwnerWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
  return result;
}

function writeLatestMacYml(artifacts) {
  const byArch = Object.fromEntries(artifacts.map((artifact) => [artifact.arch, artifact]));
  if (!byArch.x64?.exists || !byArch.arm64?.exists) return null;

  const releaseDate = new Date().toISOString();
  const ordered = [byArch.x64, byArch.arm64];
  const lines = [
    `version: ${version}`,
    "files:",
    ...ordered.flatMap((artifact) => [
      `  - url: ${artifact.fileName}`,
      `    sha512: ${artifact.sha512}`,
      `    size: ${artifact.sizeBytes}`,
    ]),
    `path: ${byArch.x64.fileName}`,
    `sha512: ${byArch.x64.sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ];

  const file = join(releaseDir, "latest-mac.yml");
  writeFileSync(file, lines.join("\n"));
  return {
    file,
    releaseDate,
    files: ordered.map((artifact) => ({
      arch: artifact.arch,
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes,
      sha512: artifact.sha512,
    })),
  };
}

cleanupAppleDouble();

const artifacts = arches.map((arch) => {
  const fileName = `Agentlas-${version}-${arch}.dmg`;
  const file = join(releaseDir, fileName);
  const exists = existsSync(file);
  const hdiutil = exists ? run("hdiutil", ["verify", file]) : null;
  const stapler = exists ? run("xcrun", ["stapler", "validate", file]) : null;
  const spctl = exists
    ? run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", file])
    : null;
  const inner = exists ? inspectInnerApps({ file, arch }) : null;
  return {
    arch,
    fileName,
    file,
    exists,
    sizeBytes: exists ? statSync(file).size : null,
    sha256: exists ? sha256(file) : null,
    sha512: exists ? sha512(file) : null,
    hdiutil,
    stapler,
    spctl,
    notarized: Boolean(stapler?.ok),
    gatekeeperAccepted: Boolean(spctl?.ok),
    inner,
  };
});

const failures = [];
for (const artifact of artifacts) {
  if (!artifact.exists) failures.push(`${artifact.fileName}: missing`);
  if (artifact.hdiutil && !artifact.hdiutil.ok) failures.push(`${artifact.fileName}: hdiutil verify failed`);
  if (artifact.stapler && !artifact.stapler.ok) failures.push(`${artifact.fileName}: notarization ticket missing`);
  if (artifact.spctl && !artifact.spctl.ok) failures.push(`${artifact.fileName}: Gatekeeper rejected`);
  if (artifact.inner) {
    if (!artifact.inner.attach?.ok) failures.push(`${artifact.fileName}: could not mount for inner-app verification`);
    if (!artifact.inner.dmgApp?.ok) failures.push(`${artifact.fileName}: DMG inner app failed pinned Developer ID/notarization/Gatekeeper`);
    if (!artifact.inner.dmgSigningPolicy?.ok) failures.push(`${artifact.fileName}: DMG inner app is missing or drifted from the updater trust policy resource`);
    if (!artifact.inner.zipExists) failures.push(`${artifact.fileName}: matching updater ZIP missing`);
    if (artifact.inner.zipExists && !artifact.inner.extract?.ok) failures.push(`${artifact.fileName}: updater ZIP could not be extracted`);
    if (!artifact.inner.zipApp?.ok) failures.push(`${artifact.fileName}: updater ZIP app failed pinned Developer ID/notarization/Gatekeeper`);
    if (!artifact.inner.zipSigningPolicy?.ok) failures.push(`${artifact.fileName}: updater ZIP app is missing or drifted from the updater trust policy resource`);
    if (!artifact.inner.designatedRequirementMatches) failures.push(`${artifact.fileName}: DMG and updater ZIP designated requirements differ`);
    if (artifact.inner.detach && !artifact.inner.detach.ok) failures.push(`${artifact.fileName}: verification mount could not be detached`);
  }
}
cleanupAppleDouble();
const appleDouble = run("find", [releaseDir, "-name", "._*", "-print"]);
if (appleDouble.output) {
  failures.push(`release directory contains AppleDouble files: ${appleDouble.output.split("\n").slice(0, 4).join(", ")}`);
}

const ready = failures.length === 0;
writeLatestMacYml(artifacts);
const summary = {
  schemaVersion: "agentlas.desktop-release-verification.v2",
  generatedAt: new Date().toISOString(),
  sourceCommit: exactSourceCommit(),
  repo,
  tag,
  version,
  ready,
  allowUnnotarized,
  artifacts: artifacts.map((artifact) => ({
    arch: artifact.arch,
    fileName: artifact.fileName,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    sha512: artifact.sha512,
    notarized: artifact.notarized,
    gatekeeperAccepted: artifact.gatekeeperAccepted,
    innerApp: artifact.inner?.dmgApp ? {
      gatekeeperAccepted: artifact.inner.dmgApp.gatekeeperAccepted,
      notarized: artifact.inner.dmgApp.notarized,
    } : null,
    url: artifactUrl(artifact.arch),
  })),
};

mkdirSync(releaseDir, { recursive: true });
writeFileSync(join(releaseDir, "desktop-release-verification.json"), `${JSON.stringify(summary, null, 2)}\n`);

if (writeEnv) {
  const envPath = join(releaseDir, ready ? "desktop-release.production.env" : "desktop-release.candidate.env");
  const byArch = Object.fromEntries(artifacts.map((artifact) => [artifact.arch, artifact]));
  writeFileSync(
    envPath,
    [
      envLine("AGENTLAS_DESKTOP_VERSION", version),
      envLine("AGENTLAS_DESKTOP_RELEASE_CHANNEL", "public"),
      envLine("AGENTLAS_DESKTOP_GITHUB_REPO", repo),
      envLine("AGENTLAS_DESKTOP_RELEASE_TAG", tag),
      envLine("AGENTLAS_DESKTOP_RELEASE_VERIFIED", ready ? "true" : "false"),
      envLine("AGENTLAS_DESKTOP_RELEASE_NOTARIZED", ready ? "true" : "false"),
      envLine("AGENTLAS_DESKTOP_MAC_ARM64_URL", artifactUrl("arm64")),
      envLine("AGENTLAS_DESKTOP_MAC_ARM64_SHA256", byArch.arm64?.sha256 || ""),
      envLine("AGENTLAS_DESKTOP_MAC_ARM64_SIZE", byArch.arm64?.sizeBytes || ""),
      envLine("AGENTLAS_DESKTOP_MAC_X64_URL", artifactUrl("x64")),
      envLine("AGENTLAS_DESKTOP_MAC_X64_SHA256", byArch.x64?.sha256 || ""),
      envLine("AGENTLAS_DESKTOP_MAC_X64_SIZE", byArch.x64?.sizeBytes || ""),
      envLine(
        "AGENTLAS_DESKTOP_RELEASE_NOTES",
        ready
          ? "Agentlas Desktop for macOS. Install approved Agentlas firms from the web and run them with your own AI runtime."
          : "Candidate DMGs exist, but public downloads remain gated until Developer ID signing, Apple notarization, and Gatekeeper validation pass.",
      ),
      "",
    ].join("\n"),
  );
  summary.envFile = envPath;
}

cleanupAppleDouble();

console.log(JSON.stringify({
  ready,
  releaseDir,
    verification: join(releaseDir, "desktop-release-verification.json"),
    envFile: summary.envFile || null,
  artifacts: summary.artifacts.map(({ arch, fileName, sizeBytes, sha256, sha512, notarized, gatekeeperAccepted }) => ({
    arch,
    fileName,
    sizeBytes,
    sha256,
    sha512,
    notarized,
    gatekeeperAccepted,
  })),
  failures,
}, null, 2));

if (!ready && !allowUnnotarized) {
  process.exit(1);
}
