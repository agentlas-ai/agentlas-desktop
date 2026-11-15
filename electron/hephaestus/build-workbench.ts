// Saved Build conversations and the Build window's per-build state (Agentlas 2.0 Build backend, owner decisions
// "Build conversations are saved — a list under the Build home, reopened later to edit"; Edit in Manage agents opens the same window).
//
// What is reused, not added:
//  - the saved conversation itself is the existing `builder-conversation-v1:*` row of the `meta` table (builder-conversation-store.ts),
//    one row per Build TURN. A "build" is the rows that share one folder (device + inode), newest row = its head. No table, no column.
//  - the baseline of an edit session is a revision of the agent's folder that the app already records (agents/workspace-service.ts
//    `currentRevision`): the change list is "now vs that revision", undo writes that revision's bytes back. No copy is made.
//  - the name uses `setAgentLocalDisplayName`, the picture uses `setAgentAvatar` (the same paths Manage agents uses).
//
// What is added: ONE small `meta` row per build (`build-workbench-v1:<owner>:<build>`): the agent it is linked to, the name and picture
// chosen before the agent exists, the edit-session baseline revision id. Read by: the Build list and the Build window. Deleted when:
// the owner removes the build, the linked agent is deleted/retired (releaseAgentReferences), or the sweep finds nothing left to reopen
// (folder gone and no linked agent; unlinked unfinished build untouched for 90 days). The sweep also drops the superseded turn rows of
// a build (only its head row is ever read) — that is also what happens to the rows already on users' machines.
//
// Electron is not imported: everything the app owns (agents, grants, trash, locks) arrives through `WorkbenchEnv`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { builderOwnerKey, builderRowRange, type BuilderConversationOwner, type StoredBuilderConversation } from "./builder-conversation-store";
import { findScopeEscapes, listBuildTree, openBuildScope, readBuildFile, removeBuildFile, writeBuildFile } from "./build-scope";
import type { BuildFileChange, BuildFileNode, BuildListItem, BuildOpened, BuildState, BuildWorkbenchRefusal, BuildWorkbenchResult } from "../../shared/build-workbench";

export const BUILD_STAGE_TOTAL = 6;
export const BUILD_LIST_DEFAULT_LIMIT = 30;
export const BUILD_LIST_MAX_LIMIT = 100;
/** An unlinked build that never finished and was not touched for this long is dropped by the sweep. */
export const BUILD_STALE_MS = 90 * 24 * 60 * 60 * 1000;
export const BUILD_AVATAR_MAX_BYTES = 512 * 1024;
const MAX_MESSAGES_BYTES = 1024 * 1024;
const MAX_ROWS_SCANNED = 2000;

export type { BuildState, BuildListItem, BuildOpened, BuildFileChange, BuildFileNode };
export type WorkbenchRefusal = BuildWorkbenchRefusal;
export type WorkbenchResult<T> = BuildWorkbenchResult<T>;

export interface WorkbenchMeta {
  schema: 1;
  buildKey: string;
  /** Identity keys (device:inode hashes) of every folder whose turn rows belong to this build. */
  aliases: string[];
  kind: "create" | "edit";
  folder: string;
  agentId: string | null;
  /** The folder was made by `openDraft` (the app made it, nothing of the owner's is in it until an agent is registered). */
  draft: boolean;
  name: string | null;
  /** A picture chosen before the agent exists (data URL, at most BUILD_AVATAR_MAX_BYTES decoded); applied and cleared when the agent is created. */
  avatarDataUrl: string | null;
  /** The agent-folder revision an edit session started from; null = no session (or a build that is not installed yet: its baseline is "empty"). */
  baselineRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPort {
  find(agentId: string): { id: string; slug: string; folder: string | null; editable: boolean } | null;
  /** agentFolderMoveBlocker: why this agent's folder must not be changed right now ("run-active", "file-operation-open", ...). */
  blocker(agentId: string, folder: string): string | null;
  rootMoveBusy(): boolean;
  /** The recorded revision id of the folder as it is now (creates the revision when the files changed since the last one). */
  headRevision(agentId: string): string | null;
  revisionFiles(agentId: string, revisionId: string): Map<string, { bytes: Buffer; executable: boolean }> | null;
  withLock<T>(agentId: string, action: () => T): T | { busy: true };
  setName(agentId: string, name: string): void;
  setAvatar(agentId: string, dataUrl: string): { ok: boolean };
  clearAvatar(agentId: string): void;
  agentsRoot(): string | null;
  /** Why `agentsRoot()` is null: "missing" (the chosen folder is gone) or "settings-invalid" (the setting cannot be read), when known. */
  agentsRootReason?(): string | null;
}

export interface WorkbenchEnv {
  db: Database.Database;
  owner: BuilderConversationOwner;
  agents: AgentPort;
  now?: () => number;
  /** A Build turn of this folder is running now (or a Preview of this build). */
  isRunning: (folder: string) => boolean;
  /** Stage events of the running turn of this folder, for "Building n/6"; [] when not running. */
  activeEvents?: (folder: string) => ReadonlyArray<{ kind: string; stage?: string; text?: string }>;
  anyBuildActive: () => boolean;
  trashFolder?: (folder: string) => Promise<boolean>;
  grant?: (folder: string) => unknown;
}

const metaPrefix = (env: WorkbenchEnv): string => `build-workbench-v1:${builderOwnerKey(env.owner)}:`;
const nowIso = (env: WorkbenchEnv): string => new Date((env.now ?? Date.now)()).toISOString();

/** The identity of a folder (device + inode, like the saved conversation's workspaceIdentity), hashed to a short stable key. */
export function folderIdentityKey(folder: string): string | null {
  try {
    const real = fs.realpathSync.native(folder);
    const info = fs.statSync(real, { bigint: true });
    if (!info.isDirectory()) return null;
    return createHash("sha256").update(`${info.dev}:${info.ino}`).digest("hex").slice(0, 24);
  } catch { return null; }
}

function rowIdentityKey(row: StoredBuilderConversation): string {
  return createHash("sha256").update(`${row.workspaceIdentity.dev}:${row.workspaceIdentity.ino}`).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading: rows → builds

function parseRows(env: WorkbenchEnv): { rows: Array<{ key: string; record: StoredBuilderConversation }>; truncated: boolean } {
  const [lo, hi] = builderRowRange(env.owner);
  const rows = env.db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? LIMIT ?").all(lo, hi, MAX_ROWS_SCANNED + 1) as Array<{ key: string; value: string }>;
  const out: Array<{ key: string; record: StoredBuilderConversation }> = [];
  for (const row of rows.slice(0, MAX_ROWS_SCANNED)) {
    try {
      const record = JSON.parse(row.value) as StoredBuilderConversation;
      if (record && record.schema === 1 && typeof record.buildId === "string" && record.workspaceIdentity && Array.isArray(record.history)) out.push({ key: row.key, record });
    } catch { /* an unreadable row is left alone; the owner can still remove the build it belonged to */ }
  }
  return { rows: out, truncated: rows.length > MAX_ROWS_SCANNED };
}

function readMetas(env: WorkbenchEnv): WorkbenchMeta[] {
  const prefix = metaPrefix(env);
  const rows = env.db.prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(prefix, prefix.slice(0, -1) + ";") as Array<{ value: string }>;
  const out: WorkbenchMeta[] = [];
  for (const row of rows) {
    try { const meta = JSON.parse(row.value) as WorkbenchMeta; if (meta && meta.schema === 1 && typeof meta.buildKey === "string") out.push(meta); } catch { /* skipped */ }
  }
  return out;
}

function writeMeta(env: WorkbenchEnv, meta: WorkbenchMeta): void {
  env.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(metaPrefix(env) + meta.buildKey, JSON.stringify(meta));
}

interface Group { buildKey: string; rows: Array<{ key: string; record: StoredBuilderConversation }>; head: { key: string; record: StoredBuilderConversation }; meta: WorkbenchMeta | null }

function groupBuilds(env: WorkbenchEnv): { groups: Map<string, Group>; metas: WorkbenchMeta[]; truncated: boolean } {
  const { rows, truncated } = parseRows(env);
  const metas = readMetas(env);
  const alias = new Map<string, string>();
  for (const meta of metas) { alias.set(meta.buildKey, meta.buildKey); for (const key of meta.aliases) alias.set(key, meta.buildKey); }
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const identity = rowIdentityKey(row.record);
    const buildKey = alias.get(identity) ?? identity;
    const group = groups.get(buildKey);
    if (!group) { groups.set(buildKey, { buildKey, rows: [row], head: row, meta: metas.find((m) => m.buildKey === buildKey) ?? null }); continue; }
    group.rows.push(row);
    if (newer(row.record, group.head.record)) group.head = row;
  }
  // A build whose first turn has not been written yet (a draft) is still a build: its meta row stands for it.
  for (const meta of metas) if (!groups.has(meta.buildKey)) groups.set(meta.buildKey, { buildKey: meta.buildKey, rows: [], head: null as never, meta });
  return { groups, metas, truncated };
}

function newer(a: StoredBuilderConversation, b: StoredBuilderConversation): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.revision > b.revision;
}

const QUESTION_BLOCK = /<<agentlas-ask>>([\s\S]*?)<<\/agentlas-ask>>/g;
/** The same block with the code fence a model often wraps it in. */
const FENCED_QUESTION_BLOCK = /(?:```[a-z]*[ \t]*\n?)?<<agentlas-ask>>([\s\S]*?)<<\/agentlas-ask>>(?:[ \t]*\n?```)?/g;

/** How many valid interview questions the builder's last message holds (the same validity as hasValidBuilderInterviewQuestion). */
export function countBuilderQuestions(text: string | null | undefined): number {
  if (!text) return 0;
  let count = 0;
  for (const match of text.matchAll(QUESTION_BLOCK)) {
    const body = match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      const value = JSON.parse(body) as { question?: unknown; options?: unknown };
      if (typeof value.question === "string" && value.question.trim() && Array.isArray(value.options)
        && value.options.filter((o) => o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string" && (o as { label: string }).label.trim()).length >= 2) count += 1;
    } catch { /* a malformed block is not a question */ }
  }
  return count;
}

function stripQuestions(text: string): string { return text.replace(QUESTION_BLOCK, "").replace(/\s+\n/g, "\n").trim(); }

function parseQuestionBlock(raw: string): { question: string; options: Array<{ label: string; description?: string }> } | null {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const value = JSON.parse(body) as { question?: unknown; options?: unknown };
    if (typeof value.question !== "string" || !value.question.trim() || !Array.isArray(value.options)) return null;
    const options = value.options.flatMap((o) => {
      if (!o || typeof o !== "object" || typeof (o as { label?: unknown }).label !== "string" || !(o as { label: string }).label.trim()) return [];
      const description = (o as { description?: unknown }).description;
      return [{ label: (o as { label: string }).label.trim(), ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}) }];
    });
    return options.length >= 2 ? { question: value.question.trim(), options } : null;
  } catch { return null; }
}

/** The interview questions of a builder message, as data (the same validity as countBuilderQuestions). */
export function builderQuestionsOf(text: string | null | undefined): Array<{ question: string; options: Array<{ label: string; description?: string }> }> {
  if (!text) return [];
  const found: Array<{ question: string; options: Array<{ label: string; description?: string }> }> = [];
  for (const match of text.matchAll(QUESTION_BLOCK)) { const parsed = parseQuestionBlock(match[1]); if (parsed) found.push(parsed); }
  return found;
}

/**
 * A builder message as words for a person (Agentlas 2.0 audit D6-2 N3): the `<<agentlas-ask>>` fence is the wire the question card is made from, not text. A valid fence becomes the
 * question and its choices as plain lines (the question is never lost); a malformed or unfinished one is dropped. `buildWorkbench.open` and the phone's `build2.open` both
 * returned the fence raw, and the phone's saved-Build view printed the JSON.
 */
export function readableBuilderMessage(text: string): string {
  const unfinished = text.lastIndexOf("<<agentlas-ask>>");
  const head = unfinished >= 0 && text.indexOf("<</agentlas-ask>>", unfinished) < 0 ? text.slice(0, unfinished) : text;
  return head.replace(FENCED_QUESTION_BLOCK, (_whole, raw: string) => {
    const parsed = parseQuestionBlock(raw);
    return parsed ? `\n${parsed.question}\n${parsed.options.map((o) => `- ${o.label}${o.description ? ` - ${o.description}` : ""}`).join("\n")}\n` : "";
  }).replace(/```[a-z]*\s*$/, "").replace(/\n{3,}/g, "\n\n").trim();
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The same stage walk the Build screen does (renderer/lib/build-session.ts stageFromEvent), so "Building 4/6" agrees on both sides. */
export function stageReachedOf(events: ReadonlyArray<{ kind: string; stage?: string; text?: string }>): number {
  const write = /write|edit|create|touch|mkdir|apply_patch|str_replace|\.md|agentlas\.json|\.agentlas|파일|생성|scaffold/i;
  let reached = 1;
  for (const ev of events) {
    if (ev.kind === "stage") {
      if (ev.stage === "security") reached = Math.max(reached, 4);
      else if (ev.stage === "build") reached = Math.max(reached, 2);
      else if (write.test(`${ev.stage ?? ""} ${ev.text ?? ""}`)) reached = Math.max(reached, 3);
      else reached = Math.max(reached, 2);
    } else if (ev.kind === "partial" || ev.kind === "log") reached = Math.max(reached, 2);
  }
  return Math.min(reached, BUILD_STAGE_TOTAL);
}

function firstUserLine(record: StoredBuilderConversation): string {
  const first = record.history.find((m) => m.role === "user")?.text ?? record.request;
  return clip(first, 80);
}

function lastLineOf(record: StoredBuilderConversation): string {
  const texts = [record.terminalText, ...[...record.history].reverse().map((m) => m.text)];
  for (const text of texts) {
    if (!text) continue;
    const lines = stripQuestions(text).split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length) return clip(lines[lines.length - 1], 140);
  }
  return "";
}

/**
 * Where the build's files are NOW. A build linked to an installed agent follows the agent: its folder can have moved (the agents root
 * move, a reconnect), and the folder the build once knew may even still exist as the retained old copy — writing there would be wrong.
 */
function liveFolder(env: WorkbenchEnv, meta: WorkbenchMeta | null, fallback: string): string {
  if (meta?.agentId) {
    try { const agent = env.agents.find(meta.agentId); if (agent?.folder) return agent.folder; } catch { /* the stored folder is the best answer left */ }
  }
  return meta?.folder ?? fallback;
}

/** After a move the folder is a different directory (another identity): later turn rows of it belong to the same build. */
function ensureAlias(env: WorkbenchEnv, meta: WorkbenchMeta, folder: string): void {
  const key = folderIdentityKey(folder);
  if (!key || meta.aliases.includes(key)) return;
  meta.aliases.push(key);
  meta.updatedAt = nowIso(env);
  writeMeta(env, meta);
}

function itemOf(env: WorkbenchEnv, group: Group): BuildListItem {
  const { head, meta } = group;
  const record = head?.record ?? null;
  const folder = liveFolder(env, meta, record?.workspaceIdentity.realPath ?? "");
  const folderAvailable = folder ? fs.existsSync(folder) : false;
  const running = folder ? env.isRunning(folder) : false;
  const questionCount = record && record.status === "waiting-user" ? Math.max(countBuilderQuestions(record.terminalText), record.supplementalQuestion ? 1 : 0, 1) : 0;
  let state: BuildState;
  if (running) state = "building";
  else if (!record) state = meta?.agentId ? "created" : "unfinished";
  else if (record.status === "waiting-user") state = "question";
  else if (record.status === "completed") state = "created";
  else if (record.status === "stopped") state = "stopped";
  else state = "unfinished";
  const events = running ? env.activeEvents?.(folder) ?? [] : [];
  const created = record?.history.length ? record.updatedAt : (meta?.createdAt ?? nowIso(env));
  const firstRow = group.rows.reduce<StoredBuilderConversation | null>((acc, row) => (!acc || row.record.updatedAt < acc.updatedAt ? row.record : acc), null);
  return {
    id: group.buildKey,
    kind: meta?.kind ?? "create",
    title: meta?.name ?? (record ? firstUserLine(record) : ""),
    lastLine: record ? lastLineOf(record) : "",
    state,
    progress: running ? { reached: stageReachedOf(events), total: BUILD_STAGE_TOTAL } : null,
    questionCount,
    agentId: meta?.agentId ?? null,
    name: meta?.name ?? null,
    hasPendingAvatar: Boolean(meta?.avatarDataUrl),
    folderAvailable,
    createdAt: meta?.createdAt ?? firstRow?.updatedAt ?? created,
    updatedAt: record && meta ? (record.updatedAt > meta.updatedAt ? record.updatedAt : meta.updatedAt) : (record?.updatedAt ?? meta?.updatedAt ?? created),
  };
}

/** One page of the owner's builds, newest first. Reads rows and metas once; nothing is written (the sweep is `sweepBuilds`). */
export function listBuilds(env: WorkbenchEnv, input: { cursor?: unknown; limit?: unknown } = {}): { items: BuildListItem[]; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(BUILD_LIST_MAX_LIMIT, Number.isInteger(input.limit) ? (input.limit as number) : BUILD_LIST_DEFAULT_LIMIT));
  const { groups } = groupBuilds(env);
  // A build is listed when it has a saved conversation or is a draft in progress: an edit session that never sent a turn, or an agent made
  // on the phone (no saved conversation), is not a "build" of the list (they are still linked, so they leave with their agent).
  const all = [...groups.values()].filter((group) => group.rows.length > 0 || group.meta?.draft === true).map((group) => itemOf(env, group))
    .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt > b.updatedAt ? -1 : 1));
  let start = 0;
  if (typeof input.cursor === "string" && input.cursor.includes("|")) {
    const [at, id] = [input.cursor.slice(0, input.cursor.lastIndexOf("|")), input.cursor.slice(input.cursor.lastIndexOf("|") + 1)];
    start = all.findIndex((item) => item.updatedAt < at || (item.updatedAt === at && item.id > id));
    if (start < 0) start = all.length;
  }
  const items = all.slice(start, start + limit);
  const last = items[items.length - 1];
  return { items, nextCursor: start + limit < all.length && last ? `${last.updatedAt}|${last.id}` : null };
}

/**
 * Reopens a build with its messages. `continuable` is true when the next turn can resume this conversation: the "latest conversation"
 * pointer (the one the builder's resume check compares against) is moved to this build's head row, which is only done while no other
 * Build runs (a running turn keeps what it captured at its start).
 */
export function openBuild(env: WorkbenchEnv, buildKey: unknown, options: { readOnly?: boolean } = {}): WorkbenchResult<{ opened: BuildOpened }> {
  if (typeof buildKey !== "string" || !/^[0-9a-f]{24}$/.test(buildKey)) return { ok: false, code: "build_not_found" };
  const { groups } = groupBuilds(env);
  const group = groups.get(buildKey);
  if (!group) return { ok: false, code: "build_not_found" };
  const record = group.head?.record ?? null;
  const item = itemOf(env, group);
  const folder = liveFolder(env, group.meta, record?.workspaceIdentity.realPath ?? "");
  // `readOnly` (the phone's read, which must not change what the Desktop's Build window resumes): no alias is recorded and the resume pointer is not moved.
  if (!options.readOnly && group.meta && folder && fs.existsSync(folder)) ensureAlias(env, group.meta, folder);
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  let bytes = 0, truncated = false;
  const source = record ? [...record.history, ...(record.terminalText && record.history[record.history.length - 1]?.text !== record.terminalText ? [{ role: "assistant" as const, text: record.terminalText }] : [])] : [];
  // Newest messages win the byte budget; the order shown is the conversation's.
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const text = readableBuilderMessage(source[i].text);
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_MESSAGES_BYTES) { truncated = true; break; }
    messages.unshift({ role: source[i].role, text });
  }
  const folderAvailable = folder ? fs.existsSync(folder) : false;
  let continuable = false;
  let reason: BuildOpened["continuableReason"] = null;
  if (!folderAvailable) reason = "folder_unavailable";
  else if (env.anyBuildActive()) reason = "another_build_active";
  else {
    continuable = true;
    if (group.head && !options.readOnly) env.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`builder-conversation-latest-v1:${builderOwnerKey(env.owner)}`, group.head.record.buildId);
  }
  let grant: unknown = null;
  if (folderAvailable && env.grant) { try { grant = env.grant(folder); } catch { grant = null; } }
  const agent = group.meta?.agentId ? env.agents.find(group.meta.agentId) : null;
  // The host resumes a runtime session only from a head row that says "waiting-user" or "completed" (ipc.ts hephaestus:build, BUILD_SESSION_RECEIPT_REQUIRED). A stopped or unfinished
  // head must not be offered as resumable: the same request is refused every time (desktop 3, B-3). No head, or a head without a session, has nothing to resume.
  const headStatus = record?.status ?? null;
  const hasSession = Boolean(record?.runtimeSessionId);
  const sessionBlock: BuildOpened["sessionBlock"] = hasSession && headStatus === "stopped" ? "stopped" : hasSession && headStatus !== "waiting-user" && headStatus !== "completed" ? "unfinished" : null;
  return { ok: true, opened: {
    build: item, messages, messagesTruncated: truncated, folder, runtimeSessionId: record?.runtimeSessionId ?? null, runtime: record?.runtime ?? null,
    runtimePinned: record?.runtimePinned ?? false, turnDefaults: { mode: agent ? "package" : null }, workspaceGrant: grant, continuable,
    questions: record && record.status === "waiting-user" ? builderQuestionsOf(record.terminalText) : [],
    continuableReason: reason, sessionResumable: sessionBlock === null, sessionBlock, pendingAvatar: Boolean(group.meta?.avatarDataUrl),
  } };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Draft (a build that has no agent yet) and linking

function slugBase(hint: unknown): string {
  const text = typeof hint === "string" ? hint.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) : "";
  return text || "draft";
}

/**
 * A folder for an agent that does not exist yet, in the agents folder (so the agent ends up where agents live, not under a temp name
 * that a later registration would keep). `nameHint` only seeds the folder name; the real name is chosen in the window.
 */
export function openDraft(env: WorkbenchEnv, input: { nameHint?: unknown } = {}): WorkbenchResult<{ buildKey: string; folder: string; workspaceGrant: unknown }> {
  const root = env.agents.agentsRoot();
  if (!root || !fs.existsSync(root)) {
    // `detail` says which: the folder is gone ("missing") or the setting cannot be read ("settings-invalid"); the owner's way out differs (desktop 3 §4.6 #8).
    let why: string | null = null;
    try { why = env.agents.agentsRootReason?.() ?? (root ? "missing" : null); } catch { why = null; }
    return { ok: false, code: "agent_root_unavailable", ...(why ? { detail: why } : {}) };
  }
  let folder = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(root, `${slugBase(input.nameHint)}-${createHash("sha256").update(`${Math.random()}:${(env.now ?? Date.now)()}:${attempt}`).digest("hex").slice(0, 6)}`);
    try { fs.mkdirSync(candidate); folder = candidate; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, code: "folder_unavailable" }; }
  }
  if (!folder) return { ok: false, code: "folder_unavailable" };
  const real = fs.realpathSync.native(folder);
  const key = folderIdentityKey(real);
  if (!key) return { ok: false, code: "folder_unavailable" };
  const at = nowIso(env);
  writeMeta(env, { schema: 1, buildKey: key, aliases: [key], kind: "create", folder: real, agentId: null, draft: true, name: null, avatarDataUrl: null, baselineRevisionId: null, createdAt: at, updatedAt: at });
  let grant: unknown = null;
  try { grant = env.grant?.(real) ?? null; } catch { grant = null; }
  return { ok: true, buildKey: key, folder: real, workspaceGrant: grant };
}

/** The meta of the build a folder belongs to, creating it when the folder only has turn rows (a build from before this change). */
function metaForFolder(env: WorkbenchEnv, folder: string, kind: "create" | "edit" = "create"): WorkbenchMeta | null {
  const identity = folderIdentityKey(folder);
  if (!identity) return null;
  const metas = readMetas(env);
  const hit = metas.find((m) => m.buildKey === identity || m.aliases.includes(identity));
  if (hit) return hit;
  const real = fs.realpathSync.native(folder);
  const at = nowIso(env);
  const meta: WorkbenchMeta = { schema: 1, buildKey: identity, aliases: [identity], kind, folder: real, agentId: null, draft: false, name: null, avatarDataUrl: null, baselineRevisionId: null, createdAt: at, updatedAt: at };
  writeMeta(env, meta);
  return meta;
}

/**
 * Called when a Build turn registered an agent from `workspace` (the package may be in a subfolder of it): links the build to the agent,
 * applies the name and the picture chosen in the window, and clears the pending picture bytes (the agent's own picture is the copy now).
 */
export function noteAgentCreated(env: WorkbenchEnv, input: { workspace: string; packageRoot: string; agentId: string }): void {
  const meta = metaForFolder(env, input.workspace);
  if (!meta) return;
  const packageKey = folderIdentityKey(input.packageRoot);
  if (packageKey && !meta.aliases.includes(packageKey)) meta.aliases.push(packageKey);
  meta.agentId = input.agentId;
  meta.updatedAt = nowIso(env);
  if (meta.name) { try { env.agents.setName(input.agentId, meta.name); } catch { /* the name stays in the build; the agent keeps the one its folder declares */ } }
  if (meta.avatarDataUrl) {
    let ok = false;
    try { ok = env.agents.setAvatar(input.agentId, meta.avatarDataUrl).ok; } catch { ok = false; }
    if (ok) meta.avatarDataUrl = null; // otherwise kept: the owner can set it again from the window, nothing is lost silently
  }
  writeMeta(env, meta);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Name and character (usable before the agent exists)

export function setBuildName(env: WorkbenchEnv, buildKey: unknown, name: unknown): WorkbenchResult<{ name: string | null }> {
  const meta = readMetas(env).find((m) => m.buildKey === buildKey);
  const found = meta ?? (typeof buildKey === "string" ? groupBuilds(env).groups.get(buildKey) : undefined);
  if (!found) return { ok: false, code: "build_not_found" };
  if (typeof name !== "string") return { ok: false, code: "name_invalid" };
  const text = name.normalize("NFC").trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text) || Array.from(text).length > 80) return { ok: false, code: "name_invalid" };
  const target = meta ?? metaForFolder(env, (found as Group).meta?.folder ?? (found as Group).head.record.workspaceIdentity.realPath);
  if (!target) return { ok: false, code: "build_not_found" };
  target.name = text || null;
  target.updatedAt = nowIso(env);
  if (target.agentId && env.agents.find(target.agentId)) {
    try { env.agents.setName(target.agentId, text); } catch { return { ok: false, code: "name_invalid" }; }
  }
  writeMeta(env, target);
  return { ok: true, name: target.name };
}

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

export function setBuildAvatar(env: WorkbenchEnv, buildKey: unknown, dataUrl: unknown): WorkbenchResult<{ applied: "agent" | "pending" }> {
  const group = typeof buildKey === "string" ? groupBuilds(env).groups.get(buildKey) : undefined;
  if (!group) return { ok: false, code: "build_not_found" };
  if (typeof dataUrl !== "string" || !DATA_URL.test(dataUrl)) return { ok: false, code: "avatar_invalid" };
  const meta = group.meta ?? metaForFolder(env, group.head.record.workspaceIdentity.realPath);
  if (!meta) return { ok: false, code: "build_not_found" };
  if (meta.agentId && env.agents.find(meta.agentId)) {
    // The agent exists: the same call Manage agents uses (its own image checks included).
    const result = env.agents.setAvatar(meta.agentId, dataUrl);
    if (!result.ok) return { ok: false, code: "avatar_invalid" };
    return { ok: true, applied: "agent" };
  }
  if (Math.floor(((DATA_URL.exec(dataUrl)![2].length) * 3) / 4) > BUILD_AVATAR_MAX_BYTES) return { ok: false, code: "avatar_too_large" };
  meta.avatarDataUrl = dataUrl;
  meta.updatedAt = nowIso(env);
  writeMeta(env, meta);
  return { ok: true, applied: "pending" };
}

export function clearBuildAvatar(env: WorkbenchEnv, buildKey: unknown): WorkbenchResult<{ done?: true }> {
  const group = typeof buildKey === "string" ? groupBuilds(env).groups.get(buildKey) : undefined;
  if (!group) return { ok: false, code: "build_not_found" };
  const meta = group.meta;
  if (meta?.avatarDataUrl) { meta.avatarDataUrl = null; meta.updatedAt = nowIso(env); writeMeta(env, meta); }
  if (meta?.agentId) { try { env.agents.clearAvatar(meta.agentId); } catch { /* an agent that is gone has no picture to clear */ } }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Edit: open for an installed agent, the change list, undo

/** The code, and for `agent_running` what holds the agent ("run-active", "file-operation-open",...: the causes end differently, desktop 3 §4.6 #10) in `detail`. */
function refuseForAgent(env: WorkbenchEnv, agentId: string, folder: string): { code: WorkbenchRefusal; detail?: string } | null {
  if (env.agents.rootMoveBusy()) return { code: "root_move_active" };
  const blocker = env.agents.blocker(agentId, folder);
  if (blocker) return { code: "agent_running", ...(/^[A-Za-z0-9_.:-]{1,80}$/.test(blocker) ? { detail: blocker } : {}) };
  if (env.isRunning(folder)) return { code: "build_turn_active" };
  return null;
}

/** Opens (or creates) the build conversation of an installed agent and starts an edit session (the baseline is the folder as it is now). */
export function openForAgent(env: WorkbenchEnv, agentId: unknown): WorkbenchResult<{ buildKey: string; opened: BuildOpened; sessionResumed: boolean }> {
  if (typeof agentId !== "string" || !agentId || agentId.length > 256) return { ok: false, code: "agent_not_found" };
  const agent = env.agents.find(agentId);
  if (!agent) return { ok: false, code: "agent_not_found" };
  if (!agent.editable) return { ok: false, code: "agent_not_editable" };
  if (!agent.folder || !fs.existsSync(agent.folder)) return { ok: false, code: "folder_unavailable" };
  const refusal = refuseForAgent(env, agentId, agent.folder);
  if (refusal) return { ok: false, ...refusal };
  const folderKey = folderIdentityKey(agent.folder);
  if (!folderKey) return { ok: false, code: "folder_unavailable" };
  const real = fs.realpathSync.native(agent.folder);
  const metas = readMetas(env);
  let meta = metas.find((m) => m.agentId === agentId) ?? metas.find((m) => m.buildKey === folderKey || m.aliases.includes(folderKey)) ?? null;
  const at = nowIso(env);
  if (!meta) meta = { schema: 1, buildKey: folderKey, aliases: [folderKey], kind: "edit", folder: real, agentId, draft: false, name: null, avatarDataUrl: null, baselineRevisionId: null, createdAt: at, updatedAt: at };
  if (!meta.aliases.includes(folderKey)) meta.aliases.push(folderKey);
  meta.agentId = agentId;
  meta.folder = real;
  // A session that was not closed (a crash) is kept, so its change list survives; a new one starts from the folder as it is now.
  let sessionResumed = false;
  if (meta.baselineRevisionId && env.agents.revisionFiles(agentId, meta.baselineRevisionId)) sessionResumed = true;
  else {
    // No baseline, no session: the change list would show every file as "added" and Undo would refuse as `no_linked_agent` for as long as the session lasts, with no word of why
    // (desktop 3, B-4). The port throws the store's own code (a busy write lock is `update_busy`); a null is "could not be read".
    let head: string | null = null;
    try { head = env.agents.headRevision(agentId); }
    catch (error) { return { ok: false, code: (error as { code?: unknown } | null)?.code === "update_busy" ? "agent_running" : "baseline_unavailable" }; }
    if (!head) return { ok: false, code: "baseline_unavailable" };
    meta.baselineRevisionId = head;
  }
  meta.updatedAt = at;
  writeMeta(env, meta);
  const opened = openBuild(env, meta.buildKey);
  if (!opened.ok) return opened;
  return { ok: true, buildKey: meta.buildKey, opened: { ...opened.opened, turnDefaults: { mode: "package" } }, sessionResumed };
}

/** Ends the edit session (the window closed or the owner said done): the next open starts from the folder as it is then. */
export function closeSession(env: WorkbenchEnv, buildKey: unknown): WorkbenchResult<{ done?: true }> {
  const meta = readMetas(env).find((m) => m.buildKey === buildKey);
  if (!meta) return { ok: false, code: "build_not_found" };
  if (meta.baselineRevisionId) { meta.baselineRevisionId = null; meta.updatedAt = nowIso(env); writeMeta(env, meta); }
  return { ok: true };
}

/** Added / removed line counts between two texts: common head and tail are cut, the middle is an LCS (a count-only estimate beyond 4M cells). */
export function lineDiffCounts(before: string, after: string): { added: number; removed: number; approximate: boolean } {
  const a = before === "" ? [] : before.split("\n"), b = after === "" ? [] : after.split("\n");
  if (before.endsWith("\n")) a.pop();
  if (after.endsWith("\n")) b.pop();
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  if (x.length === 0) return { added: y.length, removed: 0, approximate: false };
  if (y.length === 0) return { added: 0, removed: x.length, approximate: false };
  if (x.length * y.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of y) { const n = counts.get(line) ?? 0; if (n > 0) { common += 1; counts.set(line, n - 1); } }
    return { added: y.length - common, removed: x.length - common, approximate: true };
  }
  let previous = new Int32Array(y.length + 1), current = new Int32Array(y.length + 1);
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) current[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    [previous, current] = [current, previous];
  }
  const lcs = previous[y.length];
  return { added: y.length - lcs, removed: x.length - lcs, approximate: false };
}

function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function editContext(env: WorkbenchEnv, buildKey: unknown): WorkbenchResult<{ meta: WorkbenchMeta; scope: ReturnType<typeof openBuildScope> & { ok: true }; baseline: Map<string, { bytes: Buffer; executable: boolean }> | null }> {
  const meta = readMetas(env).find((m) => m.buildKey === buildKey);
  if (!meta) return { ok: false, code: "build_not_found" };
  const scope = openBuildScope(liveFolder(env, meta, meta.folder));
  if (!scope.ok) return { ok: false, code: "folder_unavailable" };
  const baseline = meta.agentId && meta.baselineRevisionId ? env.agents.revisionFiles(meta.agentId, meta.baselineRevisionId) : null;
  return { ok: true, meta, scope, baseline };
}

/**
 * The per-file change list of the session: the folder now against its baseline revision (an agent that is not installed yet has the empty
 * baseline: everything is "added"). Counts are lines; a binary file has none. Reads only.
 */
export function listChanges(env: WorkbenchEnv, buildKey: unknown): WorkbenchResult<{ changes: BuildFileChange[]; baseline: "revision" | "empty"; truncated: boolean }> {
  const ctx = editContext(env, buildKey);
  if (!ctx.ok) return ctx;
  if (ctx.meta.agentId && ctx.meta.baselineRevisionId && !ctx.baseline) return { ok: false, code: "baseline_unavailable" };
  const tree = listBuildTree(ctx.scope.scope);
  const changes: BuildFileChange[] = [];
  const seen = new Set<string>();
  for (const entry of tree.entries) {
    if (entry.type !== "file") continue;
    seen.add(entry.path);
    const read = readBuildFile(ctx.scope.scope, entry.path);
    if (!read.ok) continue;
    const before = ctx.baseline?.get(entry.path);
    if (!before) { changes.push({ path: entry.path, status: "added", added: read.file.binary ? 0 : read.file.lineCount, removed: 0, binary: read.file.binary, approximate: false }); continue; }
    const nowBytes = fs.readFileSync(path.join(ctx.scope.scope.root, ...entry.path.split("/")));
    if (sha(nowBytes) === sha(before.bytes)) continue;
    const binary = read.file.binary || before.bytes.includes(0);
    const counts = binary ? { added: 0, removed: 0, approximate: false } : lineDiffCounts(before.bytes.toString("utf8"), nowBytes.toString("utf8"));
    changes.push({ path: entry.path, status: "modified", ...counts, binary });
  }
  if (ctx.baseline) for (const [rel, before] of ctx.baseline) {
    if (seen.has(rel)) continue;
    const binary = before.bytes.includes(0);
    changes.push({ path: rel, status: "removed", added: 0, removed: binary ? 0 : before.bytes.toString("utf8").split("\n").filter((_l, i, all) => !(i === all.length - 1 && _l === "")).length, binary, approximate: false });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: true, changes, baseline: ctx.baseline ? "revision" : "empty", truncated: tree.truncated };
}

/**
 * Puts one file back to the session's baseline (a file that did not exist then is removed). Refused with a machine code while the agent
 * runs a turn, its root is being moved, a Build turn of this folder runs, or the baseline is gone; the write is atomic and held under the
 * agent's own folder lock, so it cannot interleave with a move or another change.
 */
export function undoFile(env: WorkbenchEnv, buildKey: unknown, file: unknown): WorkbenchResult<{ path: string; restored: "content" | "removed" }> {
  const ctx = editContext(env, buildKey);
  if (!ctx.ok) return ctx;
  const { meta, scope } = ctx;
  if (!meta.agentId || !meta.baselineRevisionId) return { ok: false, code: "no_linked_agent" };
  if (!ctx.baseline) return { ok: false, code: "baseline_unavailable" };
  const refusal = refuseForAgent(env, meta.agentId, liveFolder(env, meta, meta.folder));
  if (refusal) return { ok: false, ...refusal };
  if (typeof file !== "string") return { ok: false, code: "scope_path_invalid" };
  const before = ctx.baseline.get(file);
  const held = env.agents.withLock(meta.agentId, () => {
    const current = readBuildFile(scope.scope, file);
    if (before) {
      if (current.ok) {
        const nowBytes = fs.readFileSync(path.join(scope.scope.root, ...file.split("/")));
        if (sha(nowBytes) === sha(before.bytes)) return { ok: false as const, code: "no_change" as const };
      } else if (current.code !== "scope_missing") return { ok: false as const, code: current.code };
      const written = writeBuildFile(scope.scope, file, before.bytes, { executable: before.executable });
      return written.ok ? { ok: true as const, path: written.rel, restored: "content" as const } : { ok: false as const, code: written.code };
    }
    if (!current.ok) return current.code === "scope_missing" ? { ok: false as const, code: "no_change" as const } : { ok: false as const, code: current.code };
    const removed = removeBuildFile(scope.scope, file);
    return removed.ok ? { ok: true as const, path: removed.rel, restored: "removed" as const } : { ok: false as const, code: removed.code };
  });
  if (typeof held === "object" && held !== null && "busy" in held) return { ok: false, code: "agent_running", detail: "workspace-locked" };
  return held as WorkbenchResult<{ path: string; restored: "content" | "removed" }>;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Files of one build (the right pane): tree with per-file state, content by path. Both limited to the build's own folder.

/** `expected`: paths the package contract requires that are not there yet (state "pending"); `writing`: paths the live signal marks as being written. */
export function buildFileTree(env: WorkbenchEnv, buildKey: unknown, input: { expected?: readonly string[]; writing?: ReadonlySet<string> } = {}): WorkbenchResult<{ nodes: BuildFileNode[]; truncated: boolean }> {
  const meta = readMetas(env).find((m) => m.buildKey === buildKey);
  const group = meta ? null : (typeof buildKey === "string" ? groupBuilds(env).groups.get(buildKey) : undefined);
  const folder = folderOfBuild(env, buildKey);
  if (!folder) return { ok: false, code: "build_not_found" };
  const scope = openBuildScope(folder);
  if (!scope.ok) return { ok: false, code: "folder_unavailable" };
  const tree = listBuildTree(scope.scope);
  const present = new Set(tree.entries.map((e) => e.path));
  const nodes: BuildFileNode[] = tree.entries.map((e) => ({ path: e.path, type: e.type, size: e.size, state: input.writing?.has(e.path) ? "writing" : "written" }));
  for (const rel of input.expected ?? []) {
    if (present.has(rel) || !/^[A-Za-z0-9._\-\/]+$/.test(rel) || rel.includes("..")) continue;
    nodes.push({ path: rel, type: "file", size: 0, state: "pending" });
  }
  nodes.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: true, nodes, truncated: tree.truncated };
}

export function readBuildFileOf(env: WorkbenchEnv, buildKey: unknown, file: unknown, sinceLine?: unknown): WorkbenchResult<{ file: ReturnType<typeof readBuildFile> extends infer R ? (R extends { ok: true; file: infer F } ? F : never) : never }> {
  const folder = folderOfBuild(env, buildKey);
  if (!folder) return { ok: false, code: "build_not_found" };
  const scope = openBuildScope(folder);
  if (!scope.ok) return { ok: false, code: "folder_unavailable" };
  const read = readBuildFile(scope.scope, file, { sinceLine: typeof sinceLine === "number" ? sinceLine : 0 });
  return read.ok ? { ok: true, file: read.file } : { ok: false, code: read.code };
}

/** The newest saved turn of a build (its mode, runtime and runtime session), or null for a draft that has no turn yet. */
export function headRecordOf(env: WorkbenchEnv, buildKey: unknown): StoredBuilderConversation | null {
  const group = typeof buildKey === "string" ? groupBuilds(env).groups.get(buildKey) : undefined;
  return group?.head?.record ?? null;
}

/** The build a saved turn row belongs to (the phone asks "which Build is my run?": contracts/phone-build2.md `build2.forRun`); null = no such turn. */
export function buildKeyOfTurn(env: WorkbenchEnv, buildId: unknown): string | null {
  if (typeof buildId !== "string") return null;
  for (const group of groupBuilds(env).groups.values()) if (group.rows.some((row) => row.record.buildId === buildId)) return group.buildKey;
  return null;
}

/** The folder of a build, for the live signal and the post-turn escape check; null when the build is unknown or its folder is gone. */
export function folderOfBuild(env: WorkbenchEnv, buildKey: unknown): string | null {
  const meta = readMetas(env).find((m) => m.buildKey === buildKey) ?? null;
  if (meta) return liveFolder(env, meta, meta.folder);
  const group = typeof buildKey === "string" ? groupBuilds(env).groups.get(buildKey) : undefined;
  const folder = group ? liveFolder(env, group.meta, group.head?.record.workspaceIdentity.realPath ?? "") : "";
  return folder || null;
}

/** After a turn: links in the build's folder that point out of it. The window shows a refusal instead of going on. */
export function escapesOfBuild(env: WorkbenchEnv, buildKey: unknown): Array<{ path: string; kind: "outside" | "dangling" }> {
  const folder = folderOfBuild(env, buildKey);
  const scope = folder ? openBuildScope(folder) : null;
  return scope && scope.ok ? findScopeEscapes(scope.scope) : [];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Removal and retention

function deleteGroupRows(env: WorkbenchEnv, group: Group): number {
  const del = env.db.prepare("DELETE FROM meta WHERE key = ?");
  const pointerKey = `builder-conversation-latest-v1:${builderOwnerKey(env.owner)}`;
  const pointer = env.db.prepare("SELECT value FROM meta WHERE key = ?").get(pointerKey) as { value: string } | undefined;
  let removed = 0;
  env.db.transaction(() => {
    for (const row of group.rows) {
      removed += del.run(row.key).changes;
      if (pointer?.value === row.record.buildId) del.run(pointerKey);
    }
    if (group.meta) del.run(metaPrefix(env) + group.meta.buildKey);
  }).immediate();
  return removed;
}

/**
 * The owner removes a build from the list. Its conversation rows, its meta row and its pending picture go. The agent and its files stay
 * (that is Manage agents' delete); a folder the app made for a build that never got an agent is moved to the Trash.
 */
export async function removeBuild(env: WorkbenchEnv, buildKey: unknown): Promise<WorkbenchResult<{ rows: number; folderTrashed: boolean }>> {
  if (typeof buildKey !== "string") return { ok: false, code: "build_not_found" };
  const { groups } = groupBuilds(env);
  const group = groups.get(buildKey);
  if (!group) return { ok: false, code: "build_not_found" };
  const folder = liveFolder(env, group.meta, group.head?.record.workspaceIdentity.realPath ?? "");
  if (folder && env.isRunning(folder)) return { ok: false, code: "build_running" };
  const rows = deleteGroupRows(env, group);
  let folderTrashed = false;
  if (group.meta?.draft && !group.meta.agentId && folder && env.trashFolder) {
    const root = env.agents.agentsRoot();
    // Only a folder directly inside the agents folder, made by openDraft, with no agent registered for it: nothing of the owner's is lost.
    if (root && path.dirname(folder) === fs.realpathSync.native(root) && fs.existsSync(folder)) {
      try { folderTrashed = await env.trashFolder(folder); } catch { folderTrashed = false; }
    }
  }
  return { ok: true, rows, folderTrashed };
}

/** The agent was deleted or retired: every build linked to it goes (all owners' metas are checked — an agent id is unique). */
export function purgeBuildsOfAgent(db: Database.Database, agentId: string): number {
  if (typeof agentId !== "string" || !agentId) return 0;
  const rows = db.prepare("SELECT key, value FROM meta WHERE key >= 'build-workbench-v1:' AND key < 'build-workbench-v1;'").all() as Array<{ key: string; value: string }>;
  let removed = 0;
  for (const row of rows) {
    let meta: WorkbenchMeta;
    try { meta = JSON.parse(row.value) as WorkbenchMeta; } catch { continue; }
    if (meta.agentId !== agentId) continue;
    const ownerKey = row.key.slice("build-workbench-v1:".length).split(":")[0];
    const prefix = `builder-conversation-v1:${ownerKey}:`;
    const identities = new Set([meta.buildKey, ...meta.aliases]);
    const turns = db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?").all(prefix, prefix.slice(0, -1) + ";") as Array<{ key: string; value: string }>;
    db.transaction(() => {
      for (const turn of turns) {
        try {
          const record = JSON.parse(turn.value) as StoredBuilderConversation;
          if (!identities.has(rowIdentityKey(record))) continue;
          db.prepare("DELETE FROM meta WHERE key = ?").run(turn.key);
          removed += 1;
          const pointerKey = `builder-conversation-latest-v1:${ownerKey}`;
          const pointer = db.prepare("SELECT value FROM meta WHERE key = ?").get(pointerKey) as { value: string } | undefined;
          if (pointer?.value === record.buildId) db.prepare("DELETE FROM meta WHERE key = ?").run(pointerKey);
        } catch { /* an unreadable row is not this agent's */ }
      }
      db.prepare("DELETE FROM meta WHERE key = ?").run(row.key);
    }).immediate();
  }
  return removed;
}

export interface SweepReport { supersededRows: number; goneBuilds: number; staleBuilds: number; truncated: boolean }

/**
 * Retention, run once per app start and after a removal (no timer): drops the superseded turn rows of every build, the builds whose folder
 * is gone and that have no linked agent, and unlinked builds that never finished and were untouched for BUILD_STALE_MS. A running build
 * is never touched. Builds linked to an installed agent are never dropped here (they leave with the agent or by the owner's removal).
 */
export function sweepBuilds(env: WorkbenchEnv): SweepReport {
  const report: SweepReport = { supersededRows: 0, goneBuilds: 0, staleBuilds: 0, truncated: false };
  const { groups, truncated } = groupBuilds(env);
  report.truncated = truncated;
  const now = (env.now ?? Date.now)();
  for (const group of groups.values()) {
    const folder = liveFolder(env, group.meta, group.head?.record.workspaceIdentity.realPath ?? "");
    if (folder && env.isRunning(folder)) continue;
    const linked = group.meta?.agentId ? env.agents.find(group.meta.agentId) : null;
    const exists = folder ? fs.existsSync(folder) : false;
    const record = group.head?.record ?? null;
    const lastTouch = Date.parse(record?.updatedAt ?? group.meta?.updatedAt ?? "") || now;
    if (!linked && !exists) { report.goneBuilds += 1; deleteGroupRows(env, group); continue; }
    if (!linked && (!record || record.status !== "completed") && now - lastTouch > BUILD_STALE_MS) {
      report.staleBuilds += 1; deleteGroupRows(env, group);
      // A draft folder nothing was ever written into: only an empty folder is removed (rmdir refuses anything else).
      if (group.meta?.draft && exists) { try { fs.rmdirSync(folder); } catch { /* not empty: left for the owner */ } }
      continue;
    }
    if (group.rows.length > 1 && group.head) {
      const old = group.rows.filter((row) => row.key !== group.head.key);
      env.db.transaction(() => { for (const row of old) report.supersededRows += env.db.prepare("DELETE FROM meta WHERE key = ?").run(row.key).changes; }).immediate();
    }
  }
  // The "latest conversation" pointer must never name a row that is gone (the builder's resume check reads it).
  const pointerKey = `builder-conversation-latest-v1:${builderOwnerKey(env.owner)}`;
  const pointer = env.db.prepare("SELECT value FROM meta WHERE key = ?").get(pointerKey) as { value: string } | undefined;
  if (pointer && !env.db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(`builder-conversation-v1:${builderOwnerKey(env.owner)}:${pointer.value}`)) {
    env.db.prepare("DELETE FROM meta WHERE key = ?").run(pointerKey);
  }
  return report;
}
