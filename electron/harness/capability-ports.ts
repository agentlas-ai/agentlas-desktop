import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIVE_DOCUMENT_PORT_SCHEMAS as LIVE_DOCUMENT_SCHEMAS } from "../live-document/ports";
import { recordRunProducedFiles } from "./run-produced-files";
import { composeFinanceSkillContent, FINANCE_PORTS } from "../finance/tools";
import type { FinanceReceiptReference } from "../finance/receipts";
import { composeDeclaredPrompt, registerDeclaredPromptModule } from "../runtime/prompt-order";
import { didYouMean, missingArgumentsMessage } from "../../shared/did-you-mean";

/*
 * Agentlas harness capability ports (docs/2026-10-13-native-harness/15 §8, contracts/harness-capability-ports.json).
 *
 * One registry of operations every surface calls the same way: the model through the agentlas-turn gateway tools
 * (harness_search / harness_describe / harness_call), and later SDK/UI/Mobile through the same `callHarnessPort`.
 * Discovery is inert: search and describe never install, enable, log in or run anything. A port whose backing
 * service does not exist yet answers `unavailable` with a machine-readable reason instead of pretending.
 *
 * The model sees name lists in the prompt (plugins, skills, connectors) and calls these to read details or act.
 * No electron import at top level (the daemon loads the turn-tools control server): every store is loaded lazily.
 */

export type HarnessPortKind = "query" | "command" | "job" | "subscription";
export type HarnessPortStatus = "implemented" | "unavailable";

export interface HarnessCallContext {
  /** Host-only lifetime of the calling turn; never supplied by tool arguments or serialized to a child. */
  signal?: AbortSignal;
  /** Main-owned capability snapshot, absent on callers without authenticated Finance authority. */
  hostAccountBinding?: { workspaceId: string; userId: string; sessionId: string; expiresAt: number | null } | null;
  chatId: string;
  runId: string;
  /** Graph dry run or plan mode: commands are validated and refused with dry_run, nothing changes. */
  dryRun?: boolean;
  /** The run's tool permission (read|write|full); absent = read. */
  permission?: "read" | "write" | "full";
  /** The run may author graphs (One Team attached, not a Toolchain consumer or room member) — graph.draft.* gate. */
  graphAuthoring?: boolean;
  /** Exactly-once key of the caller's command (UI actions): an operation with an outside effect may dedupe on it. */
  commandId?: string;
  /** Main-only: the calling run's sealed MCP config (mcp-config.ts, prepared-transport.ts). Host-channel built-ins are
   * described and called only through it; absent (UI, mobile, SDK) they are refused, never launched bare. */
  mcpConfigPath?: string;
}

export interface HarnessPortResult {
  schemaVersion: "agentlas.harness-result.v1";
  operationId: string;
  status: "ok" | "refused" | "unavailable";
  financeReceipt?: FinanceReceiptReference;
  data?: unknown;
  /** Machine-readable cause for refused/unavailable. */
  reason?: string;
  /** What the model can do next (one line). */
  next?: string;
  receiptId: string;
}

interface PortDefinition {
  operationId: string;
  kind: HarnessPortKind;
  purpose: string;
  /** Idempotent cancellation of an exact host-bound target; never needs a UI command claim. */
  terminalTargetKeys?: readonly string[];
  required: readonly string[];
  inputSchema?: Record<string, unknown>;
  /** Absent: the port is declared but its backing service is not wired yet. */
  handler?: (args: Record<string, unknown>, ctx: HarnessCallContext) => Promise<PortOutcome>;
  /** For unavailable ports: why, and what to do instead. */
  unavailable?: { reason: string; next: string };
}

type PortOutcome =
  /** produced: absolute paths of files this call wrote. Host-only (harness/run-produced-files.ts); never in the result. */
  | { status: "ok"; data: unknown; financeReceipt?: FinanceReceiptReference; produced?: readonly string[] }
  | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

const ok = (data: unknown): PortOutcome => ({ status: "ok", data });
const refused = (reason: string, next?: string): PortOutcome => ({ status: "refused", reason, ...(next ? { next } : {}) });
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const matches = (query: string, ...fields: string[]): boolean => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = fields.join(" ").toLowerCase();
  return terms.some((term) => text.includes(term));
};

// ── receipts ledger (durable; never auto-deleted) ─────────────────────────────────────────────────────────────────

const RECEIPT_LIMIT_BYTES = 64 * 1024;

async function ledgerPath(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath(path.join("harness", "receipts.jsonl"));
}

export async function appendReceipt(entry: Record<string, unknown>): Promise<string> {
  return (await appendReceiptOutcome(entry)).receiptId;
}

/** Same ledger write, saying whether it was recorded: a receipt that could not be written is reported, not implied (22 O9). */
export async function appendReceiptOutcome(entry: Record<string, unknown>): Promise<{ receiptId: string; recorded: boolean }> {
  const receiptId = `hr_${randomUUID()}`;
  try {
    const file = await ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ receiptId, at: new Date().toISOString(), ...entry });
    if (Buffer.byteLength(line) > RECEIPT_LIMIT_BYTES) return { receiptId, recorded: false };
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    return { receiptId, recorded: true };
  } catch {
    // The ledger is evidence, not a gate: a full disk must not turn a read into a failure.
    return { receiptId, recorded: false };
  }
}

async function readReceipts(filter: (row: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[]> {
  try {
    const text = fs.readFileSync(await ledgerPath(), "utf8");
    return text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .filter((row): row is Record<string, unknown> => row !== null && filter(row));
  } catch {
    return [];
  }
}

/*
 * A media job (media.video.animate-image / .generate / .extend) has no chat of its own; its start receipt names the chat
 * that started it. Only that chat's runs take its finished files as outputs. A job that finishes after its run ended is
 * linked by the next run of that chat that reads it (media.job.status), never written into the ended run.
 */
const mediaJobChat = new Map<string, string | null>();
async function mediaJobStartedInChat(jobId: string, chatId: string): Promise<boolean> {
  if (!mediaJobChat.has(jobId)) {
    const started = await readReceipts((row) => row.jobId === jobId && typeof row.chatId === "string" && String(row.operationId ?? "").startsWith("media.video."));
    mediaJobChat.set(jobId, started.length ? started[0].chatId as string : null);
    if (mediaJobChat.size > 512) mediaJobChat.delete(mediaJobChat.keys().next().value as string);
  }
  return mediaJobChat.get(jobId) === chatId;
}

// ── plugins ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function pluginRows() {
  const { listInstalledPluginCandidates, pluginCandidatesRoot } = await import("../plugins/plugin-candidates");
  const root = pluginCandidatesRoot();
  return listInstalledPluginCandidates(root).map((plugin) => ({
    id: `plugin:${plugin.slug}`,
    slug: plugin.slug,
    name: plugin.name,
    mention: plugin.mention,
    description: plugin.description.slice(0, 280),
    hasSkills: plugin.hasSkills,
    toolIds: plugin.toolIds,
    router: path.join(root, plugin.slug, "skills", "index", "SKILL.md"),
    publisher: plugin.agentlas ? "Agentlas" : "other",
  }));
}

function pluginSkills(router: string): string[] {
  const skillsDir = path.dirname(path.dirname(router));
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
      .map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function agentlasPluginCapability(slug: string) {
  const { listCapabilities } = await import("../capabilities/one-capabilities");
  return listCapabilities().find((item) => item.source === "agentlas" && item.kind === "plugin" && (item.name === slug || item.name.split("@")[0] === slug)) ?? null;
}

async function pluginStatus(packageId: string) {
  const slug = packageId.replace(/^plugin:/, "");
  const plugin = (await pluginRows()).find((row) => row.slug === slug);
  if (!plugin) return null;
  const capability = await agentlasPluginCapability(slug);
  return { ...plugin, installed: true, enabled: capability ? capability.enabled : true, installId: capability?.id ?? `plugin:${slug}`, skills: pluginSkills(plugin.router) };
}

async function setPluginEnabled(args: Record<string, unknown>, ctx: HarnessCallContext, enabled: boolean): Promise<PortOutcome> {
  const installId = str(args.installId) || str(args.packageId);
  if (!installId) return refused("plugin_install_id_required");
  const slug = installId.replace(/^plugin:/, "");
  const capability = installId.includes(":") && !installId.startsWith("plugin:")
    ? (await import("../capabilities/one-capabilities")).listCapabilities().find((item) => item.id === installId) ?? null
    : await agentlasPluginCapability(slug);
  if (!capability) return refused("plugin_not_switchable", "built-in plugins without a switch stay on; see plugin.status");
  if (ctx.dryRun) return refused("dry_run");
  const { setCapabilityEnabled, CapabilityNotSwitchableError } = await import("../capabilities/one-capabilities");
  let changed: Awaited<ReturnType<typeof setCapabilityEnabled>>;
  try { changed = setCapabilityEnabled(capability.id, enabled); }
  catch (error) {
    if (error instanceof CapabilityNotSwitchableError) return refused("plugin_not_switchable", error.reason);
    throw error;
  }
  if (!changed) return refused("plugin_switch_failed");
  return ok({ installId: changed.id, enabled: changed.enabled, note: "takes effect on the next turn" });
}

// ── skills ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SkillRow { id: string; name: string; description: string; path: string }

function frontMatter(text: string): { name: string; description: string } {
  const block = /^---\s*([\s\S]*?)\s*---/.exec(text)?.[1] ?? text.slice(0, 600);
  const pick = (key: string) => (new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(block)?.[1] ?? "").trim().replace(/\s+/g, " ");
  return { name: pick("name"), description: pick("description") };
}

async function skillRows(): Promise<SkillRow[]> {
  const rows: SkillRow[] = [];
  try {
    const { listSkillCatalog } = await import("../hephaestus/skill-catalog");
    for (const entry of listSkillCatalog()) rows.push({ id: `catalog:${entry.slug}`, name: entry.name, description: entry.description.slice(0, 280), path: "" });
  } catch { /* no Hephaestus root: no catalog skills */ }
  for (const plugin of await pluginRows()) {
    const skillsDir = path.dirname(path.dirname(plugin.router));
    for (const name of pluginSkills(plugin.router)) {
      const file = path.join(skillsDir, name, "SKILL.md");
      let head = "";
      try { head = fs.readFileSync(file, "utf8").slice(0, 2048); } catch { continue; }
      const fm = frontMatter(head);
      rows.push({ id: `plugin:${plugin.slug}/${name}`, name: fm.name || name, description: fm.description.slice(0, 280), path: file });
    }
  }
  return rows;
}

const MAX_SKILL_READ_BYTES = 512 * 1024;

for (const workflow of ["document", "sheet", "slides"]) registerDeclaredPromptModule({
  id: `plugin.office.skill.${workflow}`, revision: 2, stability: "versioned-content", changeTriggers: ["release", "skill-package"], order: 0,
});

function composeInstalledSkillContent(skillId: string, content: string): string {
  const workflow = ["document", "sheet", "slides"].find((name) => skillId === `plugin:office/${name}`);
  if (!workflow) return composeFinanceSkillContent(skillId, content);
  if (!content.trim()) return content;
  return composeDeclaredPrompt([{ id: `plugin.office.skill.${workflow}`, revision: 2,
    stability: "versioned-content", changeTriggers: ["release", "skill-package"], order: 0, text: content }]);
}

async function readSkill(skillId: string): Promise<{ content: string; revision: string; path: string } | null> {
  if (skillId.startsWith("catalog:")) {
    const { readSkillCatalogAsset } = await import("../hephaestus/skill-catalog");
    try {
      const asset = readSkillCatalogAsset(skillId.slice("catalog:".length));
      return { content: asset.content, revision: asset.contentHash, path: "" };
    } catch {
      return null;
    }
  }
  const row = (await skillRows()).find((skill) => skill.id === skillId);
  if (!row?.path) return null;
  try {
    const stat = fs.lstatSync(row.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_READ_BYTES) return null;
    const bytes = fs.readFileSync(row.path);
    return { content: composeInstalledSkillContent(skillId, bytes.toString("utf8")), revision: sha(bytes), path: row.path };
  } catch {
    return null;
  }
}

// ── connectors / auth ─────────────────────────────────────────────────────────────────────────────────────────────

async function connectorRows() {
  const { listInstalledServers } = await import("../mcp-tools/registry");
  let servers: ReturnType<typeof listInstalledServers>;
  // A host without the store (a headless probe) has no installed connectors to list; it does not fail discovery.
  try { servers = listInstalledServers(); } catch { return []; }
  return servers.map((server) => ({
    id: `connector:${server.id}`,
    serverId: server.id,
    catalogId: server.catalogId,
    name: server.nameEn || server.name,
    transport: server.transport,
    enabled: server.enabled,
    ...(server.connectionEpoch !== undefined ? { connectionEpoch: server.connectionEpoch } : {}),
    envKeys: server.envKeys,
    // Names only: which Vault key each declared key reads for this connection ("connection" = its own account, NH29).
    ...(server.credentialRefs ? { credentialRefs: server.credentialRefs } : {}),
    credentialScope: server.credentialRefs && Object.keys(server.credentialRefs).length ? "connection" as const : "global" as const,
    url: server.url ? new URL(server.url).origin : null,
  }));
}

/**
 * Credential state of one connection. "discovery" (connector.search / describe / status, auth.status) answers from
 * value-free presence only: no secret read, no keychain listing or prompt (R-024, connector-presence.ts); production
 * 10-16..17 `harness_describe connector:*` read keychain values four times inside unattended runs. "use" (the jobs that
 * act on the connection: connector.connect, auth.ensure, auth.login) reads what it would use.
 */
async function connectorAuth(row: Awaited<ReturnType<typeof connectorRows>>[number], mode: "discovery" | "use") {
  let missingEnv: string[];
  let oauth: "usable" | "absent" | "unknown" | "not_applicable" = "not_applicable";
  let credentialState: "credential_missing" | "login_may_be_required" | "unverified" | "ready";
  if (mode === "discovery") {
    const { connectorCredentialPresence } = await import("./connector-presence");
    ({ missingEnv, oauth, credentialState } = connectorCredentialPresence(row));
  } else {
    const { hasEnvVar } = await import("../secrets/vault");
    const { credentialVaultKey } = await import("../mcp-tools/credential-refs");
    missingEnv = [];
    for (const key of row.envKeys) if (!(await hasEnvVar(credentialVaultKey(row, key)).catch(() => false))) missingEnv.push(key);
    if (row.transport !== "stdio") {
      try {
        const { listInstalledServers } = await import("../mcp-tools/registry");
        const server = listInstalledServers().find((item) => item.id === row.serverId);
        const { hasUsableMcpOAuthCredential } = await import("../mcp-tools/oauth");
        oauth = server?.url && (await hasUsableMcpOAuthCredential(server.id, server.url)) ? "usable" : "absent";
      } catch {
        oauth = "absent";
      }
    }
    credentialState = missingEnv.length > 0 ? "credential_missing" : row.transport !== "stdio" && oauth === "absent" && row.envKeys.length === 0 ? "login_may_be_required" : "ready";
  }
  const sessionState = row.enabled ? "enabled" as const : row.connectionEpoch ? "revoked" as const : "disabled" as const;
  // Every switch-off now moves the epoch (NH29), so a revoked session reads as signed out only when its credentials are
  // gone too (auth.logout); a connection the owner merely switched off, with its credentials kept, reads as disabled.
  const state = sessionState === "revoked" && (credentialState === "credential_missing" || credentialState === "login_may_be_required") ? "signed_out" as const
    : sessionState !== "enabled" ? "disabled" as const : credentialState;
  return { missingEnv, oauth, credentialState, sessionState, state };
}

/** connectionReadiness's auth axis: an unverified credential is decided by the observed handshake, like a present one. */
function readinessAuth(state: Awaited<ReturnType<typeof connectorAuth>>["credentialState"]): "ready" | "credential_missing" | "login_may_be_required" {
  return state === "unverified" ? "ready" : state;
}

/** The owner's saved key serving this connector's provider through a keyed host route (connector-keyed-route.ts). */
async function keyedRouteForConnector(row: Awaited<ReturnType<typeof connectorRows>>[number]): Promise<string | null> {
  if (row.transport === "stdio") return null;
  const { listInstalledServers } = await import("../mcp-tools/registry");
  const server = listInstalledServers().find((item) => item.id === row.serverId);
  const { keyedRouteForConnectorUrl } = await import("./connector-keyed-route");
  const { hasEnvVarAliased } = await import("../secrets/env-alias");
  return keyedRouteForConnectorUrl(server?.url, hasEnvVarAliased).catch(() => null);
}

/** Readiness from the stored observation only (no probe): configuration, credential and the last exact handshake (C05). */
async function storedConnectionReadiness(row: Awaited<ReturnType<typeof connectorRows>>[number]) {
  const observations = await import("./readiness-observations");
  const { getServer } = await import("../mcp-tools/registry");
  const { mcpServerConfigurationDigest } = await import("../mcp-tools/prepared-transport");
  const server = getServer(row.serverId);
  const auth = await connectorAuth(row, "discovery");
  return observations.connectionReadiness({ enabled: row.enabled, auth: readinessAuth(auth.credentialState), configurationDigest: server ? mcpServerConfigurationDigest(server) : "",
    observation: await observations.readReadinessObservation("connection", row.serverId) });
}

/** Bound on connector.connect's handshake + tools/list. */
const CONNECT_PROBE_MS = 15_000;

/** The Agentlas browser's own sign-in record for a site (browser_sessions); never a probe or a page load (21 G5). */
async function browserSessionFor(site: string): Promise<{ site: string; status: "valid" | "expired" | "none" } | null> {
  if (!site) return null;
  try {
    const vault = await import("../store/browser-vault");
    const norm = vault.normalizeSite(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    if (!norm) return null;
    return { site: norm, status: vault.getBrowserSite(norm)?.session.status ?? "none" };
  } catch {
    return null;
  }
}

async function findConnector(args: Record<string, unknown>) {
  const ref = str(args.connectionId) || str(args.connectorId);
  if (!ref) return null;
  const id = ref.replace(/^connector:/, "");
  return (await connectorRows()).find((row) => row.serverId === id || row.catalogId === id) ?? null;
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function toolRows() {
  const { MCP_TOOL_CATALOG } = await import("../mcp-tools/catalog");
  const installed = new Map((await connectorRows()).map((row) => [row.catalogId ?? row.serverId, row]));
  return MCP_TOOL_CATALOG.map((entry) => ({
    id: `tool:${entry.id}`,
    providerRef: entry.id,
    name: entry.nameEn || entry.name,
    description: (entry.descriptionEn || entry.description || "").slice(0, 280),
    installed: installed.has(entry.id),
    enabled: installed.get(entry.id)?.enabled ?? false,
  }));
}

// ── registry ──────────────────────────────────────────────────────────────────────────────────────────────────────


// Doc 24 §3: graph drafts. Same owner rule, checks and save as one_graph_save (graph-dispatch.ts); only the editing is incremental.
async function graphDrafts() {
  const [{ createGraphDraftService }, dispatch] = await Promise.all([import("../one/graph-draft"), import("../one/graph-dispatch")]);
  return createGraphDraftService({ ownerChatId: dispatch.oneGraphOwnerChatId, validate: dispatch.validateOneGraphBlueprint,
    save: (caller, input) => dispatch.oneGraphDispatch(caller, "one_graph_save", input) });
}
async function graphDraftCall(method: "create" | "read" | "apply" | "validate" | "commit" | "discard", args: Record<string, unknown>, ctx: HarnessCallContext): Promise<PortOutcome> {
  if (ctx.graphAuthoring !== true) return refused("graph_authoring_unavailable", "graphs are authored in a One conversation");
  if (ctx.dryRun && method === "commit") return refused("dry_run");
  const caller = { chatId: ctx.chatId, permission: ctx.permission ?? "read" as const, supervisorReplyRunId: ctx.runId };
  try {
    const result = await (await graphDrafts())[method](caller, args) as { ok?: unknown; code?: unknown };
    // one_graph_save refusals come back as data ({ ok: false, code, problems }); keep them as data, typed by status.
    return result && result.ok === false && typeof result.code === "string" ? { status: "refused", reason: result.code, data: result } : ok(result);
  } catch (error) {
    const { GraphDraftError } = await import("../one/graph-draft");
    if (error instanceof GraphDraftError) return refused(error.code, error.detail);
    if (error instanceof Error && /^(one_graph|toolchain)_[a-z_]+$/.test(error.message)) return refused(error.message);
    throw error;
  }
}
/** One draft operation through apply, so it shares the request id and revision checks. */
const graphDraftOp = (op: string) => (args: Record<string, unknown>, ctx: HarnessCallContext) => {
  const { draftId, requestId, expectedDraftRevision, ...rest } = args;
  return graphDraftCall("apply", { draftId, requestId, expectedDraftRevision, operations: [{ ...rest, op }] }, ctx);
};

const PORTS: PortDefinition[] = [
  {
    operationId: "plugin.search", kind: "query", purpose: "Read package metadata and stored installation state.", required: ["query"],
    handler: async (args) => ok((await pluginRows()).filter((row) => matches(str(args.query), row.slug, row.name, row.description)).map(({ id, mention, name, description }) => ({ id, mention, name, description }))),
  },
  {
    operationId: "plugin.describe", kind: "query", purpose: "Read package metadata and stored installation state.", required: ["packageId"],
    handler: async (args) => { const status = await pluginStatus(str(args.packageId)); return status ? ok(status) : refused("plugin_not_installed", "agentlas_resolve_plugins finds Hub plugins"); },
  },
  {
    operationId: "plugin.status", kind: "query", purpose: "Read package metadata and stored installation state.", required: ["packageId"],
    handler: async (args) => { const status = await pluginStatus(str(args.packageId)); return status ? ok({ installId: status.installId, installed: true, enabled: status.enabled }) : ok({ installed: false }); },
  },
  { operationId: "plugin.install", kind: "command", purpose: "Change exact package installation lifecycle; preserve results.", required: ["packageId", "version"], handler: async (args, ctx) => (await import("./plugin-lifecycle")).PLUGIN_LIFECYCLE_HANDLERS["plugin.install"](args, ctx) },
  { operationId: "plugin.upgrade", kind: "command", purpose: "Change exact package installation lifecycle; preserve results.", required: ["packageId", "version"], handler: async (args, ctx) => (await import("./plugin-lifecycle")).PLUGIN_LIFECYCLE_HANDLERS["plugin.upgrade"](args, ctx) },
  { operationId: "plugin.enable", kind: "command", purpose: "Change exact package installation lifecycle; preserve results.", required: ["installId"], handler: (args, ctx) => setPluginEnabled(args, ctx, true) },
  { operationId: "plugin.disable", kind: "command", purpose: "Change exact package installation lifecycle; preserve results.", required: ["installId"], handler: (args, ctx) => setPluginEnabled(args, ctx, false) },
  { operationId: "plugin.uninstall", kind: "command", purpose: "Change exact package installation lifecycle; preserve results.", required: ["installId"], handler: async (args, ctx) => (await import("./plugin-lifecycle")).PLUGIN_LIFECYCLE_HANDLERS["plugin.uninstall"](args, ctx) },
  {
    operationId: "skill.search", kind: "query", purpose: "Find skill metadata; do not activate or execute.", required: ["query"],
    handler: async (args) => ok((await skillRows()).filter((row) => matches(str(args.query), row.id, row.name, row.description)).map(({ id, name, description }) => ({ id, name, description }))),
  },
  {
    operationId: "skill.read", kind: "query", purpose: "Read the exact instruction revision and linked resources.", required: ["skillId"],
    handler: async (args) => {
      const skill = await readSkill(str(args.skillId));
      if (!skill) return refused("skill_not_found", "skill.search lists readable skills");
      const expected = str(args.skillRevision);
      if (expected && expected !== skill.revision) return refused("skill_revision_changed", `current revision ${skill.revision}`);
      return ok({ skillId: str(args.skillId), revision: skill.revision, content: skill.content });
    },
  },
  {
    operationId: "skill.activate", kind: "command", purpose: "Activate an optional skill: returns its exact content and records that the tool result was composed (provider receipt is not observed).", required: ["skillId", "skillRevision"],
    handler: async (args, ctx) => {
      const skillId = str(args.skillId);
      const skill = await readSkill(skillId);
      if (!skill) return refused("skill_not_found");
      if (str(args.skillRevision) !== skill.revision) return refused("skill_revision_changed", `read it again with skill.read (current ${skill.revision})`);
      if (ctx.dryRun) return refused("dry_run");
      const activationId = `act_${randomUUID()}`;
      // Composed here, before the adapter sends it: this is not a provider receipt or proof the model used it (22 O9).
      const receipt = await appendReceiptOutcome({ operationId: "skill.activate", activationId, skillId, revision: skill.revision, chatId: ctx.chatId, runId: ctx.runId,
        composed: "tool_result", providerAck: "unobserved" });
      return ok({ activationId, skillId, revision: skill.revision, content: skill.content,
        receipt: { composed: "tool_result", providerAck: "unobserved", ledger: receipt.recorded ? "recorded" : "unrecorded" } });
    },
  },
  {
    operationId: "skill.deactivate", kind: "command", purpose: "Mark an optional skill inactive for new work (text already in context stays).", required: ["skillId"],
    handler: async (args, ctx) => {
      if (ctx.dryRun) return refused("dry_run");
      await appendReceipt({ operationId: "skill.deactivate", skillId: str(args.skillId), activationId: str(args.activationId) || null, chatId: ctx.chatId, runId: ctx.runId });
      return ok({ skillId: str(args.skillId), active: false, note: "text already delivered this session stays in context; it no longer binds new work" });
    },
  },
  {
    operationId: "skill.activation.status", kind: "query", purpose: "Read activation/read/delivery receipts.", required: ["activationId"],
    handler: async (args) => ok(await readReceipts((row) => row.activationId === str(args.activationId))),
  },
  {
    operationId: "connector.search", kind: "query", purpose: "Read MCP definition or stored connection observation; no live probe.", required: ["query"],
    handler: async (args) => ok(await Promise.all((await connectorRows()).filter((row) => matches(str(args.query), row.serverId, row.name, row.catalogId ?? ""))
      .map(async (row) => ({ id: row.id, name: row.name, transport: row.transport, enabled: row.enabled, readiness: (await storedConnectionReadiness(row)).state })))),
  },
  {
    operationId: "connector.describe", kind: "query", purpose: "Read MCP definition or stored connection observation; no live probe.", required: ["connectorId"],
    handler: async (args) => { const row = await findConnector(args); return row ? ok({ ...row, auth: await connectorAuth(row, "discovery") }) : refused("connector_not_installed", "tool.search lists catalog connectors"); },
  },
  {
    operationId: "connector.status", kind: "query", purpose: "Read MCP definition or stored connection observation; no live probe.", required: ["connectionId"],
    handler: async (args) => { const row = await findConnector(args); return row ? ok({ id: row.id, enabled: row.enabled, ...(await connectorAuth(row, "discovery")) }) : refused("connector_not_installed"); },
  },
  {
    operationId: "connector.connect", kind: "job", purpose: "Prepare exact connection, negotiate MCP and observe actual inventory.", required: ["connectorId"],
    handler: async (args, ctx) => {
      const ref = (str(args.connectorId) || str(args.connectionId)).replace(/^(connector|tool):/, "");
      if (!ref) return refused("connector_id_required");
      if (ctx.dryRun) return refused("dry_run");
      const registry = await import("../mcp-tools/registry");
      let server = registry.listInstalledServers().find((row) => row.id === ref || row.catalogId === ref) ?? null;
      if (!server) {
        try { server = registry.installFromCatalog(ref); } catch { return refused("connector_not_in_catalog", "tool.search lists catalog connectors"); }
      }
      if (!server.enabled) server = registry.setServerEnabled(server.id, true);
      const row = (await connectorRows()).find((item) => item.serverId === server!.id)!;
      const auth = await connectorAuth(row, "use");
      const observations = await import("./readiness-observations");
      const { mcpServerConfigurationDigest } = await import("../mcp-tools/prepared-transport");
      const configurationDigest = mcpServerConfigurationDigest(server);
      if (auth.credentialState !== "credential_missing") {
        // Configuration is not readiness (C05): negotiate MCP with this exact connection and observe its tool inventory.
        const { testServerConnection } = await import("../mcp-tools/client");
        const status = await testServerConnection(server, { timeoutMs: CONNECT_PROBE_MS });
        await observations.recordReadinessObservation({ subject: "connection", id: server.id, outcome: observations.outcomeFromProbe(status), configurationDigest,
          toolCount: status.tools.length, toolNamesDigest: observations.toolNamesDigest(status.tools.map((tool) => tool.name)), via: "connector.connect" });
      }
      const readiness = observations.connectionReadiness({ enabled: true, auth: readinessAuth(auth.credentialState), configurationDigest, observation: await observations.readReadinessObservation("connection", server.id) });
      await appendReceipt({ operationId: "connector.connect", connectorId: row.id, chatId: ctx.chatId, runId: ctx.runId, state: readiness.state, ...(readiness.negotiated ? { toolCount: readiness.negotiated.toolCount } : {}) });
      return ok({ connectionId: row.id, enabled: true, auth, readiness,
        note: readiness.ready ? "its tools attach on the next turn" : ["credential_missing", "login_may_be_required", "authentication_required"].includes(readiness.state) ? "auth.ensure / auth.login next" : `not ready: ${readiness.state}` });
    },
  },
  {
    operationId: "connector.disconnect", kind: "command", purpose: "Close exact connection; preserve credentials and artifacts.", required: ["connectionId"],
    handler: async (args, ctx) => {
      const row = await findConnector(args);
      if (!row) return refused("connector_not_installed");
      if (ctx.dryRun) return refused("dry_run");
      const { setServerConnectionEnabled } = await import("../mcp-tools/registry");
      setServerConnectionEnabled(row.serverId, false);
      await appendReceipt({ operationId: "connector.disconnect", connectorId: row.id, chatId: ctx.chatId, runId: ctx.runId });
      return ok({ connectionId: row.id, enabled: false, note: "credentials and results are kept" });
    },
  },
  {
    // Agentlas extension (docs 18 §3): find MCP servers set up in Claude, Codex, Cursor, Gemini or Copilot. Inert.
    operationId: "connector.import.discover", kind: "query", purpose: "List MCP servers configured in other hosts (or at path: a plugin directory, MCPB bundle or OpenAPI file) with a compatibility grade; never values.", required: [],
    handler: async (args) => {
      const { discoverImportSources } = await import("./connector-import");
      return ok(discoverImportSources({ projectDir: str(args.projectDir) || null, path: str(args.path) || null }).map((source) => ({
        kind: source.kind,
        servers: source.definitions.map(({ name, transport, grade, loss, envKeys, secretKeys, envRefs }) => ({ name, transport, grade, loss, envKeys, secretsInSource: secretKeys, references: envRefs })),
        ...(source.unhandled?.length ? { unhandled: source.unhandled } : {}),
        ...(source.digest ? { digest: source.digest } : {}),
      })));
    },
  },
  {
    operationId: "connector.import", kind: "command", purpose: "Register chosen servers from another host's config, switched off; secrets move to the Vault by name.", required: ["kind"],
    handler: async (args, ctx) => {
      const { importConnectors } = await import("./connector-import");
      const registry = await import("../mcp-tools/registry");
      const vault = await import("../secrets/vault");
      const { PATH_IMPORT_KINDS } = await import("./connector-import");
      const kind = str(args.kind) as Parameters<typeof importConnectors>[0]["kind"];
      if (![...["claude-json", "claude-project", "codex-toml", "cursor-json", "gemini-json", "copilot-json"], ...PATH_IMPORT_KINDS].includes(kind)) return refused("import_kind_unknown", "connector.import.discover lists the kinds found");
      if (PATH_IMPORT_KINDS.includes(kind) && !str(args.path)) return refused("import_path_required", "pass path: the plugin directory, MCPB bundle or OpenAPI file");
      const { userDataPath } = await import("../runtime-paths");
      let installedRows: ReturnType<typeof registry.listInstalledServers> = [];
      try { installedRows = registry.listInstalledServers(); } catch { return refused("connector_store_unavailable"); }
      const outcomes = await importConnectors({
        kind,
        names: strList(args.names),
        newConnection: strList(args.newConnection),
        options: { projectDir: str(args.projectDir) || null, path: str(args.path) || null, bundleRoot: userDataPath(path.join("connectors", "mcpb")) },
        dryRun: ctx.dryRun,
        ports: {
          listInstalled: () => installedRows.map((row) => ({ id: row.id, command: row.command, args: row.args, url: row.url, name: row.name, envKeys: row.envKeys, ...(row.credentialRefs ? { credentialRefs: row.credentialRefs } : {}) })),
          install: (def) => registry.installCustomServer(def),
          disable: (id) => { registry.setServerEnabled(id, false); },
          // Exact name only (no misnaming alias): the comparison decides whether two entries are the same account.
          readEnv: (key) => vault.readEnvVar(key),
          setEnv: (key, value) => vault.setEnvVar(key, value),
          deleteEnv: (key) => vault.deleteEnvVar(key),
        },
      });
      await appendReceipt({ operationId: "connector.import", kind, chatId: ctx.chatId, runId: ctx.runId, outcomes: outcomes.map(({ name, status, serverId, grade, vaultSaved, vaultKept, credentialRefs }) => ({ name, status, serverId, grade, vaultSaved, vaultKept, ...(credentialRefs ? { credentialRefs } : {}) })) });
      return ok({ outcomes, next: "connector.connect turns a registered one on; its tools attach on the next turn" });
    },
  },
  {
    // Agentlas extension (docs 17 §4): subscription visual routes and media connectors with readiness reasons.
    operationId: "media.routes", kind: "query", purpose: "List image/video/speech routes: class, transport, operations, billing, readiness reason.", required: [],
    handler: async () => {
      const { mediaRoutes, routeReadinessDetail } = await import("./media-routes");
      const routes = await mediaRoutes();
      // `readiness` stays the start gate; `readinessDetail` separates configuration from what the route has produced (C08).
      return ok(await Promise.all(routes.map(async (route) => {
        const detail = await routeReadinessDetail(route);
        return { ...route, evidence: detail.evidence, readiness: detail.state, readinessDetail: detail };
      })));
    },
  },
  {
    // One host seam for keyed providers (keyed-provider.ts): the owner's saved key is used by Main and never reaches the model.
    operationId: "provider.request", kind: "job",
    purpose: "Call a keyed provider's own API (elevenlabs-audio, openai-audio, deepgram-audio, stability-image, replicate-video, runway-video) with the owner's saved key, which never reaches you; a binary answer is written to outputDir/fileName.",
    required: ["routeId", "path"],
    handler: async (args, ctx) => (await import("./keyed-provider")).keyedProviderRequest(args, ctx),
  },
  {
    operationId: "speech.synthesize", kind: "job",
    purpose: "Narration with the owner's saved speech connection (elevenlabs-audio with timing, or openai-audio); the key never reaches you. text or an absolute textPath → an mp3 in outputDir, with digest, duration and a receipt; the same request again returns the same file.",
    required: ["outputDir"],
    handler: async (args, ctx) => (await import("./keyed-provider")).speechSynthesize(args, ctx),
  },
  {
    operationId: "speech.transcribe", kind: "job",
    purpose: "Word-timed transcript of a local audio or video file through the owner's saved speech connection (elevenlabs-audio Scribe, openai-audio Whisper, deepgram-audio); the key never reaches you.",
    required: ["path"],
    handler: async (args, ctx) => (await import("./media-listen")).speechTranscribePort(args, ctx),
  },
  {
    // The listening check a run cannot do itself when its model takes no audio (media-listen.ts).
    operationId: "media.listen", kind: "job",
    purpose: "Listen to a local audio/video file for you: what is actually heard (word-timed transcript), how it differs from the script (scriptPath/scriptText: word error rate and differing spans with times), silences inside the speech, loudness and true peak, subtitle sync (subtitlePath); each check with its threshold; with outputDir a listening receipt bound to the file's sha256.",
    required: ["path"],
    handler: async (args, ctx) => (await import("./media-listen")).mediaListen(args, ctx),
  },
  {
    operationId: "media.image.generate", kind: "job", purpose: "Generate one image through a subscription route (Codex imagegen, AGY Gemini or Grok Imagine); the file is kept and optionally copied into <outputDir>/assets.", required: ["prompt"],
    handler: async (args, ctx) => {
      const route = str(args.routeId) || "auto";
      const model = route === "codex-cli-image" ? "codex" : route === "nanobanana-image" ? "gemini" : route === "grok-cli-image" ? "grok" : route === "auto" ? "auto" : null;
      if (!model) return refused("route_not_image_capable", "media.routes lists image routes; use codex-cli-image, nanobanana-image, grok-cli-image or auto");
      if (ctx.dryRun) return refused("dry_run");
      const { generateImage } = await import("../multimodal/image");
      // The run's permission reaches the image route's own CLI (multimodal/image.ts ImageAdmission, R-078).
      const result = await generateImage(model, str(args.prompt), { permission: ctx.permission });
      const { IMAGE_ENGINE_ROUTE } = await import("./media-routes");
      const { recordReadinessObservation } = await import("./readiness-observations");
      const observedRoute = (result.engine && IMAGE_ENGINE_ROUTE[result.engine]) || (route !== "auto" ? route : null);
      if (observedRoute) await recordReadinessObservation({ subject: "media-route", id: observedRoute, outcome: result.ok && result.artifactPath ? "ok" : "unavailable", via: "media.image.generate" });
      if (!result.ok || !result.artifactPath) return refused("image_generation_failed", result.reason ?? "no engine produced an image");
      let copied: string | null = null;
      const outputDir = str(args.outputDir);
      if (outputDir) {
        const { copyGeneratedImageIntoWorkspace } = await import("../multimodal/workspace-image-copy");
        copied = copyGeneratedImageIntoWorkspace({ cwd: outputDir, permission: "write", sourcePath: result.artifactPath, label: "image" });
      }
      await appendReceipt({ operationId: "media.image.generate", engine: result.engine, chatId: ctx.chatId, runId: ctx.runId, copied: Boolean(copied) });
      return { ...ok({ engine: result.engine, path: copied ?? result.artifactPath, copiedIntoAssets: Boolean(copied) }), produced: [copied ?? result.artifactPath] };
    },
  },
  {
    operationId: "media.video.animate-image", kind: "job", purpose: "Start an image-to-video job on a route (grok-cli-video, runway-video, luma-video, google-veo, seedance-video, kling-video).", required: ["routeId", "prompt"],
    handler: async (args, ctx) => {
      const { VIDEO_JOB_PROVIDER } = await import("./media-routes");
      const provider = VIDEO_JOB_PROVIDER[str(args.routeId)];
      if (!provider) return refused("route_not_video_capable", "media.routes lists media.video.animate-image routes");
      if (!str(args.imagePath) && !str(args.imageUrl)) return refused("input_image_required");
      if (ctx.dryRun) return refused("dry_run");
      const { startVideoJob } = await import("../multimodal/video");
      try {
        const job = startVideoJob({
          provider: provider as Parameters<typeof startVideoJob>[0]["provider"], prompt: str(args.prompt),
          ...(str(args.imagePath) ? { imagePath: str(args.imagePath) } : {}), ...(str(args.imageUrl) ? { imageUrl: str(args.imageUrl) } : {}),
          ...(typeof args.durationSec === "number" ? { durationSec: args.durationSec } : {}),
          ...(["16:9", "9:16", "1:1"].includes(str(args.aspectRatio)) ? { aspectRatio: str(args.aspectRatio) as "16:9" | "9:16" | "1:1" } : {}),
        });
        await appendReceipt({ operationId: "media.video.animate-image", jobId: job.id, provider, chatId: ctx.chatId, runId: ctx.runId });
        return ok({ jobId: job.id, status: job.status, next: "media.job.status with this jobId" });
      } catch (error) {
        return refused(error instanceof Error ? error.message.slice(0, 120) : "video_job_refused");
      }
    },
  },
  {
    operationId: "media.job.status", kind: "query", purpose: "Read one media job's state and output.", required: ["jobId"],
    handler: async (args, ctx) => {
      const { getVideoJob } = await import("../multimodal/video");
      const job = getVideoJob(str(args.jobId));
      if (!job) return refused("media_job_unknown");
      // The finished video is handed over by the read that reports it, to a run of the chat that started the job.
      const files = job.status === "succeeded" ? job.files.map((file) => file.absPath).filter((file) => typeof file === "string" && file) : [];
      return { ...ok(job), ...(files.length && await mediaJobStartedInChat(job.id, ctx.chatId) ? { produced: files } : {}) };
    },
  },
  {
    operationId: "media.job.cancel", kind: "command", terminalTargetKeys: ["jobId"], purpose: "Cancel one media job (provider cancel where it exists, else local stop).", required: ["jobId"],
    handler: async (args, ctx) => {
      if (ctx.dryRun) return refused("dry_run");
      const { cancelVideoJob } = await import("../multimodal/video");
      const job = cancelVideoJob(str(args.jobId));
      return job ? ok({ jobId: job.id, status: job.status }) : refused("media_job_unknown");
    },
  },
  { operationId: "media.video.generate", kind: "job", purpose: "Text-to-video on a ready route the owner selected; job status/cancel like animate-image.", required: ["prompt"],
    handler: async (args, ctx) => (await import("./media-video-generate")).mediaVideoGenerate(args, ctx) },
  {
    // NH34: edit through the same subscription routes as generation; lineage = input/output digests. No paid fallback.
    operationId: "media.image.edit", kind: "job", purpose: "Edit one image (absolute imagePath) through a subscription route (codex-cli-image or nanobanana-image); the result is a new file with the input/output digests.", required: ["imagePath", "instruction"],
    handler: async (args, ctx) => {
      const route = str(args.routeId) || "auto";
      const model = route === "codex-cli-image" ? "codex" : route === "nanobanana-image" ? "gemini" : route === "auto" ? "auto" : null;
      if (!model) return refused("route_cannot_edit_images", "media.routes lists the routes with media.image.edit");
      const imagePath = str(args.imagePath);
      if (!path.isAbsolute(imagePath)) return refused("image_path_absolute_required");
      if (ctx.dryRun) return refused("dry_run");
      const { editImage } = await import("../multimodal/image");
      const result = await editImage(model, imagePath, str(args.instruction), { permission: ctx.permission });
      const { IMAGE_ENGINE_ROUTE } = await import("./media-routes");
      const { recordReadinessObservation } = await import("./readiness-observations");
      const observedRoute = (result.engine && IMAGE_ENGINE_ROUTE[result.engine]) || (route !== "auto" ? route : null);
      if (observedRoute) await recordReadinessObservation({ subject: "media-route", id: `${observedRoute}#edit`, outcome: result.ok ? "ok" : "unavailable", via: "media.image.edit" });
      if (!result.ok || !result.artifactPath || !result.lineage) return refused("image_edit_failed", result.reason ?? "no route produced an edited image");
      let copied: string | null = null;
      if (str(args.outputDir)) {
        const { copyGeneratedImageIntoWorkspace } = await import("../multimodal/workspace-image-copy");
        copied = copyGeneratedImageIntoWorkspace({ cwd: str(args.outputDir), permission: "write", sourcePath: result.artifactPath, label: "image" });
      }
      await appendReceipt({ operationId: "media.image.edit", engine: result.engine, chatId: ctx.chatId, runId: ctx.runId, lineage: result.lineage, copied: Boolean(copied) });
      return { ...ok({ engine: result.engine, path: copied ?? result.artifactPath, lineage: result.lineage, copiedIntoAssets: Boolean(copied) }), produced: [copied ?? result.artifactPath] };
    },
  },
  {
    // NH34: continue a finished video of the same provider; the provider keeps the generation (Luma keyframes frame0).
    operationId: "media.video.extend", kind: "job", purpose: "Extend a finished video job (jobId) on a route that supports it (luma-video); job status/cancel like animate-image.", required: ["jobId", "prompt"],
    handler: async (args, ctx) => {
      const routeId = str(args.routeId) || "luma-video";
      const { mediaRoutes, VIDEO_JOB_PROVIDER } = await import("./media-routes");
      const route = (await mediaRoutes()).find((row) => row.routeId === routeId);
      if (!route || !route.operations.includes("media.video.extend")) return refused("route_cannot_extend_video", "media.routes lists the routes with media.video.extend");
      if (ctx.dryRun) return refused("dry_run");
      const { startVideoJob } = await import("../multimodal/video");
      try {
        const job = startVideoJob({ provider: VIDEO_JOB_PROVIDER[routeId] as Parameters<typeof startVideoJob>[0]["provider"], prompt: str(args.prompt), extendFromJobId: str(args.jobId),
          ...(typeof args.durationSec === "number" ? { durationSec: args.durationSec } : {}) });
        await appendReceipt({ operationId: "media.video.extend", jobId: job.id, extendsJobId: str(args.jobId), routeId, chatId: ctx.chatId, runId: ctx.runId });
        return ok({ jobId: job.id, extendsJobId: str(args.jobId), status: job.status, next: "media.job.status with this jobId" });
      } catch (error) {
        return refused(error instanceof Error ? error.message.slice(0, 120) : "video_extend_refused");
      }
    },
  },
  {
    operationId: "media.video.edit", kind: "job", purpose: "Video-to-video edit.", required: ["jobId", "prompt"],
    unavailable: { reason: "video_edit_not_wired", next: "no route here runs video-to-video yet; media.video.extend continues a Luma video, media.video.animate-image starts from a frame" },
  },
  {
    operationId: "auth.status", kind: "query", purpose: "Read redacted stored auth metadata; do not refresh, probe, or open browser.", required: ["connectionId"],
    handler: async (args) => { const row = await findConnector(args); return row ? ok({ connectionId: row.id, ...(await connectorAuth(row, "discovery")), readiness: await storedConnectionReadiness(row) }) : refused("connector_not_installed"); },
  },
  {
    operationId: "auth.ensure", kind: "job", purpose: "Reuse matching connector OAuth, Vault keys or a signed-in Agentlas browser session (site); report login need.", required: [],
    handler: async (args) => {
      const browser = await browserSessionFor(str(args.site));
      const row = await findConnector(args);
      if (!row) {
        if (!browser) return refused("connector_not_installed", "pass connectionId, or site for a browser sign-in");
        return ok({ site: browser.site, state: browser.status === "valid" ? "ready" : "login_may_be_required", reused: browser.status === "valid" ? "browser_session" : "none",
          next: browser.status === "valid" ? "use agentlas-browser on this site (signed in)" : "open the site in agentlas-browser; the owner signs in there" });
      }
      const auth = await connectorAuth(row, "use");
      if (auth.sessionState !== "enabled") return ok({ connectionId: row.id, state: auth.state, credentialState: auth.credentialState, sessionState: auth.sessionState, next: "connector.connect explicitly reconnects this exact connection" });
      if (auth.state === "ready") return ok({ connectionId: row.id, state: "ready", reused: auth.oauth === "usable" ? "oauth_session" : row.envKeys.length ? "vault_keys" : "none_needed" });
      const keyedRoute = await keyedRouteForConnector(row);
      if (keyedRoute) return ok({ connectionId: row.id, state: "ready_via_key", reused: "vault_key_route", routeId: keyedRoute,
        next: `the owner's saved key already serves this provider: use speech.synthesize or provider.request with routeId ${keyedRoute} (Main applies the key); no sign-in needed` });
      if (browser?.status === "valid") return ok({ connectionId: row.id, state: "ready_in_browser", reused: "browser_session", site: browser.site, missingEnv: auth.missingEnv,
        next: "the connector still lacks its own sign-in; for this task use agentlas-browser on the site (signed in)" });
      return ok({ connectionId: row.id, state: auth.state, missingEnv: auth.missingEnv, next: auth.missingEnv.length ? "the owner types the key in the Vault input (never in chat)" : "auth.login opens the provider sign-in" });
    },
  },
  {
    operationId: "auth.login", kind: "job", purpose: "Open login only after usable assets are absent or service requires reauthentication.", required: ["connectionId"],
    handler: async (args, ctx) => {
      const row = await findConnector(args);
      if (!row) return refused("connector_not_installed");
      const auth = await connectorAuth(row, "use");
      if (auth.credentialState === "ready") return ok({ connectionId: row.id, state: auth.state, credentialState: auth.credentialState, sessionState: auth.sessionState, note: "usable credentials already exist; no login opened", ...(auth.sessionState !== "enabled" ? { next: "connector.connect explicitly reconnects this exact connection" } : {}) });
      const keyedRoute = await keyedRouteForConnector(row);
      if (keyedRoute) return ok({ connectionId: row.id, state: "ready_via_key", routeId: keyedRoute, note: `the owner's saved key already serves this provider through routeId ${keyedRoute}; no sign-in opened` });
      const browser = await browserSessionFor(str(args.site));
      if (browser?.status === "valid") return ok({ connectionId: row.id, state: "ready_in_browser", site: browser.site, note: "signed in in agentlas-browser; no login opened" });
      if (row.transport === "stdio" || !row.url) return refused("vault_input_required", `the owner saves ${auth.missingEnv.join(", ") || "the key"} in the Vault input`);
      if (ctx.dryRun) return refused("dry_run");
      const { listInstalledServers } = await import("../mcp-tools/registry");
      const server = listInstalledServers().find((item) => item.id === row.serverId);
      if (!server?.url) return refused("connector_url_missing");
      const { startMcpOAuthAuthorization } = await import("../mcp-tools/oauth");
      const attempt = await startMcpOAuthAuthorization({ serverId: server.id, serverUrl: server.url });
      await appendReceipt({ operationId: "auth.login", connectorId: row.id, authAttemptRef: attempt.attemptId, chatId: ctx.chatId, runId: ctx.runId });
      return ok({ connectionId: row.id, authAttemptRef: attempt.attemptId, state: "waiting_for_owner", note: "the sign-in page is open for the owner" });
    },
  },
  {
    operationId: "auth.cancel", kind: "command", terminalTargetKeys: ["connectionId", "authAttemptRef"], purpose: "Cancel exact pending authentication attempt.", required: ["connectionId", "authAttemptRef"],
    handler: async (args, ctx) => {
      const row = await findConnector(args);
      if (!row) return refused("connector_not_installed");
      if (ctx.dryRun) return refused("dry_run");
      const { cancelMcpOAuthAuthorization } = await import("../mcp-tools/oauth");
      return ok(await cancelMcpOAuthAuthorization(row.serverId, str(args.authAttemptRef)));
    },
  },
  {
    operationId: "auth.logout", kind: "command", purpose: "End exact credential session; preserve other accounts and results.", required: ["connectionId"],
    handler: async (args, ctx) => {
      const row = await findConnector(args);
      if (!row) return refused("connector_not_installed");
      const { connectionOwnedVaultKeys } = await import("../mcp-tools/credential-refs");
      // Only keys this connection alone owns are removed; global keys (shared by name) stay with the owner (NH29).
      const owned = connectionOwnedVaultKeys(row);
      if (row.transport === "stdio" && !owned.length) return refused("vault_keys_are_owner_managed", "saved keys stay until the owner removes them in the Vault");
      if (ctx.dryRun) return refused("dry_run");
      const { revokeServerConnectionSession } = await import("../mcp-tools/registry");
      let revoked;
      try { revoked = revokeServerConnectionSession(row.serverId); }
      catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === "connection_epoch_unsupported" || code === "connection_epoch_invalid" || code === "connection_epoch_conflict" || code === "connector_not_installed") return refused(code);
        throw error;
      }
      if (row.transport !== "stdio") {
        const { forgetMcpOAuth } = await import("../mcp-tools/oauth");
        await forgetMcpOAuth(row.serverId);
      }
      const { deleteEnvVar } = await import("../secrets/vault");
      for (const key of owned) await deleteEnvVar(key);
      await appendReceipt({ operationId: "auth.logout", connectorId: row.id, chatId: ctx.chatId, runId: ctx.runId, ...(owned.length ? { removedConnectionKeys: owned.length } : {}) });
      return ok({ connectionId: row.id, state: "signed_out", enabled: false, connectionEpoch: revoked.connectionEpoch, ...(owned.length ? { removedConnectionKeys: owned.length } : {}) });
    },
  },
  {
    operationId: "capability.resolve", kind: "job", purpose: "Retrieve candidates; record explicit user/model selection and validate binding.", required: ["taskRef"],
    handler: async (args, ctx) => {
      const query = str(args.taskRef);
      const [plugins, skills, connectors] = await Promise.all([pluginRows(), skillRows(), connectorRows()]);
      // Candidates only: the model chooses. A selection given back is recorded as the model's choice.
      const candidates = {
        plugins: plugins.filter((row) => matches(query, row.slug, row.name, row.description)).map((row) => row.id),
        skills: skills.filter((row) => matches(query, row.id, row.name, row.description)).map((row) => row.id),
        connectors: connectors.filter((row) => matches(query, row.serverId, row.name)).map((row) => row.id),
      };
      const selection = strList(args.selectionRef ? [args.selectionRef] : args.selection);
      const receiptId = selection.length && !ctx.dryRun
        ? await appendReceipt({ operationId: "capability.resolve", taskRef: query.slice(0, 500), selection, chatId: ctx.chatId, runId: ctx.runId })
        : null;
      return ok({ candidates, selection, selectionReceipt: receiptId });
    },
  },
  {
    operationId: "agent.capabilities.get", kind: "query", purpose: "Read exact personal/worker agent bindings.", required: ["agentId"],
    handler: async (args, ctx) => {
      const { selectionFor } = await import("../capabilities/one-capabilities");
      // The calling conversation decides the One role (personal vs CEO), the same way its runs resolve it.
      const selection = selectionFor(str(args.agentId) || undefined, undefined, ctx.chatId);
      return ok({ isOne: selection.isOne, role: selection.role, enabled: selection.items.filter((item) => item.enabled).map(({ id, kind, source, name }) => ({ id, kind, source, name })) });
    },
  },
  {
    operationId: "agent.capabilities.set", kind: "command", purpose: "Attach or revoke exact references under current owner scope.", required: ["agentId"],
    handler: async (args, ctx) => {
      const { selectionFor, setCapabilityEnabled } = await import("../capabilities/one-capabilities");
      const { BUILTIN_ONE_AGENT_ID } = await import("../../shared/builtin-agent-ids");
      if (str(args.agentId) !== BUILTIN_ONE_AGENT_ID) return refused("personal_capabilities_are_one_only", "workers use the plugins and connectors of their run");
      const attach = [...strList(args.skillRefs), ...strList(args.toolRefs), ...strList(args.connectionRefs)];
      const revoke = strList(args.revokeRefs);
      const items = selectionFor(str(args.agentId)).items;
      const known = new Set(items.map((item) => item.id));
      const unknown = [...attach, ...revoke].filter((id) => !known.has(id));
      if (unknown.length) return refused("capability_ref_unknown", `unknown: ${unknown.slice(0, 5).join(", ")}`);


      const personal = items.filter((item) => item.source !== "agentlas" && [...attach, ...revoke].includes(item.id)).map((item) => item.id);
      if (personal.length) return refused("personal_runtime", `personal runtime items are not used by Agentlas runs: ${personal.slice(0, 5).join(", ")}`);
      if (ctx.dryRun) return refused("dry_run");
      for (const id of attach) setCapabilityEnabled(id, true);
      for (const id of revoke) setCapabilityEnabled(id, false);
      await appendReceipt({ operationId: "agent.capabilities.set", agentId: str(args.agentId), attach, revoke, chatId: ctx.chatId, runId: ctx.runId });
      return ok({ attached: attach, revoked: revoke, note: "takes effect on the next turn" });
    },
  },
  {
    operationId: "tool.search", kind: "query", purpose: "Search actual tool metadata plus explicitly unready candidates.", required: ["query"],
    handler: async (args) => ok((await toolRows()).filter((row) => matches(str(args.query), row.providerRef, row.name, row.description))
      .filter((row) => args.includeUnready === true || row.installed).map(({ id, name, description, installed, enabled }) => ({ id, name, description, installed, enabled }))),
  },
  {
    operationId: "tool.describe", kind: "query", purpose: "Read exact schema, provider, availability and result/UI contract.", required: ["toolId"],
    handler: async (args, ctx) => {
      const id = str(args.toolId).replace(/^tool:/, "");
      const row = (await toolRows()).find((item) => item.providerRef === id);
      if (!row) return refused("tool_not_in_catalog");
      const dispatch = await import("./tool-dispatch");
      // A host-channel built-in exists for this call only through the calling run's sealed binding (no launch here).
      const installed = row.enabled ? await dispatch.findServer(row.providerRef) : null;
      const bound = installed ? await dispatch.runScopedBinding(installed, ctx) : null;
      if (bound && !bound.ok) return { status: "refused", reason: bound.code, next: bound.next, data: { ...row, availability: bound.code } };
      // Live tool names and schema digests (tool.call requires the digest it was described with).
      // Opt-in (live: true): it starts the server once; plain describe stays inert.
      const live = row.enabled && args.live === true ? await dispatch.describeConnectorTools(row.providerRef, ctx) : null;
      return ok({ ...row, availability: bound?.ok && bound.prepared ? "attached_to_this_run" : row.enabled ? "attached_when_the_run_needs_it" : row.installed ? "installed_off" : "not_installed",
        ...(live?.ok ? { tools: live.tools.map(({ name, description, schemaDigest, inputSchema }) => ({ name, description, schemaDigest, inputSchema })) }
          : live ? { liveState: live.code } : {}),
        next: row.enabled ? "call it by its MCP tool name, or describe with live: true and tool.call with providerRef + schemaDigest" : "connector.connect" });
    },
  },
  { operationId: "tool.call", kind: "job", purpose: "Dispatch once through policy/auth/current binding and preserve exact result.", required: ["toolId", "providerRef", "schemaDigest", "arguments"], handler: async (args, ctx) => (await import("./tool-dispatch")).TOOL_PORT_HANDLERS["tool.call"](args, ctx) },
  { operationId: "tool.result", kind: "query", purpose: "Read exact invocation state and retained result handle.", required: ["callId"], handler: async (args, ctx) => (await import("./tool-dispatch")).TOOL_PORT_HANDLERS["tool.result"](args, ctx) },
  { operationId: "tool.cancel", kind: "command", terminalTargetKeys: ["callId"], purpose: "Cancel original call; settle external outcome without blind replay.", required: ["callId"], handler: async (args, ctx) => (await import("./tool-dispatch")).TOOL_PORT_HANDLERS["tool.cancel"](args, ctx) },
  { operationId: "tool.subscribe", kind: "subscription", purpose: "Resume invocation events from cursor without starting execution.", required: ["callId"], handler: async (args, ctx) => (await import("./tool-dispatch")).TOOL_PORT_HANDLERS["tool.subscribe"](args, ctx) },
  { operationId: "ui.present", kind: "command", purpose: "Project durable results; route actions through the same dispatcher.", required: [], handler: async (args, ctx) => (await import("./ui-instances")).UI_PORT_HANDLERS["ui.present"](args, ctx) },
  { operationId: "ui.update", kind: "command", purpose: "Project durable results; route actions through the same dispatcher.", required: ["instanceId"], handler: async (args, ctx) => (await import("./ui-instances")).UI_PORT_HANDLERS["ui.update"](args, ctx) },
  { operationId: "ui.close", kind: "command", purpose: "Project durable results; route actions through the same dispatcher.", required: ["instanceId"], handler: async (args, ctx) => (await import("./ui-instances")).UI_PORT_HANDLERS["ui.close"](args, ctx) },
  { operationId: "ui.action", kind: "command", purpose: "Project durable results; route actions through the same dispatcher.", required: ["instanceId", "actionId"], handler: async (args, ctx) => (await import("./ui-instances")).UI_PORT_HANDLERS["ui.action"](args, ctx) },
  { operationId: "ui.subscribe", kind: "subscription", purpose: "Read result UI instance events and revisions.", required: ["instanceId"], handler: async (args, ctx) => (await import("./ui-instances")).UI_PORT_HANDLERS["ui.subscribe"](args, ctx) },
  { operationId: "result.read", kind: "query", purpose: "Read exact retained original, structured data or artifact part.", required: ["resultRef", "part"], handler: async (args, ctx) => (await import("./tool-dispatch")).TOOL_PORT_HANDLERS["result.read"](args, ctx) },
  {
    operationId: "mcp.app.resource.read", kind: "query", purpose: "Read one MCP Apps ui:// view of an installed, enabled connector (HTML for the sandboxed host).", required: ["connectorId", "uri"],
    handler: async (args, ctx) => (await import("./tool-dispatch")).TOOL_PORT_HANDLERS["mcp.app.resource.read"](args, ctx),
  },
  // Doc 13 §7: provider cache settings. Gemini explicit cachedContents stores tokens Google bills per hour, so only the
  // owner's own surfaces (chat "ui") may turn it on or change its TTL; a model's harness_call reads it only.
  {
    operationId: "cache.settings.get", kind: "query", purpose: "Provider cache settings: Gemini explicit cachedContents (enabled, ttlSeconds).", required: [],
    handler: async () => ok({ gemini: await (await import("../runtime/gemini-explicit-cache")).readGeminiCacheSetting() }),
  },
  {
    operationId: "cache.settings.set", kind: "command", purpose: "Owner only: Gemini explicit cachedContents on/off and TTL (60-86400 s; storage billed per hour by Google).", required: ["provider"],
    handler: async (args, ctx) => {
      if (ctx.dryRun) return refused("dry_run");
      if (ctx.chatId !== "ui") return refused("owner_only", "the owner changes cache billing settings from Settings");
      if (args.provider !== "gemini") return refused("provider_unsupported", "provider: gemini");
      const cache = await import("../runtime/gemini-explicit-cache");
      const next: { enabled?: boolean; ttlSeconds?: number } = {};
      if (typeof args.enabled === "boolean") next.enabled = args.enabled;
      if (typeof args.ttlSeconds === "number") next.ttlSeconds = args.ttlSeconds;
      const saved = await cache.writeGeminiCacheSetting(next);
      await appendReceipt({ operationId: "cache.settings.set", provider: "gemini", enabled: saved.enabled, ttlSeconds: saved.ttlSeconds });
      return ok({ gemini: saved });
    },
  },
  // Doc 24 §3: build a graph a few operations at a time; graph.draft.commit saves through one_graph_save.
  { operationId: "graph.draft.create", kind: "command", purpose: "Start a graph draft (optional blueprint seed; graphId+expectedRevision to replace a saved graph).", required: [],
    handler: (args, ctx) => graphDraftCall("create", args, ctx) },
  { operationId: "graph.draft.read", kind: "query", purpose: "Draft steps by ref, branches, checks, trigger (includeBlueprint for the compiled blueprint).", required: ["draftId"],
    handler: (args, ctx) => graphDraftCall("read", args, ctx) },
  { operationId: "graph.draft.apply", kind: "command", purpose: "Apply operations all-or-nothing: node.create|update|move|remove, edge.connect|disconnect, branch.set|remove, repeat.set, check.add|remove, trigger.set, draft.set.", required: ["draftId", "operations"],
    handler: (args, ctx) => graphDraftCall("apply", args, ctx) },
  { operationId: "graph.node.create", kind: "command", purpose: "Add a step: ref, title, instruction, effect read|mutation (+kind, produces, consumes, uses, code…; before/after ref).", required: ["draftId", "ref", "title", "instruction", "effect"],
    handler: graphDraftOp("node.create") },
  { operationId: "graph.node.update", kind: "command", purpose: "Change a step: ref, set {fields}, unset [fields].", required: ["draftId", "ref"], handler: graphDraftOp("node.update") },
  { operationId: "graph.node.move", kind: "command", purpose: "Move a step before/after another ref.", required: ["draftId", "ref"], handler: graphDraftOp("node.move") },
  { operationId: "graph.node.remove", kind: "command", purpose: "Remove a step nothing still uses.", required: ["draftId", "ref"], handler: graphDraftOp("node.remove") },
  { operationId: "graph.edge.connect", kind: "command", purpose: "Feed from.produces into a later step's consumes.", required: ["draftId", "from", "to"], handler: graphDraftOp("edge.connect") },
  { operationId: "graph.edge.disconnect", kind: "command", purpose: "Stop feeding from.produces into to.", required: ["draftId", "from", "to"], handler: graphDraftOp("edge.disconnect") },
  { operationId: "graph.branch.set", kind: "command", purpose: "Condition after a step: id, after, var, test, value, yes/no refs.", required: ["draftId", "id", "after", "var", "test"], handler: graphDraftOp("branch.set") },
  { operationId: "graph.branch.remove", kind: "command", purpose: "Remove a branch or repeat by id.", required: ["draftId", "id"], handler: graphDraftOp("branch.remove") },
  { operationId: "graph.repeat.set", kind: "command", purpose: "Bounded repeat: id, after, var, test, value, repeat (earlier ref), repeatOn yes|no, maxRepeats 1-20.", required: ["draftId", "id", "after", "var", "test", "repeat", "repeatOn", "maxRepeats"], handler: graphDraftOp("repeat.set") },
  { operationId: "graph.check.add", kind: "command", purpose: "Verification step after a step: id, after, subject, criteria, items, produces, evidence.", required: ["draftId", "id", "after", "subject", "criteria"], handler: graphDraftOp("check.add") },
  { operationId: "graph.check.remove", kind: "command", purpose: "Remove a check by id.", required: ["draftId", "id"], handler: graphDraftOp("check.remove") },
  { operationId: "graph.trigger.set", kind: "command", purpose: "Start condition: kind cron (schedule) | input (label, varName).", required: ["draftId", "kind"], handler: graphDraftOp("trigger.set") },
  { operationId: "graph.draft.validate", kind: "query", purpose: "Run one_graph_save's checks on the draft without saving.", required: ["draftId"],
    handler: (args, ctx) => graphDraftCall("validate", args, ctx) },
  { operationId: "graph.draft.commit", kind: "command", purpose: "Save the draft through one_graph_save (requestId; retries return the first receipt).", required: ["draftId", "requestId"],
    handler: (args, ctx) => graphDraftCall("commit", args, ctx) },
  { operationId: "graph.draft.discard", kind: "command", purpose: "Delete a draft (saved graphs are untouched).", required: ["draftId"],
    handler: (args, ctx) => graphDraftCall("discard", args, ctx) },
  // Doc 12 F3: thread / turn service over Agentlas' own journal (thread-service.ts) for every executor and caller.
  { operationId: "thread.list", kind: "query", purpose: "Recent conversations (or one project's), newest first, with whether a turn is running.", required: [],
    handler: async (args) => (await import("./thread-service")).threadList(args) },
  { operationId: "thread.read", kind: "query", purpose: "One conversation's messages, oldest first; page back with the returned olderCursor (pass as cursor).", required: ["threadId"],
    handler: async (args) => (await import("./thread-service")).threadRead(args) },
  { operationId: "turn.status", kind: "query", purpose: "The newest run of a conversation: status, times, model, error code.", required: ["threadId"],
    handler: async (args) => (await import("./thread-service")).turnStatus(args) },
  { operationId: "turn.interrupt", kind: "command", purpose: "Owner only: Stop the running turn of a conversation.", required: ["threadId"],
    handler: async (args, ctx) => (await import("./thread-service")).turnInterrupt(args, ctx) },
  { operationId: "turn.start", kind: "command", purpose: "Owner only: start a turn with text in an idle Work conversation (permissions read|write|full, default: the last run's).", required: ["threadId", "text"],
    handler: async (args, ctx) => (await import("./thread-service")).turnStart(args, ctx) },
  // Doc 12 F6: a capability added only by this port + its FeatureModule (feature-registry.ts "media-quality").
  {
    operationId: "media.quality.probe", kind: "query", purpose: "Measure a local video/audio/image file (size, duration, resolution, fps, audio; optional loudness) and check it against expectations.", required: ["path"],
    handler: async (args) => (await import("./media-quality")).mediaQualityProbe(args),
  },
  // Doc 01 §1: the common pre-effect checkpoint. Read-only view of effects whose outcome was never confirmed.
  {
    operationId: "effects.uncertain", kind: "query", purpose: "Mutating tool calls that began but never confirmed an outcome (optionally for one chatId).", required: [],
    handler: async (args) => ok({ effects: await (await import("./effect-ledger")).uncertainEffects(typeof args.chatId === "string" ? args.chatId : undefined) }),
  },
  // Doc 13 §7: the wire a BYOK backend speaks (DeepSeek: Chat Completions or its stateless Responses). Owner-only change.
  {
    operationId: "byok.wire.get", kind: "query", purpose: "The wire each BYOK backend speaks (deepseek: chat | responses).", required: [],
    handler: async () => ok({ wires: await (await import("../runtime/byok-wire")).readByokWires() }),
  },
  {
    operationId: "byok.wire.set", kind: "command", purpose: "Owner only: choose a documented wire for a BYOK backend (deepseek: chat | responses).", required: ["backend", "wire"],
    handler: async (args, ctx) => {
      if (ctx.dryRun) return refused("dry_run");
      if (ctx.chatId !== "ui") return refused("owner_only", "the owner chooses the provider wire from Settings");
      const wires = await import("../runtime/byok-wire");
      const backend = typeof args.backend === "string" ? args.backend : "";
      const wire = args.wire === "responses" || args.wire === "chat" ? args.wire : null;
      if (!wire || !(wires.BYOK_WIRES[backend] ?? []).includes(wire)) return refused("wire_unsupported", `supported: ${JSON.stringify(wires.BYOK_WIRES)}`);
      await wires.writeByokWire(backend, wire);
      await appendReceipt({ operationId: "byok.wire.set", backend, wire });
      return ok({ wires: await wires.readByokWires() });
    },
  },
  // Doc 14 §5-6: the first two small features as one domain operation for every caller (UI, SDK, model, app control, daemon).
  {
    operationId: "settings.language.get", kind: "query", purpose: "The core language setting: locale, preference, revision.", required: [],
    handler: async (args, ctx) => (await import("./settings-agent-ops")).SETTINGS_AGENT_PORT_HANDLERS["settings.language.get"](args, ctx),
  },
  {
    operationId: "settings.language.set", kind: "command", purpose: "Set ko, en or system with an expected revision; the saved receipt and each UI's application ACK are reported separately.", required: ["locale"],
    handler: async (args, ctx) => (await import("./settings-agent-ops")).SETTINGS_AGENT_PORT_HANDLERS["settings.language.set"](args, ctx),
  },
  {
    operationId: "agent.uninstall", kind: "command", purpose: "Remove an installed agent (occupancy, routing, pools); sourcePolicy retain (default) or trash; chats and history stay.", required: ["agentId"],
    handler: async (args, ctx) => (await import("./settings-agent-ops")).SETTINGS_AGENT_PORT_HANDLERS["agent.uninstall"](args, ctx),
  },
  // Doc 14 §6-8: every app-control operation (settings, Work, Graph, Apps, automations, agents, projects, memory,
  // models, mail, Science) through the same dispatcher — same catalog, validation and owner-turn policy as One's
  // one_app_operations / one_app_call. The owner's own surfaces (chat "ui") count as an owner turn, and so does the
  // personal One's reply to a message the owner wrote (the same host-sealed provenance one_app_call reads, 22 O7 / 21 G4);
  // any other model harness_call does not, so destructive or consent operations are refused there with the reason.
  {
    operationId: "app.operations", kind: "query", purpose: "Discover app operations (query in English words, area, or exact operation for its input_schema).", required: [],
    handler: async (args) => ok(await (await import("../app-control/service")).appControlOperations(args)),
  },
  {
    operationId: "app.call", kind: "command", purpose: "Run one app operation with its exact input_schema (destructive/consent operations need the owner).", required: ["operation"],
    handler: async (args, ctx) => {
      if (ctx.dryRun) return refused("dry_run");
      try {


        const appArgs = args.args !== undefined ? args.args : args.input;
        const result = await (await import("../app-control/service")).appControlCall({ ownerTurn: await harnessOwnerTurn(ctx) }, { operation: args.operation, args: appArgs });
        return ok(result);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "operation_failed";
        // 600, not 300: the handler's own text can lead and the argument hint (service.ts withArgumentHints) follows it.
        return refused(code, error instanceof Error ? error.message.slice(0, 600) : undefined);
      }
    },
  },
  // Canonical 18-area registry (doc 03 §2-3): agentlas.<area>.<action> ids and owner aliases over these ports and the
  // existing tools; search is deterministic, an unknown name runs nothing.
  {
    operationId: "tool.canonical.project", kind: "query", purpose: "The same canonical registry projected for one wire (mcp | codex-dynamic | anthropic-deferred) with each entry's schemaDigest.", required: ["target"],
    handler: async (args, ctx) => (await import("./canonical-registry")).CANONICAL_PORT_HANDLERS["tool.canonical.project"](args, ctx),
  },
  {
    operationId: "tool.canonical.search", kind: "query", purpose: "Search agentlas.<area>.<action> entries (area/effects filters only when asked).", required: ["query"],
    handler: async (args, ctx) => (await import("./canonical-registry")).CANONICAL_PORT_HANDLERS["tool.canonical.search"](args, ctx),
  },
  {
    operationId: "tool.canonical.describe", kind: "query", purpose: "One canonical entry or alias (canonicalId or name): schema digest, effects, consent, backing and availability.", required: [],
    handler: async (args, ctx) => (await import("./canonical-registry")).CANONICAL_PORT_HANDLERS["tool.canonical.describe"](args, ctx),
  },
  {
    operationId: "tool.canonical.call", kind: "job", purpose: "Run a port-backed canonical entry (canonicalId or name); a tool-backed one answers with its exact tool name.", required: [],
    handler: async (args, ctx) => (await import("./canonical-registry")).CANONICAL_PORT_HANDLERS["tool.canonical.call"](args, ctx),
  },
  // Context inspector (doc 20 §6): read-only; never calls a model, logs in, compacts or ends a session.
  {
    operationId: "context.inspect", kind: "query", purpose: "What a chat's model request carried (the last, or requestId), item by item, with each item's measurement.", required: [],
    // Scoped to the caller's own chat (a run never reads another conversation's requests); requestId picks a past request (NH18).
    handler: async (args, ctx) => (await import("./context-inspect")).CONTEXT_PORT_HANDLERS["context.inspect"](args, ctx),
  },
  {
    operationId: "context.sources.get", kind: "query", purpose: "The retained original of one context item occurrence of the caller's chat.", required: ["occurrenceId"],
    handler: async (args, ctx) => (await import("./context-inspect")).CONTEXT_PORT_HANDLERS["context.sources.get"](args, ctx),
  },
  {
    operationId: "context.items.list", kind: "query", purpose: "Page through prompt modules (with size) and installed plugins, skills, connectors and tools.", required: ["list"],
    handler: async (args) => {
      const list = str(args.list);
      if (!["modules", "plugins", "skills", "connectors", "tools"].includes(list)) return refused("list_unknown", "modules, plugins, skills, connectors or tools");
      const { listContextItems } = await import("./context-inspect");
      return ok(await listContextItems(list as "modules", {
        cursor: typeof args.cursor === "number" ? args.cursor : undefined, limit: typeof args.limit === "number" ? args.limit : undefined,
        locale: args.locale === "ko" ? "ko" : "en",
      }));
    },
  },
  // G21: read-only operator telemetry over the model-call ledger; the owner opens it, nothing calls a model.
  {
    operationId: "telemetry.summary", kind: "query", purpose: "Operator view: calls by role, retries, cache hit ratio, compactions and cost (unknown counted separately) for a chat or period.", required: [],
    handler: async (args) => {
      const { telemetrySummary } = await import("./telemetry-summary");
      return ok(await telemetrySummary({
        chatId: str(args.chatId) || undefined, since: str(args.since) || undefined, until: str(args.until) || undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }));
    },
  },
  // G18: owner-supplied price table (the built-in table is empty). Changing it is the owner's call from Settings.
  {
    operationId: "pricing.list", kind: "query", purpose: "The model price table in force: owner-entered entries (built-in table is empty) with currency, effective date, revision and source.", required: [],
    handler: async () => {
      const pricing = await import("../runtime/model-pricing");
      return ok({ schemaVersion: pricing.MODEL_PRICE_SCHEMA, builtIn: pricing.BUILT_IN_PRICES.length, entries: pricing.activePriceTable() });
    },
  },
  {
    operationId: "pricing.set", kind: "command", purpose: "Owner only: add/replace a price entry (provider, model, currency, effectiveFrom, source, inputPerM, outputPerM; optional cachedReadPerM, cacheWritePerM, prefix) or remove one (remove: true).", required: ["provider", "model"],
    handler: async (args, ctx) => {
      if (ctx.dryRun) return refused("dry_run");
      if (ctx.chatId !== "ui") return refused("owner_only", "the owner enters prices from Settings");
      const pricing = await import("../runtime/model-pricing");
      if (args.remove === true) {
        if (!str(args.effectiveFrom)) return refused("effective_from_required", "name the entry's effectiveFrom to remove it");
        const entries = pricing.removeOwnerPrice({ provider: str(args.provider), model: str(args.model), prefix: args.prefix === true, effectiveFrom: str(args.effectiveFrom) });
        await appendReceipt({ operationId: "pricing.set", removed: true, provider: str(args.provider), model: str(args.model) });
        return ok({ entries });
      }
      const checked = pricing.validatePriceEntry(args);
      if (!checked.ok) return refused(checked.reason, "see pricing.list for the entry shape");
      const entries = pricing.upsertOwnerPrice(checked.entry);
      await appendReceipt({ operationId: "pricing.set", provider: checked.entry.provider, model: checked.entry.model, revision: checked.entry.revision });
      return ok({ entries });
    },
  },
  {
    operationId: "context.items.get", kind: "query", purpose: "One prompt module's exact rendered text and size.", required: ["itemId"],
    handler: async (args) => {
      const { getContextItem } = await import("./context-inspect");
      const item = await getContextItem(str(args.itemId), args.locale === "ko" ? "ko" : "en");
      return item ? ok(item) : refused("item_unknown", "module ids come from context.items.list modules; others: harness_describe");
    },
  },
  ...FINANCE_PORTS,
  // Live documents (live-document/ports.ts): the owner watches these edits typed into the Document tab.
  { operationId: "document.list", kind: "query", purpose: "Office documents (xlsx docx pptx hwpx hwp) open for live editing in this conversation.", required: [],
    handler: async (args, ctx) => (await import("../live-document/ports")).documentList(args, ctx) },
  { operationId: "document.open", kind: "command", purpose: "Open a local xlsx/docx/pptx/hwpx/hwp file for live editing in the owner's Document tab; returns sessionId, addressable outline and the ops its format supports.", required: ["path"],
    inputSchema: LIVE_DOCUMENT_SCHEMAS.open, handler: async (args, ctx) => (await import("../live-document/ports")).documentOpen(args, ctx) },
  { operationId: "document.create", kind: "command", purpose: "Create a new blank A4 docx/xlsx/pptx/hwpx file (Hangul documents are .hwpx) at a path that does not exist yet and open it in the Document tab for live editing.", required: ["path"],
    inputSchema: LIVE_DOCUMENT_SCHEMAS.create, handler: async (args, ctx) => (await import("../live-document/ports")).documentCreate(args, ctx) },
  { operationId: "document.read", kind: "query", purpose: "Current outline of a live document with the ids its ops address (cells A1, block, table-cell and slide-shape ids) and its revision.", required: ["sessionId"],
    inputSchema: LIVE_DOCUMENT_SCHEMAS.read, handler: async (args, ctx) => (await import("../live-document/ports")).documentRead(args, ctx) },
  { operationId: "document.apply", kind: "command", purpose: "Edit a live document in its original format, all-or-nothing: set_cell, add_sheet, rename_sheet, delete_sheet, set_number_format, add_chart, set_text, insert_text, insert_paragraph, insert_table (docx/hwpx, or on a pptx slide: after = the slide id), delete_block, add_slide, delete_slide, set_notes (pptx speaker notes), set_format (bold/italic/underline/size/color/align/fill, heading), insert_table widths; the owner sees each edit typed.", required: ["sessionId", "ops"],
    inputSchema: LIVE_DOCUMENT_SCHEMAS.apply, handler: async (args, ctx) => (await import("../live-document/ports")).documentApply(args, ctx) },
  { operationId: "document.render", kind: "query", purpose: "Photograph an open document's slides, pages or sheets as PNG images to check its layout: text running out of its box, overlapping boxes, a table off the page. At most 4 per call (from/count; the reply's next says where to continue). Returns each image (shown to you where your runtime reads images) and the boxes that overflow. Agentlas's own layout of the document's current working state, unsaved edits included, not Office's.", required: ["sessionId"],
    inputSchema: LIVE_DOCUMENT_SCHEMAS.render, handler: async (args, ctx) => (await import("../live-document/ports")).documentRender(args, ctx) },
  { operationId: "document.save", kind: "command", purpose: "Write a live document back to its file in the original format (refused if the file changed on disk meanwhile).", required: ["sessionId"],
    inputSchema: LIVE_DOCUMENT_SCHEMAS.save, handler: async (args, ctx) => (await import("../live-document/ports")).documentSave(args, ctx) },
];

const PORT_BY_ID = new Map(PORTS.map((port) => [port.operationId, port]));

/** A host-issued action may always cancel its fixed original target, even when UI claim persistence is unavailable. */
export function isFixedTerminalHarnessAction(operationId: string, fixedArgs: Record<string, unknown>): boolean {
  const keys = PORT_BY_ID.get(operationId)?.terminalTargetKeys;
  return Boolean(keys?.length && keys.every(key => typeof fixedArgs[key] === "string" && (fixedArgs[key] as string).trim().length > 0));
}

export function harnessPortIds(): string[] {
  return PORTS.map((port) => port.operationId);
}

export function harnessPortStatus(operationId: string): HarnessPortStatus | null {
  const port = PORT_BY_ID.get(operationId);
  return port ? (port.handler ? "implemented" : "unavailable") : null;
}

/** One dispatcher for every caller. Unknown operations, missing fields and unwired ports answer, never throw. */
/**
 * Owner provenance for app.call. The run id comes from Main's per-run capability binding, never from model arguments.
 * The personal One's reply run bound to an owner-written message is an owner turn on every entry (22 O7 / 21 G4):
 * one_app_call and harness app.call ask the same supervisor; a review, check-in or any other chat is not.
 */
async function harnessOwnerTurn(ctx: HarnessCallContext): Promise<boolean> {
  if (ctx.chatId === "ui") return true;
  try {
    const host = await import("../one/supervisor");
    if (!host.isPersonalSupervisorConversation(ctx.chatId)) return false;
    const service = host.supervisorRunsInDaemon() ? host.oneSupervisor() : (await import("../one/supervisor-native-runtime")).oneSupervisorEndpoint();
    return Boolean(await service.ownerTurn(ctx.runId));
  } catch {
    return false;
  }
}

/**





 */
function withRequiredIdAliases(required: readonly string[], args: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  const ids = required.filter((key) => /^[a-z][A-Za-z]*Id$/.test(key));
  let out = args;
  for (const key of ids) {
    if (out[key] !== undefined && out[key] !== null && !(typeof out[key] === "string" && !(out[key] as string).trim())) continue;
    const stem = key.slice(0, -2);
    const alias = text(args[stem]) ? stem : ids.length === 1 && text(args.id) ? "id" : null;
    if (alias) out = { ...out, [key]: args[alias] };
  }
  return out;
}

/**
 * `. Did you mean x?` (or nothing) for a refused operation id; hint text only, the refused id is never run as the near one.
 * An id that is exactly an app operation (automations.listRuns) is a call to app.call, not a port: say so.
 */
async function nearOperations(id: string): Promise<string> {
  const near = didYouMean(id, PORT_BY_ID.keys());
  let app = "";
  try {
    const { APP_CONTROL_CATALOG } = await import("../app-control/catalog.generated");
    if (APP_CONTROL_CATALOG.some((entry) => entry.path === id)) app = ` ${id} is an app operation: run harness_call app.call with args {"operation":"${id}","args":{…}}.`;
  } catch { /* the catalog is a plain generated module; without it only the id hint is given */ }
  return `${near ? `.${near}` : ""}${app}`;
}

export async function callHarnessPort(operationId: string, rawArgs: Record<string, unknown>, ctx: HarnessCallContext): Promise<HarnessPortResult> {
  const port = PORT_BY_ID.get(operationId);
  const base = { schemaVersion: "agentlas.harness-result.v1" as const, operationId };
  // A misspelled id names the closest operation ids; the refused id is never run as one of them.
  if (!port) return { ...base, status: "refused", reason: "operation_unknown", next: `harness_search with kind "operation" lists them${await nearOperations(operationId)}`, receiptId: `hr_${randomUUID()}` };
  const args = withRequiredIdAliases(port.required, rawArgs);
  const missing = port.required.filter((key) => args[key] === undefined || args[key] === null || (typeof args[key] === "string" && !(args[key] as string).trim()));
  // An argument sent under a wrong name is the usual cause: name the missing field it is closest to.
  if (missing.length) return { ...base, status: "refused", reason: "arguments_missing", next: missingArgumentsMessage(missing, Object.keys(rawArgs), [...port.required, ...Object.keys((port.inputSchema?.properties ?? {}) as object)]), receiptId: `hr_${randomUUID()}` };
  if (!port.handler) return { ...base, status: "unavailable", reason: port.unavailable!.reason, next: port.unavailable!.next, receiptId: `hr_${randomUUID()}` };
  let outcome: PortOutcome;
  try {
    outcome = await port.handler(args, ctx);
  } catch (error) {
    outcome = refused("operation_failed", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
  }
  const receiptId = port.kind === "query" ? `hr_${randomUUID()}` : await appendReceipt({ operationId, status: outcome.status, chatId: ctx.chatId, runId: ctx.runId });


  if (outcome.status === "ok" && outcome.produced?.length && !ctx.dryRun) recordRunProducedFiles(ctx.runId, operationId, outcome.produced);
  return outcome.status === "ok"
    ? { ...base, status: "ok", ...(outcome.financeReceipt ? { financeReceipt: outcome.financeReceipt } : {}), data: outcome.data, receiptId }
    : { ...base, status: outcome.status, reason: outcome.reason, ...(outcome.next ? { next: outcome.next } : {}), ...(outcome.data !== undefined ? { data: outcome.data } : {}), receiptId };
}

export type HarnessItemKind = "plugin" | "skill" | "connector" | "tool" | "operation" | "feature";

/** Unified inert discovery across plugins, skills, connectors, catalog tools and the port operations themselves. */
/** App catalog paths (automations.listRuns, …) that answer a query; empty when none or the catalog is unreachable. */
async function appOperationPaths(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  try {
    // A Korean query also asks with the English catalog words for its nouns (search-rank.ts englishAppTerms).
    const english = (await import("./search-rank")).englishAppTerms(query);
    const found = await (await import("../app-control/service")).appControlOperations({ query: english ? `${query} ${english}`.slice(0, 200) : query, limit: 8 }) as { operations?: Array<{ operation?: unknown }> };
    return (found.operations ?? []).flatMap((row) => typeof row.operation === "string" ? [row.operation] : []);
  } catch { return []; }
}

export async function searchHarness(query: string, kind?: HarnessItemKind): Promise<Array<{ id: string; kind: HarnessItemKind; name: string; description: string }>> {
  const out: Array<{ id: string; kind: HarnessItemKind; name: string; description: string; rankTerms?: string[] }> = [];
  const want = (k: HarnessItemKind) => !kind || kind === k;
  if (want("plugin")) for (const row of await pluginRows()) if (matches(query, row.slug, row.name, row.description)) out.push({ id: row.id, kind: "plugin", name: row.mention, description: row.description });
  if (want("skill")) for (const row of await skillRows()) if (matches(query, row.id, row.name, row.description)) out.push({ id: row.id, kind: "skill", name: row.name, description: row.description });
  if (want("connector")) for (const row of await connectorRows()) if (matches(query, row.serverId, row.name)) out.push({ id: row.id, kind: "connector", name: row.name, description: `${row.transport}${row.enabled ? "" : ", off"}` });
  if (want("tool")) for (const row of await toolRows()) if (matches(query, row.providerRef, row.name, row.description)) out.push({ id: row.id, kind: "tool", name: row.name, description: `${row.description}${row.installed ? "" : " (not installed)"}` });
  if (want("feature")) {
    const { FEATURE_MODULES } = await import("./feature-registry");
    for (const feature of FEATURE_MODULES) if (matches(query, feature.featureId, ...feature.surfaces)) out.push({ id: `feature:${feature.featureId}`, kind: "feature", name: feature.featureId, description: `surfaces: ${feature.surfaces.join(", ") || "-"}` });
  }
  if (want("operation")) for (const port of PORTS) if (matches(query, port.operationId, port.purpose)) out.push({ id: port.operationId, kind: "operation", name: port.operationId, description: `${port.purpose}${port.handler ? "" : " (unavailable)"}` });
  // The app's own operations answer through app.operations / app.call, whose purpose names no domain. The catalog paths
  // that answer the query rank those two entries, and they lead the candidates so a tie goes to the app. The two entries are shown, with the matching paths named in their description, whenever the catalog
  // answers the query: also under a kind filter, because a worker that narrows to plugin/skill/connector/tool/feature
  // otherwise never sees the app's own operations, where Hub search (marketplace.search) lives, and
  // reports "no such tool". Nothing else is added to what the query found.
  const appPaths = await appOperationPaths(query);
  const { hasHangul } = await import("./search-rank");
  if (appPaths.length) for (const id of ["app.call", "app.operations"]) {
    const port = PORT_BY_ID.get(id);
    if (!port) continue;
    const at = out.findIndex((item) => item.id === id);
    if (at >= 0) out.splice(at, 1);
    // A Hangul query shares no word with the English port text and would drop the entry: its own words rank it (other queries unchanged;
    // text that only has accents or other non-ASCII letters is not Korean).
    // The entry names the app operations that answered this query: their purpose lines name no domain, so naming the
    // matching operation (marketplace.search for a Hub search) is what ties the generic entry to the request.
    out.unshift({ id: port.operationId, kind: "operation", name: port.operationId, description: `${port.purpose}${port.handler ? "" : " (unavailable)"} Operations matching this search: ${appPaths.slice(0, 8).join(", ")}.`, rankTerms: hasHangul(query) ? [...appPaths, query.toLowerCase()] : appPaths });
  }
  // Best match first across every kind (search-rank.ts); the fixed kind order cut the answering operation off (r07).
  const { rankHarnessItems } = await import("./search-rank");
  return rankHarnessItems(query, out, 60);
}

/** Exact detail for one id from harness_search; an operation id returns its required fields and status. */
export async function describeHarness(id: string, ctx: HarnessCallContext): Promise<HarnessPortResult> {
  const ref = str(id);
  if (PORT_BY_ID.has(ref)) {
    const port = PORT_BY_ID.get(ref)!;
    const inputSchema = port.operationId === "ui.present" ? (await import("../../shared/inline-ui-presentation")).UI_PRESENT_INPUT_SCHEMA
      : port.operationId === "result.read" ? (await import("../../shared/retained-result-schema")).RETAINED_RESULT_READ_SCHEMA : port.inputSchema;
    return { schemaVersion: "agentlas.harness-result.v1", operationId: "describe", status: "ok", data: { operationId: port.operationId, kind: port.kind, purpose: port.purpose, required: port.required, ...(inputSchema ? { inputSchema } : {}), status: port.handler ? "implemented" : "unavailable", ...(port.unavailable ? port.unavailable : {}) }, receiptId: `hr_${randomUUID()}` };
  }
  if (ref.startsWith("feature:")) {
    const { featureModule } = await import("./feature-registry");
    const feature = featureModule(ref.slice("feature:".length));
    return feature
      ? { schemaVersion: "agentlas.harness-result.v1", operationId: "describe", status: "ok", data: feature, receiptId: `hr_${randomUUID()}` }
      : { schemaVersion: "agentlas.harness-result.v1", operationId: "describe", status: "refused", reason: "feature_unknown", receiptId: `hr_${randomUUID()}` };
  }
  if (ref.startsWith("plugin:") && !ref.includes("/")) return callHarnessPort("plugin.describe", { packageId: ref }, ctx);
  if (ref.startsWith("plugin:") || ref.startsWith("catalog:")) return callHarnessPort("skill.read", { skillId: ref }, ctx);
  if (ref.startsWith("connector:")) return callHarnessPort("connector.describe", { connectorId: ref }, ctx);
  if (ref.startsWith("tool:")) return callHarnessPort("tool.describe", { toolId: ref }, ctx);
  if (ref.startsWith("agentlas.") || ref.startsWith("check.")) return callHarnessPort("tool.canonical.describe", { canonicalId: ref }, ctx);
  return { schemaVersion: "agentlas.harness-result.v1", operationId: "describe", status: "refused", reason: "id_unknown", next: `use an id returned by harness_search${await nearOperations(ref)}`, receiptId: `hr_${randomUUID()}` };
}
