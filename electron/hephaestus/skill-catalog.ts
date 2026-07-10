import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SkillCatalogAsset, SkillCatalogEntry } from "../../shared/types";
import { hephaestusRoot } from "./root";

// Cloud package portability contract: any individual file above 512 KiB is
// omitted by the packager, so such a skill must never be offered as injectable.
const MAX_SKILL_BYTES = 512 * 1024;
const SAFE_SKILL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function skillsRoot(): string | null {
  const root = hephaestusRoot();
  if (!root) return null;
  const candidate = path.join(root, "skills");
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function safeCatalogPath(slug: string): string {
  if (!SAFE_SKILL_SLUG.test(slug) || slug === "." || slug === "..") {
    throw new Error("Invalid skill catalog slug");
  }
  const root = skillsRoot();
  if (!root) throw new Error("Hephaestus skill catalog is unavailable");
  const directory = path.join(root, slug);
  const file = path.join(directory, "SKILL.md");
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill catalog path escapes its root");
  const dirStat = fs.lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("Skill catalog entry is not a real directory");
  const fileStat = fs.lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Skill catalog source must be a regular file");
  return file;
}

function readStableSkillFile(file: string): { bytes: Buffer; hash: string } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Skill catalog source must be a regular file");
    if (before.size > MAX_SKILL_BYTES) throw new Error("Skill catalog source exceeds the portable 512 KiB limit");
    const bytes = fs.readFileSync(fd);
    if (bytes.byteLength > MAX_SKILL_BYTES) throw new Error("Skill catalog source exceeds the portable 512 KiB limit");
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error("Skill catalog source changed while it was being read");
    }
    return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

function metadata(slug: string, content: string): SkillCatalogEntry {
  let name = slug;
  let description = "";
  const fm = content.match(/^---\s*([\s\S]*?)\s*---/);
  const block = fm ? fm[1] : content.slice(0, 600);
  const nameMatch = block.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  const descriptionMatch = block.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m);
  if (nameMatch) name = nameMatch[1].trim();
  if (descriptionMatch) description = descriptionMatch[1].trim().replace(/\s+/g, " ");
  return { slug, name, description };
}

export function listSkillCatalog(): SkillCatalogEntry[] {
  const root = skillsRoot();
  if (!root) return [];
  const result: SkillCatalogEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_SKILL_SLUG.test(entry.name)) continue;
    try {
      const { content } = readSkillCatalogAsset(entry.name);
      result.push(metadata(entry.name, content));
    } catch {
      // Invalid, linked, oversized, or concurrently changing entries are not callable catalog assets.
    }
  }
  return result.sort((a, b) => a.slug.localeCompare(b.slug, "en"));
}

export function readSkillCatalogAsset(slug: string): SkillCatalogAsset {
  const file = safeCatalogPath(slug);
  const { bytes, hash } = readStableSkillFile(file);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new Error("Skill catalog source is not valid UTF-8");
  }
  const entry = metadata(slug, content);
  return { ...entry, content, contentHash: hash, byteLength: bytes.byteLength };
}
