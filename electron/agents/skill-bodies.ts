import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
 * Package skills for a run that cannot read files (native-harness notyet NH04).
 *
 * An installed package lists its skills as names plus a revision digest (agents/files.ts agentSkillCatalogLine; owner
 * 2026-10-13: a list, not inlined bodies — the agent opens the SKILL.md it needs with its own file tools). A run with no
 * file reader (the untrusted, restricted and host-judgment prompt profiles) cannot open them, so the host supplies the
 * exact bodies of the listed revision right after the list. The list is host-minted; its digest is recomputed from the
 * files with the same algorithm, and a mismatch is refused, never replaced by other bytes. Runs that can read files keep
 * the list unchanged. No electron import: the daemon composes prompts too.
 */

/** Same roots and order as agents/files.ts AGENT_SKILL_ROOTS (first root wins). */
export const NO_READER_SKILL_ROOTS = ["skills", ".claude/skills", ".codex/skills", ".gemini/skills", ".agents/skills"] as const;
/** Upper bound for the bodies one prompt carries; beyond it the run is refused rather than handed a partial set. */
export const NO_READER_SKILL_BUDGET_BYTES = 512 * 1024;
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_SKILLS = 128;

const CATALOG_LINE = /^skills: [^\n]+; rev [0-9a-f]{12}\)$/gm;
const SINGLE_ROOT_LINE = /^skills: ([^\n]+?) \(([^\n]+)\/<name>\/SKILL\.md; rev ([0-9a-f]{12})\)$/;
const MULTI_ROOT_LINE = /^skills: ([^\n]+?) \(in ([^\n]+); rev ([0-9a-f]{12})\)$/;

interface SkillFile { root: string; slug: string; bytes: Buffer }

function listSkills(dir: string): Array<{ root: string; slug: string }> {
  const entries: Array<{ root: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const root of NO_READER_SKILL_ROOTS) {
    const skillsDir = path.join(dir, root);
    let names: string[];
    try {
      const stat = fs.lstatSync(skillsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      names = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, "en"));
    } catch { continue; }
    for (const slug of names) {
      if (seen.has(slug.toLowerCase())) continue;
      seen.add(slug.toLowerCase());
      entries.push({ root, slug });
    }
  }
  return entries;
}

/** The package's SKILL.md files and the catalog revision they pin (agentSkillCatalogLine's digest). */
function readSkills(dir: string): { files: SkillFile[]; rev: string } {
  const revision = createHash("sha256");
  const files: SkillFile[] = [];
  const entries = listSkills(dir);
  if (entries.length > MAX_SKILLS) throw new Error("agent_skill_package_too_large");
  for (const { root, slug } of entries) {
    const skillPath = path.join(dir, root, slug, "SKILL.md");
    let fd: number;
    try { fd = fs.openSync(skillPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error("agent_package_source_changed");
      const bytes = fs.readFileSync(fd);
      revision.update(`${root}/${slug}\0`).update(bytes).update("\0");
      files.push({ root, slug, bytes });
    } finally { fs.closeSync(fd); }
  }
  return { files, rev: revision.digest("hex").slice(0, 12) };
}

function bodiesBlock(rev: string, files: readonly SkillFile[]): string {
  return [
    `skill bodies (rev ${rev}; no file reader in this run, so each listed SKILL.md follows exactly):`,
    ...files.map((file) => {
      const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 16);
      return `<<<skill ${file.slug} ${file.root}/${file.slug}/SKILL.md sha256:${digest}>>>\n${file.bytes.toString("utf8")}\n<<<end skill ${file.slug}>>>`;
    }),
  ].join("\n");
}

/**
 * The agent definition with every host skill list followed by the exact bodies of that revision. Text without a list is
 * returned unchanged. Throws agent_package_source_changed when the files no longer match the listed revision and
 * agent_skill_bodies_exceed_no_reader_budget when the bodies would not fit.
 */
export function withSkillBodiesForNoReader(agentPrompt: string): string {
  if (!agentPrompt.includes("SKILL.md") || !agentPrompt.includes("; rev ")) return agentPrompt;
  let used = 0;
  const supply = (line: string, listed: string[], dirs: string[], rev: string): string => {
    for (const dir of dirs) {
      const { files, rev: actual } = readSkills(dir);
      if (actual !== rev) continue;
      if (files.map((file) => file.slug).join(",") !== listed.join(",")) continue;
      used += files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
      if (used > NO_READER_SKILL_BUDGET_BYTES) throw new Error("agent_skill_bodies_exceed_no_reader_budget");
      return `${line}\n${bodiesBlock(rev, files)}`;
    }
    throw new Error("agent_package_source_changed");
  };
  // One pass over the original text, so a body that happens to contain a list-shaped line is never expanded again.
  return agentPrompt.replace(CATALOG_LINE, (line: string) => {
    const single = SINGLE_ROOT_LINE.exec(line);
    if (single) {
      const [, names, rootDir, rev] = single;
      // rootDir = path.join(packageDir, root); the longest matching root first, the digest decides between candidates.
      const dirs = [...NO_READER_SKILL_ROOTS].sort((a, b) => b.length - a.length)
        // path.join used the platform separator (Windows: backslashes inside ".claude\\skills" too).
        .filter((root) => [`/${root}`, `${path.sep}${root.split("/").join(path.sep)}`].some((tail) => rootDir.endsWith(tail)))
        .map((root) => rootDir.slice(0, rootDir.length - root.length - 1));
      return supply(line, names.split(", "), dirs, rev);
    }
    const multi = MULTI_ROOT_LINE.exec(line);
    if (multi) {
      const [, pairs, dir, rev] = multi;
      return supply(line, pairs.split(", ").map((pair) => pair.split("=")[0]), [dir], rev);
    }
    return line;
  });
}
