import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { homeParticipants, homeSearch, homeTree } from "../home/home-tree";
import { createChat, getChat } from "../store/chats";
import { getCanonicalTaskForChat } from "../store/tasks";
import { getAutomation, getAutomationLiveRunId, getAutomationLiveRunState } from "../store/automations";
import { listCapabilityGrants } from "../store/capability-grants";
import { getOneProfile, updateOneProfile } from "../store/one-profile";
import { getFirm } from "../store/firms";
import { personalWriteRefusal } from "../one/write-gate";
import { parseApprovalScopeIdentity } from "../../shared/approval-card";
import { AGENT_APPEARANCE_CHARACTERS } from "../../shared/agent-appearance";
import { LEAD_ROOM_KEY_PREFIX } from "../runtime/session-scope";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { withoutArchivedAgents } from "../archive/auto-archive";
import { agentFolderStatus } from "../agents/relocate";
import { resolveOneTeamAvatarProtocolPath } from "../one/avatar";
import { AgentWorkspaceError } from "../agents/workspace-snapshot";
import { getAgentWorkspace, listAgentWorkspaceSkillSummaries, rejectAgentWorkspaceProposal, getAgentWorkspaceDiff, withWorkspaceLockPatience } from "../agents/workspace-service";
import { approveReviewedAgentWorkspaceProposal } from "../agents/workspace-approve";
import { hasDeferredApproval } from "../agents/deferred-apply";
import { queryOwnedMemory } from "../one/memory-inspector";
import { currentMemoryOwnerRef, forgetOwnedMemory, learningActor, memoryTargetRevision, ownedMemoryRecord } from "../memory/owner-mutations";
import { getMemoryStoreInfo } from "../memory/database";
import { memoryClassificationRules, workspaceRulesOn } from "../memory/classification";
import { personalReadable } from "../../shared/memory-classification";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { MOBILE_BUILD_V2_COMMANDS } from "../../shared/mobile-build-v2";
import { isUserFacingProjectAgent } from "../../shared/project-agent-pool";
import { sanitizeMobileBridgeText } from "./sanitize";
import type { AgentWorkspaceMemoryCandidate, AgentWorkspaceProposal, AgentWorkspaceRevision } from "../../shared/agent-workspace";
import type { AgentFolderState } from "../../shared/agent-root";
import { agentDisplayName } from "../../shared/agent-display-name";
import type { AgentFace } from "../../shared/agent-face";
import { faceField, projectAgentFaces } from "./agent-faces";
import {
  MOBILE_WORKSPACE_V2_COMMAND_OPERATIONS, MOBILE_WORKSPACE_V2_LIMITS as LIMITS, MOBILE_WORKSPACE_V2_READ_OPERATIONS, MOBILE_WORKSPACE_V2_SCHEMA,
  validateMobileWorkspaceV2Args,
  type MobileWorkspaceV2Group, type MobileWorkspaceV2Refusal, type MobileWorkspaceV2Row, type MobileWorkspaceV2Tree,
} from "../../shared/mobile-workspace-v2";

/*
 * Phone reads and commands of the redesigned Workspace (workspace2.read / workspace2.command, decision). A projection over what the
 * Desktop already keeps: the Home tree's rows (home/home-tree.ts), the installed agents, an agent's folder state / proposals / history
 * (agents/workspace-service.ts), the owner's memory inspector (one/memory-inspector.ts). Nothing here has a table, a timer or a model call:
 * every answer is read when asked, bounded, and passed through the bridge's own text redaction. The phone is the owner: lines are shown in
 * full up to a page size, but the answer still crosses the encrypted bridge only for a phone paired to this Desktop's signed-in account
 * (authority.ts checks that before any operation here runs).
 *
 * Expected refusals are answers `{ ok: false, code }` (machine codes, MobileWorkspaceV2Refusal), never prose, so a phone without the
 * `refusal.specific.v1` capability reads them too. A malformed request is refused by the wire parser before it gets here.
 * No Electron import: the daemon hosts the phone bridge too.
 */

export interface WorkspaceV2Deps {
  hostId: string;
  /** Pending approvals and questions per conversation, the same sources the snapshot's pending lists read. */
  attentionByChat(): Promise<ReadonlyMap<string, number>>;
  /** Ask the bridge to publish its existing snapshot-updated notice (the phone re-reads what it shows). */
  changed(): void;
}

type Json = Record<string, unknown>;
const refuse = (code: MobileWorkspaceV2Refusal): { ok: false; code: MobileWorkspaceV2Refusal } => ({ ok: false, code });

/** One line of display text: redacted by the bridge's own rules, whitespace folded, cut by characters. */
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value) return "";
  const clean = sanitizeMobileBridgeText(value, max * 4 + 16).replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const offsetOf = (cursor: unknown): number => typeof cursor === "string" && /^o[0-9]{1,6}$/.test(cursor) ? Number(cursor.slice(1)) : 0;
const pageOf = <T>(items: readonly T[], cursor: unknown, limit: number): { items: T[]; next: string | null } => {
  const start = offsetOf(cursor), end = start + limit;
  return { items: items.slice(start, end), next: end < items.length ? `o${end}` : null };
};
const asRecord = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

// ───────────────────────────────────────────── Workspace list

interface HomeRow { id: string; kind: "solo" | "group" | "work"; projectId: string | null; title: string; taskId: string | null; agentNames: string[]; agentNamesEn?: string[]; agentIds?: string[]; memberCount: number; updatedAt: string }

function leadRoomIds(ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const row of getDb().prepare(`SELECT key FROM meta WHERE key IN (${chunk.map(() => "?").join(",")})`).all(...chunk.map((id) => LEAD_ROOM_KEY_PREFIX + id)) as Array<{ key: string }>) out.add(row.key.slice(LEAD_ROOM_KEY_PREFIX.length));
    }
  } catch { /* a store without `meta` has no lead rooms */ }
  return out;
}

/** The faces of the agents of these rows, the chosen faces of all of them read together once (a list of many rows reads the store once, not once per row). */
function rowFaces(rows: readonly HomeRow[]): ReadonlyMap<string, AgentFace | null> {
  const wanted = new Set(rows.flatMap((row) => row.kind === "work" ? [] : (row.agentIds ?? []).slice(0, 3)));
  wanted.delete("");
  if (!wanted.size) return new Map();
  let installed: Installed[] = [];
  try { installed = listInstalledAgentsReadOnly().filter((agent) => wanted.has(agent.id)); } catch { /* no faces then */ }
  return projectAgentFaces(installed);
}

function phoneRow(row: HomeRow, attention: ReadonlyMap<string, number>, leads: ReadonlySet<string>, faces: ReadonlyMap<string, AgentFace | null>): MobileWorkspaceV2Row {
  const waiting = attention.get(row.id) ?? 0;
  const names = row.agentNames.slice(0, 3);
  const namesEn = row.agentNamesEn?.slice(0, 3);
  const ids = row.kind === "work" ? [] : (row.agentIds ?? []).slice(0, 3);
  const agentFaces = ids.length === names.length ? ids.map((id) => faces.get(id) ?? null) : [];
  return {
    id: row.id, kind: row.kind, title: text(row.title, 120), taskId: row.taskId,
    agentNames: names.map((name) => text(name, 80)),
    ...(namesEn && namesEn.length === names.length && namesEn.some((name, index) => name !== names[index]) ? { agentNamesEn: namesEn.map((name) => text(name, 80)) } : {}),
    ...(agentFaces.some((face) => face !== null) ? { agentFaces } : {}),
    memberCount: row.memberCount, updatedAt: row.updatedAt,
    ...(leads.has(row.id) ? { lead: true as const } : {}), ...(waiting > 0 ? { attention: waiting } : {}),
  };
}

async function readTree(deps: WorkspaceV2Deps, args: Json): Promise<MobileWorkspaceV2Tree | { schemaVersion: 1; unchanged: true; revision: string }> {
  const db = getDb();
  const snapshot = homeTree(db);
  const projects = (() => { try { return db.prepare("SELECT id, name FROM projects ORDER BY updated_at DESC").all() as Array<{ id: string; name: string }>; } catch { return []; } })();
  const attention = await deps.attentionByChat();
  const known = new Set(projects.map((project) => project.id));
  const open = num(args.openProjects) ?? LIMITS.treeOpenProjectsDefault, per = num(args.rowsPerKind) ?? LIMITS.rowsPerKindDefault;
  const byGroup = new Map<string | null, { chats: HomeRow[]; work: HomeRow[] }>();
  // Newest first already (homeTree orders by activity); a row whose project is gone falls into No project instead of vanishing.
  for (const row of snapshot.rows) {
    const id = row.projectId && known.has(row.projectId) ? row.projectId : null;
    let bucket = byGroup.get(id);
    if (!bucket) byGroup.set(id, bucket = { chats: [], work: [] });
    (row.kind === "work" ? bucket.work : bucket.chats).push(row);
  }
  const empty = { chats: [] as HomeRow[], work: [] as HomeRow[] };
  let openLeft = open;
  const plan = [...projects.slice(0, LIMITS.treeProjectsMax).map((project) => ({ id: project.id as string | null, name: project.name as string | null })), { id: null, name: null }].map((entry) => {
    const bucket = byGroup.get(entry.id) ?? empty;
    const hasRows = bucket.chats.length + bucket.work.length > 0;
    // The newest projects that have conversations are drawn open; No project always is; the others wait for projectRows.
    const inline = entry.id === null || (hasRows && openLeft > 0);
    if (entry.id !== null && inline) openLeft -= 1;
    return { ...entry, bucket, inline };
  });
  const leads = leadRoomIds(plan.flatMap((entry) => entry.inline ? [...entry.bucket.chats.slice(0, per), ...entry.bucket.work.slice(0, per)] : []).filter((row) => row.kind === "group").map((row) => row.id));
  const faces = rowFaces(plan.flatMap((entry) => entry.inline ? [...entry.bucket.chats.slice(0, per), ...entry.bucket.work.slice(0, per)] : []));
  const groups = plan.map((entry): MobileWorkspaceV2Group => {
    const { bucket } = entry;
    let waiting = 0;
    for (const row of bucket.chats) waiting += attention.get(row.id) ?? 0;
    for (const row of bucket.work) waiting += attention.get(row.id) ?? 0;
    return {
      id: entry.id, name: entry.name === null ? null : text(entry.name, 120), agentChats: bucket.chats.length, workSessions: bucket.work.length, attention: waiting, collapsed: !entry.inline,
      ...(entry.inline ? { rows: {
        chats: bucket.chats.slice(0, per).map((row) => phoneRow(row, attention, leads, faces)), work: bucket.work.slice(0, per).map((row) => phoneRow(row, attention, leads, faces)),
        chatsMore: bucket.chats.length > per, workMore: bucket.work.length > per,
      } } : {}),
    };
  });
  const tree: Omit<MobileWorkspaceV2Tree, "revision"> = {
    schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, hostId: deps.hostId, projects: groups.slice(0, -1), projectsOmitted: Math.max(0, projects.length - LIMITS.treeProjectsMax),
    noProject: groups[groups.length - 1]!, truncated: snapshot.truncated,
  };
  // The revision hashes what the phone would draw (the open-project choice is part of the request, so part of the hash).
  const revision = digest([tree, open, per]);
  if (typeof args.ifRevision === "string" && args.ifRevision === revision) return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, unchanged: true, revision };
  return { ...tree, revision };
}

async function readProjectRows(deps: WorkspaceV2Deps, args: Json): Promise<Json> {
  const db = getDb();
  const projectId = args.projectId === null ? null : String(args.projectId);
  const known = new Set((() => { try { return (db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map((row) => row.id); } catch { return []; } })());
  if (projectId !== null && !known.has(projectId)) return refuse("unavailable");
  const wantWork = args.kind === "work";
  const rows = homeTree(db).rows.filter((row) => (row.kind === "work") === wantWork && (projectId === null ? !row.projectId || !known.has(row.projectId) : row.projectId === projectId));
  const page = pageOf(rows, args.cursor, num(args.limit) ?? LIMITS.rowsPerKindDefault);
  const attention = await deps.attentionByChat(), leads = leadRoomIds(page.items.filter((row) => row.kind === "group").map((row) => row.id)), pageFaces = rowFaces(page.items);
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, projectId, kind: args.kind, total: rows.length, rows: page.items.map((row) => phoneRow(row, attention, leads, pageFaces)), next: page.next };
}

async function readSearch(deps: WorkspaceV2Deps, args: Json): Promise<Json> {
  const found = homeSearch(getDb(), String(args.text)).slice(0, LIMITS.searchRowsMax);
  const attention = await deps.attentionByChat(), leads = leadRoomIds(found.filter((row) => row.kind === "group").map((row) => row.id)), searchFaces = rowFaces(found);
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, rows: found.map((row) => ({ ...phoneRow(row, attention, leads, searchFaces), projectId: row.projectId })) };
}

// ───────────────────────────────────────────── Agents

type Installed = ReturnType<typeof listInstalledAgentsReadOnly>[number];

/** The agents the owner sees in Manage agents: not hidden (Finance, Science, private), not archived, not the personal agent. */
function visibleAgents(): Installed[] {
  return withoutArchivedAgents(listInstalledAgentsReadOnly()).filter((agent) => agent.id !== BUILTIN_ONE_AGENT_ID && agent.slug !== "agentlas-one" && isUserFacingProjectAgent(agent));
}
const sourceOf = (agent: Installed): "computer" | "cloud" | "hub" => agent.assetSource === "hub" ? "hub" : agent.assetSource === "agent-cloud" ? "cloud" : "computer";
function portraitOf(agentId: string): string | null {
  try { return resolveOneTeamAvatarProtocolPath(`agentlas://one-avatar/${agentId}`) ? `one-avatar:${agentId}` : null; } catch { return null; }
}
function folderOf(agentId: string): AgentFolderState | null {
  try { return agentFolderStatus(agentId)?.state ?? null; } catch { return null; }
}
/**
 * `face` = the picture the Desktop draws for this agent, decided by shared/agent-face.ts from the owner's chosen face or the agent's own name
 * (seed = the unfolded, uncut name, not the `name` text below). Optional: a phone that does not know it ignores the key (it reads a head field by field).
 * `faces` is read once for the whole list by the caller.
 */
/**
 * `nameEn` / `taglineEn` = what a phone in English shows, by the same rule as the Desktop library (shared/agent-display-name.ts): the owner's own
 * name wins in both languages, then the agent's English name. They are sent only when they differ from `name` / `tagline`, so an agent written in
 * Korean only stays Korean. Optional keys: a phone that does not know them reads `name` and `tagline` as before.
 */
function englishHead(agent: Installed): Json {
  const name = text(agentDisplayName(agent), 80);
  const nameEn = text(agentDisplayName(agent, "en"), 80);
  const tagline = text(agent.tagline, 140);
  const taglineEn = text(agent.taglineEn, 140);
  return { ...(nameEn && nameEn !== name ? { nameEn } : {}), ...(taglineEn && taglineEn !== tagline ? { taglineEn } : {}) };
}
function agentHead(agent: Installed, faces: ReadonlyMap<string, AgentFace | null>): Json {
  return {
    id: agent.id, handle: text(agent.slug, 80), name: text(agentDisplayName(agent), 80), ...englishHead(agent), tagline: text(agent.tagline, 140), tone: text(agent.tone, 40),
    portrait: portraitOf(agent.id), ...faceField(faces.get(agent.id)), kind: agent.kind === "team" ? "team" : "agent", source: sourceOf(agent), folder: folderOf(agent.id),
  };
}

function readAgents(args: Json): Json {
  const filter = str(args.filter);
  const all = visibleAgents().filter((agent) => !filter || sourceOf(agent) === filter)
    .sort((a, b) => agentDisplayName(a).localeCompare(agentDisplayName(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  // The revision covers the whole list (faces and folder states included), never one page of it.
  const faces = projectAgentFaces(all);
  const heads = all.map((agent) => agentHead(agent, faces));
  const revision = digest(heads);
  const page = pageOf(heads, args.cursor, num(args.limit) ?? LIMITS.agentsPageDefault);
  const rows = page.items;
  if (args.cursor === undefined && typeof args.ifRevision === "string" && args.ifRevision === revision) return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, unchanged: true, revision };
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, revision, total: all.length, agents: rows, next: page.next };
}

function findAgent(agentId: string): Installed | null {
  return visibleAgents().find((agent) => agent.id === agentId) ?? null;
}

/** The agent's folder, read the way Manage agents reads it; a folder that is not there is a code, and nothing is created for it. */
async function workspaceOf(agentId: string): Promise<{ ok: true; workspace: ReturnType<typeof getAgentWorkspace> } | { ok: false; code: MobileWorkspaceV2Refusal }> {
  if (folderOf(agentId) !== "ok") return { ok: false, code: "folder_unavailable" };
  try { return { ok: true, workspace: await withWorkspaceLockPatience(() => getAgentWorkspace(agentId)) }; }
  catch (error) {
    if (error instanceof AgentWorkspaceError) return { ok: false, code: error.code === "update_busy" ? "workspace_busy" : "folder_unavailable" };
    throw error;
  }
}

const memoryTotal = (agentId: string): number => { try { return queryOwnedMemory({ actorId: agentId, status: "active", limit: 1 }).total; } catch { return 0; } };

const skillNames = (proposal: Pick<AgentWorkspaceProposal, "skillPromotion" | "changeSummary">): string[] =>
  (proposal.skillPromotion?.skills ?? []).map((skill) => text(skill.name, 80)).filter(Boolean);

async function readAgentProfile(args: Json): Promise<Json> {
  const agent = findAgent(String(args.agentId));
  if (!agent) return refuse("agent_not_found");
  const opened = await workspaceOf(agent.id);
  const workspace = opened.ok ? opened.workspace : null;
  const skills = workspace ? workspace.files.filter((file) => file.kind === "file" && /^skills\/[^/]+\/SKILL\.md$/i.test(file.path)).length : null;
  const folder = folderOf(agent.id);
  return {
    schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, ...agentHead(agent, projectAgentFaces([agent])), createdAt: agent.installedAt,
    folder: { state: folder, reconnectable: folder === "root-unavailable" || folder === "folder-missing" },
    activation: workspace?.activation ?? null,
    counts: { memories: memoryTotal(agent.id), skills, files: workspace ? workspace.files.filter((file) => file.kind === "file").length : null },
    pendingApprovals: workspace ? workspace.proposals.filter((proposal) => proposal.status === "review_ready").length : null,
    ...(workspace?.autoEvolution ? { autoEvolution: workspace.autoEvolution.enabled } : {}),
  };
}

// ───────────────────────────────────────────── Timeline, memory, skills

/** The one proposal the phone may approve by itself: a change that only creates skill files, with the redaction facts it shows. */
function skillOnly(proposal: AgentWorkspaceProposal): boolean {
  return Boolean(proposal.skillPromotion?.skills.length) && proposal.changes.length > 0
    && proposal.changes.every((change) => change.operation === "create" && /^skills\/[^/]+\/SKILL\.md$/i.test(change.path));
}

function approvalItem(proposal: AgentWorkspaceProposal): Json {
  const promotion = proposal.skillPromotion;
  const added = (proposal.changeSummary ?? []).reduce((sum, change) => sum + change.addedLines, 0), removed = (proposal.changeSummary ?? []).reduce((sum, change) => sum + change.removedLines, 0);
  return {
    kind: "approval", id: `p:${proposal.id}`, at: proposal.createdAt, proposalId: proposal.id, reviewedHash: proposal.proposalDigest,
    summary: text(proposal.summary, 200),
    skills: (promotion?.skills ?? []).slice(0, 10).map((skill) => ({ name: text(skill.name, 80), description: text(skill.description, 200) })),
    redactedCount: promotion?.redactedCount ?? 0, namesIncomplete: promotion?.namesIncomplete === true, mayLeaveThisComputer: promotion ? true : false,
    files: (proposal.changeSummary ?? proposal.changes).length, addedLines: added, removedLines: removed,
    canAddHere: skillOnly(proposal),
    // Audit 62 (bridge B12): the approval the phone pressed is waiting for the run to end (in memory): the item says so, so a phone that was told "queued" can tell a kept approval from one that is gone (a restart drops it: `queued` is false again and the change is `review_ready`).
    queued: hasDeferredApproval(proposal.id),
    ...(proposal.card ? { lesson: { situation: text(proposal.card.situation, 240), observed: text(proposal.card.observed, 240), after: text(proposal.card.after, 240) } } : {}),
  };
}

function evolvedItem(revision: AgentWorkspaceRevision): Json {
  const changed = revision.experience?.changed ?? [];
  return {
    kind: "evolved", id: `r:${revision.id}`, at: revision.createdAt, operation: revision.operation, summary: text(revision.summary, 200),
    skills: changed.flatMap((change) => change.skill ? [text(change.skill.name, 80)] : []).slice(0, 10),
    changed: changed.slice(0, 8).map((change) => ({ operation: change.operation, path: text(change.path, 120) })),
    ...(revision.experience?.lesson ? { lesson: text(revision.experience.lesson, 240) } : {}),
    ...(revision.outcome ? { runs: revision.outcome.runs, failed: revision.outcome.failed } : {}),
  };
}

/**
 * "Memory summary" posts. No model is called and nothing is stored for this: a post per project the agent has memories in, made of the
 * count and the newest line titles of the agent's newest 300 memory lines (the same read Manage agents' Memory tab makes first).
 */
function memoryItems(agentId: string): Json[] {
  let result: ReturnType<typeof queryOwnedMemory>;
  try { result = queryOwnedMemory({ actorId: agentId, status: "active", limit: 300 }); } catch { return []; }
  const groups = new Map<string, { project: string | null; count: number; at: string; titles: string[] }>();
  for (const entry of result.entries) {
    const key = entry.projectSlug ?? "";
    let group = groups.get(key);
    if (!group) groups.set(key, group = { project: entry.projectSlug, count: 0, at: entry.createdAt, titles: [] });
    group.count += 1;
    if (entry.createdAt > group.at) group.at = entry.createdAt;
    if (group.titles.length < 3) group.titles.push(text(entry.title, 120));
  }
  return [...groups.entries()].map(([key, group]) => ({
    kind: "memory", id: `m:${digest(key).slice(0, 16)}`, at: group.at, project: group.project ? text(group.project, 80) : null, count: group.count, latest: group.titles,
    countIsPartial: result.total > result.entries.length,
  })).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40);
}

async function readTimeline(args: Json): Promise<Json> {
  const agent = findAgent(String(args.agentId));
  if (!agent) return refuse("agent_not_found");
  const opened = await workspaceOf(agent.id);
  const items: Json[] = [];
  if (opened.ok) {
    for (const proposal of opened.workspace.proposals.filter((entry) => entry.status === "review_ready").slice(0, 50)) items.push(approvalItem(proposal));
    for (const revision of opened.workspace.history.filter((entry) => entry.operation === "apply" || entry.operation === "rollback").slice(0, 100)) items.push(evolvedItem(revision));
  }
  items.push(...memoryItems(agent.id));
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(a.id).localeCompare(String(b.id)));
  const page = pageOf(items, args.cursor, num(args.limit) ?? LIMITS.timelinePageDefault);
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, agentId: agent.id, folderAvailable: opened.ok, total: items.length, items: page.items, next: page.next };
}

function readMemory(args: Json): Json {
  const agent = findAgent(String(args.agentId));
  if (!agent) return refuse("agent_not_found");
  const limit = num(args.limit) ?? LIMITS.memoryPageDefault, start = offsetOf(args.cursor);
  const reach = Math.min(LIMITS.memoryReachMax, start + limit);
  let result: ReturnType<typeof queryOwnedMemory>;
  try { result = queryOwnedMemory({ actorId: agent.id, status: "active", limit: reach }); } catch { return refuse("unavailable"); }
  const lines = result.entries.slice(start, start + limit).map((entry) => {
    const body = text(entry.content, LIMITS.lineTextMax + 1), cut = Array.from(entry.content).length > LIMITS.lineTextMax;
    return { memoryId: entry.memoryId, kind: entry.kind, scope: entry.scope, text: cut ? text(entry.content, LIMITS.lineTextMax) : body, ...(cut ? { textTruncated: true } : {}),
      createdAt: entry.createdAt, project: entry.projectSlug ? text(entry.projectSlug, 80) : null };
  });
  const next = start + limit < Math.min(result.total, LIMITS.memoryReachMax) ? `o${start + limit}` : null;
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, agentId: agent.id, total: result.total, reachable: Math.min(result.total, LIMITS.memoryReachMax), lines, next };
}

async function readSkills(args: Json): Promise<Json> {
  const agent = findAgent(String(args.agentId));
  if (!agent) return refuse("agent_not_found");
  const opened = await workspaceOf(agent.id);
  if (!opened.ok) return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, agentId: agent.id, folderAvailable: false, skills: [], candidates: [], watching: [], dismissed: [], skipped: [], redactedCount: 0, namesIncomplete: false };
  const workspace = opened.workspace;
  const skills = (() => { try { return listAgentWorkspaceSkillSummaries(agent.id, LIMITS.skillsMax); } catch { return []; } })();
  const open = workspace.proposals.filter((proposal) => proposal.status === "review_ready" && proposal.skillPromotion);
  const watching = new Map<string, AgentWorkspaceMemoryCandidate>();
  for (const candidate of workspace.memoryCandidates) {
    if (candidate.state !== "watching" && candidate.state !== "eligible") continue;
    const key = candidate.groupId ?? candidate.id;
    if (!watching.has(key)) watching.set(key, candidate);
  }
  return {
    schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, agentId: agent.id, folderAvailable: true,
    skills: skills.map((skill) => ({ name: text(skill.name, 80), description: text(skill.description, 200), path: text(skill.path, 160) })),
    candidates: open.slice(0, 20).map(approvalItem),
    watching: [...watching.values()].slice(0, 20).map((candidate) => ({ id: candidate.id, title: text(candidate.title, 120), state: candidate.state, runs: candidate.promotion?.runs ?? 0, needRuns: candidate.promotion?.needRuns ?? 0 })),
    dismissed: workspace.proposals.filter((proposal) => proposal.status === "rejected" && (proposal.skillPromotion || (proposal.changeSummary ?? []).some((change) => change.skill))).slice(0, 30)
      .map((proposal) => ({ proposalId: proposal.id, at: proposal.createdAt, summary: text(proposal.summary, 200), skills: skillNames(proposal) })),
    skipped: (workspace.skippedSkills ?? []).slice(0, 50).map((skipped) => ({ path: text(skipped.path, 160), code: text(skipped.code, 60) })),
    redactedCount: open.reduce((sum, proposal) => sum + (proposal.skillPromotion?.redactedCount ?? 0), 0),
    namesIncomplete: open.some((proposal) => proposal.skillPromotion?.namesIncomplete === true),
  };
}

// ───────────────────────────────────────────── What I know

const PERSONAL_SCOPE = "user_identity";
/**
 * Which of the two lists a Personal line belongs to, by the same rule the readers obey (shared/memory-classification.ts personalReadable). With the workspace-rules switch on (Agentlas 2.0 P3a) no
 * Personal line is read by every agent any more - the preference lines are the personal agent's own, so they are listed under `about` and `rules` is empty; the response keys do not change.
 * `personalRead: true` asks the personal agent's own conversation's question: the list a line belongs to, not whether this reader may read it.
 */
function knowledgeListOf(kind: string, rulesOn = false): "rules" | "about" | null {
  const rules = memoryClassificationRules();
  const options = rulesOn ? { rulesOn: true, personalRead: true } : {};
  const everyone = personalReadable(rules, PERSONAL_SCOPE, kind, "any-other-agent", options);
  const personalOnly = personalReadable(rules, PERSONAL_SCOPE, kind, BUILTIN_ONE_AGENT_ID, options);
  return everyone ? "rules" : personalOnly ? "about" : null;
}

function readKnowledge(args: Json): Json {
  let result: ReturnType<typeof queryOwnedMemory>;
  try { result = queryOwnedMemory({ actorId: null, scope: PERSONAL_SCOPE, status: "active", limit: LIMITS.memoryReachMax }); } catch { return refuse("unavailable"); }
  const sorted = { rules: [] as typeof result.entries, about: [] as typeof result.entries };
  const rulesOn = workspaceRulesOn() && memoryClassificationRules() !== null;
  for (const entry of result.entries) { const list = knowledgeListOf(entry.kind, rulesOn); if (list) sorted[list].push(entry); }
  const which = str(args.list) as "rules" | "about" | undefined;
  const limit = num(args.limit) ?? LIMITS.knowledgePageDefault;
  const page = which ? pageOf(sorted[which], args.cursor, limit) : null;
  return {
    schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, counts: { rules: sorted.rules.length, about: sorted.about.length }, truncated: result.truncated,
    ...(which && page ? {
      list: which, next: page.next,
      items: page.items.map((entry) => ({
        memoryId: entry.memoryId, expectedRevision: entry.expectedRevision, kind: entry.kind, text: text(entry.content, LIMITS.lineTextMax),
        ...(Array.from(entry.content).length > LIMITS.lineTextMax ? { textTruncated: true } : {}), createdAt: entry.createdAt,
        // Redesign backend C: the names of the skills made from this line, read before it is forgotten (the same skills the desktop's forget answer lists). `[]` = none; the key is absent when not known. Names only.
        ...(entry.derivedSkills ? { derivedSkills: [...new Set(entry.derivedSkills.map((skill) => text(skill.skillName, 80)).filter(Boolean))].slice(0, 20) } : {}),
      })),
    } : {}),
  };
}

function forgetKnowledge(deps: WorkspaceV2Deps, args: Json): Json {
  let row: ReturnType<typeof ownedMemoryRecord>;
  // K7'' (audit D11): one answer for "no such line" and "a line that is not Personal" - the phone is told nothing about whether a non-Personal id exists on the computer. No app screen calls this method yet (mobile `lib`: 0 calls);
  // the other keys this method answers are unchanged.
  try { row = ownedMemoryRecord(String(args.memoryId)); } catch { return refuse("line_not_found"); }
  if (row.scope !== PERSONAL_SCOPE) return refuse("line_not_found");
  // Already forgotten (here or on the computer): the same end state, so asking twice is not an error.
  if (!row.content) return { ok: true, changed: false, memoryId: row.id };
  if (memoryTargetRevision(row) !== args.expectedRevision) return refuse("line_changed");
  const actorId = learningActor(row);
  if (!actorId) return refuse("unavailable");
  try {
    forgetOwnedMemory({ memoryId: row.id, ownerRef: currentMemoryOwnerRef(), actorId, expectedRevision: String(args.expectedRevision), expectedEpoch: getMemoryStoreInfo().revocationEpoch });
  } catch (error) {
    // Two phones, or the phone and the computer, forgot the same line a moment apart.
    try { if (!ownedMemoryRecord(row.id).content) return { ok: true, changed: false, memoryId: row.id }; } catch { /* fall through */ }
    return refuse(error instanceof Error && error.message === "memory_owner_revision_changed" ? "line_changed" : "unavailable");
  }
  try { emitDesktopStoreChange({ entity: "agent", id: actorId }); } catch { /* no window here */ }
  deps.changed();
  return { ok: true, changed: true, memoryId: row.id };
}

// ───────────────────────────────────────────── Add skill / Dismiss

type Settled = "applied" | "rejected";
const settledOf = (status: AgentWorkspaceProposal["status"]): Settled | null => status === "applied" ? "applied" : status === "rejected" ? "rejected" : null;

/** One decision at a time per proposal in this process: a second request for the same proposal waits and then reads the settled state (the folder lock covers other processes). */
const deciding = new Map<string, Promise<unknown>>();
async function decideSkill(deps: WorkspaceV2Deps, args: Json): Promise<Json> {
  const key = String(args.proposalId);
  const previous = deciding.get(key) ?? Promise.resolve();
  const run = previous.then(() => decideSkillNow(deps, args), () => decideSkillNow(deps, args));
  const tail = run.finally(() => { if (deciding.get(key) === tail) deciding.delete(key); });
  deciding.set(key, tail);
  return run;
}
async function decideSkillNow(deps: WorkspaceV2Deps, args: Json): Promise<Json> {
  const agent = findAgent(String(args.agentId));
  if (!agent) return refuse("agent_not_found");
  const proposalId = String(args.proposalId), reviewedHash = String(args.reviewedHash), add = args.decision === "add";
  const opened = await workspaceOf(agent.id);
  if (!opened.ok) return refuse(opened.code);
  const proposal = opened.workspace.proposals.find((entry) => entry.id === proposalId);
  // A proposal of another agent is not found here: the request names its agent and the two must agree.
  if (!proposal) return refuse("proposal_not_found");
  const done = (state: string, changed: boolean, extra: Json = {}): Json => { if (changed) deps.changed(); return { ok: true, proposalId, state, changed, skills: skillNames(proposal), ...extra }; };
  const settled = settledOf(proposal.status);
  if (settled) {
    // The same decision again (a resend, or the computer decided first the same way) is the settled state; the other one is a code.
    if (add) return settled === "applied" ? done("applied", false) : refuse("already_dismissed");
    return settled === "rejected" ? done("dismissed", false) : refuse("already_added");
  }
  if (proposal.status === "applying") return add ? done("applying", false) : refuse("proposal_stale");
  if (proposal.status === "recovery_required") return refuse("recovery_required");
  if (add) {
    if (proposal.status === "stale") return refuse("proposal_stale");
    if (!skillOnly(proposal)) return refuse("needs_computer_review");
    // The hash of the change the phone showed must still be the change that would be applied.
    if (proposal.proposalDigest !== reviewedHash) return refuse("proposal_changed");
    try {
      const diff = await withWorkspaceLockPatience(() => getAgentWorkspaceDiff(proposalId));
      if (diff.status === "stale") return refuse("proposal_stale");
      if (diff.status !== "review_ready" || diff.reviewedHash !== reviewedHash) return refuse("proposal_changed");
      const result = await approveReviewedAgentWorkspaceProposal({ proposalId, reviewedHash });
      try { emitDesktopStoreChange({ entity: "agent", id: agent.id }); } catch { /* no window here */ }
      return "applyWhenIdle" in result && result.applyWhenIdle ? done("queued_until_idle", true) : done("applied", true);
    } catch (error) {
      // A second request got here while the first was applying: read the state again instead of guessing.
      const again = (await workspaceOf(agent.id));
      const now = again.ok ? again.workspace.proposals.find((entry) => entry.id === proposalId) : null;
      if (now?.status === "applied") return done("applied", false);
      if (now?.status === "rejected") return refuse("already_dismissed");
      if (error instanceof AgentWorkspaceError) {
        if (error.code === "update_busy") return refuse("workspace_busy");
        if (error.code === "approval_stale" || error.code === "base_changed" || error.code === "preview_changed") return refuse("proposal_stale");
        if (error.code === "recovery_required" || error.code === "write_race" || error.code === "readback_mismatch") return refuse("recovery_required");
      }
      return refuse("unavailable");
    }
  }
  try {
    await withWorkspaceLockPatience(() => rejectAgentWorkspaceProposal(proposalId));
    try { emitDesktopStoreChange({ entity: "agent", id: agent.id }); } catch { /* no window here */ }
    return done("dismissed", true);
  } catch (error) {
    const again = (await workspaceOf(agent.id));
    const now = again.ok ? again.workspace.proposals.find((entry) => entry.id === proposalId) : null;
    if (now?.status === "rejected") return done("dismissed", false);
    if (now?.status === "applied") return refuse("already_added");
    if (error instanceof AgentWorkspaceError && error.code === "update_busy") return refuse("workspace_busy");
    return refuse("unavailable");
  }
}


// ───────────────────────────────────────────── XS-1: values the confirmed phone pictures wait for
// Every one of these is a read of something the Desktop already keeps (the "Always allowed" list of Settings, the automation scheduler's run row,
// the group room's member list, the personal agent's profile, the Work window's New chat). Nothing here has a table, a timer or a model call.

/** One line of "Always allowed" the way the Desktop's Settings list names it: the tool's name with underscores folded, and the MCP server it came from. */
function allowedTool(capability: string): { tool: string; server: string | null } {
  const name = capability.slice("tool:".length);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return { tool: text((mcp ? mcp[2]! : name).replace(/_+/g, " ").trim() || name, 80), server: mcp ? text(mcp[1], 80) : null };
}

/** Picture 36, "Always allowed N": the answers "always allow" that cover this project (the rows Settings > Always allowed shows under the project's name). */
function readProjectAllowed(args: Json): Json {
  const projectId = String(args.projectId);
  let known = false;
  try { known = Boolean(getDb().prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)); } catch { known = false; }
  if (!known) return refuse("project_not_found");
  let rows: ReturnType<typeof listCapabilityGrants>;
  try { rows = listCapabilityGrants(); } catch { return refuse("unavailable"); }
  // The same filter as the Desktop's list: an allow, of a tool, that the owner answered (not the personal agent's delegation), whose scope is this project.
  const mine = rows.filter((row) => row.decision === "allow" && row.capability.startsWith("tool:") && row.source !== "one-delegation"
    && (() => { const scope = parseApprovalScopeIdentity(row.binding?.workspaceIdentity); return scope?.kind === "project" && scope.id === projectId; })());
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, projectId, count: mine.length, tools: mine.slice(0, 50).map((row) => allowedTool(row.capability)) };
}

/**
 * Picture 60, "N minutes in": when the run that is running now started. The state is the scheduler's own (getAutomationLiveRunState), and the start is the `started_at`
 * of the very row that state names (the newest running row), so the two cannot disagree. `elapsedSeconds` is counted here, so a phone with a different clock draws the same minutes.
 */
function readAutomationRun(args: Json): Json {
  const id = String(args.automationId);
  let automation: ReturnType<typeof getAutomation> = null;
  try { automation = getAutomation(id); } catch { return refuse("unavailable"); }
  if (!automation) return refuse("automation_not_found");
  let state: ReturnType<typeof getAutomationLiveRunState> = null;
  let runId: string | null = null;
  let startedAt: string | null = null;
  try {
    state = getAutomationLiveRunState(id);
    if (state === "running") {
      runId = getAutomationLiveRunId(id);
      const row = getDb().prepare("SELECT started_at AS startedAt FROM automation_runs WHERE automation_id = ? AND status = 'running' ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1").get(id) as { startedAt: string | null } | undefined;
      startedAt = row?.startedAt ?? null;
    }
  } catch { return refuse("unavailable"); }
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : null;
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, automationId: id, state, runId, startedAt: elapsed === null ? null : startedAt, elapsedSeconds: elapsed };
}

const MEMBERS_MAX = 8;
/**
 * Picture 4, the faces in a group conversation's head. The members of the room, in room order, with the same face values the agent list carries (`tone`, `portrait`):
 * a room made from the New chat button names them in `one_taskforces`, a seat's room in the chat's own `participants`, a firm's room in the firm's org chart.
 * A conversation that is not a group answers an empty list, not an error.
 */
function readChatMembers(args: Json): Json {
  const chatId = String(args.chatId);
  let chat: ReturnType<typeof getChat> = null;
  try { chat = getChat(chatId); } catch { return refuse("unavailable"); }
  if (!chat) return refuse("chat_not_found");
  const named: Array<{ agentId: string; name: string | null }> = [];
  const seen = new Set<string>();
  const add = (agentId: string | null | undefined, name: string | null) => { if (agentId && !seen.has(agentId)) { seen.add(agentId); named.push({ agentId, name }); } };
  try { for (const member of homeParticipants(getDb(), chatId)) add(member.agentId, member.name); } catch { /* a store without rooms has none */ }
  // A seat's participants are a room's members only when the seat is a group; a firm's conversation sits in its CEO's one-to-one seat, so its members are the org chart's.
  if (!named.length && chat.seatKind === "group") for (const participant of chat.participants ?? []) add(participant.agentId, participant.displayName || null);
  if (!named.length && chat.firmId) {
    try { for (const node of getFirm(chat.firmId)?.orgChart ?? []) add(node.agentId, null); } catch { /* a firm that is gone has no faces */ }
  }
  let installed = new Map<string, Installed>();
  try { installed = new Map(listInstalledAgentsReadOnly().map((agent) => [agent.id, agent] as const)); } catch { /* names alone then */ }
  const shown = named.slice(0, MEMBERS_MAX);
  const faces = projectAgentFaces(shown.flatMap(({ agentId }) => installed.get(agentId) ?? []));
  const members = shown.map(({ agentId, name }) => {
    const agent = installed.get(agentId);
    return agent ? agentHead(agent, faces) : { id: agentId, name: text(name, 80), tone: "", portrait: null };
  });
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, ok: true, chatId, total: named.length, members };
}

/**
 * Picture 97, [New chat] with no project: the Desktop's own New chat without a project. A Work conversation that belongs to no project is a conversation the Desktop already has
 * (the tree's "No project" group; it works in its own folder `agent-cwd/<chat id>`, runtime/session-cwd.ts). Its Task is made the way every Work conversation's is. The phone then
 * opens it with `chats.get` and sends the first message through the same `invoke.start` as any conversation, so no run is started here.
 */
function startChat(deps: WorkspaceV2Deps): Json {
  let chatId: string;
  try { chatId = createChat({ originSurface: "work" }).id; } catch { return refuse("unavailable"); }
  let taskId: string | null = null;
  try { taskId = getCanonicalTaskForChat(chatId)?.id ?? null; } catch { /* the phone reads it back with chats.get */ }
  deps.changed();
  return { ok: true, chatId, taskId };
}

/**
 * Picture 107, [Choose character]: the personal agent's face becomes one of the preset characters (the same field the Desktop's profile sheet writes, `avatarIcon`).
 * The home computer only (the write gate `one.avatar.set` obeys); a profile that changed on another device is `stale_version` with the version it has now.
 */
function setCharacter(deps: WorkspaceV2Deps, args: Json): Json {
  const gate = personalWriteRefusal();
  if (gate) return refuse(gate);
  const characterId = String(args.characterId);
  if (!(AGENT_APPEARANCE_CHARACTERS as readonly string[]).includes(characterId)) return refuse("character_unknown");
  const expectedVersion = Number(args.expectedVersion);
  const current = getOneProfile();
  if (current.version !== expectedVersion) return { ok: false, code: "stale_version", version: current.version };
  try {
    const next = updateOneProfile({ expectedVersion, patch: { avatarIcon: `character:${characterId}` } });
    if (next.version !== current.version) deps.changed();
    return { ok: true, version: next.version, avatarIcon: next.avatarIcon, changed: next.version !== current.version };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "one_profile_version_conflict") return { ok: false, code: "stale_version", version: getOneProfile().version };
    return refuse("unavailable");
  }
}

// ───────────────────────────────────────────── Entry

/**
 * `build: true` (redesign backend C) says this Desktop answers build2.list/open/files/file.read; the key is absent otherwise (an older Desktop, or the background
 * service, which does not hold the Build window's state), and a phone does not call them then. Without the option the answer is what it was before.
 * `buildCommands` (PB-D, contracts/phone-build2.md section 6) rides on the same condition: the names a phone may draw and call (`continue` = `build.start { buildKey }`, the rest are
 * `build2.<name>`). A name that is not in the list is not offered.
 */
export function workspaceV2Capability(options: { build?: boolean } = {}): Json {
  return { schemaVersion: MOBILE_WORKSPACE_V2_SCHEMA, read: [...MOBILE_WORKSPACE_V2_READ_OPERATIONS], command: [...MOBILE_WORKSPACE_V2_COMMAND_OPERATIONS], limits: { ...LIMITS }, ...(options.build ? { build: true, buildCommands: [...MOBILE_BUILD_V2_COMMANDS] } : {}) };
}

export function createWorkspaceV2(deps: WorkspaceV2Deps): {
  read(operation: string, args: unknown): Promise<Json>;
  command(operation: string, args: unknown): Promise<Json>;
} {
  const checked = (operation: string, rawArgs: unknown): Json => {
    const problem = validateMobileWorkspaceV2Args(operation, rawArgs);
    if (problem) throw new TypeError(`workspace2: ${problem}`);
    return asRecord(rawArgs);
  };
  return {
    async read(operation, rawArgs) {
      if (!(MOBILE_WORKSPACE_V2_READ_OPERATIONS as readonly string[]).includes(operation)) throw new TypeError("workspace2.read: unknown operation");
      const args = checked(operation, rawArgs);
      switch (operation) {
        case "tree": return readTree(deps, args) as unknown as Json;
        case "projectRows": return readProjectRows(deps, args);
        case "search": return readSearch(deps, args);
        case "agents": return readAgents(args);
        case "agentProfile": return readAgentProfile(args);
        case "timeline": return readTimeline(args);
        case "memory": return readMemory(args);
        case "skills": return readSkills(args);
        case "projectAllowed": return readProjectAllowed(args);
        case "automationRun": return readAutomationRun(args);
        case "chatMembers": return readChatMembers(args);
        default: return readKnowledge(args);
      }
    },
    async command(operation, rawArgs) {
      if (!(MOBILE_WORKSPACE_V2_COMMAND_OPERATIONS as readonly string[]).includes(operation)) throw new TypeError("workspace2.command: unknown operation");
      const args = checked(operation, rawArgs);
      switch (operation) {
        case "skill.decide": return decideSkill(deps, args);
        case "chat.start": return startChat(deps);
        case "profile.character": return setCharacter(deps, args);
        default: return forgetKnowledge(deps, args);
      }
    },
  };
}
