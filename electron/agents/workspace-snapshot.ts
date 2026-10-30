import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { readCanonicalPromptFromDirectory } from "./prompt-authority";
import type { AgentWorkspaceFile, AgentWorkspaceFileRole } from "../../shared/agent-workspace";

export const AGENT_TREE_SCHEMA = "agentlas.agent-tree.v1" as const;
export const AGENT_ASSET_POLICY = "agentlas.runtime-assets.v1" as const;
export const MAX_WORKSPACE_FILES = 2000;
export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_TOTAL_BYTES = 32 * 1024 * 1024;
const PRIVATE_DIRECTORIES = new Set([".git", ".agentlas", "node_modules", ".cache", "__pycache__", "credentials", "secrets", "signing"]);
const ROOT_PRIVATE_DIRECTORIES = new Set(["dist", "build", "cache", "logs", "run-outputs", "outputs", "output", "tmp", "temp", "recovery"]);
const PRIVATE_NAMES = new Set(["memory.md", "memory.json", "memory.jsonl", "memory-tickets.jsonl", "transcript.jsonl", "transcripts.jsonl", ".agentlas-cloud-package.json"]);
const INSTRUCTIONS = new Set(["AGENT.md", "agent.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "system-prompt.md"]);
const MANIFESTS = new Set(["agentlas.json", "manifest.json", "manifest.md", "package.json"]);

export class AgentWorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AgentWorkspaceError"; }
}
export function workspaceHash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function normalizeWorkspacePath(value: string): string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || value.length > 260 || value.includes("\\")
    || value.includes("\0") || /[\u0000-\u001f\u007f]/u.test(value) || /^[A-Za-z]:/.test(value)
    || path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === ".." || /[<>:"|?*]/.test(part)
      || part.length > 255 || Buffer.byteLength(part) > 255
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(value)) !== value) {
    throw new AgentWorkspaceError("invalid_path", "Choose a file inside this agent.");
  }
  return value;
}
/** The private-name rules of the asset policy, for a path that need not be portable (the run view must still keep private files out). */
function isPrivateAssetPath(relativePath: string): boolean {
  const lower = relativePath.split("/").map(part => part.toLowerCase());
  return lower.some(part => PRIVATE_DIRECTORIES.has(part) || part.startsWith(".env"))
    || ROOT_PRIVATE_DIRECTORIES.has(lower[0]) || PRIVATE_NAMES.has(lower.at(-1)!)
    || /\.(?:log|sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx)$/i.test(lower.at(-1)!);
}
export function isWorkspaceAsset(relativePath: string): boolean {
  normalizeWorkspacePath(relativePath);
  return !isPrivateAssetPath(relativePath);
}
export function workspaceFileRole(relativePath: string, entry: string | null): AgentWorkspaceFileRole {
  if (relativePath === entry || INSTRUCTIONS.has(relativePath)) return "instruction";
  if (MANIFESTS.has(relativePath)) return "manifest";
  if (relativePath.startsWith("skills/") || relativePath.startsWith(".agents/skills/")) return "skill";
  if (relativePath.startsWith("knowledge/")) return "knowledge";
  if (["tools/", "hooks/", "contracts/"].some(prefix => relativePath.startsWith(prefix))) return "tool";
  return "asset";
}
export interface WorkspaceAsset extends AgentWorkspaceFile { contentBase64: string; }
export interface WorkspaceTree {
  schemaVersion: typeof AGENT_TREE_SCHEMA;
  assetPolicyVersion: typeof AGENT_ASSET_POLICY;
  canonicalEntry: string | null;
  treeDigest: string;
  files: WorkspaceAsset[];
}
export function workspaceTreeDigest(files: readonly AgentWorkspaceFile[]): string {
  const projected = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(file => ({
    path: file.path, role: file.role, blobHash: file.blobHash, byteLength: file.byteLength, executable: file.executable,
  }));
  return workspaceHash(JSON.stringify({ schemaVersion: AGENT_TREE_SCHEMA, assetPolicyVersion: AGENT_ASSET_POLICY, files: projected }));
}
export function decodeWorkspaceText(bytes: Buffer): string | null {
  try { const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); return text.includes("\0") ? null : text; }
  catch { return null; }
}
/** Reject every linked path component, including existing parents of a new file. */
export function workspaceTarget(root: string, relativePath: string, createParents = false): string {
  normalizeWorkspacePath(relativePath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgentWorkspaceError("unsafe_root", "This agent folder cannot be edited safely.");
  const rootReal = fs.realpathSync.native(root);
  let current = rootReal;
  const parts = relativePath.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!fs.existsSync(current)) {
      if (createParents && i < parts.length - 1) fs.mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())
      || (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))) {
      throw new AgentWorkspaceError("unsafe_path", "Linked or special files cannot be changed here.");
    }
    const real = fs.realpathSync.native(current);
    if (real !== current || !real.startsWith(rootReal + path.sep)) throw new AgentWorkspaceError("path_escape", "This file is outside the agent folder.");
  }
  return current;
}
function stableBytes(root: string, relativePath: string): { bytes: Buffer; executable: boolean } {
  const target = workspaceTarget(root, relativePath);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_WORKSPACE_FILE_BYTES) throw new AgentWorkspaceError("file_limit", "A file is too large or cannot be read safely.");
    const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd); const live = fs.lstatSync(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || live.dev !== after.dev || live.ino !== after.ino || bytes.length !== before.size) {
      throw new AgentWorkspaceError("source_changed", "The file changed while it was being read. Refresh and review again.");
    }
    return { bytes, executable: Boolean(before.mode & 0o111) };
  } finally { fs.closeSync(fd); }
}
/** What a run lease could not hash. Identity only: it is never read, followed or written through, and it holds no bytes. */
export interface WorkspaceUnverifiedEntry {
  path: string;
  /** unportable: the name cannot be a portable package path (not NFC, reserved character, trailing dot, ...). */
  kind: "symlink" | "oversize" | "multilink" | "special" | "unportable";
  byteLength?: number;
  mtimeMs?: number;
  /** The link text exactly as stored. The link is never resolved or opened. */
  linkTarget?: string;
}
export interface WorkspaceInspection { tree: WorkspaceTree; unverified: WorkspaceUnverifiedEntry[]; }
// Names a runtime loads by convention, at any depth: a link or an oversize file here would change what the agent is told or runs.
const RUNTIME_LOADED_NAMES = new Set([...INSTRUCTIONS, "SKILL.md"].map(name => name.toLowerCase()));
const RUNTIME_LOADED_ROLES = new Set<AgentWorkspaceFileRole>(["instruction", "manifest", "skill", "tool"]);
/** Reviewed instructions, skills, tools, manifests and hidden runtime config (.claude, .codex, .mcp.json, ...) must stay fully hashed.
 * Both spellings of a path are checked so a linked directory named `skills` or `tools` counts like the files under it. */
function runtimeLoaded(relativePath: string, entry: string | null): boolean {
  if (relativePath === entry || relativePath.startsWith(".")) return true;
  if (RUNTIME_LOADED_NAMES.has(relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase())) return true;
  return [relativePath, relativePath + "/"].some(candidate => RUNTIME_LOADED_ROLES.has(workspaceFileRole(candidate, entry)));
}
/** A virtualenv is environment, like node_modules: generated, machine specific, never reviewed. `.venv` by name (a real folder or
 * a link to one), any other name by its PEP 405 marker. */
function isEnvironmentDirectory(dir: string, item: fs.Dirent): boolean {
  if (!item.isDirectory() && !item.isSymbolicLink()) return false;
  if (item.name.toLowerCase() === ".venv") return true;
  if (!item.isDirectory()) return false;
  try { return fs.lstatSync(path.join(dir, item.name, "pyvenv.cfg")).isFile(); } catch { return false; }
}
function unverifiedIdentity(full: string, relativePath: string, unportableName = false): WorkspaceUnverifiedEntry | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(full); } catch { return null; }
  if (stat.isSymbolicLink()) {
    let linkTarget = ""; try { linkTarget = fs.readlinkSync(full); } catch { /* the entry is still recorded as a link */ }
    return { path: relativePath, kind: "symlink", linkTarget };
  }
  if (unportableName) return { path: relativePath, kind: "unportable", ...(stat.isFile() ? { byteLength: stat.size, mtimeMs: stat.mtimeMs } : {}) };
  if (!stat.isFile()) return { path: relativePath, kind: "special" };
  if (stat.nlink !== 1) return { path: relativePath, kind: "multilink", byteLength: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.size > MAX_WORKSPACE_FILE_BYTES) return { path: relativePath, kind: "oversize", byteLength: stat.size, mtimeMs: stat.mtimeMs };
  return null;
}
export function snapshotAgentWorkspace(root: string, options: { allowInterruptedEntry?: boolean } = {}): WorkspaceTree {
  return collectWorkspace(root, options, false).tree;
}
// Why the run view tries the exact snapshot first: for every folder the exact snapshot can make, the tree is byte for byte the
// same one, so no digest, revision or review changes for an agent that works today. Only a folder it refuses gets the view below.
const TOLERATED_REFUSALS = new Set(["unsafe_path", "file_limit", "tree_limit", "invalid_path"]);
/**
 * The view a run lease, the workspace panel and the canonical-entry read take of an agent folder. A message to an agent must not end
 * with no model call because the folder holds a virtualenv, a report PDF or a big knowledge file. Reviewed content is not loosened:
 * every file the snapshot can hash is hashed exactly as before; virtualenvs are skipped like node_modules; a link, hard link,
 * special file or file over the size limit is left out of the hashed tree and recorded by identity (never read or followed); and
 * anything a runtime loads as instructions, skills, tools or config (runtimeLoaded) still refuses as before. A reviewed file swapped
 * for a link leaves the hashed tree, so the digest changes and the pre-dispatch revision check catches it.
 * Review, apply, rollback, recovery and Cloud compare keep the exact snapshotAgentWorkspace: they need every byte.
 */
export function snapshotAgentWorkspaceForRun(root: string, options: { allowInterruptedEntry?: boolean } = {}): WorkspaceInspection {
  try { return collectWorkspace(root, options, false); }
  catch (error) { if (!(error instanceof AgentWorkspaceError) || !TOLERATED_REFUSALS.has(error.code)) throw error; }
  return collectWorkspace(root, options, true);
}
function collectWorkspace(root: string, options: { allowInterruptedEntry?: boolean }, tolerate: boolean): WorkspaceInspection {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgentWorkspaceError("unsafe_root", "Choose a real agent folder.");
  let entry: string | null = null;
  try { entry = readCanonicalPromptFromDirectory(root)?.relativePath ?? null; }
  catch (error) {
    if (!options.allowInterruptedEntry) throw error;
    const manifestPath = path.join(root, "agentlas.json");
    if (fs.existsSync(manifestPath)) {
      try { const declared = JSON.parse(stableBytes(root, "agentlas.json").bytes.toString("utf8")).entry;
        if (typeof declared === "string" && isWorkspaceAsset(declared)) entry = normalizeWorkspacePath(declared);
      } catch { /* Unknown manifest edits remain observable during recovery. */ }
    }
  }
  if (entry && !isWorkspaceAsset(entry) && !options.allowInterruptedEntry) throw new AgentWorkspaceError("private_entry", "The agent entry cannot be private memory, credentials or run state.");
  const files: WorkspaceAsset[] = []; const unverified: WorkspaceUnverifiedEntry[] = []; const collisions = new Set<string>(); let total = 0;
  const visit = (dir: string, prefix: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix + item.name;
      // Tolerated only in the run view and only outside runtimeLoaded paths; the entry is recorded, never opened, read or followed.
      const record = (unportableName = false): boolean => {
        if (!tolerate || runtimeLoaded(relativePath, entry)) return false;
        const identity = unverifiedIdentity(path.join(dir, item.name), relativePath, unportableName);
        if (identity) unverified.push(identity);
        return Boolean(identity);
      };
      let asset: boolean;
      try { asset = isWorkspaceAsset(relativePath); }
      catch (error) {
        // A name that cannot be a portable package path (a decomposed Korean name written by macOS, a reserved character) cannot enter the
        // hashed tree. The exact snapshot still refuses it; the run view keeps private names out and records the rest.
        if (!tolerate || !(error instanceof AgentWorkspaceError) || error.code !== "invalid_path") throw error;
        if (isPrivateAssetPath(relativePath) || record(true)) continue;
        throw error;
      }
      if (!asset) continue;
      if (tolerate && isEnvironmentDirectory(dir, item)) continue;
      const collision = relativePath.normalize("NFC").toLowerCase();
      if (collisions.has(collision)) throw new AgentWorkspaceError("path_collision", "Some file names collide. Rename them before comparing versions.");
      collisions.add(collision);
      if (item.isSymbolicLink()) { if (record()) continue; throw new AgentWorkspaceError("unsafe_path", "Linked files cannot be included in a version."); }
      if (item.isDirectory()) { visit(path.join(dir, item.name), relativePath + "/"); continue; }
      if (!item.isFile()) { if (record()) continue; throw new AgentWorkspaceError("unsafe_path", "Special files cannot be included in a version."); }
      let read: { bytes: Buffer; executable: boolean };
      try { read = stableBytes(root, relativePath); }
      catch (error) {
        // Oversize, hard-linked, or swapped for a link between the directory read and the open: recorded the same way.
        if (tolerate && error instanceof AgentWorkspaceError && (error.code === "file_limit" || error.code === "unsafe_path") && record()) continue;
        throw error;
      }
      const { bytes, executable } = read; total += bytes.length;
      if (files.length >= MAX_WORKSPACE_FILES || total > MAX_WORKSPACE_TOTAL_BYTES) throw new AgentWorkspaceError("tree_limit", "This agent has too many or too large files to compare safely.");
      files.push({ path: relativePath, role: workspaceFileRole(relativePath, entry), blobHash: workspaceHash(bytes), byteLength: bytes.length,
        executable, kind: "file", binary: decodeWorkspaceText(bytes) === null, contentBase64: bytes.toString("base64") });
    }
  };
  visit(root, ""); files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  unverified.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { tree: { schemaVersion: AGENT_TREE_SCHEMA, assetPolicyVersion: AGENT_ASSET_POLICY, canonicalEntry: entry, treeDigest: workspaceTreeDigest(files), files }, unverified };
}
