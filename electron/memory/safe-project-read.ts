import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { verifyActivatedFolderIdentity } from "../architecture/activation";

export const PROJECT_MEMORY_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_CODE_MAP_MAX_BYTES = 16 * 1024 * 1024;
// The injected seed carries only modules/entry points/top symbols — ~31KB on
// this repo. The full map is 1000x larger and is the find tool's business, not
// the turn's.
export const PROJECT_CODE_MAP_SEED_MAX_BYTES = 1024 * 1024;
// A large repo's sitemap can reach into the tens of megabytes; on this workspace
// it hit 13MB and blew the 2MB text cap, so it silently read as null and was
// never injected (the same failure the code map had). Injection only ever emits
// per-status counts, so the file never needs to be small — it just needs to be
// readable.
export const PROJECT_SITEMAP_MAX_BYTES = 24 * 1024 * 1024;

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

interface ProjectMemoryWorkerReply {
  id: number;
  data: Uint8Array | null;
}

interface PendingProjectMemoryRead {
  resolve: (value: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

const PROJECT_MEMORY_WORKER_TIMEOUT_MS = 5_000;
const PROJECT_MEMORY_READ_WORKER_SOURCE = String.raw`
  const fs = require("node:fs");
  const path = require("node:path");
  const { parentPort } = require("node:worker_threads");

  function pathIsInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  }

  function validateParentChain(memoryRoot, absolutePath) {
    const relative = path.relative(memoryRoot, path.dirname(absolutePath));
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
    const segments = relative === "" ? [] : relative.split(path.sep);
    let current = memoryRoot;
    for (const segment of ["", ...segments]) {
      if (segment) current = path.join(current, segment);
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    return true;
  }

  function sameFileIdentity(expected, actual) {
    if (!actual.isFile()) return false;
    if (expected.dev > 0n && actual.dev > 0n && expected.dev !== actual.dev) return false;
    if (expected.ino > 0n && actual.ino > 0n && expected.ino !== actual.ino) return false;
    if (expected.birthtimeNs > 0n && actual.birthtimeNs > 0n && expected.birthtimeNs !== actual.birthtimeNs) return false;
    return expected.size === actual.size && expected.mtimeNs === actual.mtimeNs && expected.ctimeNs === actual.ctimeNs;
  }

  parentPort.on("message", (message) => {
    const id = message && Number.isSafeInteger(message.id) ? message.id : 0;
    let fd = null;
    try {
      const memoryRoot = path.resolve(message.memoryRoot);
      const absolutePath = path.resolve(message.absolutePath);
      const maxBytes = Number(message.maxBytes);
      if (!id || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !pathIsInside(memoryRoot, absolutePath)) {
        throw new Error("invalid-project-memory-read");
      }
      const expected = Object.fromEntries(
        Object.entries(message.expected).map(([key, value]) => [key, BigInt(value)]),
      );
      if (!validateParentChain(memoryRoot, absolutePath)) throw new Error("invalid-parent-chain");
      const before = fs.lstatSync(absolutePath, { bigint: true });
      if (before.isSymbolicLink() || !sameFileIdentity(expected, before) || before.size > BigInt(maxBytes)) {
        throw new Error("file-identity-changed");
      }
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!sameFileIdentity(expected, opened) || opened.size > BigInt(maxBytes)) {
        throw new Error("descriptor-identity-changed");
      }
      const buffer = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (bytesRead <= 0) throw new Error("short-read");
        offset += bytesRead;
      }
      const afterDescriptor = fs.fstatSync(fd, { bigint: true });
      const afterPath = fs.lstatSync(absolutePath, { bigint: true });
      if (!sameFileIdentity(opened, afterDescriptor) || afterPath.isSymbolicLink()
        || !sameFileIdentity(afterDescriptor, afterPath) || !validateParentChain(memoryRoot, absolutePath)) {
        throw new Error("post-read-identity-changed");
      }
      const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      parentPort.postMessage({ id, data }, [data.buffer]);
    } catch {
      parentPort.postMessage({ id, data: null });
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  });
`;

let projectMemoryReadWorker: Worker | null = null;
let nextProjectMemoryReadId = 0;
const pendingProjectMemoryReads = new Map<number, PendingProjectMemoryRead>();

function settleProjectMemoryWorker(worker: Worker): void {
  if (projectMemoryReadWorker !== worker) return;
  projectMemoryReadWorker = null;
  for (const pending of pendingProjectMemoryReads.values()) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  pendingProjectMemoryReads.clear();
}

function ensureProjectMemoryReadWorker(): Worker {
  if (projectMemoryReadWorker) return projectMemoryReadWorker;
  const worker = new Worker(PROJECT_MEMORY_READ_WORKER_SOURCE, { eval: true });
  projectMemoryReadWorker = worker;
  worker.unref();
  worker.on("message", (message: ProjectMemoryWorkerReply) => {
    if (!message || !Number.isSafeInteger(message.id)) return;
    const pending = pendingProjectMemoryReads.get(message.id);
    if (!pending) return;
    pendingProjectMemoryReads.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message.data instanceof Uint8Array ? Buffer.from(message.data) : null);
  });
  worker.once("error", () => settleProjectMemoryWorker(worker));
  worker.once("exit", () => settleProjectMemoryWorker(worker));
  return worker;
}

function readProjectMemoryInWorker(
  inspected: { memoryRoot: string; absolutePath: string; stat: fs.BigIntStats },
  maxBytes: number,
): Promise<Buffer | null> {
  const worker = ensureProjectMemoryReadWorker();
  const id = ++nextProjectMemoryReadId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingProjectMemoryReads.delete(id)) return;
      resolve(null);
      settleProjectMemoryWorker(worker);
      void worker.terminate();
    }, PROJECT_MEMORY_WORKER_TIMEOUT_MS);
    timer.unref?.();
    pendingProjectMemoryReads.set(id, { resolve, timer });
    worker.postMessage({
      id,
      memoryRoot: inspected.memoryRoot,
      absolutePath: inspected.absolutePath,
      maxBytes,
      expected: {
        dev: inspected.stat.dev.toString(),
        ino: inspected.stat.ino.toString(),
        birthtimeNs: inspected.stat.birthtimeNs.toString(),
        size: inspected.stat.size.toString(),
        mtimeNs: inspected.stat.mtimeNs.toString(),
        ctimeNs: inspected.stat.ctimeNs.toString(),
      },
    });
  });
}

/**
 * Isolated equivalent for network request paths. File open/read runs on a
 * dedicated worker so neither a blocked synchronous open nor a saturated
 * process-wide libuv pool can starve Electron's main event loop.
 */
export async function readActivatedProjectMemoryTextAsync(
  projectPath: string,
  relativePath: string,
  maxBytes = PROJECT_MEMORY_TEXT_MAX_BYTES,
): Promise<string | null> {
  const inspected = safeFileStat(projectPath, relativePath, maxBytes);
  if (!inspected) return null;
  try {
    const buffer = await readProjectMemoryInWorker(inspected, maxBytes);
    if (!buffer) return null;
    projectMemoryReadTestHook?.("after-read", inspected.absolutePath);
    const afterPath = fs.lstatSync(inspected.absolutePath, { bigint: true });
    if (afterPath.isSymbolicLink() || !sameFileIdentity(inspected.stat, afterPath)) return null;
    if (!validateParentChain(inspected.memoryRoot, inspected.absolutePath)) return null;
    if (!verifyActivatedFolderIdentity(projectPath)) return null;

    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export async function readActivatedProjectMemoryJsonAsync<T>(
  projectPath: string,
  relativePath: string,
  maxBytes = PROJECT_MEMORY_TEXT_MAX_BYTES,
): Promise<T | null> {
  const raw = await readActivatedProjectMemoryTextAsync(projectPath, relativePath, maxBytes);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function activatedProjectMemoryFileExistsAsync(
  projectPath: string,
  relativePath: string,
  maxBytes = PROJECT_CODE_MAP_MAX_BYTES,
): Promise<boolean> {
  return activatedProjectMemoryFileExists(projectPath, relativePath, maxBytes);
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
