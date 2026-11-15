// The write scope of a Build conversation (Agentlas 2.0 Build backend, decision "write only inside that agent's folder").
//
// Everything the host does with a path of a Build — reading a file for the right pane, undoing one file, listing the tree —
// goes through `resolveInScope`: the path is portable and relative, every existing part is looked at with lstat, a link is
// followed only to a place inside the folder (and never written through), and the final real path must be inside the real
// folder. A refusal is a machine code, never a sentence. Electron is not imported (Main, the daemon and gates read this file).
//
// What this cannot do: stop the model's own shell inside a CLI runtime from writing elsewhere. That belongs to the runtime's
// sandbox (permission "write"); here the host proves afterwards that nothing in the folder points outside it (`findScopeEscapes`).
import fs from "node:fs";
import path from "node:path";
import { isWorkspaceAsset, MAX_WORKSPACE_FILE_BYTES, normalizeWorkspacePath } from "../agents/workspace-snapshot";

import type { BuildFileRead, BuildScopeCode } from "../../shared/build-workbench";
export type { BuildFileRead };
export type { BuildScopeCode };

export interface BuildScope { readonly root: string }
export type ScopeResult<T> = ({ ok: true } & T) | { ok: false; code: BuildScopeCode };

export const MAX_BUILD_TREE_FILES = 2000;
export const MAX_BUILD_READ_BYTES = MAX_WORKSPACE_FILE_BYTES;

const fold = (value: string): string => (process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value);

export function insideOrSame(root: string, candidate: string): boolean {
  const a = fold(path.resolve(root)), b = fold(path.resolve(candidate));
  if (a === b) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(prefix);
}

/** The folder of one build, resolved once: its real path is what every later check compares against. */
export function openBuildScope(folder: unknown): ScopeResult<{ scope: BuildScope }> {
  if (typeof folder !== "string" || !folder || folder.includes("\0") || !path.isAbsolute(folder)) return { ok: false, code: "scope_root_invalid" };
  try {
    const real = fs.realpathSync.native(folder);
    if (!fs.statSync(real).isDirectory()) return { ok: false, code: "scope_root_invalid" };
    // The filesystem root and the owner's home are never a build folder, whatever was asked.
    if (path.parse(real).root === real) return { ok: false, code: "scope_root_invalid" };
    return { ok: true, scope: { root: real } };
  } catch { return { ok: false, code: "scope_root_invalid" }; }
}

/**
 * A relative, portable, forward-slash path → an absolute path inside the scope. `forWrite` additionally refuses to go through any
 * link and refuses a hard-linked file (its other name may be outside). A part that does not exist yet is fine for a write.
 */
export function resolveInScope(scope: BuildScope, relative: unknown, options: { forWrite?: boolean; allowPrivate?: boolean } = {}): ScopeResult<{ abs: string; rel: string; exists: boolean }> {
  let rel: string;
  try { rel = normalizeWorkspacePath(relative as string); } catch { return { ok: false, code: "scope_path_invalid" }; }
  let assetOk = false;
  try { assetOk = isWorkspaceAsset(rel); } catch { return { ok: false, code: "scope_path_invalid" }; }
  if (!assetOk && !options.allowPrivate) return { ok: false, code: "scope_private" };
  let current = scope.root;
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    const next = path.join(current, parts[i]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        // Nothing from here on exists: a write creates it under `current`, which is inside (current is real and checked).
        if (!options.forWrite) return { ok: false, code: "scope_missing" };
        return { ok: true, abs: path.join(current, ...parts.slice(i)), rel, exists: false };
      }
      return { ok: false, code: "scope_path_invalid" };
    }
    if (stat.isSymbolicLink()) {
      if (options.forWrite) return { ok: false, code: "scope_symlink" };
      let real: string;
      try { real = fs.realpathSync.native(next); } catch { return { ok: false, code: "scope_symlink" }; }
      if (!insideOrSame(scope.root, real)) return { ok: false, code: "scope_escape" };
      current = real;
      continue;
    }
    if (i < parts.length - 1 && !stat.isDirectory()) return { ok: false, code: options.forWrite ? "scope_path_invalid" : "scope_missing" };
    if (i === parts.length - 1 && options.forWrite && stat.isFile() && stat.nlink > 1) return { ok: false, code: "scope_hardlink" };
    current = next;
  }
  let real: string;
  try { real = fs.realpathSync.native(current); } catch { return { ok: false, code: "scope_missing" }; }
  if (!insideOrSame(scope.root, real)) return { ok: false, code: "scope_escape" };
  return { ok: true, abs: real, rel, exists: true };
}

export interface BuildTreeEntry { path: string; type: "file" | "dir"; size: number; mtimeMs: number }

/** The folder's files and folders (links are not followed, private files are not listed), sorted by path, at most MAX_BUILD_TREE_FILES files. */
export function listBuildTree(scope: BuildScope): { entries: BuildTreeEntry[]; truncated: boolean } {
  const entries: BuildTreeEntry[] = [];
  let files = 0, truncated = false;
  const visit = (dir: string, prefix: string): void => {
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (truncated) return;
      const rel = prefix + item.name;
      let asset = false;
      try { asset = isWorkspaceAsset(rel); } catch { asset = false; }
      if (!asset || item.isSymbolicLink()) continue;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(path.join(dir, item.name)); } catch { continue; }
      if (stat.isDirectory()) { entries.push({ path: rel, type: "dir", size: 0, mtimeMs: stat.mtimeMs }); visit(path.join(dir, item.name), rel + "/"); }
      else if (stat.isFile()) {
        if (files >= MAX_BUILD_TREE_FILES) { truncated = true; return; }
        files += 1;
        entries.push({ path: rel, type: "file", size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  visit(scope.root, "");
  return { entries, truncated };
}


/** Reads one file of the scope. `sinceLine` (0-based) returns only the lines from there on, for the line-by-line view. */
export function readBuildFile(scope: BuildScope, relative: unknown, options: { sinceLine?: number; maxBytes?: number } = {}): ScopeResult<{ file: BuildFileRead }> {
  const resolved = resolveInScope(scope, relative);
  if (!resolved.ok) return resolved;
  const max = Math.min(options.maxBytes ?? MAX_BUILD_READ_BYTES, MAX_BUILD_READ_BYTES);
  let fd: number | null = null;
  try {
    // O_NOFOLLOW where the platform has it: the last part cannot be swapped for a link between the check and the open.
    const flags = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);
    fd = fs.openSync(resolved.abs, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: "scope_not_file" };
    const size = Math.min(stat.size, max);
    const buffer = Buffer.alloc(size);
    const read = size > 0 ? fs.readSync(fd, buffer, 0, size, 0) : 0;
    const bytes = buffer.subarray(0, read);
    const binary = bytes.includes(0);
    if (binary) return { ok: true, file: { path: resolved.rel, content: "", byteLength: stat.size, lineCount: 0, binary: true, truncated: stat.size > max, startLine: 0 } };
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
    const since = Math.max(0, Math.min(Math.trunc(options.sinceLine ?? 0), lineCount));
    return { ok: true, file: { path: resolved.rel, content: since > 0 ? lines.slice(since).join("\n") : text, byteLength: stat.size, lineCount, binary: false, truncated: stat.size > max, startLine: since } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === "ELOOP" ? "scope_symlink" : code === "ENOENT" ? "scope_missing" : "scope_not_file" };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed with the process */ } }
  }
}

/** Replaces (or creates) one file of the scope atomically: a temp file next to it, then a rename. Never writes through a link. */
export function writeBuildFile(scope: BuildScope, relative: unknown, bytes: Buffer, options: { executable?: boolean } = {}): ScopeResult<{ rel: string }> {
  const resolved = resolveInScope(scope, relative, { forWrite: true });
  if (!resolved.ok) return resolved;
  if (bytes.length > MAX_BUILD_READ_BYTES) return { ok: false, code: "scope_too_large" };
  const dir = path.dirname(resolved.abs);
  const tmp = path.join(dir, `.${path.basename(resolved.abs)}.build-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    // Parents are created one at a time under a directory that was already checked to be inside the scope.
    const missing: string[] = [];
    for (let at = dir; !fs.existsSync(at) && insideOrSame(scope.root, at) && at !== scope.root; at = path.dirname(at)) missing.unshift(at);
    for (const folder of missing) fs.mkdirSync(folder);
    const realDir = fs.realpathSync.native(dir);
    if (!insideOrSame(scope.root, realDir)) return { ok: false, code: "scope_escape" };
    fs.writeFileSync(tmp, bytes, { flag: "wx", mode: options.executable ? 0o755 : 0o644 });
    fs.renameSync(tmp, resolved.abs);
    return { ok: true, rel: resolved.rel };
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
    return { ok: false, code: "scope_write_failed" };
  }
}

/** Removes one file of the scope (a file only, never a folder, never through a link). */
export function removeBuildFile(scope: BuildScope, relative: unknown): ScopeResult<{ rel: string; removed: boolean }> {
  const resolved = resolveInScope(scope, relative, { forWrite: true });
  if (!resolved.ok) return resolved;
  if (!resolved.exists) return { ok: true, rel: resolved.rel, removed: false };
  try {
    if (!fs.lstatSync(resolved.abs).isFile()) return { ok: false, code: "scope_not_file" };
    fs.unlinkSync(resolved.abs);
    return { ok: true, rel: resolved.rel, removed: true };
  } catch { return { ok: false, code: "scope_write_failed" }; }
}

/**
 * After a turn: every link inside the folder that points outside it (or nowhere). The model's own shell cannot be fenced here, but a
 * link out of the folder is how a later host read or write would leave it, so the host looks and refuses to go on when there is one.
 */
export function findScopeEscapes(scope: BuildScope, limit = 20, budget = 20_000): Array<{ path: string; kind: "outside" | "dangling" }> {
  const found: Array<{ path: string; kind: "outside" | "dangling" }> = [];
  let visited = 0;
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (found.length >= limit || depth > 24 || visited > budget) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (found.length >= limit || (visited += 1) > budget) return;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        try { if (!insideOrSame(scope.root, fs.realpathSync.native(full))) found.push({ path: prefix + item.name, kind: "outside" }); }
        catch { found.push({ path: prefix + item.name, kind: "dangling" }); }
      } else if (item.isDirectory() && item.name !== "node_modules" && item.name !== ".git") visit(full, prefix + item.name + "/", depth + 1);
    }
  };
  visit(scope.root, "", 0);
  return found;
}
