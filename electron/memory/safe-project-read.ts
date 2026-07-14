import fs from "node:fs";
import path from "node:path";
import { verifyActivatedFolderIdentity } from "../architecture/activation";

export const PROJECT_MEMORY_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_CODE_MAP_MAX_BYTES = 16 * 1024 * 1024;

type ProjectMemoryReadTestHook = (
  stage: "after-read",
  absolutePath: string,
) => void;

let projectMemoryReadTestHook: ProjectMemoryReadTestHook | null = null;

/** Deterministic race injection for the Electron regression harness only. */
export function setProjectMemoryReadTestHook(hook: ProjectMemoryReadTestHook | null): void {
  if (process.env.AGENTLAS_E2E !== "1") {
    throw new Error("Project memory read hooks are available only in the E2E harness.");
  }
  projectMemoryReadTestHook = hook;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveProjectMemoryFile(projectPath: string, relativePath: string): {
  memoryRoot: string;
  absolutePath: string;
} | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const projectRoot = path.resolve(projectPath);
  const memoryRoot = path.join(projectRoot, ".agentlas");
  const absolutePath = path.resolve(memoryRoot, relativePath);
  if (!pathIsInside(memoryRoot, absolutePath) || absolutePath === memoryRoot) return null;
  return { memoryRoot, absolutePath };
}

function validateParentChain(memoryRoot: string, absolutePath: string): boolean {
  try {
    const relative = path.relative(memoryRoot, path.dirname(absolutePath));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const segments = relative === "" ? [] : relative.split(path.sep);
    let current = memoryRoot;
    for (const segment of ["", ...segments]) {
      if (segment) current = path.join(current, segment);
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sameFileIdentity(expected: fs.BigIntStats, actual: fs.BigIntStats): boolean {
  if (!expected.isFile() || !actual.isFile()) return false;
  if (expected.dev > 0n && actual.dev > 0n && expected.dev !== actual.dev) return false;
  if (expected.ino > 0n && actual.ino > 0n && expected.ino !== actual.ino) return false;
  if (expected.birthtimeNs > 0n && actual.birthtimeNs > 0n && expected.birthtimeNs !== actual.birthtimeNs) {
    return false;
  }
  return expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.ctimeNs === actual.ctimeNs;
}

function safeFileStat(
  projectPath: string,
  relativePath: string,
  maxBytes: number,
): { memoryRoot: string; absolutePath: string; stat: fs.BigIntStats } | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const resolved = resolveProjectMemoryFile(projectPath, relativePath);
  if (!resolved || !verifyActivatedFolderIdentity(projectPath)) return null;
  if (!validateParentChain(resolved.memoryRoot, resolved.absolutePath)) return null;
  try {
    const stat = fs.lstatSync(resolved.absolutePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(maxBytes)) return null;
    return { ...resolved, stat };
  } catch {
    return null;
  }
}

/**
 * Read one bounded UTF-8 file from the already activated `.agentlas` tree.
 * Every path component must be a real directory and the descriptor/path/root
 * identities must still match after the read. Any ambiguity returns null.
 */
export function readActivatedProjectMemoryText(
  projectPath: string,
  relativePath: string,
  maxBytes = PROJECT_MEMORY_TEXT_MAX_BYTES,
): string | null {
  const inspected = safeFileStat(projectPath, relativePath, maxBytes);
  if (!inspected) return null;
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(inspected.absolutePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(inspected.stat, opened) || opened.size > BigInt(maxBytes)) return null;

    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    projectMemoryReadTestHook?.("after-read", inspected.absolutePath);

    const afterDescriptor = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, afterDescriptor)) return null;
    const afterPath = fs.lstatSync(inspected.absolutePath, { bigint: true });
    if (afterPath.isSymbolicLink() || !sameFileIdentity(afterDescriptor, afterPath)) return null;
    if (!validateParentChain(inspected.memoryRoot, inspected.absolutePath)) return null;
    if (!verifyActivatedFolderIdentity(projectPath)) return null;

    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A failed close cannot make an already rejected optional recall safe.
      }
    }
  }
}

export function readActivatedProjectMemoryJson<T>(
  projectPath: string,
  relativePath: string,
  maxBytes = PROJECT_MEMORY_TEXT_MAX_BYTES,
): T | null {
  const raw = readActivatedProjectMemoryText(projectPath, relativePath, maxBytes);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function activatedProjectMemoryFileExists(
  projectPath: string,
  relativePath: string,
  maxBytes = PROJECT_CODE_MAP_MAX_BYTES,
): boolean {
  const inspected = safeFileStat(projectPath, relativePath, maxBytes);
  if (!inspected) return false;
  // Revalidate after inspection so a same-path replacement cannot turn a
  // boolean existence check into an outside-tree information oracle.
  try {
    const after = fs.lstatSync(inspected.absolutePath, { bigint: true });
    return !after.isSymbolicLink() &&
      sameFileIdentity(inspected.stat, after) &&
      validateParentChain(inspected.memoryRoot, inspected.absolutePath) &&
      verifyActivatedFolderIdentity(projectPath);
  } catch {
    return false;
  }
}
