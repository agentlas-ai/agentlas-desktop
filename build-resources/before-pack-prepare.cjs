"use strict";

const { execFileSync } = require("node:child_process");
const { lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } = require("node:fs");
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

// Keep generated Electron JavaScript maps available for local debugging until
// packaging. Remove them after preparation, before ASAR records its header.
function removeGeneratedElectronSourceMaps(context) {
  const projectDir = context.packager.projectDir;
  const appDir = context.packager.info.appDir;
  if (!path.isAbsolute(appDir) || path.resolve(appDir) !== appDir
    || appDir !== projectDir || realpathSync.native(appDir) !== appDir) {
    throw new Error("[beforePack] appDir must be the canonical project directory");
  }
  const root = path.join(appDir, "dist", "electron");
  for (const directory of [path.join(appDir, "dist"), root]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(directory) !== directory) {
      throw new Error("[beforePack] generated Electron dist root is unsafe");
    }
  }
  const maps = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("[beforePack] generated Electron dist contains a symlink");
      if (stat.isDirectory()) {
        if (realpathSync.native(file) !== file) throw new Error("[beforePack] generated Electron dist contains an unsafe directory");
        visit(file);
      } else if (entry.name.endsWith(".js.map")) {
        if (!stat.isFile()) throw new Error("[beforePack] generated Electron map is not a regular file");
        maps.push(file);
      }
    }
  }
  visit(root);
  for (const file of maps) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync.native(file) !== file) {
      throw new Error("[beforePack] generated Electron map changed before removal");
    }
    unlinkSync(file);
  }
  return maps.length;
}

// Run before ASAR header sizes/integrity are captured, and only on the build
// dependency copy. Removing debug symbols leaves native exported ABI intact.
function stripNodePtyDebug(projectDir, platform) {
  if (platform !== "darwin") return;
  const root = path.join(projectDir, "node_modules", "node-pty");
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (entry.name.endsWith(".node") || entry.name === "spawn-helper")) {
        const magic = readFileSync(file).subarray(0, 4).toString("hex");
        if (["cffaedfe", "cefaedfe", "cafebabe", "bebafeca", "cafebabf"].includes(magic)) {
          execFileSync("/usr/bin/strip", ["-S", file]);
        }
      }
    }
  }
  visit(root);
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
  console.log(`[beforePack] removed ${removeGeneratedElectronSourceMaps(context)} generated Electron JS source maps before ASAR`);
};

module.exports.verifyPublicPackageMetadata = verifyPublicPackageMetadata;

module.exports.removeGeneratedElectronSourceMaps = removeGeneratedElectronSourceMaps;

module.exports.stripNodePtyDebug = stripNodePtyDebug;
