"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * electron-builder can be invoked directly, outside the npm dist wrappers.
 * Always prepare and byte-verify the pinned Core checkout before extraResources
 * snapshots it into a package.
 */
module.exports = async function beforePackPrepare(context) {
  const projectDir = context.packager.projectDir;
  execFileSync(process.execPath, [path.join(projectDir, "scripts", "ensure-engine.mjs")], {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
};
