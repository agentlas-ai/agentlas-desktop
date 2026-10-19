import { createHash } from "node:crypto";
import fs from "node:fs";
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

/**
 * The single implementation of "remove an installed agent": occupancy settlement, DB row, routing and pool release are
 * inside registry.uninstallAgent; the original local-import source folder moves to the OS Trash only on removeSource.
 * Chats, history and artifacts are never touched here. IPC team:uninstall and the agent.uninstall port both call this.
 */
export async function performAgentUninstall(id: string, options?: AgentUninstallOptions): Promise<RosterRemovalResult> {
  const { getAgentById, uninstallAgent } = await import("../mcp/registry");
  const { getRoute } = await import("../agents/routes");
  const existing = getAgentById(id);
  if (!existing) return { removed: false, sourceMovedToTrash: false };
  const route = getRoute(id);
  uninstallAgent(id);
  let sourceMovedToTrash = false;
  if (options?.removeSource && route?.source === "local-import" && fs.existsSync(route.path)) {
    try {
      const { shell } = await import("electron");
      await shell.trashItem(route.path);
      sourceMovedToTrash = true;
    } catch {
      // Registry removal remains complete; the result tells the caller that the original folder still needs attention.
    }
  }
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
