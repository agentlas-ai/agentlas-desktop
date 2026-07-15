#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const identity = require(path.join(root, "dist/electron/install-identity.js"));

const official = identity.OFFICIAL_BUILD_INSTALL_IDENTITY;
const candidate = identity.LOCAL_CANDIDATE_BUILD_INSTALL_IDENTITY;

assert.deepEqual(
  identity.resolveInstallIdentity({
    packaged: true,
    packageMetadata: { agentlasInstallIdentity: official },
  }),
  identity.OFFICIAL_INSTALL_IDENTITY,
  "official packaged metadata must retain the existing install namespaces",
);

const local = identity.resolveInstallIdentity({
  packaged: true,
  packageMetadata: { agentlasInstallIdentity: candidate },
});
assert.deepEqual(local, {
  channel: "local-candidate",
  appName: "Agentlas-Local-Candidate",
  userDataNamespace: "Agentlas-Local-Candidate",
  keychainService: "com.agentlas.desktop.candidate",
  updatesEnabled: false,
  userDataOverride: null,
});

assert.throws(
  () => identity.resolveInstallIdentity({
    packaged: true,
    packageMetadata: {
      agentlasInstallIdentity: { ...candidate, keychainService: "com.agentlas.desktop" },
    },
  }),
  /local candidate marker is invalid/,
  "a malformed local marker must fail closed instead of sharing official Keychain state",
);
assert.throws(
  () => identity.resolveInstallIdentity({
    packaged: true,
    packageMetadata: { agentlasInstallIdentity: official },
    qaUserDataDir: "/tmp/attempted-qa-override",
  }),
  /QA userData override is forbidden/,
  "a mutable QA environment override must not change a packaged identity",
);
assert.throws(
  () => identity.resolveInstallIdentity({ packaged: true, packageMetadata: {} }),
  /packaged marker is unknown or incomplete/,
  "an unmarked packaged app must not receive any install identity",
);

assert.deepEqual(
  identity.resolveInstallIdentity({
    packaged: false,
    qaUserDataDir: "/tmp/agentlas-qa-isolated",
    allowQaOverride: true,
  }),
  {
    channel: "qa",
    appName: "Agentlas-QA",
    userDataNamespace: "Agentlas-QA",
    keychainService: "com.agentlas.desktop.qa",
    updatesEnabled: false,
    userDataOverride: "/tmp/agentlas-qa-isolated",
  },
  "unpackaged QA must keep an isolated app and Keychain namespace",
);
assert.throws(
  () => identity.resolveInstallIdentity({
    packaged: false,
    qaUserDataDir: "/tmp/not-authorized",
    allowQaOverride: false,
  }),
  /allowed only for an unpackaged run/,
);

const expectedOfficialMarker = { ...official };
for (const configName of ["electron-builder.yml", "electron-builder.mac-stable.yml"]) {
  const config = yaml.load(fs.readFileSync(path.join(root, configName), "utf8"));
  assert.deepEqual(
    config.extraMetadata?.agentlasInstallIdentity,
    expectedOfficialMarker,
    `${configName} must inject the exact immutable official marker`,
  );
}
const localConfig = yaml.load(fs.readFileSync(path.join(root, "electron-builder.mac-local.yml"), "utf8"));
assert.deepEqual(
  localConfig.extraMetadata?.agentlasInstallIdentity,
  { ...candidate },
  "local config must inject only the isolated candidate marker",
);
assert.equal(localConfig.publish, null, "local config must not create an update feed");
assert.equal(
  localConfig.mac?.extraResources,
  null,
  "local config must clear the inherited official macOS updater trust policy",
);

const source = fs.readFileSync(path.join(root, "electron/install-identity.ts"), "utf8");
assert.doesNotMatch(source, /from\s+["']electron["']/);
assert.doesNotMatch(source, /node:(?:fs|path)/);

async function verifyVaultUsesResolvedIdentity() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const services = [];
  Module._load = function loadKeytar(request, parent, isMain) {
    if (request === "keytar") {
      return {
        getPassword: async (service) => {
          services.push(service);
          return null;
        },
        setPassword: async (service) => { services.push(service); },
        deletePassword: async (service) => { services.push(service); },
        findCredentials: async (service) => {
          services.push(service);
          return [];
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let vault;
  try {
    vault = require(path.join(root, "dist/electron/secrets/vault.js"));
  } finally {
    Module._load = originalLoad;
  }

  identity.configureInstallIdentity(local);
  await vault.setEnvVar("AGENTLAS_INSTALL_IDENTITY_TEST", "candidate-only-value");
  assert.deepEqual(
    services,
    ["com.agentlas.desktop.candidate"],
    "candidate secrets must use the isolated Keychain service",
  );

  const qa = identity.resolveInstallIdentity({
    packaged: false,
    qaUserDataDir: "/tmp/agentlas-qa-keychain",
    allowQaOverride: true,
  });
  assert.equal(qa.keychainService, "com.agentlas.desktop.qa");
  assert.throws(
    () => identity.configureInstallIdentity(qa),
    /identity cannot be reconfigured after startup/,
    "a process must not switch protected-storage namespaces after startup",
  );
}

verifyVaultUsesResolvedIdentity()
  .then(() => {
    console.log("test-install-identity: PASS (immutable package marker, isolated QA/candidate namespaces)");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
