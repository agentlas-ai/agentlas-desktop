#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function envLine(key, value) {
  return `${key}=${String(value).replace(/\n/g, " ")}`;
}

function artifactUrl(arch) {
  return `https://github.com/${repo}/releases/download/${tag}/Agentlas-${version}-${arch}.dmg`;
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
  };
});

const failures = [];
for (const artifact of artifacts) {
  if (!artifact.exists) failures.push(`${artifact.fileName}: missing`);
  if (artifact.hdiutil && !artifact.hdiutil.ok) failures.push(`${artifact.fileName}: hdiutil verify failed`);
  if (artifact.stapler && !artifact.stapler.ok) failures.push(`${artifact.fileName}: notarization ticket missing`);
  if (artifact.spctl && !artifact.spctl.ok) failures.push(`${artifact.fileName}: Gatekeeper rejected`);
}
cleanupAppleDouble();
const appleDouble = run("find", [releaseDir, "-name", "._*", "-print"]);
if (appleDouble.output) {
  failures.push(`release directory contains AppleDouble files: ${appleDouble.output.split("\n").slice(0, 4).join(", ")}`);
}

const ready = failures.length === 0;
const latestMac = writeLatestMacYml(artifacts);
const summary = {
  generatedAt: new Date().toISOString(),
  releaseDir,
  repo,
  tag,
  version,
  ready,
  allowUnnotarized,
  latestMac,
  artifacts: artifacts.map((artifact) => ({
    arch: artifact.arch,
    fileName: artifact.fileName,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    sha512: artifact.sha512,
    notarized: artifact.notarized,
    gatekeeperAccepted: artifact.gatekeeperAccepted,
    url: artifactUrl(artifact.arch),
    checks: {
      hdiutil: artifact.hdiutil ? { ok: artifact.hdiutil.ok, output: artifact.hdiutil.output } : null,
      stapler: artifact.stapler ? { ok: artifact.stapler.ok, output: artifact.stapler.output } : null,
      spctl: artifact.spctl ? { ok: artifact.spctl.ok, output: artifact.spctl.output } : null,
    },
  })),
  failures,
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
