#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) || "release-local");
const officialApp = "Agentlas.app";
const candidateApp = "Agentlas-Local-Candidate.app";
const candidateInstallIdentity = {
  schemaVersion: 1,
  channel: "local-candidate",
  appId: "com.agentlas.desktop.candidate",
  appName: "Agentlas-Local-Candidate",
  userDataNamespace: "Agentlas-Local-Candidate",
  keychainService: "com.agentlas.desktop.candidate",
  updateFeed: "none",
};

function directoriesBelow(start) {
  if (!existsSync(start)) return [];
  const found = [];
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of readdirSync(current)) {
      const target = join(current, entry);
      if (!statSync(target).isDirectory()) continue;
      if (entry.endsWith(".app")) found.push(target);
      else queue.push(target);
    }
  }
  return found;
}

const apps = directoriesBelow(output);
if (apps.length !== 1 || !apps[0].endsWith(`/${candidateApp}`)) {
  throw new Error(`Local output must contain exactly one ${candidateApp}`);
}
if (apps.some((app) => app.endsWith(`/${officialApp}`))) {
  throw new Error("Local candidate must never produce Agentlas.app");
}

const appPath = apps[0];
const plist = join(appPath, "Contents", "Info.plist");
function readPlistValue(key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
for (const [key, expected] of Object.entries({
  CFBundleIdentifier: candidateInstallIdentity.appId,
  CFBundleName: candidateInstallIdentity.appName,
  CFBundleDisplayName: candidateInstallIdentity.appName,
  CFBundleExecutable: candidateInstallIdentity.appName,
})) {
  if (readPlistValue(key) !== expected) {
    throw new Error(`Local candidate ${key} is not isolated`);
  }
}
const resources = join(appPath, "Contents", "Resources");
if (existsSync(join(resources, "macos-release-signing-policy.json"))) {
  throw new Error("Local candidate must not embed the official macOS release signing policy");
}
for (const updateConfig of ["app-update.yml", "app-update.yaml"]) {
  if (existsSync(join(resources, updateConfig))) {
    throw new Error("Local candidate must not embed an official update feed");
  }
}
const appAsar = join(resources, "app.asar");
if (!existsSync(appAsar)) throw new Error("Local candidate must contain app.asar for install-identity verification");
let packagedMetadata;
try {
  packagedMetadata = JSON.parse(extractFile(appAsar, "package.json").toString("utf8"));
} catch {
  throw new Error("Local candidate app.asar package metadata is unreadable");
}
const packagedIdentity = packagedMetadata?.agentlasInstallIdentity;
if (
  !packagedIdentity ||
  Object.keys(packagedIdentity).length !== Object.keys(candidateInstallIdentity).length ||
  Object.entries(candidateInstallIdentity).some(([key, value]) => packagedIdentity[key] !== value)
) {
  throw new Error("Local candidate app.asar install identity must be the exact isolated marker");
}
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (
  packageJson.agentlasBundledRuntimeSource?.ref !== `v${packageJson.agentlasUpdateCompatibility?.bundledRuntimeVersion}` ||
  !/^[a-f0-9]{40}$/.test(packageJson.agentlasBundledRuntimeSource?.commit || "")
) {
  throw new Error("Local candidate verification refuses a version/Core regression");
}
console.log(JSON.stringify({
  ok: true,
  productName: "Agentlas-Local-Candidate",
  bundleIdentifier: "com.agentlas.desktop.candidate",
  installIdentityEmbedded: true,
  officialFeedEmbedded: false,
  officialTrustPolicyEmbedded: false,
  officialApplicationsPathShared: false,
}, null, 2));
