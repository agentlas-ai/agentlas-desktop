import fs from "node:fs";
import path from "node:path";

/*
 * Skills of an agent package that a run leaves out instead of refusing to start.
 *
 * A package may carry `.agentlas/skill-registry.json` (kind agentlas-skill-lifecycle-registry): skills the curator proposed are
 * `tier: "candidate"` and quarantined until the owner promotes them. A candidate whose folder sits in the native `.claude/skills`
 * root is one the host's skill list (agents/files.ts listAgentSkillEntries, agents/skill-bodies.ts listSkills) would hand to the
 * model as if it were reviewed. That is what the check protects. Refusing the whole run for it (unreviewed_native_skill, and
 * skill_registry_unsafe for a registry that is a link or special file) stopped an agent that had nothing else wrong; the protection is
 * kept by leaving those skills out of the list, and the agent runs with the rest.
 *
 *  - slugs: candidates in the registry, left out of the `.claude/skills` root.
 *  - nativeRootUntrusted: the registry cannot be read as a plain file (a link, a hard link, not a regular file, damaged JSON, or a
 *    `.agentlas` folder that is a link), so which skills are candidates is unknown. Then a skill that exists only in the `.claude/skills`
 *    root is left out; one the package also ships in a reviewed root (`skills/` and the others, first root wins) is unaffected.
 * Nothing is read through a link and nothing is written. No Electron import: the daemon composes prompts too.
 */
export interface SkillsLeftOut { slugs: ReadonlySet<string>; nativeRootUntrusted: boolean }

export const NATIVE_SKILL_ROOT = ".claude/skills";
const NONE: SkillsLeftOut = Object.freeze({ slugs: new Set<string>(), nativeRootUntrusted: false });

export function skillsLeftOut(packageDir: string): SkillsLeftOut {
  const agentlasDir = path.join(packageDir, ".agentlas");
  let dirStat: fs.Stats;
  try { dirStat = fs.lstatSync(agentlasDir); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? NONE : { slugs: new Set(), nativeRootUntrusted: true }; }
  const untrusted: SkillsLeftOut = { slugs: new Set(), nativeRootUntrusted: true };
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return untrusted;
  const registryPath = path.join(agentlasDir, "skill-registry.json");
  let fileStat: fs.Stats;
  try { fileStat = fs.lstatSync(registryPath); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? NONE : untrusted; }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) return untrusted;
  let registry: { kind?: unknown; skills?: unknown };
  try { registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as typeof registry; } catch { return untrusted; }
  if (!registry || registry.kind !== "agentlas-skill-lifecycle-registry" || !Array.isArray(registry.skills)) return NONE;
  const slugs = new Set<string>();
  for (const skill of registry.skills as Array<{ slug?: unknown; tier?: unknown; state?: unknown }>) {
    if (!skill || skill.tier !== "candidate" || typeof skill.state !== "string" || !["candidate", "local_candidate"].includes(skill.state)) continue;
    if (typeof skill.slug === "string" && /^[a-z0-9][a-z0-9_-]{0,100}$/.test(skill.slug)) slugs.add(skill.slug.toLowerCase());
  }
  return slugs.size ? { slugs, nativeRootUntrusted: false } : NONE;
}

/**
 * Whether the skill `slug` found in `root` is left out of this package's skill list. Callers list the roots in order and skip a slug an
 * earlier root already showed, so a slug reaching here from the native root is one that no reviewed root ships.
 */
export function skillIsLeftOut(leftOut: SkillsLeftOut, root: string, slug: string): boolean {
  if (root !== NATIVE_SKILL_ROOT) return false;
  return leftOut.slugs.has(slug.toLowerCase()) || leftOut.nativeRootUntrusted;
}
