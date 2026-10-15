import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getRoute } from "../agents/routes";
import { userDataDir } from "../runtime-paths";
import { scanAgentFolder } from "../agents/folder-scan";
import { buildLocalTeamOrgChart } from "../agents/team-org-chart";
import { isWorkspaceAsset } from "../agents/workspace-snapshot";
import { materializeTeamMemberCells } from "../store/team-member-cells";
import { bindResolvedOrgAgentIds } from "../store/org-spec";
import { readCloudAgentRestoreMarker, readRestoredCloudAgentPackageSnapshot } from "./restore";
import type { InstalledFirm, ResolvedOrg } from "../../shared/types";

type TeamRow = { id: string; slug: string; name: string; name_en: string; tagline: string;
  system_prompt: string; entity_kind: string; visibility: string; installed_at: string };

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const projectionKey = (id: string): string => `restored-team-firm:${id}`;
const rowSql = "SELECT id, slug, name, name_en, tagline, system_prompt, entity_kind, visibility, installed_at FROM installed_agents";

function readDeclaredRestoredTeam(managed: string): ReturnType<typeof scanAgentFolder> | null {
  let declaredRosterCount = 0;
  for (const name of ["manifest.json", "agentlas.json"]) {
    const file = path.join(managed, name);
    if (!fs.existsSync(file)) continue;
    const declaration = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new Error("restored_team_manifest_invalid");
    if (!declaredRosterCount) {
      const roster = [declaration.roster, declaration.agents, declaration.members, declaration.team]
        .find(value => Array.isArray(value) && value.length > 0);
      if (roster) {
        declaredRosterCount = roster.length;
        for (const entry of roster) {
          const ref = typeof entry === "string" ? entry
            : entry && typeof entry === "object" ? [entry.path, entry.file, entry.agent, entry.promptFileRef]
              .find(value => typeof value === "string") : null;
          if (typeof ref !== "string" || !ref.trim() || /^[a-zA-Z]:|^[/\\]/.test(ref)) return null;
          const relative = path.relative(managed, path.resolve(managed, ref.replace(/\\/g, "/")));
          if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
        }
      }
    }
  }
  const scan = scanAgentFolder(managed);
  // Restored packages declare real roster files. The scanner's name-only fallback cannot grant execution.
  if (scan.kind !== "team" || scan.source !== "manifest-roster" || scan.members.length < 2
    || declaredRosterCount !== scan.members.length
    || scan.members.some(member => !member.promptFileRef
      || !isWorkspaceAsset(member.promptFileRef.replace(/\\/g, "/")))
    || new Set(scan.members.map(member => member.promptFileRef)).size !== scan.members.length) return null;
  return scan;
}

/** Current source identity for the already owned package; used by prepared admission CAS. */
export function restoredTeamSourceDigest(agentId: string): string | null {
  const row = getDb().prepare(`${rowSql} WHERE id = ?`).get(agentId) as TeamRow | undefined;
  const route = getRoute(agentId);
  if (!row || row.entity_kind !== "team" || !row.system_prompt.trim()
    || ["background", "private"].includes(row.visibility) || !route || route.agentId !== agentId
    || route.source !== "agent-cloud" || route.kind !== "team") return null;
  const managed = path.join(userDataDir(), "agents", row.slug);
  if (path.resolve(route.path) !== path.resolve(managed)) return null;
  const marker = readCloudAgentRestoreMarker(managed);
  if (!marker || marker.slug !== row.slug || marker.fork || marker.packageHash !== route.packageHash) return null;
  try {
    const sourceDigest = readRestoredCloudAgentPackageSnapshot(managed, marker.packageHash);
    return sourceDigest && readDeclaredRestoredTeam(managed)
      && readRestoredCloudAgentPackageSnapshot(managed, marker.packageHash) === sourceDigest ? sourceDigest : null;
  } catch { return null; }
}

/** Materialize only an already owned, exact restored team. Inventory previews never call this. */
export function recoverRestoredTeamFirms(agentId?: string): void {
  const db = getDb();
  const rows = db.prepare(`SELECT id, slug, name, name_en, tagline, system_prompt, entity_kind,
    visibility, installed_at FROM installed_agents WHERE entity_kind = 'team'
    ${agentId ? "AND id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as TeamRow[];
  for (const row of rows) {
    try {
      const route = getRoute(row.id);
      if (!route || route.agentId !== row.id || route.source !== "agent-cloud" || route.kind !== "team"
        || !row.system_prompt.trim() || ["background", "private"].includes(row.visibility)) continue;
      const matches = db.prepare("SELECT id, ceo_agent_id, org_chart_json FROM firms WHERE id = ? OR slug IN (?, ?) OR ceo_agent_id = ?")
        .all(row.id, row.slug, `firm-${row.slug}`, row.id) as Array<{ id: string; ceo_agent_id: string; org_chart_json: string }>;
      const priorProjectionRaw = db.prepare("SELECT value FROM meta WHERE key = ?").get(projectionKey(row.id)) as { value: string } | undefined;
      const priorProjection = priorProjectionRaw ? JSON.parse(priorProjectionRaw.value) as { firmId: string; sourceDigest: string; chartDigest: string; orgDigest: string } : null;
      // Refresh only our exact projection. Existing or customized organizations keep their owner authority.
      if (matches.length > 0 && (matches.length !== 1 || matches[0].ceo_agent_id !== row.id
        || priorProjection?.firmId !== matches[0].id
        || priorProjection.chartDigest !== digest(matches[0].org_chart_json))) continue;
      const priorOrg = matches[0] ? db.prepare("SELECT value FROM meta WHERE key = ?").get(`orgspec:${matches[0].id}`) as { value: string } | undefined : undefined;
      if (matches[0] && (!priorOrg || priorProjection!.orgDigest !== digest(priorOrg.value))) continue;
      const managed = path.join(userDataDir(), "agents", row.slug);
      if (path.resolve(route.path) !== path.resolve(managed)) continue;
      const marker = readCloudAgentRestoreMarker(managed);
      if (!marker || marker.slug !== row.slug || marker.fork || marker.packageHash !== route.packageHash) continue;
      const sourceDigest = readRestoredCloudAgentPackageSnapshot(managed, marker.packageHash);
      if (!sourceDigest || priorProjection?.sourceDigest === sourceDigest) continue;
      const scan = readDeclaredRestoredTeam(managed);
      if (!scan) continue;
      const divisions: ResolvedOrg["divisions"] = scan.members.map(member => ({
        id: member.id, name: member.name, role: member.role, promptFileRef: member.promptFileRef,
        prompt: fs.readFileSync(path.join(managed, member.promptFileRef!), "utf8").slice(0, 8000), specialists: [],
      }));
      const rowSnapshot = JSON.stringify(row);
      const routeSnapshot = JSON.stringify(route);
      const commit = db.transaction(() => {
        const live = db.prepare(`SELECT id, slug, name, name_en, tagline, system_prompt, entity_kind,
          visibility, installed_at FROM installed_agents WHERE id = ?`).get(row.id);
        if (JSON.stringify(live) !== rowSnapshot || JSON.stringify(getRoute(row.id)) !== routeSnapshot
          || readRestoredCloudAgentPackageSnapshot(managed, marker.packageHash) !== sourceDigest) return;
        const liveMatches = db.prepare("SELECT id, ceo_agent_id, org_chart_json FROM firms WHERE id = ? OR slug IN (?, ?) OR ceo_agent_id = ?")
          .all(row.id, row.slug, `firm-${row.slug}`, row.id);
        if (JSON.stringify(liveMatches) !== JSON.stringify(matches)
          || JSON.stringify(db.prepare("SELECT value FROM meta WHERE key = ?").get(projectionKey(row.id))) !== JSON.stringify(priorProjectionRaw)
          || (matches[0] && JSON.stringify(db.prepare("SELECT value FROM meta WHERE key = ?").get(`orgspec:${matches[0].id}`)) !== JSON.stringify(priorOrg))) return;
        const id = matches[0]?.id ?? randomUUID();
        const firmSlug = `firm-${row.slug}`;
        const orgChart = materializeTeamMemberCells(db, { firmId: id, firmSlug, ceoAgentId: row.id,
          installedAt: row.installed_at, orgChart: buildLocalTeamOrgChart(row.id, row.slug, undefined, scan.members) });
        const firm: InstalledFirm = { id, slug: firmSlug, name: row.name, nameEn: row.name_en || row.name,
          tagline: row.tagline, taglineEn: row.tagline, persona: "", ceoAgentId: row.id, orgChart,
          installedAt: row.installed_at };
        const chartJson = JSON.stringify(orgChart);
        if (matches[0]) db.prepare("UPDATE firms SET org_chart_json = ? WHERE id = ?").run(chartJson, id);
        else db.prepare(`INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona,
          ceo_agent_id, org_chart_json, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, firmSlug, firm.name, firm.nameEn, firm.tagline, firm.taglineEn, "", row.id,
            chartJson, row.installed_at);
        const org: ResolvedOrg = { source: "resolver", ceo: { id: row.id, name: row.name,
          role: "CEO", agentId: row.id, prompt: row.system_prompt },
          divisions: bindResolvedOrgAgentIds(firm, divisions), sourcePath: managed, resolvedAt: new Date().toISOString() };
        const orgJson = JSON.stringify(org);
        const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        setMeta.run(`orgspec:${id}`, orgJson);
        setMeta.run(projectionKey(row.id), JSON.stringify({ firmId: id, sourceDigest,
          chartDigest: digest(chartJson), orgDigest: digest(orgJson) }));
        // Roll back cells, firm, and spec together if the source or route changed while materializing.
        if (JSON.stringify(getRoute(row.id)) !== routeSnapshot
          || readRestoredCloudAgentPackageSnapshot(managed, marker.packageHash) !== sourceDigest) throw new Error("restored_team_source_changed");
      });
      commit();
    } catch {
      // A refused or changing package must not prevent another installed agent's turn.
      // Its existing preflight availability checks continue to report the missing firm.
    }
  }
}
