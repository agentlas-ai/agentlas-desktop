import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { persistUiLocaleCore, readUiLocaleCore, type UiLocaleCore, type UiLocalePref } from "../ui-locale";
import type { RosterRemovalResult } from "../../shared/types";
import { invalidValueMessage } from "../../shared/did-you-mean";

/*
 * First two domain operations of the SDK/harness (docs/2026-10-13-native-harness/14 §5-§7):
 *   settings.language.get / settings.language.set   core setting = userData/ui-locale.json {locale, pref, revision}
 *   agent.uninstall                                  the one implementation behind IPC team:uninstall
 *
 * Every caller (model via harness_call, renderer/SDK, One app control, daemon) reaches these through the harness
 * dispatcher. No electron import at top level (the daemon loads this): electron, the registry and the DB are loaded
 * lazily, and only on paths that need them.
 */

type Args = Record<string, unknown>;
export type SettingsAgentOutcome =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string };
interface Ctx { chatId: string; runId: string; dryRun?: boolean }

const ok = (data: unknown): SettingsAgentOutcome => ({ status: "ok", data });
const refused = (reason: string, next?: string): SettingsAgentOutcome => ({ status: "refused", reason, ...(next ? { next } : {}) });
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

async function receipt(entry: Record<string, unknown>): Promise<string> {
  return (await import("./capability-ports")).appendReceipt(entry);
}

// ── language ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LanguageChangedEvent {
  type: "settings.language.changed";
  revision: number;
  locale: "ko" | "en";
  pref: UiLocalePref;
  origin: "port" | "renderer" | "other-process";
}

const listeners = new Set<(event: LanguageChangedEvent) => void>();
let projectorTargets: () => string[] = () => [];
const appliedAcks = new Map<number, Set<string>>();
let lastSeenRevision = -1;

/** Projectors (windows, menu, mobile bridge) subscribe here. Returns the unsubscribe. */
export function onLanguageChanged(handler: (event: LanguageChangedEvent) => void): () => void {
  listeners.add(handler);
  return () => { listeners.delete(handler); };
}

/** Main registers which UI targets currently exist (e.g. one per open window) so set can wait for their ACK. */
export function attachLanguageProjectors(targets: () => string[]): void {
  projectorTargets = targets;
}

export function emitLanguageChanged(core: UiLocaleCore, origin: LanguageChangedEvent["origin"]): void {
  if (core.revision <= lastSeenRevision && origin !== "port") return;
  lastSeenRevision = Math.max(lastSeenRevision, core.revision);
  const event: LanguageChangedEvent = { type: "settings.language.changed", revision: core.revision, locale: core.locale, pref: core.pref, origin };
  for (const handler of [...listeners]) { try { handler(event); } catch { /* a projector must not break the setting */ } }
}

/** A UI target (renderer window) reports it applied this revision. */
export function acknowledgeLanguageApplied(revision: number, target: string): void {
  if (!Number.isInteger(revision)) return;
  let set = appliedAcks.get(revision);
  if (!set) { set = new Set(); appliedAcks.set(revision, set); }
  set.add(target);
  for (const key of [...appliedAcks.keys()]) if (key < revision - 8) appliedAcks.delete(key);
  ackWaiters.forEach((wake) => wake());
}
const ackWaiters = new Set<() => void>();

/** Another process (the daemon) changed the file: poll it so Main's windows and menu follow. Returns stop. */
export function watchLanguageSetting(intervalMs = 1000): () => void {
  const file = userDataPath("ui-locale.json");
  lastSeenRevision = Math.max(lastSeenRevision, readUiLocaleCore()?.revision ?? 0);
  const listener = () => {
    const core = readUiLocaleCore();
    if (core && core.revision > lastSeenRevision) emitLanguageChanged(core, "other-process");
  };
  fs.watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => fs.unwatchFile(file, listener);
}

function systemLocale(): "ko" | "en" {
  let raw = "";
  try {
    const electron = require("electron") as { app?: { getLocale?: () => string } };
    raw = electron?.app?.getLocale?.() ?? "";
  } catch { /* daemon: no electron */ }
  if (!raw) raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "en";
  return raw.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function languageView(core: UiLocaleCore | null) {
  if (!core) return { locale: systemLocale(), pref: "system" as UiLocalePref, revision: 0, source: "system-default" as const, updatedAt: null };
  return { locale: core.locale, pref: core.pref, revision: core.revision, source: "core-setting" as const, updatedAt: core.updatedAt };
}

async function waitForAck(revision: number, timeoutMs: number): Promise<string[]> {
  const targets = projectorTargets();
  if (targets.length === 0) return [];
  const acked = () => [...(appliedAcks.get(revision) ?? [])];
  if (targets.every((t) => acked().includes(t))) return acked();
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); ackWaiters.delete(check); resolve(); };
    const check = () => { if (targets.every((t) => acked().includes(t))) done(); };
    const timer = setTimeout(done, timeoutMs);
    ackWaiters.add(check);
  });
  return acked();
}

async function languageGet(): Promise<SettingsAgentOutcome> {
  const view = languageView(readUiLocaleCore());
  return ok({ ...view, uiAppliedTargets: [...(appliedAcks.get(view.revision) ?? [])] });
}

async function languageSet(args: Args, ctx: Ctx): Promise<SettingsAgentOutcome> {
  const pref = str(args.locale);
  if (pref !== "ko" && pref !== "en" && pref !== "system") return refused("invalid_locale", invalidValueMessage("locale", args.locale, ["ko", "en", "system"]));
  const expected = args.expectedRevision;
  if (expected !== undefined && !(typeof expected === "number" && Number.isInteger(expected) && expected >= 0)) return refused("invalid_expected_revision");
  const before = readUiLocaleCore();
  const currentRevision = before?.revision ?? 0;
  if (typeof expected === "number" && expected !== currentRevision) {
    return refused("stale_revision", `Current revision is ${currentRevision}; call settings.language.get and retry.`);
  }
  if (ctx.dryRun) return refused("dry_run", "Dry run: the language setting was not changed.");
  const resolved = pref === "system" ? systemLocale() : pref;
  // Compare-and-set under the cross-process lock, confirmed by readback: only a durable write is "saved" (NH17).
  const persisted = persistUiLocaleCore(resolved, pref, typeof expected === "number" ? expected : currentRevision);
  if (!persisted.ok) {
    const current = persisted.current;
    return refused(persisted.code === "stale_revision" ? "stale_revision" : "persist_failed",
      persisted.code === "stale_revision"
        ? `Current revision is ${current?.revision ?? 0}; call settings.language.get and retry.`
        : `The language setting was not saved (${persisted.message}); it is still ${current?.locale ?? "unknown"} at revision ${current?.revision ?? 0}.`);
  }
  const core = persisted.core;
  const changed = persisted.changed;
  const receiptId = await receipt({
    operationId: "settings.language.set", chatId: ctx.chatId, runId: ctx.runId,
    inputDigest: digest({ locale: pref }), domainRevision: core.revision, status: "saved", locale: core.locale, pref: core.pref, changed,
  });
  if (changed) emitLanguageChanged(core, "port");
  const targets = projectorTargets();
  const acked = changed ? await waitForAck(core.revision, 1500) : [...(appliedAcks.get(core.revision) ?? [])];
  const applied = targets.length > 0 && targets.every((t) => acked.includes(t));
  return ok({
    saved: { receiptId, revision: core.revision, locale: core.locale, pref: core.pref, changed },
    ui: applied
      ? { applied: true, pending: false, ackedTargets: acked }
      : { applied: false, pending: true, ackedTargets: acked, expectedTargets: targets,
          note: targets.length === 0 ? "No UI window is attached; the saved setting applies when a window opens." : "Not every UI target acknowledged yet; it is saved and will apply." },
  });
}

// ── agent removal ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentUninstallOptions { removeSource?: boolean }

/** What must be read about an agent BEFORE its registry row goes: the engine needs its folder's ids, and the folder may move to Trash. */
export interface AgentRemovalContext {
  id: string;
  /** Every id the agent's folder says it has had (owner.json), the agent's own id excluded by the engine call. */
  aliases: string[];
  /** The agent's registered folder (any source), or null. */
  folder: string | null;
  /**
   * Folders that exist only because of this agent and that the app made in the agent root: a 3-file stub that has no route, and the
   * app-side state folder of an agent registered in place. They go to the OS Trash with the agent (-8: they stayed behind,
   * and installing the same slug again then added a `-id6` folder each time).
   */
  appFolders: string[];
  /** A Hub agent that was only called (no local instructions, shared/call-only-agent.ts): it keeps no memory here, so the engine is not asked. */
  callOnly: boolean;
}

/** Read before the registry row is removed. Returns null when the agent is not installed. */
export async function captureAgentRemovalContext(id: string): Promise<AgentRemovalContext | null> {
  const { getAgentById } = await import("../mcp/registry");
  const { getRoute } = await import("../agents/routes");
  const existing = getAgentById(id);
  if (!existing) return null;
  const route = getRoute(id);
  const { ownerAliases } = await import("../agents/agent-forget");
  const aliasSet = new Set(ownerAliases(route?.path ?? existing.localPath ?? null));
  try { // an agent registered in place keeps its owner.json in the app-side state folder instead
    const { agentStateDir } = await import("../agents/home");
    const state = agentStateDir({ id, slug: existing.slug });
    if (state) for (const alias of ownerAliases(path.dirname(state))) aliasSet.add(alias);
  } catch { /* the folder's own owner.json is enough */ }
  const { isCallOnlyHubAgent } = await import("../../shared/call-only-agent");
  const callOnly = isCallOnlyHubAgent(existing);
  const appFolders: string[] = [];
  try {
    const home = await import("../agents/home");
    const { getDb } = await import("../store/db");
    const owned = home.ownedAgentFolder({ id, slug: existing.slug });
    const cls = owned ? home.classifyAgentFolder(owned) : null;
    // Only a folder this agent's own marker names, directly under the agent root, and only when it is not the registered package itself
    // (that one follows the owner's "also move the folder to Trash" choice below).
    if (owned && cls?.owner === "app" && cls.appRoot === "agent-home" && !cls.nested
      && home.ownerIds(owned).every((ownerId) => ownerId === id)
      // …or the registered folder of a call-only Hub seat: its route names the 3-file stub the app wrote for the seat, which holds nothing of the owner's.
      && (!route || path.resolve(route.path) !== path.resolve(owned) || (callOnly && isBareStubFolder(owned, home.AGENT_LOCAL_STATE_FOLDER)))) appFolders.push(owned);
    // A stub that has not been moved yet is still at the old place: the same rule (the app made it from the row, nothing else names it).
    if (!route && !owned) {
      const legacy = home.resolveAgentHome({ id, slug: existing.slug }, null);
      const legacyCls = home.classifyAgentFolder(legacy.dir);
      if (legacy.source === "legacy" && fs.existsSync(legacy.dir) && legacyCls.owner === "app" && !legacyCls.nested
        && (getDb().prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE slug = ?").get(existing.slug) as { n: number }).n === 1) appFolders.push(legacy.dir);
    }
  } catch { /* nothing to clean */ }
  return { id, aliases: [...aliasSet], folder: route?.path ?? existing.localPath ?? null, appFolders, callOnly };
}

/**
 * Everything that follows the registry row's removal, for ONE removed agent — the same for a single agent, a team's members, and any other path that
 * removes an agent: checkpoints and engine-side memory (never throws; leftovers are retried by the pending list), the agent's model assignment, its
 * place in group rooms (room records and the "deleted agent" mark stay), and the folder rule (below).
 */
export async function finishAgentRemoval(ctx: AgentRemovalContext, options?: AgentUninstallOptions): Promise<{ sourceMovedToTrash: boolean; forgetPartial?: string[] }> {
  // Open read connections to this agent's memory store would block deleting or moving its folder on Windows: close them first (nothing is open while the layout switch is OFF).
  try {
    const { closeAgentStoreHandles } = await import("../memory/store-delete");
    for (const folder of [ctx.folder, ...(ctx.appFolders ?? [])]) closeAgentStoreHandles(folder);
  } catch { /* nothing open */ }
  const finish = { folder: ctx.folder, appFolders: ctx.appFolders ?? [], removeSource: Boolean(options?.removeSource) };
  // (#1): the owner can ALWAYS remove an agent, whatever state the engine is in. The engine's `forget-agent` is asked first (it also clears the root's views and translation
  // jobs); when it cannot finish (no engine/Python, no answer, an old engine, a locked file) the desktop itself removes what lives with the agent — the memory store inside its folder, the
  // root's rows and turn records for it — and then runs the folder rule. What only the engine can do stays on the pending list (one line per agent, retried at app start and when the
  // engine becomes usable), and the result says `partial` with codes instead of claiming everything was forgotten.
  let forgetPartial: string[] | undefined;
  let engine: "forgotten" | "partial" | "skipped" | "unavailable" | "not_called" = "not_called";
  try {
    const { forgetAgentTraces } = await import("../agents/agent-forget");
    const trace = await forgetAgentTraces(ctx.id, { aliases: ctx.aliases, callOnly: ctx.callOnly });
    engine = trace.engine;
    if (trace.engine === "partial") forgetPartial = trace.left.length ? trace.left : ["engine_no_answer"];
    else if (trace.engine === "unavailable") forgetPartial = ["engine_unavailable"];
  } catch { engine = "partial"; forgetPartial = ["traces_failed"]; /* removal of the row is complete; the pending list keeps whatever it could */ }
  await releaseAgentReferences(ctx.id);
  const direct = await finishRemovedAgentFolders(ctx.id, finish, { engine, aliases: [ctx.id, ...ctx.aliases] });
  if (direct.left.length) forgetPartial = [...new Set([...(forgetPartial ?? []), ...direct.left])];
  if (forgetPartial) console.warn(`[agent-removal] ${ctx.id}: removed, but not everything is forgotten yet (${forgetPartial.join(",")})`);
  return { sourceMovedToTrash: direct.sourceMovedToTrash, ...(forgetPartial ? { forgetPartial } : {}) };
}

/**
 * The folder half of an agent removal. Always: the account's memory store inside the folder goes (the engine does the same when it answers; deleting a file twice is nothing), the account's copies kept in
 * `.agentlas-local/absorbed-*` go (the engine does not know them and the folder merge would revive them — #2), then the folder rule below (app-made folders to the OS Trash, an owner's
 * registered folder only loses this agent's marker). When the engine did not finish (`engine` is anything but `forgotten`) the desktop also empties the root's rows and turn records of the agent itself.
 * Returns what happened plus codes of what is still left. Never throws.
 */
export async function finishRemovedAgentFolders(agentId: string, finish: { folder: string | null; appFolders: readonly string[]; removeSource: boolean }, options: { engine?: "forgotten" | "partial" | "skipped" | "unavailable" | "not_called"; aliases?: readonly string[] } = {}): Promise<{ sourceMovedToTrash: boolean; left: string[] }> {
  const left: string[] = [];
  try {
    const { purgeAbsorbedAccountMemory, purgeAgentAccountStore } = await import("../memory/store-delete");
    const { getMemoryStoreInfo } = await import("../memory/database");
    const { agentAccountFolder } = await import("../memory/stores");
    const owner = getMemoryStoreInfo().ownerNamespace;
    const account = agentAccountFolder(owner);
    for (const folder of [finish.folder, ...finish.appFolders]) {
      if (!folder) continue;
      const failedStore = purgeAgentAccountStore(folder, account);
      if (failedStore.length) { left.push("agent_store"); console.warn(`[agent-removal] ${agentId}: its memory store inside ${failedStore.length} folder(s) could not be removed`); }
      const failed = purgeAbsorbedAccountMemory(folder, account);
      if (failed.length) { left.push("agent_store"); console.warn(`[agent-removal] ${agentId}: ${failed.length} preserved copy(ies) of its memory could not be removed`); }
    }
    // The engine said done: it emptied the root. Anything else (it could not, it was not there, it deferred): the desktop does it — it owns the root file.
    if (options.engine !== undefined && options.engine !== "forgotten" && options.engine !== "not_called") {
      const { getMemoryDb } = await import("../memory/database");
      const { purgeAgentRowsFromRoot } = await import("../memory/store-delete");
      const purged = purgeAgentRowsFromRoot(getMemoryDb(), options.aliases?.length ? options.aliases : [agentId]);
      left.push(...purged.left);
    }
  } catch { left.push("agent_store"); /* the folder rule below still runs: this was already the case before */ }
  const sourceMovedToTrash = finish.removeSource ? await trashAppOwnedFolder(finish.folder) : false;
  // After the engine was asked (it needs the folder to find the agent's memory): the stub or state folder nothing else owns.
  for (const folder of finish.appFolders) await trashAppOwnedFolder(folder);
  // A package folder the owner chose to keep no longer names an agent that is gone: its marker goes, the folder and its contents stay.
  if (!sourceMovedToTrash && finish.folder) await dropOwnerMarkerOf(finish.folder, agentId);
  return { sourceMovedToTrash, left: [...new Set(left)] };
}

/** Rows that named the agent and would otherwise stay as orphans: its own model assignment, and its seat in group rooms. Never throws. */
export async function releaseAgentReferences(agentId: string): Promise<void> {
  try {
    const { removeAgentRuntimeOverride } = await import("../store/agent-runtime-overrides");
    removeAgentRuntimeOverride("agent", agentId);
  } catch { /* no override table in an old store */ }
  try {
    // The saved Build conversations of this agent and its Build window state go with it (Agentlas 2.0 Build: retention = the agent's life).
    const { getDb } = await import("../store/db");
    const { purgeBuildsOfAgent } = await import("../hephaestus/build-workbench");
    const { previewClose } = await import("../hephaestus/build-preview");
    const db = getDb();
    const keys = db.prepare("SELECT value FROM meta WHERE key >= 'build-workbench-v1:' AND key < 'build-workbench-v1;'").all() as Array<{ value: string }>;
    for (const row of keys) { try { const meta = JSON.parse(row.value) as { agentId?: string; buildKey?: string }; if (meta.agentId === agentId && meta.buildKey) previewClose(meta.buildKey); } catch { /* unreadable meta */ } }
    purgeBuildsOfAgent(db, agentId);
  } catch { /* no meta table in a bare store, or nothing linked */ }
  try {
    const { getDb } = await import("../store/db");
    const { removeAgentChatParticipant } = await import("../one/agent-chat");
    const needle = `%${JSON.stringify(agentId).slice(1, -1).replace(/[\\%_]/g, "")}%`;
    const rooms = getDb().prepare(`SELECT tf.chat_id AS chatId, tf.member_agent_ids_json AS members FROM one_taskforces tf
        JOIN chats c ON c.id = tf.chat_id WHERE c.archived_at IS NULL AND tf.member_agent_ids_json LIKE ?`).all(needle) as Array<{ chatId: string; members: string }>;
    for (const room of rooms) {
      let members: unknown = [];
      try { members = JSON.parse(room.members); } catch { continue; }
      if (!Array.isArray(members) || !members.includes(agentId)) continue;
      // The existing "take a participant out" path: a two-person room becomes one-to-one again, the next member leads, history stays.
      try { removeAgentChatParticipant({ chatId: room.chatId, agentId }); }
      catch (error) { console.warn(`[agent-removal] room ${room.chatId} keeps ${agentId} as a deleted member:`, error instanceof Error ? error.message : error); }
    }
  } catch { /* no group-room tables in an old store */ }
}

/** Only the three files the app writes for a stub (and this computer's state folder) are in the folder. */
function isBareStubFolder(folder: string, stateFolder: string): boolean {
  try {
    return fs.readdirSync(folder).every((name) => name === "system-prompt.md" || name === "AGENT.md" || name === "manifest.md" || name === stateFolder || name === ".DS_Store");
  } catch {
    return false;
  }
}

/** Removes this agent's id from the owner marker of a folder the app made (the marker file goes when no id is left). Never throws. */
async function dropOwnerMarkerOf(folder: string, agentId: string): Promise<void> {
  try {
    const home = await import("../agents/home");
    const cls = home.classifyAgentFolder(folder);
    if (cls.owner !== "app" || cls.nested) return;
    const ids = home.ownerIds(folder);
    if (!ids.includes(agentId)) return;
    const file = path.join(folder, home.AGENT_LOCAL_STATE_FOLDER, home.AGENT_OWNER_FILE);
    const left = ids.filter((ownerId) => ownerId !== agentId);
    if (left.length === 0) fs.unlinkSync(file);
    else home.writeFileDurable(file, JSON.stringify({ schema: 1, agentId: left[0], ids: left }) + "\n");
    home.invalidateOwnerIndex();
  } catch { /* the marker stays; a later install of the same name takes the -id6 name */ }
}

/**
 * The one folder rule: a folder the app made (under the agent root, the old userData/agents, or ~/.agentlas) goes to the OS Trash; a folder the
 * owner registered in place (anywhere else) is never moved or deleted. Returns whether something moved.
 */
export async function trashAppOwnedFolder(folder: string | null | undefined): Promise<boolean> {
  if (!folder || !fs.existsSync(folder)) return false;
  try {
    const { isUserOwnedFolder } = await import("../agents/agent-forget");
    if (await isUserOwnedFolder(folder)) return false;
    const { shell } = await import("electron");
    await shell.trashItem(folder);
    return true;
  } catch {
    return false; // Registry removal remains complete; the result tells the caller that the folder still needs attention.
  }
}

/**
 * The single implementation of "remove an installed agent": occupancy settlement, DB row, routing and pool release are
 * inside registry.uninstallAgent; the rest is finishAgentRemoval. IPC team:uninstall and the agent.uninstall port both call this;
 * a team's members go through the same two steps (ipc firms:uninstall).
 */
export async function performAgentUninstall(id: string, options?: AgentUninstallOptions): Promise<RosterRemovalResult> {
  const { uninstallAgent } = await import("../mcp/registry");
  // Built-in agents (Finance, Science, ...) now own a memory folder: removing one here would delete that memory and the next start would make an empty one. The harness port refuses the same way (`agentUninstall`).
  if ((await agentRevision(id)).builtin) return { removed: false, sourceMovedToTrash: false, refused: "builtin_agent" };
  const ctx = await captureAgentRemovalContext(id);
  if (!ctx) return { removed: false, sourceMovedToTrash: false };
  // The ids are read first, then the registry row goes, then the engine is called, then the folder (the engine needs the folder to still be there).
  uninstallAgent(id);
  const { sourceMovedToTrash } = await finishAgentRemoval(ctx, options);
  return { removed: true, sourceMovedToTrash };
}

async function agentRevision(id: string): Promise<{ revision: string; builtin: boolean; exists: boolean }> {
  const { getDb } = await import("../store/db");
  const row = getDb().prepare("SELECT id, slug, installed_at, system_prompt, builtin FROM installed_agents WHERE id = ?")
    .get(id) as { id: string; slug: string; installed_at: string; system_prompt: string; builtin: number } | undefined;
  if (!row) return { revision: "", builtin: false, exists: false };
  return { revision: digest([row.id, row.slug, row.installed_at, row.system_prompt]), builtin: row.builtin === 1, exists: true };
}

async function agentUninstall(args: Args, ctx: Ctx): Promise<SettingsAgentOutcome> {
  const agentId = str(args.agentId);
  if (!agentId) return refused("agent_id_required");
  const policy = args.sourcePolicy === undefined ? "retain" : str(args.sourcePolicy);
  if (policy !== "retain" && policy !== "trash") return refused("invalid_source_policy", invalidValueMessage("sourcePolicy", args.sourcePolicy, ["retain", "trash"]));
  if (args.expectedRevision !== undefined && typeof args.expectedRevision !== "string") return refused("invalid_expected_revision");
  let state: Awaited<ReturnType<typeof agentRevision>>;
  try { state = await agentRevision(agentId); } catch (error) {
    return { status: "unavailable", reason: "store_unavailable", next: error instanceof Error ? error.message.slice(0, 200) : "The agent store is not reachable from this host." };
  }
  if (!state.exists) return refused("agent_not_found", "Nothing to remove; the agent is not installed.");
  if (state.builtin) return refused("builtin_agent", "Built-in and system agents cannot be uninstalled.");
  if (typeof args.expectedRevision === "string" && args.expectedRevision !== state.revision) {
    return refused("stale_revision", `Current agent revision is ${state.revision}.`);
  }
  if (ctx.dryRun) return refused("dry_run", "Dry run: the agent was not removed.");
  let result: RosterRemovalResult;
  try {
    result = await performAgentUninstall(agentId, { removeSource: policy === "trash" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused("uninstall_blocked", message.slice(0, 300));
  }
  const receiptId = await receipt({
    operationId: "agent.uninstall", chatId: ctx.chatId, runId: ctx.runId, inputDigest: digest({ agentId, policy }),
    domainRevision: state.revision, status: result.removed ? "removed" : "not_removed", sourcePolicy: policy, sourceMovedToTrash: result.sourceMovedToTrash,
  });
  return ok({
    removed: result.removed, sourcePolicy: policy, sourceMovedToTrash: result.sourceMovedToTrash, receiptId, agentRevision: state.revision,
    retained: ["chats", "history", "artifacts"],
    ...(policy === "trash" && result.removed && !result.sourceMovedToTrash ? { sourceNote: "The source folder was not moved to Trash (not a local import, missing, or Trash unavailable)." } : {}),
  });
}

export const SETTINGS_AGENT_PORT_HANDLERS: Record<string, (args: Args, ctx: Ctx) => Promise<SettingsAgentOutcome>> = {
  "settings.language.get": () => languageGet(),
  "settings.language.set": (args, ctx) => languageSet(args, ctx),
  "agent.uninstall": (args, ctx) => agentUninstall(args, ctx),
};
