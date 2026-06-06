#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(desktopRoot, "..");
const signingDir = resolve(desktopRoot, process.env.AGENTLAS_SIGNING_DIR || "signing");

const desktopPkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const currentVersion = String(desktopPkg.version || "0.0.0");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || desktopRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function hasFile(relativePath) {
  return existsSync(join(signingDir, relativePath));
}

function ghSecrets(repo) {
  const result = run("gh", ["secret", "list", "-R", repo], { cwd: repoRoot });
  if (!result.ok) return { ok: false, names: [], error: result.output };
  return {
    ok: true,
    names: result.output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  };
}

const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
const developerIdIdentities = identities.output
  .split(/\r?\n/)
  .filter((line) => /Developer ID Application:/i.test(line));
const ghAuth = run("gh", ["auth", "status", "-h", "github.com"], { cwd: repoRoot });
const notaryProfileName = process.env.AGENTLAS_NOTARY_PROFILE || "agentlas-notary";
const notaryProfile = run("xcrun", ["notarytool", "history", "--keychain-profile", notaryProfileName]);

const env = {
  APPLE_ID: hasEnv("APPLE_ID"),
  APPLE_APP_SPECIFIC_PASSWORD: hasEnv("APPLE_APP_SPECIFIC_PASSWORD"),
  APPLE_TEAM_ID: hasEnv("APPLE_TEAM_ID"),
  CSC_LINK: hasEnv("CSC_LINK"),
  CSC_KEY_PASSWORD: hasEnv("CSC_KEY_PASSWORD"),
  GH_TOKEN: hasEnv("GH_TOKEN") || hasEnv("GITHUB_TOKEN"),
  GH_AUTH_LOGIN: ghAuth.ok,
};
const localSigningFiles = {
  signingDir,
  developerIdP12: hasFile("agentlas-developer-id.p12"),
  developerIdP12Password: hasFile("agentlas-developer-id.p12.password"),
  appleAppSpecificPassword: hasFile("apple-app-specific-password"),
};
const localSigningFileReady = localSigningFiles.developerIdP12 && localSigningFiles.developerIdP12Password;
const notarizationReady =
  notaryProfile.ok ||
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);

const agentlasSecrets = ghSecrets("agentlas-ai/agentlas-desktop");
const requiredWorkflowSecrets = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "MAC_DEVELOPER_ID_CERTIFICATE",
  "MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD",
  "AGENTLAS_DESKTOP_RELEASE_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_PROJECT_ID",
];

const releaseVerification = join(desktopRoot, "release", "desktop-release-verification.json");
const releaseEnv = join(desktopRoot, "release", "desktop-release.production.env");
const verification = existsSync(releaseVerification)
  ? JSON.parse(readFileSync(releaseVerification, "utf8"))
  : null;
const releaseEnvValues = existsSync(releaseEnv)
  ? Object.fromEntries(
      readFileSync(releaseEnv, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    )
  : null;

const missingWorkflowSecrets = agentlasSecrets.ok
  ? requiredWorkflowSecrets.filter((name) => !agentlasSecrets.names.includes(name))
  : requiredWorkflowSecrets;

const railwayAccess = run("node", [
  "scripts/check-railway-release-access.mjs",
  "--environment=production",
  "--service=agentlas-web",
]);

const localReady =
  (developerIdIdentities.length > 0 || (env.CSC_LINK && env.CSC_KEY_PASSWORD) || localSigningFileReady) &&
  notarizationReady &&
  (env.GH_TOKEN || env.GH_AUTH_LOGIN) &&
  railwayAccess.ok;
const workflowReady = agentlasSecrets.ok && missingWorkflowSecrets.length === 0;

console.log(JSON.stringify({
  local: {
    ready: localReady,
    developerIdApplicationIdentities: developerIdIdentities.map((line) => line.replace(/^\s*\d+\)\s*/, "")),
    localSigningFiles,
    notaryProfile: {
      name: notaryProfileName,
      ready: notaryProfile.ok,
    },
    env,
    railwayAccess: {
      ready: railwayAccess.ok,
      output: railwayAccess.output,
    },
    nextCommand: localReady
      ? "AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac && npm run release:mac:publish && npm run release:web-env -- --apply --restart --verify-url=https://agentlas.cloud/api/desktop/latest"
      : "Put Developer ID files in signing/, configure notarization credentials, authenticate GitHub, and verify Railway with npm run release:railway:check.",
  },
  githubActions: {
    ready: workflowReady,
    repo: "agentlas-ai/agentlas-desktop",
    missingSecrets: missingWorkflowSecrets,
    credentialValidity: "gh secret list verifies secret names only; release-signed-mac.yml checks Railway access with release:railway:check and skips only web env publishing if it is invalid.",
    nextCommand: workflowReady
      ? `gh workflow run release-signed-mac.yml -R agentlas-ai/agentlas-desktop -f version=${currentVersion} -f tag=v${currentVersion} -f draft=false -f apply_web_env=true`
      : "Set the missing GitHub Actions secrets, then run the desktop release workflow.",
  },
  localCachedReleaseVerification: verification
    ? {
        stale: releaseEnvValues?.AGENTLAS_DESKTOP_VERSION
          ? releaseEnvValues.AGENTLAS_DESKTOP_VERSION !== currentVersion
          : null,
        envVersion: releaseEnvValues?.AGENTLAS_DESKTOP_VERSION || null,
        envTag: releaseEnvValues?.AGENTLAS_DESKTOP_RELEASE_TAG || null,
        ready: verification.ready,
        failures: verification.failures,
        artifacts: verification.artifacts?.map((artifact) => ({
          arch: artifact.arch,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          notarized: artifact.notarized,
          gatekeeperAccepted: artifact.gatekeeperAccepted,
        })),
      }
    : null,
}, null, 2));

if (!localReady && !workflowReady) process.exit(1);
