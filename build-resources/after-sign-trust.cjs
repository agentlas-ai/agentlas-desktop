const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepareMacRuntimeResourcesForInstall } = require("./after-pack-clean.cjs");

const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "macos-release-signing-policy.json"), "utf8"));
const localBundleIdentifier = "com.agentlas.desktop.candidate";
const localProductName = "Agentlas-Local-Candidate";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  return { ok: result.status === 0, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
}

function plistValue(plist, key) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
  return result.ok ? result.output.trim() : null;
}

function metadataValue(output, key) {
  const prefix = `${key}=`;
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function firstAuthority(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("Authority="));
  return line ? line.slice("Authority=".length).trim() : null;
}

/**
 * electron-builder afterSign boundary. An official-ID macOS bundle may leave
 * packaging only when it is already in the exact Developer ID lineage. Local
 * unsigned/Apple Distribution QA builds must use the isolated candidate name
 * and ID, so they cannot later be mistaken for /Applications/Agentlas.app.
 */
module.exports = async function afterSignTrust(context) {
  const apps = fs.existsSync(context.appOutDir)
    ? fs.readdirSync(context.appOutDir).filter((entry) => entry.endsWith(".app"))
    : [];
  if (apps.length === 0) return; // Windows/Linux packaging: impact must stay zero.
  if (apps.length !== 1) throw new Error("macOS package must contain exactly one application bundle");

  const appPath = path.join(context.appOutDir, apps[0]);
  const plist = path.join(appPath, "Contents", "Info.plist");
  const bundleIdentifier = plistValue(plist, "CFBundleIdentifier");
  const productName = plistValue(plist, "CFBundleName");

  if (bundleIdentifier === localBundleIdentifier) {
    if (apps[0] !== `${localProductName}.app` || productName !== localProductName) {
      throw new Error("local macOS candidate identity is not isolated");
    }
    await prepareMacRuntimeResourcesForInstall(context);
    return;
  }
  if (bundleIdentifier !== policy.bundleIdentifier || apps[0] !== "Agentlas.app") {
    throw new Error("unknown macOS bundle identity cannot leave packaging");
  }

  const display = run("codesign", ["-d", "-r-", "--verbose=4", appPath]);
  const developerId =
    display.ok &&
    metadataValue(display.output, "Identifier") === policy.bundleIdentifier &&
    metadataValue(display.output, "TeamIdentifier") === policy.teamIdentifier &&
    firstAuthority(display.output) === policy.leafAuthority;
  const requirement = developerId
    ? run("codesign", ["--verify", "--deep", "--strict", `-R=${policy.designatedRequirement}`, appPath])
    : { ok: false };
  if (!developerId || !requirement.ok) {
    // Never include raw codesign output: it can contain local keychain/path details.
    throw new Error("official macOS bundle requires the pinned Developer ID signing identity");
  }

  // Squirrel.Mac clears quarantine xattrs before taking ownership of an update.
  // Normalize the signed runtime trees to owner-writable archive modes only
  // after the complete signing pass, then re-check the exact requirement.
  await prepareMacRuntimeResourcesForInstall(context);
  const installableRequirement = run("codesign", ["--verify", "--deep", "--strict", `-R=${policy.designatedRequirement}`, appPath]);
  if (!installableRequirement.ok) {
    throw new Error("Squirrel-installable runtime permissions invalidated the official macOS code signature");
  }
};
