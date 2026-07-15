import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

export function readMacReleaseSigningPolicy(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (
    raw?.schemaVersion !== 1 ||
    typeof raw.bundleIdentifier !== "string" ||
    !/^[A-Za-z0-9.-]+$/.test(raw.bundleIdentifier) ||
    typeof raw.teamIdentifier !== "string" ||
    !/^[A-Z0-9]{10}$/.test(raw.teamIdentifier) ||
    raw.leafAuthorityPrefix !== "Developer ID Application:" ||
    typeof raw.designatedRequirement !== "string" ||
    !raw.designatedRequirement.includes(`identifier \"${raw.bundleIdentifier}\"`) ||
    !raw.designatedRequirement.includes("anchor apple generic") ||
    !raw.designatedRequirement.includes("1.2.840.113635.100.6.1.13") ||
    !raw.designatedRequirement.includes("1.2.840.113635.100.6.2.6") ||
    !raw.designatedRequirement.includes(raw.teamIdentifier)
  ) {
    throw new Error("Invalid pinned macOS release signing policy");
  }
  return raw;
}

/**
 * The running macOS updater reads this policy from its sealed Resources
 * directory. Verify the packaged copy separately from code-signature checks:
 * a missing, altered, or symlinked file must never become an update input.
 */
export function inspectPackagedMacSigningPolicy({ appPath, policyPath }) {
  let sourceStat;
  try {
    sourceStat = lstatSync(policyPath);
  } catch {
    throw new Error("The source macOS updater trust policy is missing");
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("The source macOS updater trust policy must be a regular file");
  }

  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  for (const directory of [appPath, contentsPath, resourcesPath]) {
    let directoryStat;
    try {
      directoryStat = lstatSync(directory);
    } catch {
      return { ok: false, present: false, matchesSource: false, sha256: null };
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { ok: false, present: false, matchesSource: false, sha256: null };
    }
  }

  const packagedPath = join(resourcesPath, "macos-release-signing-policy.json");
  let packagedStat;
  try {
    packagedStat = lstatSync(packagedPath);
  } catch {
    return { ok: false, present: false, matchesSource: false, sha256: null };
  }
  if (!packagedStat.isFile() || packagedStat.isSymbolicLink()) {
    return { ok: false, present: true, matchesSource: false, sha256: null };
  }

  const expected = readFileSync(policyPath);
  const actual = readFileSync(packagedPath);
  const matchesSource = actual.equals(expected);
  return {
    ok: matchesSource,
    present: true,
    matchesSource,
    sha256: createHash("sha256").update(actual).digest("hex"),
  };
}

function value(output, key) {
  const prefix = `${key}=`;
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function authorityChain(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length).trim());
}

function designatedRequirement(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.trim().startsWith("designated =>"));
  return line ? line.trim().replace(/\s+/g, " ") : null;
}

/**
 * Release-artifact trust is deliberately stricter than the running-source
 * preflight: every extracted inner app must also carry a stapled notarization
 * ticket before it can enter the official update feed.
 */
export function verifyMacAppBundle({
  appPath,
  policyPath,
  runCommand = run,
  requireStapledNotarization = true,
}) {
  let policy;
  try {
    policy = readMacReleaseSigningPolicy(policyPath);
  } catch {
    return {
      ok: false,
      category: "policy-invalid",
      developerId: false,
      notarized: false,
      stapledNotarization: false,
      gatekeeperAccepted: false,
      designatedRequirement: null,
      checks: {},
    };
  }

  const display = runCommand("codesign", ["-d", "-r-", "--verbose=4", appPath]);
  const identifier = display.ok ? value(display.output, "Identifier") : null;
  const teamIdentifier = display.ok ? value(display.output, "TeamIdentifier") : null;
  const authorities = display.ok ? authorityChain(display.output) : [];
  const developerId = Boolean(
    display.ok &&
    identifier === policy.bundleIdentifier &&
    teamIdentifier === policy.teamIdentifier &&
    authorities[0]?.startsWith(policy.leafAuthorityPrefix),
  );
  const codesign = developerId
    ? runCommand("codesign", [
      "--verify",
      "--deep",
      "--strict",
      `-R=${policy.designatedRequirement}`,
      appPath,
    ])
    : { ok: false, status: null, output: "" };
  const stapler = codesign.ok
    ? runCommand("xcrun", ["stapler", "validate", appPath])
    : { ok: false, status: null, output: "" };
  const spctl = codesign.ok
    ? runCommand("spctl", [
      "-a",
      "-t",
      "execute",
      "--context",
      "context:primary-signature",
      "-vv",
      appPath,
    ])
    : { ok: false, status: null, output: "" };
  const gatekeeperNotarized = Boolean(spctl.ok && /source=Notarized Developer ID/i.test(spctl.output));
  const notarized = stapler.ok || gatekeeperNotarized;

  let category = "accepted";
  if (!display.ok || !developerId) category = "not-developer-id";
  else if (!codesign.ok) category = "designated-requirement-rejected";
  else if (!spctl.ok) category = "gatekeeper-rejected";
  else if (!notarized || (requireStapledNotarization && !stapler.ok)) category = "notarization-rejected";

  return {
    ok: developerId && codesign.ok && spctl.ok && notarized && (!requireStapledNotarization || stapler.ok),
    category,
    developerId,
    notarized,
    stapledNotarization: stapler.ok,
    gatekeeperAccepted: spctl.ok,
    bundleIdentifier: identifier,
    teamIdentifier,
    leafAuthority: authorities[0] ?? null,
    authorities,
    designatedRequirement: designatedRequirement(display.output),
    checks: { display, codesign, stapler, spctl },
  };
}
