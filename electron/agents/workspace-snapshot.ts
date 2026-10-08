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
export function isWorkspaceAsset(relativePath: string): boolean {
  const parts = normalizeWorkspacePath(relativePath).split("/");
  const lower = parts.map(part => part.toLowerCase());
  return !lower.some(part => PRIVATE_DIRECTORIES.has(part) || part.startsWith(".env"))
    && !ROOT_PRIVATE_DIRECTORIES.has(lower[0]) && !PRIVATE_NAMES.has(lower.at(-1)!)
    && !/\.(?:log|sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx)$/i.test(lower.at(-1)!);
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
export function snapshotAgentWorkspace(root: string, options: { allowInterruptedEntry?: boolean } = {}): WorkspaceTree {
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
  const files: WorkspaceAsset[] = []; const collisions = new Set<string>(); let total = 0;
  const visit = (dir: string, prefix: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix + item.name;
      if (!isWorkspaceAsset(relativePath)) continue;
      const collision = relativePath.normalize("NFC").toLowerCase();
      if (collisions.has(collision)) throw new AgentWorkspaceError("path_collision", "Some file names collide. Rename them before comparing versions.");
      collisions.add(collision);
      if (item.isSymbolicLink()) throw new AgentWorkspaceError("unsafe_path", "Linked files cannot be included in a version.");
      if (item.isDirectory()) { visit(path.join(dir, item.name), relativePath + "/"); continue; }
      if (!item.isFile()) throw new AgentWorkspaceError("unsafe_path", "Special files cannot be included in a version.");
      const { bytes, executable } = stableBytes(root, relativePath); total += bytes.length;
      if (files.length >= MAX_WORKSPACE_FILES || total > MAX_WORKSPACE_TOTAL_BYTES) throw new AgentWorkspaceError("tree_limit", "This agent has too many or too large files to compare safely.");
      files.push({ path: relativePath, role: workspaceFileRole(relativePath, entry), blobHash: workspaceHash(bytes), byteLength: bytes.length,
        executable, kind: "file", binary: decodeWorkspaceText(bytes) === null, contentBase64: bytes.toString("base64") });
    }
  };
  visit(root, ""); files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { schemaVersion: AGENT_TREE_SCHEMA, assetPolicyVersion: AGENT_ASSET_POLICY, canonicalEntry: entry, treeDigest: workspaceTreeDigest(files), files };
}
