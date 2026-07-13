import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LOCAL_AGENT_DEFINITION_HASH_VERSION = "agentlas-local-definition-v1" as const;

const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;
const ROOT_DEFINITION_FILE_RE = /^(?:agent|agents|team|system-prompt|soul|persona|manifest|playbook|workflow|prompt|claude|gemini|readme)(?:\.[^.]+)?$/i;
const DEFINITION_DIRS = new Set([
  "agents",
  "skills",
  "playbooks",
  "workflows",
  "team",
  "teams",
  "departments",
  "hr-departments",
]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", ".next", "output", "ledgers", "memory"]);

function normalizedRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function isDefinitionPath(relative: string): boolean {
  const parts = relative.split("/");
  if (parts.length === 1) return ROOT_DEFINITION_FILE_RE.test(parts[0]);
  if (DEFINITION_DIRS.has(parts[0])) return true;
  return parts[0] === ".agentlas" && parts[1] === "skills";
}

function shouldEnterDirectory(relative: string): boolean {
  const parts = relative.split("/");
  if (EXCLUDED_DIRS.has(parts.at(-1) ?? "")) return false;
  if (parts[0] === ".agentlas") return parts.length === 1 || parts[1] === "skills";
  return DEFINITION_DIRS.has(parts[0]);
}

/**
 * Content-derived fingerprint for a local AgentDefinition.
 *
 * Memory, receipts, generated output, local paths and credentials are excluded.
 * This lets legacy local agents own exact private Experience candidates without
 * pretending that they already have a Hub-issued AgentDefinition release.
 */
export function computeLocalAgentDefinitionHash(rootPath: string): string {
  const requested = path.resolve(rootPath);
  const rootStat = fs.lstatSync(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Local AgentDefinition root must be a real directory.");
  }
  const root = fs.realpathSync.native(requested);
  const files: Array<{ relative: string; absolute: string }> = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizedRelative(root, absolute);
      if (entry.isSymbolicLink()) {
        if (isDefinitionPath(relative) || shouldEnterDirectory(relative)) {
          throw new Error("Symbolic links are not allowed in local AgentDefinition assets.");
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (shouldEnterDirectory(relative)) walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isDefinitionPath(relative)) continue;
      if (files.length >= MAX_FILES) throw new Error("Local AgentDefinition exceeds the file limit.");
      files.push({ relative, absolute });
    }
  };

  walk(root);
  if (files.length === 0) throw new Error("No local AgentDefinition files were found.");
  files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);

  const definition = createHash("sha256");
  definition.update(LOCAL_AGENT_DEFINITION_HASH_VERSION).update("\0");
  let totalBytes = 0;
  for (const file of files) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(file.absolute, flags);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) throw new Error("Local AgentDefinition assets must be regular files.");
      const content = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new Error("Local AgentDefinition changed while it was being fingerprinted.");
      }
      totalBytes += content.length;
      if (totalBytes > MAX_BYTES) throw new Error("Local AgentDefinition exceeds the byte limit.");
      definition.update(file.relative).update("\0");
      definition.update(createHash("sha256").update(content).digest("hex")).update("\0");
      definition.update((before.mode & 0o111) !== 0 ? "x" : "-").update("\0");
    } finally {
      fs.closeSync(fd);
    }
  }
  return definition.digest("hex");
}
