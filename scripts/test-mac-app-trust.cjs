#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  inspectMacInstalledAppTrust,
  repairMacInstalledAppGeneratedPythonCaches,
} = require("../dist/electron/updater/mac-app-trust.js");
const { updaterDiagnostic } = require("../dist/electron/updater/controller.js");

const policyPath = path.resolve(__dirname, "../build-resources/macos-release-signing-policy.json");
const bundlePath = "/Applications/Agentlas.app";
const officialMetadata = [
  "Executable=/Applications/Agentlas.app/Contents/MacOS/Agentlas",
  "Identifier=com.agentlas.desktop",
  "Authority=Developer ID Application: Jeongmin Kim (F469CGM7T5)",
  "Authority=Developer ID Certification Authority G2",
  "Authority=Apple Root CA - G3",
  "TeamIdentifier=F469CGM7T5",
  "designated => identifier \"com.agentlas.desktop\" and anchor apple generic",
].join("\n");

function runnerFor({ metadata = officialMetadata, seal = true, requirement = true, gatekeeper = true } = {}) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, [...args]]);
      if (command === "codesign" && args[0] === "-d") return { ok: true, output: metadata };
      if (command === "codesign") {
        const isRequirement = args.some((arg) => arg.startsWith("-R="));
        const ok = isRequirement ? seal && requirement : seal;
        const output = ok
          ? "valid"
          : !seal
            ? "a sealed resource is missing or invalid"
            : "sensitive requirement output";
        return { ok, output };
      }
      if (command === "spctl") return { ok: gatekeeper, output: gatekeeper ? "accepted" : "sensitive rejection output" };
      throw new Error(`unexpected command: ${command}`);
    },
  };
}

(async () => {
  const official = runnerFor();
  assert.deepEqual(await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: official.run }), { ok: true });
  assert.equal(official.calls.length, 3);
  const requirementCall = official.calls[1];
  assert.ok(requirementCall[1].some((arg) => arg.startsWith("-R=identifier \"com.agentlas.desktop\"")));
  assert.ok(requirementCall[1].some((arg) => arg.includes("1.2.840.113635.100.6.1.13")));
  assert.ok(requirementCall[1].some((arg) => arg.includes("F469CGM7T5")));

  const appleDistribution = runnerFor({
    metadata: officialMetadata.replace(
      "Developer ID Application: Jeongmin Kim (F469CGM7T5)",
      "Apple Distribution: AppBridge Inc. (F469CGM7T5)",
    ),
  });
  assert.deepEqual(
    await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: appleDistribution.run }),
    { ok: false, diagnostic: updaterDiagnostic("source-signature-class") },
  );
  assert.equal(appleDistribution.calls.length, 1);

  const wrongDeveloperSameTeam = runnerFor({
    metadata: officialMetadata.replace(
      "Developer ID Application: Jeongmin Kim (F469CGM7T5)",
      "Developer ID Application: Someone Else (F469CGM7T5)",
    ),
  });
  assert.deepEqual(
    await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: wrongDeveloperSameTeam.run }),
    { ok: false, diagnostic: updaterDiagnostic("source-signature-class") },
  );

  const wrongTeam = runnerFor({ metadata: officialMetadata.replaceAll("F469CGM7T5", "AAAAAAAAAA") });
  assert.deepEqual(
    await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: wrongTeam.run }),
    { ok: false, diagnostic: updaterDiagnostic("source-identity") },
  );

  const sealFailure = runnerFor({ seal: false });
  assert.deepEqual(
    await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: sealFailure.run }),
    { ok: false, diagnostic: updaterDiagnostic("source-seal") },
  );
  assert.equal(sealFailure.calls.length, 2);

  const requirementFailure = runnerFor({ requirement: false });
  assert.deepEqual(
    await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: requirementFailure.run }),
    { ok: false, diagnostic: updaterDiagnostic("source-designated-requirement") },
  );

  const gatekeeperFailure = runnerFor({ gatekeeper: false });
  const rejected = await inspectMacInstalledAppTrust({ bundlePath, policyPath, runCommand: gatekeeperFailure.run });
  assert.deepEqual(rejected, { ok: false, diagnostic: updaterDiagnostic("source-gatekeeper") });
  assert.doesNotMatch(JSON.stringify(rejected), /sensitive rejection output/);

  assert.deepEqual(
    await inspectMacInstalledAppTrust({
      bundlePath,
      policyPath: `${policyPath}.missing`,
      runCommand: async () => { throw new Error("must not run"); },
    }),
    { ok: false, diagnostic: updaterDiagnostic("source-verification-unavailable") },
  );

  const repairFixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mac-cache-repair-"));
  try {
    const repairApp = path.join(repairFixture, "Agentlas.app");
    const hephaestusCache = path.join(repairApp, "Contents", "Resources", "Hephaestus", "agentlas_cloud", "__pycache__");
    const pythonCache = path.join(repairApp, "Contents", "Resources", "python-runtime", "lib", "python3.12", "__pycache__");
    const outside = path.join(repairFixture, "outside");
    fs.mkdirSync(hephaestusCache, { recursive: true });
    fs.mkdirSync(pythonCache, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const codeResources = path.join(repairApp, "Contents", "_CodeSignature", "CodeResources");
    fs.mkdirSync(path.dirname(codeResources), { recursive: true });
    fs.writeFileSync(codeResources, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>files2</key><dict></dict></dict></plist>`);
    fs.writeFileSync(path.join(hephaestusCache, "module.cpython-312.pyc"), "generated");
    fs.writeFileSync(path.join(pythonCache, "stdlib.cpython-312.pyc"), "generated");
    fs.writeFileSync(path.join(repairApp, "Contents", "Resources", "Hephaestus", "agentlas_cloud", "module.py"), "# signed source\n");
    fs.writeFileSync(path.join(outside, "must-stay.pyc"), "outside");
    fs.symlinkSync(outside, path.join(repairApp, "Contents", "Resources", "Hephaestus", "linked-cache"));
    assert.equal(await repairMacInstalledAppGeneratedPythonCaches({
      bundlePath: repairApp,
      diagnostic: updaterDiagnostic("source-identity"),
    }), false, "identity failures must never mutate the bundle");
    assert.equal(await repairMacInstalledAppGeneratedPythonCaches({
      bundlePath: repairApp,
      diagnostic: updaterDiagnostic("source-seal"),
    }), true, "a source-seal failure should remove generated Python bytecode");
    assert.equal(fs.existsSync(path.join(hephaestusCache, "module.cpython-312.pyc")), false);
    assert.equal(fs.existsSync(path.join(pythonCache, "stdlib.cpython-312.pyc")), false);
    assert.equal(fs.existsSync(path.join(repairApp, "Contents", "Resources", "Hephaestus", "agentlas_cloud", "module.py")), true);
    assert.equal(fs.existsSync(path.join(outside, "must-stay.pyc")), true, "repair must never follow symlinks outside Resources");

    const sealedCache = path.join(repairApp, "Contents", "Resources", "Hephaestus", "sealed", "__pycache__");
    const unsealedCache = path.join(repairApp, "Contents", "Resources", "Hephaestus", "unsealed", "__pycache__");
    fs.mkdirSync(sealedCache, { recursive: true });
    fs.mkdirSync(unsealedCache, { recursive: true });
    const sealedBytecode = path.join(sealedCache, "sealed.cpython-312.pyc");
    const unsealedBytecode = path.join(unsealedCache, "generated.cpython-312.pyc");
    fs.writeFileSync(sealedBytecode, "signed");
    fs.writeFileSync(unsealedBytecode, "generated");
    fs.writeFileSync(codeResources, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>files2</key><dict><key>Resources/Hephaestus/sealed/__pycache__/sealed.cpython-312.pyc</key><dict/></dict></dict></plist>`);
    assert.equal(await repairMacInstalledAppGeneratedPythonCaches({
      bundlePath: repairApp,
      diagnostic: updaterDiagnostic("source-seal"),
    }), false, "a signed Python cache candidate must fail the entire repair closed");
    assert.equal(fs.existsSync(sealedBytecode), true);
    assert.equal(fs.existsSync(unsealedBytecode), true, "a sealed candidate must prevent partial deletion");
    fs.rmSync(path.dirname(sealedCache), { recursive: true, force: true });
    fs.rmSync(path.dirname(unsealedCache), { recursive: true, force: true });
    fs.writeFileSync(codeResources, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>files2</key><dict></dict></dict></plist>`);

    const linkedApp = path.join(repairFixture, "Linked.app");
    const linkedResources = path.join(repairFixture, "linked-resources");
    const linkedCache = path.join(linkedResources, "Hephaestus", "__pycache__");
    fs.mkdirSync(path.join(linkedApp, "Contents"), { recursive: true });
    fs.mkdirSync(linkedCache, { recursive: true });
    const linkedBytecode = path.join(linkedCache, "outside.cpython-312.pyc");
    fs.writeFileSync(linkedBytecode, "outside");
    fs.symlinkSync(linkedResources, path.join(linkedApp, "Contents", "Resources"));
    assert.equal(await repairMacInstalledAppGeneratedPythonCaches({
      bundlePath: linkedApp,
      diagnostic: updaterDiagnostic("source-seal"),
    }), false, "a symlinked Resources root must fail closed");
    assert.equal(fs.existsSync(linkedBytecode), true, "a symlinked Resources root must never be mutated");

    const hardlinkCache = path.join(repairApp, "Contents", "Resources", "Hephaestus", "hardlink", "__pycache__");
    fs.mkdirSync(hardlinkCache, { recursive: true });
    const hardlinkBytecode = path.join(hardlinkCache, "linked.cpython-312.pyc");
    const hardlinkTwin = path.join(repairFixture, "hardlink-twin.pyc");
    fs.writeFileSync(hardlinkBytecode, "linked");
    fs.linkSync(hardlinkBytecode, hardlinkTwin);
    assert.equal(await repairMacInstalledAppGeneratedPythonCaches({
      bundlePath: repairApp,
      diagnostic: updaterDiagnostic("source-seal"),
    }), false, "hard-linked bytecode must not be removed");
    assert.equal(fs.existsSync(hardlinkBytecode), true);
    assert.equal(fs.existsSync(hardlinkTwin), true);
  } finally {
    fs.rmSync(repairFixture, { recursive: true, force: true });
  }

  const { inspectPackagedMacSigningPolicy, verifyMacAppBundle } = await import("./lib/mac-app-signature.mjs");
  const policyFixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mac-policy-"));
  try {
    const appPath = path.join(policyFixture, "Agentlas.app");
    const packagedPolicyPath = path.join(appPath, "Contents", "Resources", "macos-release-signing-policy.json");
    fs.mkdirSync(path.dirname(packagedPolicyPath), { recursive: true });
    fs.copyFileSync(policyPath, packagedPolicyPath);
    const matchingPolicy = inspectPackagedMacSigningPolicy({ appPath, policyPath });
    assert.equal(matchingPolicy.ok, true, "a regular byte-identical packaged policy must be accepted");
    assert.equal(matchingPolicy.present, true);
    assert.equal(matchingPolicy.matchesSource, true);
    assert.match(matchingPolicy.sha256, /^[a-f0-9]{64}$/);

    fs.rmSync(packagedPolicyPath);
    assert.deepEqual(
      inspectPackagedMacSigningPolicy({ appPath, policyPath }),
      { ok: false, present: false, matchesSource: false, sha256: null },
      "a missing packaged policy must fail closed",
    );

    fs.writeFileSync(packagedPolicyPath, `${fs.readFileSync(policyPath, "utf8")}\nmutated`);
    const alteredPolicy = inspectPackagedMacSigningPolicy({ appPath, policyPath });
    assert.equal(alteredPolicy.ok, false, "a byte-altered packaged policy must fail closed");
    assert.equal(alteredPolicy.present, true);
    assert.equal(alteredPolicy.matchesSource, false);

    fs.rmSync(packagedPolicyPath);
    fs.symlinkSync(policyPath, packagedPolicyPath);
    const symlinkedPolicy = inspectPackagedMacSigningPolicy({ appPath, policyPath });
    assert.deepEqual(
      symlinkedPolicy,
      { ok: false, present: true, matchesSource: false, sha256: null },
      "a symlinked packaged policy must fail closed",
    );

    fs.rmSync(path.join(appPath, "Contents"), { recursive: true, force: true });
    const linkedResources = path.join(policyFixture, "linked-resources");
    fs.mkdirSync(linkedResources, { recursive: true });
    fs.copyFileSync(policyPath, path.join(linkedResources, "macos-release-signing-policy.json"));
    fs.mkdirSync(path.join(appPath, "Contents"), { recursive: true });
    fs.symlinkSync(linkedResources, path.join(appPath, "Contents", "Resources"));
    assert.deepEqual(
      inspectPackagedMacSigningPolicy({ appPath, policyPath }),
      { ok: false, present: false, matchesSource: false, sha256: null },
      "a symlinked Resources directory must fail closed before reading the policy leaf",
    );
  } finally {
    fs.rmSync(policyFixture, { recursive: true, force: true });
  }
  const releaseCommands = [];
  const verifiedReleaseApp = verifyMacAppBundle({
    appPath: bundlePath,
    policyPath,
    runCommand: (command, args) => {
      releaseCommands.push([command, [...args]]);
      if (command === "codesign" && args[0] === "-d") return { ok: true, status: 0, output: officialMetadata };
      return { ok: true, status: 0, output: "accepted" };
    },
  });
  assert.equal(verifiedReleaseApp.ok, true);
  assert.equal(verifiedReleaseApp.developerId, true);
  assert.equal(verifiedReleaseApp.notarized, true);
  assert.equal(verifiedReleaseApp.stapledNotarization, true);
  assert.deepEqual(releaseCommands.map(([command]) => command), ["codesign", "codesign", "xcrun", "spctl"]);

  const missingTicketCommands = [];
  const missingTicket = verifyMacAppBundle({
    appPath: bundlePath,
    policyPath,
    runCommand: (command, args) => {
      missingTicketCommands.push([command, [...args]]);
      if (command === "codesign" && args[0] === "-d") return { ok: true, status: 0, output: officialMetadata };
      if (command === "xcrun") return { ok: false, status: 1, output: "private local path" };
      return { ok: true, status: 0, output: "accepted\nsource=Notarized Developer ID" };
    },
  });
  assert.equal(missingTicket.ok, false);
  assert.equal(missingTicket.category, "notarization-rejected");
  assert.equal(missingTicket.notarized, true);
  assert.equal(missingTicket.stapledNotarization, false);
  assert.equal(missingTicketCommands.some(([command]) => command === "spctl"), true);

  const historicalOfficial = verifyMacAppBundle({
    appPath: bundlePath,
    policyPath,
    requireStapledNotarization: false,
    runCommand: (command, args) => {
      if (command === "codesign" && args[0] === "-d") return { ok: true, status: 0, output: officialMetadata };
      if (command === "xcrun") return { ok: false, status: 1, output: "no separate app ticket" };
      if (command === "spctl") return { ok: true, status: 0, output: "accepted\nsource=Notarized Developer ID" };
      return { ok: true, status: 0, output: "accepted" };
    },
  });
  assert.equal(historicalOfficial.ok, true);
  assert.equal(historicalOfficial.notarized, true);
  assert.equal(historicalOfficial.stapledNotarization, false);

  const unsignedReleaseCommands = [];
  const unsignedReleaseApp = verifyMacAppBundle({
    appPath: bundlePath,
    policyPath,
    runCommand: (command, args) => {
      unsignedReleaseCommands.push([command, [...args]]);
      return { ok: false, status: 1, output: "code object is not signed at all" };
    },
  });
  assert.equal(unsignedReleaseApp.ok, false);
  assert.equal(unsignedReleaseApp.category, "not-developer-id");
  assert.equal(unsignedReleaseCommands.length, 1);

  console.log("test-mac-app-trust: PASS (pinned Developer ID, notarization, Gatekeeper, redaction)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
