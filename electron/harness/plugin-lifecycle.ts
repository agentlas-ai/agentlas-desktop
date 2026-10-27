/*
 * plugin.install / plugin.upgrade / plugin.uninstall (docs/2026-10-13-native-harness/15 §8, contract policy
 * "host-issued-owner-admission"). The owner's own calls (Tools page, SDK: ctx.chatId "ui") run; a model call answers
 * with the exact package for the owner to decide, because installing or removing a capability is the owner's choice.
 *
 * - install/upgrade reuse installHubPlugin (skill bundles land in ~/.agentlas/plugins/<slug>, MCP rows register; a
 *   local stdio server stays pending until the owner approves local execution) and pin the manifest's exact version.
 * - uninstall moves a skill bundle out of the plugins folder into userData/harness/trash (never deleted) or removes a
 *   connector row; built-in Agentlas plugins are switched off (plugin.disable), not removed.
 * - Revisions: one integer per slug in userData/harness/plugin-revisions.json (1 = first install); stale refused.
 * No electron import (the daemon loads the dispatcher).
 */
import fs from "node:fs";
import path from "node:path";

type Ctx = { chatId: string; runId: string; dryRun?: boolean };
type Outcome = { status: "ok"; data: unknown } | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

const ok = (data: unknown): Outcome => ({ status: "ok", data });
const refused = (reason: string, next?: string, data?: unknown): Outcome => ({ status: "refused", reason, ...(next ? { next } : {}), ...(data !== undefined ? { data } : {}) });
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;

/** The owner's own surfaces call the dispatcher with chat "ui" (renderer / SDK). */
export const ownerCall = (ctx: { chatId: string }): boolean => ctx.chatId === "ui";

async function revisionsFile(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath(path.join("harness", "plugin-revisions.json"));
}

async function readRevisions(): Promise<Record<string, { revision: number; version: string | null; updatedAt: string }>> {
  try { return JSON.parse(fs.readFileSync(await revisionsFile(), "utf8")); } catch { return {}; }
}

async function writeRevision(slug: string, version: string | null, removed = false): Promise<number> {
  const file = await revisionsFile();
  const all = await readRevisions();
  const next = (all[slug]?.revision ?? 0) + 1;
  if (removed) delete all[slug];
  else all[slug] = { revision: next, version, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** Current revision of an installed plugin: recorded, else 1 for one installed before revisions existed. */
export async function pluginRevision(slug: string): Promise<number | null> {
  const { isSkillBundleInstalled } = await import("../mcp-tools/hub-plugin-bridge");
  const recorded = (await readRevisions())[slug];
  if (recorded) return recorded.revision;
  return isSkillBundleInstalled(slug) ? 1 : null;
}

function ownerDecision(action: string, packageId: string): Outcome {
  return refused("owner_decision_required", `${action} is the owner's choice: show "${packageId}", what it adds and whether it needs a key; the owner runs it from Tools`, { packageId });
}

async function installOrUpgrade(args: Record<string, unknown>, ctx: Ctx, upgrade: boolean): Promise<Outcome> {
  const slug = str(args.packageId).replace(/^plugin:/, "");
  const version = str(args.version);
  if (!SLUG_RE.test(slug)) return refused("package_id_invalid");
  if (!ownerCall(ctx)) return ownerDecision(upgrade ? "upgrade" : "install", slug);
  const manifestUrl = str(args.manifestUrl);
  if (!/^https:\/\//.test(manifestUrl)) return refused("manifest_url_required", "the Hub listing's https manifest URL (agentlas_resolve_plugins returns it)");
  const current = await pluginRevision(slug);
  if (upgrade && current === null) return refused("not_installed", "plugin.install first");
  if (!upgrade && current !== null) return refused("already_installed", "plugin.upgrade with the new version");
  const expected = typeof args.expectedRevision === "number" ? args.expectedRevision : undefined;
  if (expected !== undefined && expected !== (current ?? 0)) return refused("stale_revision", `current revision ${current ?? 0}`);
  const bridge = await import("../mcp-tools/hub-plugin-bridge");
  const manifest = await bridge.fetchHubPluginManifest(manifestUrl);
  if (!manifest) return refused("manifest_unreachable");
  const manifestVersion = typeof manifest.version === "string" ? manifest.version : null;
  if (version && manifestVersion && version !== manifestVersion) return refused("version_mismatch", `the manifest is ${manifestVersion}`);
  if (ctx.dryRun) return refused("dry_run");
  const result = await bridge.installHubPlugin({ slug, manifestUrl, approveLocalExecution: args.approveLocalExecution === true },
    { fetchManifest: async () => manifest });
  const installedSkills = result.skills?.installed?.length ?? 0;
  const registered = result.receipts.length;
  if (installedSkills === 0 && registered === 0) return refused("nothing_installable", "the manifest carried no skills or connectable MCP servers", { receipts: result.receipts });
  const revision = await writeRevision(slug, manifestVersion ?? (version || null));
  const { appendReceipt } = await import("./capability-ports");
  const receiptId = await appendReceipt({ operationId: upgrade ? "plugin.upgrade" : "plugin.install", packageId: slug, version: manifestVersion ?? version, revision, chatId: ctx.chatId, runId: ctx.runId });
  return ok({ installId: `plugin:${slug}`, revision, version: manifestVersion ?? version, skills: result.skills ?? null, receipts: result.receipts, liveServerIds: result.liveServerIds, receiptId, note: "attaches on the next turn" });
}

export const PLUGIN_LIFECYCLE_HANDLERS: Record<string, (args: Record<string, unknown>, ctx: Ctx) => Promise<Outcome>> = {
  "plugin.install": (args, ctx) => installOrUpgrade(args, ctx, false),
  "plugin.upgrade": (args, ctx) => installOrUpgrade(args, ctx, true),
  "plugin.uninstall": async (args, ctx) => {
    const installId = str(args.installId);
    if (!installId) return refused("arguments_missing", "required: installId");
    if (!ownerCall(ctx)) return ownerDecision("uninstall", installId);
    if (installId.startsWith("connector:")) {
      const serverId = installId.slice("connector:".length);
      const { getServer, removeServer } = await import("../mcp-tools/registry");
      if (!getServer(serverId)) return refused("not_installed");
      if (ctx.dryRun) return refused("dry_run");
      removeServer(serverId);
      const { appendReceipt } = await import("./capability-ports");
      return ok({ installId, removed: true, receiptId: await appendReceipt({ operationId: "plugin.uninstall", installId, chatId: ctx.chatId, runId: ctx.runId }) });
    }
    const slug = installId.replace(/^plugin:/, "");
    if (!SLUG_RE.test(slug)) return refused("install_id_invalid");
    const { agentlasPluginsDir } = await import("../mcp-tools/hub-plugin-bridge");
    const dir = path.join(agentlasPluginsDir(), slug);
    let manifest: { publisher?: { name?: string } } = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8")); } catch { return refused("not_installed"); }
    if (manifest.publisher?.name === "Agentlas") return refused("builtin_plugin", "plugin.disable switches it off without removing it");
    const current = await pluginRevision(slug);
    const expected = typeof args.expectedRevision === "number" ? args.expectedRevision : undefined;
    if (expected === undefined) return refused("arguments_missing", `required: expectedRevision (current ${current})`);
    if (expected !== current) return refused("stale_revision", `current revision ${current}`);
    if (ctx.dryRun) return refused("dry_run");
    const { userDataPath } = await import("../runtime-paths");
    const trash = userDataPath(path.join("harness", "trash", `${slug}-${Date.now()}`));
    fs.mkdirSync(path.dirname(trash), { recursive: true, mode: 0o700 });
    fs.renameSync(dir, trash);
    await writeRevision(slug, null, true);
    const { appendReceipt } = await import("./capability-ports");
    return ok({ installId: `plugin:${slug}`, removed: true, keptAt: trash, receiptId: await appendReceipt({ operationId: "plugin.uninstall", installId: `plugin:${slug}`, chatId: ctx.chatId, runId: ctx.runId }) });
  },
};
