"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");
const { prepareScienceNativeDependencies } = require("./science-native-dependencies.cjs");
const {
  materializeProductExtensionSigningPolicy,
} = require("./product-extension-signing-policy.cjs");

function verifyPublicPackageMetadata(projectDir) {
  const packagePath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const serialized = JSON.stringify(pkg);
  const authorEmail = pkg.author && typeof pkg.author === "object" ? pkg.author.email : "";
  if (
    pkg.repository
    || pkg.bugs
    || authorEmail
    || serialized.includes("github.com/agentlas-ai/agentlas-desktop")
    || serialized.includes("/Users/")
  ) {
    throw new Error(
      "[beforePack] package.json contains source-repository or private-host metadata that must not enter app.asar",
    );
  }
}

/**
 * electron-builder can be invoked directly, outside the npm dist wrappers.
 * Always prepare and byte-verify the pinned Core checkout before extraResources
 * snapshots it into a package.
 */
module.exports = async function beforePackPrepare(context) {
  const projectDir = context.packager.projectDir;
  verifyPublicPackageMetadata(projectDir);
  const scienceNative = await prepareScienceNativeDependencies(projectDir, context.electronPlatformName, Arch[context.arch]);
  console.log(`[beforePack] prepared Science native dependencies ${JSON.stringify(scienceNative)}`);
  const signingPolicy = materializeProductExtensionSigningPolicy(projectDir);
  console.log(
    `[beforePack] prepared product-extension signing policy ${signingPolicy.sha256} `
      + `(${signingPolicy.keyIds.length} trusted key id(s))`,
  );
  execFileSync(process.execPath, [path.join(projectDir, "scripts", "ensure-engine.mjs")], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(projectDir, "scripts", "prepare-embedded-core.mjs")], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
};

module.exports.verifyPublicPackageMetadata = verifyPublicPackageMetadata;
