import fs from "node:fs";
import path from "node:path";

export const CANONICAL_AGENT_PROMPT_FILES = [
  "system-prompt.md",
  "soul.md",
  "agent.md",
  "claude.md",
  "agents.md",
  "gemini.md",
  "persona.md",
  "prompt.md",
] as const;

export const MAX_PORTABLE_AGENT_ASSET_BYTES = 512 * 1024;

export interface CanonicalPromptAsset {
  relativePath: string;
  content: string;
}

type PackagePromptFile = { path: string; contentBase64: string };

const AGENTLAS_RUNTIME_MANIFEST = "agentlas.json";

function decodeExactUtf8(bytes: Buffer): string {
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Canonical agent prompt is not valid UTF-8");
  return content;
}

function readStableRegularFile(file: string, rootReal: string): Buffer {
  const beforeReal = fs.realpathSync.native(file);
  if (!isInsideRoot(rootReal, beforeReal)) {
    throw new Error("Canonical agent prompt resolves outside its package root");
  }
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Canonical agent prompt must be a regular file");
    if (before.size > MAX_PORTABLE_AGENT_ASSET_BYTES) {
      throw new Error("Canonical agent prompt exceeds the portable 512 KiB limit");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const afterReal = fs.realpathSync.native(file);
    const pathStat = fs.lstatSync(file);
    if (
      bytes.byteLength > MAX_PORTABLE_AGENT_ASSET_BYTES ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      beforeReal !== afterReal ||
      !isInsideRoot(rootReal, afterReal) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      after.mode !== pathStat.mode ||
      bytes.byteLength !== after.size
    ) {
      throw new Error("Canonical agent prompt changed while it was being read");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function readCanonicalPromptFromDirectory(root: string): CanonicalPromptAsset | null {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Canonical agent package root must be a real directory");
  }
  const rootReal = fs.realpathSync.native(root);
  const entries = fs.readdirSync(rootReal, { withFileTypes: true });
  const runtimeManifest = entries.find(
    (candidate) => candidate.name.toLowerCase() === AGENTLAS_RUNTIME_MANIFEST,
  );
  if (runtimeManifest) {
    if (!runtimeManifest.isFile() || runtimeManifest.isSymbolicLink()) {
      throw new Error("agentlas.json must be a regular package file");
    }
    const manifestBytes = readStableRegularFile(path.join(rootReal, runtimeManifest.name), rootReal);
    const declaredEntry = declaredRuntimeEntry(decodeExactUtf8(manifestBytes));
    if (declaredEntry) {
      const target = resolveDirectoryEntry(rootReal, declaredEntry);
      const bytes = readStableRegularFile(target, rootReal);
      return { relativePath: declaredEntry, content: decodeExactUtf8(bytes) };
    }
  }
  for (const wanted of CANONICAL_AGENT_PROMPT_FILES) {
    const entry = entries.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Canonical agent prompt must not be a symbolic link");
    const bytes = readStableRegularFile(path.join(rootReal, entry.name), rootReal);
    return { relativePath: entry.name, content: decodeExactUtf8(bytes) };
  }
  return null;
}

export function readCanonicalPromptFromPackageFiles(
  files: PackagePromptFile[],
): CanonicalPromptAsset | null {
  const runtimeManifest = files.find(
    (candidate) => !candidate.path.includes("/") && candidate.path.toLowerCase() === AGENTLAS_RUNTIME_MANIFEST,
  );
  if (runtimeManifest) {
    const declaredEntry = declaredRuntimeEntry(decodePackageFile(runtimeManifest));
    if (declaredEntry) {
      const entryFile = files.find((candidate) => candidate.path === declaredEntry);
      if (!entryFile) throw new Error(`agentlas.json entry is missing from the package: ${declaredEntry}`);
      return { relativePath: declaredEntry, content: decodePackageFile(entryFile) };
    }
  }
  for (const wanted of CANONICAL_AGENT_PROMPT_FILES) {
    const file = files.find((candidate) => !candidate.path.includes("/") && candidate.path.toLowerCase() === wanted);
    if (!file) continue;
    return { relativePath: file.path, content: decodePackageFile(file) };
  }
  return null;
}

function decodePackageFile(file: PackagePromptFile): string {
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.byteLength > MAX_PORTABLE_AGENT_ASSET_BYTES) {
    throw new Error("Canonical agent prompt exceeds the portable 512 KiB limit");
  }
  return decodeExactUtf8(bytes);
}

function declaredRuntimeEntry(manifestText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error("agentlas.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agentlas.json must be a JSON object");
  }
  const entry = (parsed as Record<string, unknown>).entry;
  if (entry === undefined || entry === null) return null;
  if (typeof entry !== "string" || !entry) throw new Error("agentlas.json entry must be a non-empty string");
  return validatePortableEntry(entry);
}

function validatePortableEntry(value: string): string {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.length > 260
  ) {
    throw new Error("agentlas.json entry must be a portable package-relative path");
  }
  for (const part of value.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      part.length > 255 ||
      Buffer.byteLength(part, "utf8") > 255 ||
      hasUnpairedSurrogate(part) ||
      /[<>:\"|?*\u0000-\u001f]/.test(part) ||
      /[ .]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ) {
      throw new Error("agentlas.json entry must be a portable package-relative path");
    }
  }
  return value;
}

function resolveDirectoryEntry(rootReal: string, relativePath: string): string {
  let current = rootReal;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("agentlas.json entry must not traverse a symbolic link");
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error("agentlas.json entry parent must be a directory");
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error("agentlas.json entry must point to a regular file");
    }
  }
  const resolved = fs.realpathSync.native(current);
  if (!isInsideRoot(rootReal, resolved)) throw new Error("agentlas.json entry escapes its package root");
  return current;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
