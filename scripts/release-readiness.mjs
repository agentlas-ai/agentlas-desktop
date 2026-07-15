#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(desktopRoot, "..");
const signingDir = resolve(desktopRoot, process.env.AGENTLAS_SIGNING_DIR || "signing");
const workspaceWebRoot = join(repoRoot, "agentlas", "AgentsAtlas", "app");
const railwayCwd = process.env.AGENTLAS_RAILWAY_CWD
  ? resolve(process.env.AGENTLAS_RAILWAY_CWD)
  : existsSync(workspaceWebRoot)
    ? workspaceWebRoot
    : desktopRoot;

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
const requiredMacWorkflowSecrets = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "MAC_DEVELOPER_ID_CERTIFICATE",
  "MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD",
  "AGENTLAS_DESKTOP_RELEASE_TOKEN",
];
const optionalWebEnvWorkflowSecrets = [
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
const cachedReleaseVersion = String(
  verification?.version || releaseEnvValues?.AGENTLAS_DESKTOP_VERSION || "",
).trim() || null;
const cachedReleaseTag = String(
  verification?.tag || releaseEnvValues?.AGENTLAS_DESKTOP_RELEASE_TAG || "",
).trim() || null;

const missingWorkflowSecrets = agentlasSecrets.ok
  ? requiredMacWorkflowSecrets.filter((name) => !agentlasSecrets.names.includes(name))
  : null;
const missingOptionalWebEnvSecrets = agentlasSecrets.ok
  ? optionalWebEnvWorkflowSecrets.filter((name) => !agentlasSecrets.names.includes(name))
  : null;

const railwayAccess = run("node", [
  "scripts/check-railway-release-access.mjs",
  "--environment=production",
  "--service=agentlas-web",
  `--railway-cwd=${railwayCwd}`,
]);

const localMacPublishReady =
  (developerIdIdentities.length > 0 || (env.CSC_LINK && env.CSC_KEY_PASSWORD) || localSigningFileReady) &&
  notarizationReady &&
  (env.GH_TOKEN || env.GH_AUTH_LOGIN);
const localWebEnvReady = localMacPublishReady && railwayAccess.ok;
const workflowReady = agentlasSecrets.ok && missingWorkflowSecrets?.length === 0;

console.log(JSON.stringify({
  local: {
    ready: localMacPublishReady,
    macPublishReady: localMacPublishReady,
    webEnvReady: localWebEnvReady,
    developerIdApplicationIdentities: developerIdIdentities.map((line) => line.replace(/^\s*\d+\)\s*/, "")),
    localSigningFiles,
    notaryProfile: {
      name: notaryProfileName,
      ready: notaryProfile.ok,
    },
    env,
    railwayAccess: {
      ready: railwayAccess.ok,
      cwd: railwayCwd,
      output: railwayAccess.output,
    },
    nextCommand: localMacPublishReady
      ? localWebEnvReady
        ? "AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac && npm run release:mac:publish && npm run release:web-env -- --apply --restart --verify-url=https://agentlas.cloud/api/desktop/latest"
        : "AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac && npm run release:mac:publish # Railway web env is a separate optional follow-up"
      : "Put Developer ID files in signing/, configure notarization credentials, and authenticate GitHub. Verify Railway separately only when applying web release env.",
  },
  githubActions: {
    ready: workflowReady,
    repo: "agentlas-ai/agentlas-desktop",
    missingSecrets: missingWorkflowSecrets,
    secretInventoryStatus: agentlasSecrets.ok ? "verified" : "unavailable",
    secretInventoryError: agentlasSecrets.ok ? null : agentlasSecrets.error,
    optionalWebEnv: {
      ready: agentlasSecrets.ok && missingOptionalWebEnvSecrets?.length === 0,
      missingSecrets: missingOptionalWebEnvSecrets,
      note: "Railway credentials are optional for publishing the signed Mac app; they only control the separate web-env apply step.",
    },
    credentialValidity: "gh secret list verifies secret names only; release-signed-mac.yml checks Railway access with release:railway:check and skips only web env publishing if it is invalid.",
    nextCommand: workflowReady
      ? `gh workflow run release-signed-mac.yml -R agentlas-ai/agentlas-desktop -f version=${currentVersion} -f tag=v${currentVersion} -f draft=false -f apply_web_env=true`
      : agentlasSecrets.ok
        ? "Set the verified missing GitHub Actions secrets, then run the desktop release workflow."
        : "Authenticate GitHub first so workflow secret names can be verified; missing secrets are currently unknown.",
  },
  localCachedReleaseVerification: verification
    ? {
        stale: cachedReleaseVersion ? cachedReleaseVersion !== currentVersion : null,
        version: cachedReleaseVersion,
        tag: cachedReleaseTag,
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

if (!localMacPublishReady && !workflowReady) process.exit(1);
