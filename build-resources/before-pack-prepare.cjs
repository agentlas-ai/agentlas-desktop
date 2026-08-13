"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

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
