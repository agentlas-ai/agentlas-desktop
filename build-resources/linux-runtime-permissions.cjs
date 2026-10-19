"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const digest = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");

/** Public unpacked dependencies become root-owned in a .deb. A private build
 * umask must not make their JS or native addons unreadable to the app user.
 * Keep plugin/source manifests and other signed runtime trees untouched. */
async function prepareLinuxRuntimePermissions(context) {
  if (context.electronPlatformName !== "linux") return { skipped: true, reason: "non-linux" };
  const appOut = path.resolve(context.appOutDir), appInfo = await fs.lstat(appOut);
  // A build root must name its real directory, including its ancestors.
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink() || await fs.realpath(appOut) !== appOut) {
    throw new Error("[afterPack] Linux output directory must be canonical");
  }
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new Error("[afterPack] Linux runtime no-follow file handles are unavailable");
  }
  const resources = path.join(appOut, "resources"), resourceInfo = await fs.lstat(resources);
  if (!resourceInfo.isDirectory() || resourceInfo.isSymbolicLink() || await fs.realpath(resources) !== resources) {
    throw new Error("[afterPack] Linux resource directory is invalid");
  }
  const root = path.join(resources, "app.asar.unpacked", "node_modules");
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new Error("[afterPack] Linux unpacked dependency root is invalid");
  }
  const entries = [];
  async function walk(file) {
    const stat = await fs.lstat(file), relative = path.relative(root, file);
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(file);
      if (path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(file), link)) || !inside(root, await fs.realpath(file))) {
        throw new Error(`[afterPack] Linux dependency link escapes its runtime: ${relative}`);
      }
      entries.push({ file, relative, kind: "link", link });
    } else if (stat.isDirectory()) {
      entries.push({ file, relative, kind: "directory", dev: stat.dev, ino: stat.ino, mode: 0o755 });
      for (const name of (await fs.readdir(file)).sort()) await walk(path.join(file, name));
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error(`[afterPack] Linux dependency must not share a writable inode: ${relative}`);
      entries.push({ file, relative, kind: "file", dev: stat.dev, ino: stat.ino, size: stat.size,
        mode: (stat.mode & 0o111) !== 0 ? 0o755 : 0o644, sha256: await digest(file) });
    } else {
      throw new Error(`[afterPack] Linux dependency entry is not a regular runtime file: ${relative}`);
    }
  }
  // Validate the whole tree before changing anything, including link targets.
  await walk(root);
  for (const entry of entries) {
    if (entry.kind === "link") continue;
    const current = await fs.lstat(entry.file);
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino || entry.kind === "file" && current.nlink !== 1
      || !inside(root, await fs.realpath(entry.file))) {
      throw new Error(`[afterPack] Linux dependency changed during permission preparation: ${entry.relative}`);
    }
    // A replacement after the path checks must never redirect chmod to a
    // symlink target. Check the opened inode, then operate on that handle.
    const handle = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== entry.dev || opened.ino !== entry.ino
        || (entry.kind === "directory" ? !opened.isDirectory() : !opened.isFile() || opened.nlink !== 1)
        || !inside(root, await fs.realpath(entry.file))) {
        throw new Error(`[afterPack] Linux dependency handle changed: ${entry.relative}`);
      }
      await handle.chmod(entry.mode);
    } finally {
      await handle.close();
    }
  }
  for (const entry of entries) {
    const current = await fs.lstat(entry.file);
    if (entry.kind === "link") {
      if (!current.isSymbolicLink() || await fs.readlink(entry.file) !== entry.link || !inside(root, await fs.realpath(entry.file))) {
        throw new Error(`[afterPack] Linux dependency link changed: ${entry.relative}`);
      }
    } else if ((current.mode & 0o7777) !== entry.mode || current.dev !== entry.dev || current.ino !== entry.ino
      || entry.kind === "file" && (current.nlink !== 1 || current.size !== entry.size || await digest(entry.file) !== entry.sha256)) {
      throw new Error(`[afterPack] Linux dependency bytes or permissions changed: ${entry.relative}`);
    }
  }
  return { skipped: false, directories: entries.filter(e => e.kind === "directory").length,
    files: entries.filter(e => e.kind === "file").length, links: entries.filter(e => e.kind === "link").length,
    codeBytesUnchanged: true, groupAndOtherWrites: false };
}

module.exports = { prepareLinuxRuntimePermissions };
