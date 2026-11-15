// Seeds the built-in background architecture agents into the
// installed_agents table on app boot / CLI run. Idempotent + version-gated:
//
//   - First run: inserts all background agents with stable ids (builtinAgentId).
//   - ARCHITECTURE_VERSION bumped: re-syncs name/prompt/role of the built-ins ONLY.
//   - Steady state (version unchanged + all present): no-op, cheap.
//
// Never touches user chats, marketplace-installed agents, project memory, or local imports.
// This is what makes "research the architecture, bump the version, ship" safe to repeat.
import { getDb } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { materializeAgentFiles } from "../agents/files";
import { publicAgentVisibility } from "../agents/policy";
import { compareSemVer, parseSemVer } from "../../shared/semver";
import { specialFolderAgentForSlug } from "../../shared/special-folder-agents";
import {
  ARCHITECTURE_VERSION,
  BUILTIN_AGENTS,
  SCIENCE_RESEARCH_DIRECTOR_SLUG,
  builtinAgentId,
  type BuiltinAgentDef,
} from "./manifest";

const META_KEY = "architecture_version";

export function shouldApplyBuiltinArchitectureSeed(
  installedVersion: string | null,
  bundleVersion: string,
  installedCount: number,
  bundleCount: number,
): boolean {
  if (!parseSemVer(bundleVersion)) return false;
  if (installedVersion == null || installedVersion === "") return true;
  const precedence = compareSemVer(installedVersion, bundleVersion);
  // Unknown/newer shared-store versions belong to another compatible runtime.
  // Never rewrite them with this Desktop build.
  if (precedence == null || precedence > 0) return false;
  if (precedence < 0) return true;
  const have = Number.isSafeInteger(installedCount) ? installedCount : 0;
  const expected = Number.isSafeInteger(bundleCount) ? bundleCount : 0;
  return have < expected;
}

/**
 * A special-folder agent (shared/special-folder-agents.ts) whose slug an owner's own agent already holds is not seeded: the owner's row stays theirs (it is not
 * promoted to a built-in, renamed or re-prompted) and its folder is never written. The slug is the only collision the table can have (the id is ours alone).
 */
function specialSlugHeldByOtherAgent(def: BuiltinAgentDef): boolean {
  if (!specialFolderAgentForSlug(def.slug)) return false;
  const row = getDb().prepare("SELECT id FROM installed_agents WHERE slug = ?").get(def.slug) as { id: string } | undefined;
  return Boolean(row && row.id !== builtinAgentId(def.slug));
}

function upsertBuiltin(def: BuiltinAgentDef, now: string): void {
  if (specialSlugHeldByOtherAgent(def)) return;
  const db = getDb();
  const id = builtinAgentId(def.slug);
  const visibility = publicAgentVisibility({ ...def, builtin: true });
  const existing = db
    .prepare("SELECT id, installed_at FROM installed_agents WHERE id = ? OR slug = ?")
    .get(id, def.slug) as { id: string; installed_at: string } | undefined;

  // Science binds every turn to this exact Main-owned id. A legacy or
  // user-installed same-slug row must not be silently promoted and then run
  // under a different identity.
  if (def.slug === SCIENCE_RESEARCH_DIRECTOR_SLUG && existing && existing.id !== id) {
    throw new Error("science-research-director-builtin-identity-conflict");
  }

  if (existing) {
    // Re-sync the evolving fields; keep id + installed_at stable.
    db.prepare(
      `UPDATE installed_agents
       SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ?,
           tone = ?, role = ?, builtin = 1, trust_grade = 'A', visibility = ?
       WHERE id = ?`,
    ).run(
      def.name,
      def.nameEn,
      def.tagline,
      def.taglineEn,
      def.systemPrompt,
      def.tone,
      def.role,
      visibility,
      existing.id,
    );
    materializeAgentFiles(existing.id);
    return;
  }

  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, ?, 1, ?, ?)`,
  ).run(
    id,
    def.slug,
    def.name,
    def.nameEn,
    def.tagline,
    def.taglineEn,
    def.systemPrompt,
    now,
    def.tone,
    def.role,
    visibility,
  );
  materializeAgentFiles(id);
}

/**
 * Ensure the built-in architecture agents exist and match the current manifest.
 * Returns true if anything was (re)seeded.
 */
export function seedBuiltinAgents(): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const installedVersion = getMeta(META_KEY);
    const have = db
      .prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE builtin = 1")
      .get() as { n: number };
    // A definition that is not seeded because the owner holds its slug is not "missing": counting it would re-run the seed on every start.
    const seedable = BUILTIN_AGENTS.filter((def) => !specialSlugHeldByOtherAgent(def)).length;
    if (!shouldApplyBuiltinArchitectureSeed(
      installedVersion,
      ARCHITECTURE_VERSION,
      have.n,
      seedable,
    )) return false;
    for (const def of BUILTIN_AGENTS) upsertBuiltin(def, now);
    setMeta(META_KEY, ARCHITECTURE_VERSION);
    return true;
  });
  return tx();
}
