import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const FILE_OBSERVATION_MAX_BYTES = 16 * 1024 * 1024;
export type FileObservationAction = "read" | "write" | "edit";
export interface FileObservation {
  root: string;
  relativePath: string;
  action: FileObservationAction;
  sha256: string;
  bytes: number;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A bounded observation of regular bytes, never a model-supplied digest.
 * Proof is intentionally narrower than general tools: all symlink components
 * are refused, including links whose current target happens to be in scope. */
export function observeWorkspaceFile(root: string, relativePath: string, action: FileObservationAction, expectedText?: string): FileObservation | null {
  let fd: number | undefined;
  try {
    if (!["read", "write", "edit"].includes(action) || !root || root.length > 700 || !relativePath || relativePath.length > 700
      || relativePath.includes("\0") || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
      || /^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]+/).some(part => part === "..")) return null;
    const canonicalRoot = fs.realpathSync(root);
    if (!fs.statSync(canonicalRoot).isDirectory()) return null;
    const target = path.resolve(canonicalRoot, relativePath);
    const relative = path.relative(canonicalRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
    const inspect = () => {
      let component = canonicalRoot;
      for (const part of relative.split(path.sep)) {
        component = path.join(component, part);
        if (fs.lstatSync(component).isSymbolicLink()) throw new Error("file_proof_symlink");
      }
      if (fs.realpathSync(root) !== canonicalRoot || fs.realpathSync(target) !== target) throw new Error("file_proof_scope_changed");
      return fs.statSync(target);
    };
    const before = inspect();
    if (!before.isFile() || before.size > FILE_OBSERVATION_MAX_BYTES) return null;
    fd = fs.openSync(target, fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)));
    const opened = fs.fstatSync(fd), current = inspect();
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(opened.size);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) return null;
      count += read;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, count)) return null;
    const after = fs.fstatSync(fd), linked = inspect();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || linked.dev !== after.dev || linked.ino !== after.ino
      || linked.size !== after.size || linked.mtimeMs !== after.mtimeMs || linked.ctimeMs !== after.ctimeMs) return null;
    if (expectedText !== undefined && !bytes.equals(Buffer.from(expectedText, "utf8"))) return null;
    return { root: canonicalRoot, relativePath: relative, action, sha256: hash(bytes), bytes: bytes.length };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
