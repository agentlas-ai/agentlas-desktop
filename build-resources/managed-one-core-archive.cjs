"use strict";

// This input is available only to the Managed One image preparation path.
// It accepts the exact release archive pinned by the Desktop package, never a
// generic tarball or a mutable URL. The caller owns the private output root.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tar = require("tar");

const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_PATH_BYTES = 4096;

function releasePin(pkg) {
  const source = pkg.agentlasBundledRuntimeSource || {};
  const version = pkg.agentlasUpdateCompatibility?.bundledRuntimeVersion;
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)
      || source.repository !== "https://github.com/agentlas-ai/Agentlas-OS.git"
      || source.ref !== `v${version}`
      || source.assetName !== `hephaestus-runtime-v${version}.tar.gz`
      || !/^[a-f0-9]{64}$/.test(source.assetSha256 || "")
      || !/^[a-f0-9]{40}$/.test(source.commit || "")) {
    throw new Error("managed_one_archive_pin_invalid");
  }
  return { version, commit: source.commit, assetName: source.assetName, sha256: source.assetSha256,
    rootName: `Agentlas-OS-${version}` };
}

function sha256File(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, bytes));
    return digest.digest("hex");
  } finally { fs.closeSync(fd); }
}

function checkedEntry(rawPath, type, size, mode, expectedRoot) {
  if (typeof rawPath !== "string" || !rawPath || Buffer.byteLength(rawPath) > MAX_PATH_BYTES
      || rawPath.includes("\\") || rawPath.includes("\0") || rawPath.startsWith("/")) {
    throw new Error("managed_one_archive_path_invalid");
  }
  if (type !== "File" && type !== "Directory") throw new Error("managed_one_archive_entry_type_invalid");
  const name = type === "Directory" ? rawPath.replace(/\/$/, "") : rawPath;
  const parts = name.split("/");
  if (parts[0] !== expectedRoot || parts.some(part => !part || part === "." || part === ".."
      || /[\x00-\x1f\x7f:]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error("managed_one_archive_path_invalid");
  }
  if (!Number.isSafeInteger(mode) || mode < 0 || (mode & ~0o777) !== 0) throw new Error("managed_one_archive_mode_invalid");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES
      || (type === "Directory" && size !== 0)) throw new Error("managed_one_archive_size_invalid");
  return parts.join("/");
}

function inspectArchive(archive, expectedRoot) {
  const seen = new Map();
  let count = 0, total = 0;
  tar.t({ file: archive, sync: true, strict: true, preservePaths: true, maxMetaEntrySize: 1024 * 1024,
    onReadEntry(entry) {
      if (++count > MAX_ENTRIES) throw new Error("managed_one_archive_entry_limit");
      const name = checkedEntry(entry.path, entry.type, entry.size, entry.mode, expectedRoot);
      const canonical = name.normalize("NFC").toLowerCase();
      if (seen.has(canonical)) throw new Error("managed_one_archive_duplicate_path");
      seen.set(canonical, entry.type);
      total += entry.size;
      if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("managed_one_archive_size_limit");
    },
  });
  if (!count || seen.get(expectedRoot.toLowerCase()) !== "Directory") throw new Error("managed_one_archive_root_missing");
  for (const [name] of seen) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (seen.get(parts.join("/")) === "File") throw new Error("managed_one_archive_parent_is_file");
    }
  }
  return { entries: count, uncompressedBytes: total };
}

function validateExtractedIdentity(root, pin) {
  const readJson = (relative, max) => {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("managed_one_archive_identity_invalid");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const manifest = readJson("manifest.json", 1024 * 1024);
  const provenance = readJson("release-provenance.json", 64 * 1024);
  if (manifest.version !== pin.version || provenance.schemaVersion !== "agentlas.release-provenance.v1"
      || provenance.commit !== pin.commit) throw new Error("managed_one_archive_identity_mismatch");
}

function copyPinnedReleaseArchive({ archivePath, privateRoot, destination, pkg }) {
  const pin = releasePin(pkg);
  if (!path.isAbsolute(archivePath) || path.basename(archivePath) !== pin.assetName) throw new Error("managed_one_archive_path_invalid");
  const privateStat = fs.lstatSync(privateRoot), privateReal = fs.realpathSync(privateRoot);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()
      || (process.platform !== "win32" && ((privateStat.mode & 0o077) !== 0 || privateStat.uid !== process.getuid?.()))
      || fs.realpathSync(path.dirname(destination)) !== privateReal
      || path.basename(destination) === "." || path.basename(destination) === "..") {
    throw new Error("managed_one_archive_private_root_invalid");
  }
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMPRESSED_BYTES) throw new Error("managed_one_archive_input_invalid");
  const copy = path.join(privateRoot, "verified-release.tar.gz");
  let copied = false, createdDestination = false;
  try {
    fs.copyFileSync(archivePath, copy, fs.constants.COPYFILE_EXCL);
    copied = true;
    fs.chmodSync(copy, 0o600);
    if (sha256File(copy) !== pin.sha256) throw new Error("managed_one_archive_digest_mismatch");
    const inspection = inspectArchive(copy, pin.rootName);
    fs.mkdirSync(destination, { mode: 0o700 });
    createdDestination = true;
    tar.x({ file: copy, cwd: destination, sync: true, strict: true, strip: 1,
      preservePaths: false, noChmod: true, noMtime: true, noChown: true });
    validateExtractedIdentity(destination, pin);
    return { sourceKind: "managed-one-release-archive", sourceAssetSha256: pin.sha256, ...inspection };
  } catch (error) {
    if (createdDestination) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (fs.existsSync(destination)) throw new Error("managed_one_archive_destination_cleanup_failed");
    }
    throw error;
  } finally {
    // This path was created exclusively inside our private, unique temp root.
    if (copied) {
      try { fs.unlinkSync(copy); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

module.exports = { copyPinnedReleaseArchive, inspectArchive, releasePin, validateExtractedIdentity };
