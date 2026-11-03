#!/usr/bin/env node
"use strict";

// Project the verified embedded Core into the exact runtime subset used by
// desktop packaging. This build helper never modifies the prepared source.
const fs = require("node:fs");
const path = require("node:path");
const contract = require("../build-resources/embedded-core-contract.cjs");

function fail(code) { throw new Error(code); }
function nested(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function sensitive(value) {
  return value.toLowerCase().split(/[\\/]+/).some(part => [".git", ".agentlas", ".codex", ".memory.local", "credentials", "signing"].includes(part));
}
function project(sourceArg, destinationArg) {
  if (!sourceArg || !destinationArg) fail("managed_core_paths_required");
  const source = path.resolve(sourceArg), destination = path.resolve(destinationArg);
  if (nested(source, destination) || nested(destination, source)) fail("managed_core_paths_overlap");
  // The helper is solely for sibling build outputs, never an arbitrary user path.
  if (path.basename(source) !== "Hephaestus" || path.basename(destination) !== "Hephaestus-package" || path.dirname(source) !== path.dirname(destination)) fail("managed_core_paths_invalid");
  if (sensitive(source) || sensitive(destination)) fail("managed_core_sensitive_path");
  const parent = path.dirname(source);
  if (fs.realpathSync(parent) !== parent || fs.realpathSync(source) !== source) fail("managed_core_symlink_path");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) fail("managed_core_source_invalid");
  try { fs.lstatSync(destination); fail("managed_core_destination_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  function walk(directory, relative, onFile) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const from = path.join(directory, entry.name), stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) fail("managed_core_symlink_rejected");
      if (stat.isDirectory()) walk(from, rel, onFile);
      else if (stat.isFile()) onFile(from, rel, stat);
      else fail("managed_core_entry_invalid");
    }
  }

  // Validate the entire source, including intentionally omitted paths, before
  // opening the output. A source receipt alone also permits symlink entries.
  walk(source, "", () => {});
  const pkg = require("../package.json");
  const receipt = contract.verifyReceipt(source, pkg);
  // The verified staging directory can be 0700 because its parent is private.
  // The projected Core contains only the packaged runtime subset and must be
  // traversable by the unprivileged container user after Docker copies it.
  fs.mkdirSync(destination, { mode: 0o755 });
  fs.chmodSync(destination, 0o755);
  walk(source, "", (from, relative, stat) => {
    if (contract.packageOmissionReason(relative)) return;
    const target = path.join(destination, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, stat.mode & 0o777);
  });
  // Fail the build on source drift, a forbidden file, changed bytes, missing
  // capabilities, or any checksum/mode mismatch in the packaged subset.
  contract.verifyReceipt(source, pkg);
  contract.verifyPackagedSubset(destination, source);
  if (contract.treeSha256(destination) !== receipt.packageProjection.includedTreeSha256) fail("managed_core_projection_checksum_mismatch");
  return { includedFileCount: receipt.packageProjection.includedFileCount, sha256: receipt.packageProjection.includedTreeSha256 };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) fail("managed_core_paths_required");
    const result = project(process.argv[2], process.argv[3]);
    console.log(`managed-one embedded Core projection: ${result.includedFileCount} files verified`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "managed_core_projection_failed");
    process.exitCode = 1;
  }
}
module.exports = { project };
