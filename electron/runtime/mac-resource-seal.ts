import fs from "node:fs";
import path from "node:path";
import {
  inspectMacInstalledAppTrust,
  repairMacInstalledAppGeneratedPythonCaches,
} from "../updater/mac-app-trust";

const SEALED_RUNTIME_NAMES = ["Hephaestus", "python-runtime"] as const;

export type MacRuntimeSealResult = {
  directories: number;
  files: number;
  changedEntries: number;
  alreadySealed: boolean;
  repairedGeneratedCaches: boolean;
};

export type MacRuntimeSealInput = {
  bundlePath: string;
  resourcesPath: string;
  policyPath: string;
};

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canCurrentProcessWrite(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isEffectivelyWritable(target: string, mode: number): boolean {
  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return runningAsRoot ? (mode & 0o222) !== 0 : canCurrentProcessWrite(target);
}

type SealTarget = {
  absolute: string;
  dev: number;
  ino: number;
};

function sealEntry(
  target: SealTarget,
  mode: number,
  label: string,
  kind: "directory" | "file",
): boolean {
  const beforePath = fs.lstatSync(target.absolute);
  if (
    beforePath.isSymbolicLink()
    || (kind === "directory" ? !beforePath.isDirectory() : !beforePath.isFile())
    || beforePath.dev !== target.dev
    || beforePath.ino !== target.ino
    || (kind === "file" && beforePath.nlink !== 1)
  ) {
    throw new Error(`Packaged runtime ${label} changed before sealing`);
  }
  const flags = fs.constants.O_RDONLY
    | fs.constants.O_NOFOLLOW
    | (kind === "directory" ? fs.constants.O_DIRECTORY : 0);
  const fd = fs.openSync(target.absolute, flags);
  try {
    const before = fs.fstatSync(fd);
    if (
      (kind === "directory" ? !before.isDirectory() : !before.isFile())
      || before.dev !== target.dev
      || before.ino !== target.ino
      || (kind === "file" && before.nlink !== 1)
    ) {
      throw new Error(`Packaged runtime ${label} changed while opening for sealing`);
    }
    if ((before.mode & 0o777) !== mode || isEffectivelyWritable(target.absolute, before.mode)) {
      try {
        // Mutate the verified inode, never a path that could have become a
        // symlink between inspection and chmod.
        fs.fchmodSync(fd, mode);
      } catch (error) {
        // A root-owned /Applications install can already be immutable to the
        // desktop user even when that user cannot normalize its owner bits.
        if (canCurrentProcessWrite(target.absolute)) throw error;
      }
    }
    const after = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(target.absolute);
    if (
      after.dev !== target.dev
      || after.ino !== target.ino
      || afterPath.isSymbolicLink()
      || (kind === "directory" ? !afterPath.isDirectory() : !afterPath.isFile())
      || afterPath.dev !== target.dev
      || afterPath.ino !== target.ino
      || (kind === "file" && (after.nlink !== 1 || afterPath.nlink !== 1))
    ) {
      throw new Error(`Packaged runtime ${label} changed during sealing`);
    }
    if (isEffectivelyWritable(target.absolute, after.mode)) {
      throw new Error(`Packaged runtime ${label} remained writable after sealing`);
    }
    return (before.mode & 0o777) !== (after.mode & 0o777);
  } finally {
    fs.closeSync(fd);
  }
}

function sealTree(root: string, resourcesRoot: string): Omit<MacRuntimeSealResult, "alreadySealed" | "repairedGeneratedCaches"> {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Packaged runtime root is not a regular directory: ${path.basename(root)}`);
  }
  const realRoot = fs.realpathSync(root);
  if (!isInside(resourcesRoot, realRoot)) {
    throw new Error(`Packaged runtime root escapes Resources: ${path.basename(root)}`);
  }

  const directories: SealTarget[] = [{ absolute: root, dev: rootStat.dev, ino: rootStat.ino }];
  const files: Array<SealTarget & { executable: boolean }> = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(absolute);
        if (path.isAbsolute(linkTarget)) {
          throw new Error(`Packaged runtime symlink must be relative: ${path.relative(root, absolute)}`);
        }
        const lexicalTarget = path.resolve(path.dirname(absolute), linkTarget);
        if (!isInside(root, lexicalTarget)) {
          throw new Error(`Packaged runtime symlink escapes its root: ${path.relative(root, absolute)}`);
        }
        const realTarget = fs.realpathSync(absolute);
        if (!isInside(realRoot, realTarget)) {
          throw new Error(`Packaged runtime symlink resolves outside its root: ${path.relative(root, absolute)}`);
        }
        // Python distributions intentionally contain relative aliases such as
        // bin/python -> python3.12. Validate them, but never chmod through one.
        continue;
      }
      if (stat.isDirectory()) {
        directories.push({ absolute, dev: stat.dev, ino: stat.ino });
        queue.push(absolute);
      } else if (stat.isFile()) {
        // chmod on a hard link can mutate an inode outside the inspected tree.
        if (stat.nlink !== 1) {
          throw new Error(`Packaged runtime file is hard-linked: ${path.relative(root, absolute)}`);
        }
        files.push({ absolute, dev: stat.dev, ino: stat.ino, executable: (stat.mode & 0o111) !== 0 });
      } else {
        throw new Error(`Packaged runtime contains an unsupported entry: ${path.relative(root, absolute)}`);
      }
    }
  }

  let changedEntries = 0;
  for (const file of files) {
    if (sealEntry(file, file.executable ? 0o555 : 0o444, path.relative(root, file.absolute), "file")) {
      changedEntries += 1;
    }
  }
  for (const directory of directories.sort((left, right) => right.absolute.length - left.absolute.length)) {
    if (sealEntry(directory, 0o555, path.relative(root, directory.absolute) || ".", "directory")) {
      changedEntries += 1;
    }
  }

  for (const file of files) {
    const stat = fs.lstatSync(file.absolute);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.dev !== file.dev
      || stat.ino !== file.ino
      || (file.executable && (stat.mode & 0o111) === 0)
      || isEffectivelyWritable(file.absolute, stat.mode)
    ) {
      throw new Error(`Packaged runtime file could not be sealed: ${path.relative(root, file.absolute)}`);
    }
  }
  for (const directory of directories) {
    const stat = fs.lstatSync(directory.absolute);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.dev !== directory.dev
      || stat.ino !== directory.ino
      || (stat.mode & 0o111) === 0
      || isEffectivelyWritable(directory.absolute, stat.mode)
    ) {
      throw new Error(`Packaged runtime directory could not be sealed: ${path.relative(root, directory.absolute)}`);
    }
  }
  return { directories: directories.length, files: files.length, changedEntries };
}

function sealRuntimeTrees(resourcesPath: string): Omit<MacRuntimeSealResult, "alreadySealed" | "repairedGeneratedCaches"> {
  const resourcesStat = fs.lstatSync(resourcesPath);
  if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink()) {
    throw new Error("Packaged Resources root is not a regular directory");
  }
  const resourcesRoot = fs.realpathSync(resourcesPath);
  let directories = 0;
  let files = 0;
  let changedEntries = 0;
  for (const name of SEALED_RUNTIME_NAMES) {
    const sealed = sealTree(path.join(resourcesRoot, name), resourcesRoot);
    directories += sealed.directories;
    files += sealed.files;
    changedEntries += sealed.changedEntries;
  }
  return { directories, files, changedEntries };
}

/** Pure filesystem boundary used by signed-artifact and hostile-tree tests. */
export function sealMacRuntimeResourcesForExecution(resourcesPath: string): MacRuntimeSealResult {
  const sealed = sealRuntimeTrees(resourcesPath);
  return {
    ...sealed,
    alreadySealed: sealed.changedEntries === 0,
    repairedGeneratedCaches: false,
  };
}

function trustFailure(stage: string, category: string): Error {
  return new Error(`Official macOS runtime ${stage} failed (${category})`);
}

/**
 * The updater ZIP stays owner-writable so Squirrel can clear quarantine. At
 * the first official packaged launch (and idempotently thereafter), validate
 * the exact app lineage, repair only verified generated Python caches, then
 * make the installed runtime immutable before any Python process can start.
 */
export async function prepareMacRuntimeResourcesForExecution(
  input: MacRuntimeSealInput,
): Promise<MacRuntimeSealResult> {
  const bundleStat = fs.lstatSync(input.bundlePath);
  const resourcesStat = fs.lstatSync(input.resourcesPath);
  if (
    !bundleStat.isDirectory()
    || bundleStat.isSymbolicLink()
    || !resourcesStat.isDirectory()
    || resourcesStat.isSymbolicLink()
  ) {
    throw new Error("Official macOS runtime boundary is not a regular application bundle");
  }
  const realBundle = fs.realpathSync(input.bundlePath);
  const realResources = fs.realpathSync(input.resourcesPath);
  if (realResources !== path.join(realBundle, "Contents", "Resources")) {
    throw new Error("Official macOS runtime Resources path escaped its application bundle");
  }
  const policyStat = fs.lstatSync(input.policyPath);
  if (
    !policyStat.isFile()
    || policyStat.isSymbolicLink()
    || policyStat.nlink !== 1
    || fs.realpathSync(input.policyPath) !== path.join(realResources, "macos-release-signing-policy.json")
  ) {
    throw new Error("Official macOS runtime signing policy is not a regular packaged resource");
  }

  let repairedGeneratedCaches = false;
  let trust = await inspectMacInstalledAppTrust({
    bundlePath: realBundle,
    policyPath: input.policyPath,
  });
  if (!trust.ok) {
    if (trust.diagnostic.category !== "source-seal") {
      throw trustFailure("pre-seal trust check", trust.diagnostic.category);
    }
    repairedGeneratedCaches = await repairMacInstalledAppGeneratedPythonCaches({
      bundlePath: realBundle,
      diagnostic: trust.diagnostic,
    });
    if (!repairedGeneratedCaches) {
      throw trustFailure("generated-cache repair", trust.diagnostic.category);
    }
    trust = await inspectMacInstalledAppTrust({
      bundlePath: realBundle,
      policyPath: input.policyPath,
    });
    if (!trust.ok) throw trustFailure("post-repair trust check", trust.diagnostic.category);
  }

  const sealed = sealMacRuntimeResourcesForExecution(realResources);
  // Idempotent fast path: the pre-seal trust check already covered the exact
  // requirement and Gatekeeper, and no filesystem mode or content changed.
  if (sealed.changedEntries === 0) {
    return {
      ...sealed,
      alreadySealed: true,
      repairedGeneratedCaches,
    };
  }

  const finalTrust = await inspectMacInstalledAppTrust({
    bundlePath: realBundle,
    policyPath: input.policyPath,
  });
  if (!finalTrust.ok) throw trustFailure("post-seal trust check", finalTrust.diagnostic.category);
  return {
    ...sealed,
    alreadySealed: false,
    repairedGeneratedCaches,
  };
}
