// Auto-archive of locally stored agents that have not been used for 30 days (owner decision 2026-10-13).
//
// Archiving is a move out of sight, never a delete: the agent row, its files and its history stay exactly where they are.
// Archive touches ONLY the meta key below: no installed_agents row, chat, task, run, result, memory or file is deleted or
// rewritten (scripts/test-archive-routing.cjs proves it row by row), so "unused for 30 days" is never a retention TTL for results.
// An archived agent disappears from the org chart and from direct selection; the only ways back are the restore button in
// Settings and being picked by routing (which restores it automatically). The switch is on by default and can be turned off.
//
// The state lives in the meta table (one JSON value) so no schema migration is needed.
import { getMeta, setMeta } from "../store/meta";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";

/** Owner 2026-10-13: "30일간 한 번도 안 쓴 것". The only fixed number of the feature; everything else is derived. */
export const AUTO_ARCHIVE_UNUSED_DAYS = 30;
const ENABLED_KEY = "archive.auto.enabled.v1";
const STATE_KEY = "archive.agents.v1";
const DAY_MS = 86_400_000;

export interface ArchiveRecord {
  archivedAt: string;
  /** "auto-unused": the 30-day sweep; "manual": the owner archived it. */
  reason: "auto-unused" | "manual";
  /** The reference time the sweep judged (last use, or install time when never used). */
  lastUsedAt: string | null;
}

export interface ArchiveCandidate {
  id: string;
  installedAt: string;
  /** Last run participation from agent_usage; null when the agent never ran. */
  lastUsedAt: string | null;
  builtin: boolean;
  /** Exempt: bookmarked by the owner, part of a running job, or the target of an enabled automation. */
  protected: boolean;
}

export function autoArchiveEnabled(): boolean {
  return getMeta(ENABLED_KEY) !== "0";
}

export function setAutoArchiveEnabled(enabled: boolean): void {
  setMeta(ENABLED_KEY, enabled ? "1" : "0");
}

function readState(): Record<string, ArchiveRecord> {
  try {
    const parsed = JSON.parse(getMeta(STATE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, ArchiveRecord> : {};
  } catch { return {}; }
}

function writeState(state: Record<string, ArchiveRecord>): void {
  setMeta(STATE_KEY, JSON.stringify(state));
}

export function listArchivedAgents(): Record<string, ArchiveRecord> {
  return readState();
}

export function isAgentArchived(agentId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readState(), agentId);
}

export function archiveAgent(agentId: string, reason: ArchiveRecord["reason"] = "manual", lastUsedAt: string | null = null, now = Date.now()): void {
  const state = readState();
  if (state[agentId]) return;
  state[agentId] = { archivedAt: new Date(now).toISOString(), reason, lastUsedAt };
  writeState(state);
}

/** Restore button and routing both end here. Returns whether the agent was archived. */
export function restoreAgent(agentId: string): boolean {
  const state = readState();
  if (!state[agentId]) return false;
  delete state[agentId];
  writeState(state);
  return true;
}

/** Ids currently archived; list projections (org chart, pickers, auto-route pool) subtract this set. */
export function archivedAgentIds(): ReadonlySet<string> {
  return new Set(Object.keys(readState()));
}

/** Drop archived agents from a default list/pool. Lookups by id (history, rooms, invocation) must NOT use this. */
export function withoutArchivedAgents<T extends { id: string }>(agents: readonly T[]): T[] {
  const archived = archivedAgentIds();
  return archived.size === 0 ? [...agents] : agents.filter((agent) => !archived.has(agent.id));
}

/** An explicit pick / route / invoke of an agent: restore it if archived and carry on. Never refuses, never throws. */
export function restoreAgentForUse(agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  try {
    const restored = restoreAgent(agentId);
    if (restored) emitDesktopStoreChange({ entity: "agent", id: agentId });
    return restored;
  } catch (error) {
    console.warn("[archive] restore-for-use failed; continuing without it:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Pure: which candidates the sweep archives. Not-yet-30-days-old installs count their install time as a use. */
export function selectUnusedAgents(candidates: readonly ArchiveCandidate[], alreadyArchived: ReadonlySet<string>, now: number, days = AUTO_ARCHIVE_UNUSED_DAYS): ArchiveCandidate[] {
  const cutoff = now - days * DAY_MS;
  return candidates.filter((agent) => {
    if (agent.builtin || agent.protected || alreadyArchived.has(agent.id)) return false;
    const reference = Math.max(Date.parse(agent.installedAt) || 0, Date.parse(agent.lastUsedAt ?? "") || 0);
    return reference > 0 && reference <= cutoff;
  });
}

function defaultCandidates(): ArchiveCandidate[] {
  const rows = getDb().prepare(
    `SELECT a.id, a.installed_at AS installedAt, a.builtin, a.bookmarked_at AS bookmarkedAt, a.visibility,
            (SELECT u.last_used_at FROM agent_usage u WHERE u.agent_key = a.id) AS lastUsedAt,
            EXISTS(SELECT 1 FROM one_org_members m WHERE m.installed_agent_id = a.id AND m.archived_at IS NULL
                   AND m.status_kind IN ('working','running','waiting')) AS busy,
            -- An enabled automation that targets the agent is its next use, however far away the schedule puts it.
            EXISTS(SELECT 1 FROM automations au WHERE au.enabled = 1 AND au.target_type = 'agent'
                   AND au.target_id = a.id) AS scheduled
       FROM installed_agents a
      WHERE a.id NOT LIKE 'builtin-%'`,
  ).all() as Array<{ id: string; installedAt: string; builtin: number | null; bookmarkedAt: string | null; lastUsedAt: string | null; busy: number; scheduled: number }>;
  return rows.map((row) => ({
    id: row.id, installedAt: row.installedAt, lastUsedAt: row.lastUsedAt, builtin: row.builtin === 1,
    protected: row.bookmarkedAt !== null || row.busy === 1 || row.scheduled === 1,
  }));
}

/** Run the sweep (a no-op while the switch is off). Returns the ids archived this time. */
export function sweepUnusedAgents(now = Date.now(), candidates: readonly ArchiveCandidate[] = defaultCandidates()): string[] {
  if (!autoArchiveEnabled()) return [];
  const archived = new Set(Object.keys(readState()));
  const picked = selectUnusedAgents(candidates, archived, now);
  for (const agent of picked) archiveAgent(agent.id, "auto-unused", agent.lastUsedAt ?? agent.installedAt, now);
  if (picked.length > 0) emitDesktopStoreChange({ entity: "agent" });
  return picked.map((agent) => agent.id);
}
