import fs from "node:fs";
import { resolveMcpNeeds, type McpNeedCandidate, type ResolvedMcpNeeds } from "./need-resolver";
import os from "node:os";
import path from "node:path";
import { MCP_TOOL_CATALOG } from "./catalog";
import { installFromCatalog, listInstalledServers } from "./registry";
import { testServerConnection } from "./client";
import { readEnvVar } from "../secrets/vault";
import { getSource as getMarketSource } from "../marketplace";
import { COMPUTER_USE_JUDGMENT_GUIDANCE, COMPUTER_USE_JUDGMENT_KIND, COMPUTER_USE_JUDGMENT_QUESTION, resolveAutomationToolMode } from "../../shared/automation-tool-policy";
import { judgedComputerUse } from "../system-agents/judged-tool-mode";
import type {
  AutomationHubMode,
  AutomationToolMode,
  InstalledMcpServer,
  MarketplaceListing,
  McpToolCatalogEntry,
} from "../../shared/types";

export interface AutoSelectedMcpTool {
  id: string;
  name: string;
  reason: string;
  installed: boolean;
  missingEnv: string[];
  required: boolean;
  state:
    | "ready"
    | "missing-key"
    | "install-failed"
    | "probe-failed"
    | "disabled"
    | "server-unavailable"
    | "host-failure";
}

export interface HubPluginCandidate {
  slug: string;
  name: string;
  reason: string;
  installCli?: string;
  manifestUrl?: string;
  category?: string;
  score: number;
}

export interface AutoSelectedMcpContext {
  tools: AutoSelectedMcpTool[];
  localInventory: string[];
  localPluginCount: number;
  hubPluginCount: number;
  hubPlugins: HubPluginCandidate[];
  hubPluginError?: string;
  /** True when the resident judge actually decided this run's optional tool set. */
  needsDecided: boolean;
  /** Value-free note: nothing was decided, or the candidate inventory was capped. */
  needsNote?: string;
}

export interface AutoSelectMcpDependencies {
  listInstalledServers: () => InstalledMcpServer[];
  installFromCatalog: (catalogId: string) => InstalledMcpServer;
  readEnvVar: (key: string) => Promise<string | null>;
  testServerConnection: (server: InstalledMcpServer) => Promise<{
    connected: boolean;
    missingEnv: string[];
  }>;
  /** The only thing allowed to pick an optional tool. Injectable so tests can pin a verdict. */
  resolveNeeds: (input: { task: string; candidates: McpNeedCandidate[] }) => Promise<ResolvedMcpNeeds>;
}

const DEFAULT_AUTO_SELECT_DEPS: AutoSelectMcpDependencies = {
  listInstalledServers,
  installFromCatalog,
  readEnvVar,
  // The browser host may need to open Chrome and attach over CDP on its first
  // run. Three seconds was shorter than a warm local probe and made clean
  // installs look unavailable before the bundled host could answer tools/list.
  testServerConnection: (server) => testServerConnection(server, {
    timeoutMs: server.catalogId === "agentlas-browser" || server.catalogId === "playwright"
      ? 20_000
      : 3_000,
  }),
  resolveNeeds: resolveMcpNeeds,
};

// Tool selection is decided by resolveMcpNeeds() (electron/mcp-tools/need-resolver.ts),
// which asks the connected model what the task actually needs. The keyword tables that used
// to live here are GONE on purpose: a word in a prompt must never attach a tool or raise a
// credential prompt — that is what handed users a Brave Search key request (and a stalled
// run) for a Reddit posting job whose text merely said "조사".
//
// What may still pin a tool without the model: an EXPLICIT user choice (toolMode) and the
// credential-free Hub routing resolver. Those are settings, not word matches.
const HUB_PLUGIN_LOOKUP_TIMEOUT_MS = 8_000;
const HUB_PLUGIN_CANDIDATE_LIMIT = 8;
/** Hub inventory offered to the resident judge in one call. */
const HUB_PLUGIN_INVENTORY_LIMIT = 60;

const LOCAL_PLUGIN_SCAN_DIRS = [
  path.join(os.homedir(), ".codex", "plugins", "cache"),
  path.join(os.homedir(), ".claude", "plugins", "cache"),
  path.join(os.homedir(), ".claude", "plugins", "marketplaces"),
  path.join(os.homedir(), ".agentlas", "plugins"),
];

function normalize(text: string): string {
  return text.toLowerCase();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Hub plugin lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function missingRequiredEnv(
  entry: McpToolCatalogEntry,
  readSecret: (key: string) => Promise<string | null>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const requirement of entry.envRequirements) {
    if (!requirement.required) continue;
    const value = await readSecret(requirement.key);
    if (!value) missing.push(requirement.key);
  }
  return missing;
}

function readDirectoryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function listLocalPluginInventory(installed: Set<string>): string[] {
  const inventory = new Set<string>();
  for (const entry of MCP_TOOL_CATALOG) inventory.add(entry.id);
  for (const id of installed) inventory.add(id);
  for (const dir of LOCAL_PLUGIN_SCAN_DIRS) {
    for (const name of readDirectoryNames(dir)) inventory.add(name);
  }
  return Array.from(inventory).sort((a, b) => a.localeCompare(b));
}

function isHubPluginListing(listing: MarketplaceListing): boolean {
  return listing.entityKind === "plugin" || listing.source === "hub-plugin" || listing.kind === "hub-plugin";
}

/** One line of inventory text for the resident judge — what this plugin does, in words. */
function hubListingDescription(listing: MarketplaceListing): string {
  return (
    [listing.taglineEn, listing.tagline, listing.category, listing.developer]
      .filter(Boolean)
      .join(" · ") || "Agentlas Hub plugin"
  );
}

/** Fetch the Hub plugin inventory. NOTHING is scored or filtered by words here — the
 *  listings are handed to the resident judge as candidates and it names the ones the
 *  task actually needs. */
async function fetchHubPluginInventory(hubAllowed: boolean): Promise<{
  listings: MarketplaceListing[];
  hubPluginCount: number;
  hubPluginError?: string;
}> {
  if (!hubAllowed) return { listings: [], hubPluginCount: 0 };
  try {
    const listings = await withTimeout(getMarketSource().searchAgents(""), HUB_PLUGIN_LOOKUP_TIMEOUT_MS);
    const plugins = listings.filter(isHubPluginListing);
    return { listings: plugins, hubPluginCount: plugins.length };
  } catch (err) {
    return {
      listings: [],
      hubPluginCount: 0,
      hubPluginError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function autoSelectMcpTools(input: {
  userPrompt: string;
  systemPrompt: string;
  agentName: string;
  workingFolder?: string | null;
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
}, injectedDeps: Partial<AutoSelectMcpDependencies> = {}): Promise<AutoSelectedMcpContext> {
  const deps: AutoSelectMcpDependencies = { ...DEFAULT_AUTO_SELECT_DEPS, ...injectedDeps };
  // The task as written, not lowercased and not tokenized — the resident judge reads it.
  // Agent name and user prompt come first because the resolver truncates the tail.
  const taskText = [input.agentName, input.userPrompt, input.workingFolder ?? "", input.systemPrompt]
    .filter(Boolean)
    .join("\n");
  // Does this automation actually have to drive a human-facing web UI? The resident judge is
  // the only answer — there is no keyword pre-filter, so a task written in ANY language gets
  // judged, not silently skipped. The verdict is cached, so the synchronous store writes that
  // resolve the same automation later read it too (see peekJudgment / judgedComputerUse).
  // Skipped only when the user already chose the mode by hand — nothing left to decide.
  const toolModeText = [input.agentName ?? "", input.userPrompt ?? "", input.workingFolder ?? ""].join("\n");
  if (input.toolMode !== "browser" && input.toolMode !== "computer-use" && toolModeText.trim()) {
    try {
      const { prejudge } = await import("../system-agents/judgment");
      await prejudge<"yes" | "no">({
        kind: COMPUTER_USE_JUDGMENT_KIND,
        question: COMPUTER_USE_JUDGMENT_QUESTION,
        labels: ["yes", "no"] as const,
        input: toolModeText,
        guidance: COMPUTER_USE_JUDGMENT_GUIDANCE,
        // Conservative default is "no": an unreachable model must not force the brittle
        // screen-driving path. peekJudgment only reads llm-sourced verdicts anyway.
        fallback: "no",
      });
    } catch {
      // Judgment is best-effort; an unjudged run stays on the neutral "auto" path.
    }
  }
  const effectiveToolMode = resolveAutomationToolMode({
    toolMode: input.toolMode,
    name: input.agentName,
    promptTemplate: input.userPrompt,
    targetLabel: input.workingFolder,
    judged: judgedComputerUse,
  });
  let initialInstalledServers: InstalledMcpServer[] = [];
  try {
    initialInstalledServers = deps.listInstalledServers();
  } catch {
    initialInstalledServers = [];
  }
  const installed = new Set(
    initialInstalledServers
      .map((server) => server.catalogId)
      .filter((id): id is string => Boolean(id)),
  );
  const hubAllowed = input.hubMode !== "local-only";
  const localInventory = listLocalPluginInventory(installed);
  // Generic social/web actions currently resolve to Computer Use first, but a
  // missing native driver must not strand a task that the authenticated
  // Agentlas Browser can safely complete. Explicit Computer Use selections
  // remain strict and never receive this browser fallback.
  const allowAutomaticBrowserFallback = input.toolMode == null && effectiveToolMode === "computer-use";

  const hubInventory = await fetchHubPluginInventory(hubAllowed);

  // ── Pins: settings and explicit user choices. These are the ONLY tools that may be
  // attached without the resident judge, and none of them can raise a key prompt on its
  // own (the browser/CUA hosts are local, the Hub resolver has no env requirement).
  // Browser and Computer Use are EXACT host bindings. The competing host is never added —
  // not as a pin, not as a candidate, not as a quiet fallback. Missing host authority must
  // fail closed rather than silently drive a different surface.
  const blockedByHostBinding = (id: string): boolean => {
    if (effectiveToolMode === "browser") return id === "playwright" || id === "cua-driver";
    if (effectiveToolMode === "computer-use") return id === "playwright";
    return false;
  };

  const pinnedReasons = new Map<string, string>();
  if (hubAllowed) {
    pinnedReasons.set("hephaestus-network", "always available routing/plugin resolver");
  }
  if (effectiveToolMode === "browser") {
    pinnedReasons.set("agentlas-browser", "Browser plugin (real-login CDP) for this automation");
  }
  if (effectiveToolMode === "computer-use") {
    pinnedReasons.set(
      "cua-driver",
      input.toolMode === "computer-use"
        ? "user-selected Computer Use for this automation"
        : "Agentlas policy selected Computer Use for human web/social automation",
    );
  }
  if (allowAutomaticBrowserFallback) {
    pinnedReasons.set("agentlas-browser", "authenticated browser fallback for policy-selected Computer Use");
  }
  // Everything pinned so far is a host binding or the routing resolver — these outrank both
  // the judge's picks and the installed-convenience pins added next.
  const hostBindingPins = new Set(pinnedReasons.keys());
  // Anything the user already installed and enabled stays available every run. Dropping the
  // keyword scorer must never REMOVE a capability the user set up — it only stops unconfigured
  // tools from being force-attached. A pin here can still be dropped below if it turns out to
  // need a credential, so this can never produce a key prompt on its own.
  for (const server of initialInstalledServers) {
    if (!server.catalogId || !server.enabled) continue;
    if (pinnedReasons.has(server.catalogId) || blockedByHostBinding(server.catalogId)) continue;
    pinnedReasons.set(server.catalogId, "already installed and enabled by the user");
  }

  const localCandidates: McpNeedCandidate[] = MCP_TOOL_CATALOG.filter((entry) => {
    if (pinnedReasons.has(entry.id) || blockedByHostBinding(entry.id)) return false;
    if (entry.id === "lazyweb") return false;
    if (entry.id === "hephaestus-network") return hubAllowed;
    return true;
  }).map((entry) => ({
    id: entry.id,
    name: entry.nameEn || entry.name,
    description: entry.descriptionEn || entry.description,
    origin: "local" as const,
    needsCredential: entry.envRequirements.some((requirement) => requirement.required),
  }));

  const hubOffered = hubInventory.listings.slice(0, HUB_PLUGIN_INVENTORY_LIMIT);
  const hubCandidates: McpNeedCandidate[] = hubOffered.map((listing) => ({
    id: listing.slug,
    name: listing.nameEn || listing.name || listing.slug,
    description: hubListingDescription(listing),
    origin: "hub" as const,
  }));

  // User-registered custom servers are inventory too, so an unconfigured one can be named by
  // the judge instead of prompting for its key on every unrelated run.
  const customCandidates: McpNeedCandidate[] = initialInstalledServers
    .filter((server) => !server.catalogId)
    .map((server) => ({
      id: server.id,
      name: server.nameEn || server.name,
      description: "user-registered custom MCP server",
      origin: "local" as const,
      needsCredential: server.envKeys.length > 0,
    }));

  // ONE judgment call decides the whole optional tool set — Hub entries offered first.
  const needs = await deps.resolveNeeds({
    task: taskText,
    candidates: [...hubCandidates, ...localCandidates, ...customCandidates],
  });
  const neededIds = new Set(needs.needed);
  const cappedHub = Math.max(0, hubInventory.listings.length - hubOffered.length);
  const needsNote = [
    needs.decided
      ? ""
      : "No connected model was available to decide which optional tools this task needs, so only explicitly configured tools were attached.",
    cappedHub > 0 ? `${cappedHub} further Hub plugins were not offered to the selector this run.` : "",
    needs.omitted.length > 0 ? `${needs.omitted.length} candidates exceeded the selector inventory cap.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Rank before the probe cap so a convenience pin can never crowd out a host binding or a
  // capability the judge said the task actually needs.
  const pickRank = (id: string): number => {
    if (hostBindingPins.has(id)) return 0;
    if (neededIds.has(id)) return 1;
    return 2;
  };
  const picked = MCP_TOOL_CATALOG.filter(
    (entry) => (pinnedReasons.has(entry.id) || neededIds.has(entry.id)) && !blockedByHostBinding(entry.id),
  )
    .sort((a, b) => pickRank(a.id) - pickRank(b.id))
    .slice(0, 10);

  const resolved = await Promise.allSettled(picked.map(async (entry): Promise<AutoSelectedMcpTool> => {
    // `required` is a host binding, never a selection outcome.
    const required =
      effectiveToolMode === "browser" && entry.id === "agentlas-browser" ||
      effectiveToolMode === "computer-use" && entry.id === "cua-driver";
    const base = {
      id: entry.id,
      name: entry.nameEn || entry.name,
      reason:
        pinnedReasons.get(entry.id) ??
        `resident judgment: ${needs.reason || "the task needs this capability"}`,
      required,
    };
    const missingEnv = await missingRequiredEnv(entry, deps.readEnvVar);
    if (missingEnv.length > 0) return { ...base, installed: false, missingEnv, state: "missing-key" };

    let server = deps.listInstalledServers().find((candidate) =>
      candidate.catalogId === entry.id || candidate.id === entry.id);
    if (!server) {
      try {
        server = deps.installFromCatalog(entry.id);
        installed.add(entry.id);
      } catch {
        return { ...base, installed: false, missingEnv: [], state: "install-failed" };
      }
    }
    if (!server) return { ...base, installed: false, missingEnv: [], state: "server-unavailable" };
    if (!server.enabled) return { ...base, installed: false, missingEnv: [], state: "disabled" };
    try {
      const status = await deps.testServerConnection(server);
      if (status.missingEnv.length > 0) {
        return { ...base, installed: false, missingEnv: [...new Set(status.missingEnv)].sort(), state: "missing-key" };
      }
      if (!status.connected) return { ...base, installed: false, missingEnv: [], state: "probe-failed" };
    } catch {
      return { ...base, installed: false, missingEnv: [], state: "probe-failed" };
    }
    return { ...base, installed: true, missingEnv: [], state: "ready" };
  }));
  const result: AutoSelectedMcpTool[] = resolved.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    const entry = picked[index];
    return {
      id: entry.id,
      name: entry.nameEn || entry.name,
      reason: pinnedReasons.get(entry.id) ?? "resident judgment: the task needs this capability",
      installed: false,
      missingEnv: [],
      required: false,
      state: "host-failure",
    };
  });

  // ── THE INVARIANT ────────────────────────────────────────────────────────────
  // A credential prompt may exist ONLY for a tool the resident judge named, or one the user
  // bound to this automation by hand. Nothing else may ever reach "missing-key": that state
  // is what opens the pre-launch key sheet and stalls the run. A convenience pin that turns
  // out to need a key is dropped silently — the run continues without it.
  const mayRequestCredentials = (toolId: string): boolean =>
    neededIds.has(toolId) ||
    (input.toolMode === "browser" && toolId === "agentlas-browser") ||
    (input.toolMode === "computer-use" && toolId === "cua-driver");
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const tool = result[index];
    if (tool.state === "missing-key" && !mayRequestCredentials(tool.id)) result.splice(index, 1);
  }

  // 사용자가 손수 등록한 커스텀 MCP(카탈로그에 없는 catalogId=null)는 위 MCP_TOOL_CATALOG
  // 스캔에 잡히지 않아 채팅 런타임(.mcp.json)에서 늘 누락됐다 — 명시적으로 추가한 서버이므로
  // 항상 후보에 포함한다. remote(헤더 없는 URL)는 envKeys가 비어 바로 사용 가능하고,
  // 헤더/키가 필요한 서버는 vault에 값이 있을 때만 installed로 잡힌다.
  let latestInstalledServers: InstalledMcpServer[] = [];
  try {
    latestInstalledServers = deps.listInstalledServers();
  } catch {
    latestInstalledServers = [];
  }
  for (const server of latestInstalledServers) {
    if (server.catalogId) continue;
    if (result.some((tool) => tool.id === server.id)) continue;
    const missingEnv: string[] = [];
    for (const key of server.envKeys) {
      const value = await deps.readEnvVar(key);
      if (!value) missingEnv.push(key);
    }
    let state: AutoSelectedMcpTool["state"] = missingEnv.length > 0 ? "missing-key" : "ready";
    if (state === "ready" && !server.enabled) state = "disabled";
    if (state === "ready") {
      try {
        const status = await deps.testServerConnection(server);
        if (status.missingEnv.length > 0) {
          missingEnv.push(...status.missingEnv.filter((key) => !missingEnv.includes(key)));
          state = "missing-key";
        } else if (!status.connected) {
          state = "probe-failed";
        }
      } catch {
        state = "probe-failed";
      }
    }
    // Same invariant as the catalog pins: a custom server that is ready stays available, but
    // an unconfigured one only surfaces (and only asks for its key) when the task needs it.
    if (state === "missing-key" && !neededIds.has(server.id)) continue;
    result.push({
      id: server.id,
      name: server.nameEn || server.name,
      reason: "user-added custom MCP (always available)",
      installed: state === "ready",
      missingEnv,
      required: false,
      state,
    });
  }

  // Hub candidates are the plugins the resident judge named — never a word-scored guess.
  // Undecided runs surface none and let the model resolve plugins live through
  // agentlas_resolve_plugins / hephaestus-network instead.
  const hubPlugins: HubPluginCandidate[] = hubOffered
    .filter((listing) => neededIds.has(listing.slug))
    .slice(0, HUB_PLUGIN_CANDIDATE_LIMIT)
    .map((listing) => ({
      slug: listing.slug,
      name: listing.nameEn || listing.name || listing.slug,
      reason: `resident judgment: ${needs.reason || "the task needs this plugin"}`,
      installCli: listing.installCli,
      manifestUrl: listing.manifestUrl || listing.detailUrl,
      category: listing.category,
      score: 100,
    }));

  return {
    tools: result,
    localInventory,
    localPluginCount: localInventory.length,
    hubPluginCount: hubInventory.hubPluginCount,
    hubPlugins,
    needsDecided: needs.decided,
    ...(needsNote ? { needsNote } : {}),
    ...(hubInventory.hubPluginError ? { hubPluginError: hubInventory.hubPluginError } : {}),
  };
}

export function buildMcpAutoSelectionPrompt(
  selected: AutoSelectedMcpContext,
  opts?: { toolMode?: AutomationToolMode; hubMode?: AutomationHubMode },
): string {
  if (selected.tools.length === 0 && selected.hubPluginCount === 0) return "";
  const installed = selected.tools.filter((tool) => tool.installed);
  const blocked = selected.tools.filter((tool) => !tool.installed && tool.missingEnv.length > 0);
  const unavailable = selected.tools.filter((tool) => tool.state !== "ready");
  const browserReady = installed.some((tool) => tool.id === "agentlas-browser");
  const computerUseSelected = selected.tools.some((tool) => tool.id === "cua-driver");
  const computerUseReady = installed.some((tool) => tool.id === "cua-driver");
  const modeLine =
    opts?.toolMode === "browser"
      ? "This automation is bound to Agentlas Browser (real-login CDP). Use only that browser host for web work; never create a fresh Playwright profile."
      : opts?.toolMode === "computer-use"
        ? "This automation explicitly selected Computer Use mode; use desktop/screen tools for UI work."
        : "";
  const hubLine =
    opts?.hubMode === "hub-first"
      ? "This automation is Hub-first: prefer Agentlas Hub specialists/plugins through hephaestus-network before local fallbacks."
      : opts?.hubMode === "hub-allowed"
        ? "This automation may use Agentlas Hub specialists/plugins through hephaestus-network when local tools are insufficient."
        : opts?.hubMode === "local-only"
          ? "This automation is local-only: do not use Agentlas Hub routing or borrowed Hub agents."
          : "";
  const hubCandidates =
    selected.hubPlugins.length > 0
      ? `Relevant Hub plugin candidates: ${selected.hubPlugins
          .map((plugin) =>
            `${plugin.slug} (${plugin.name}; ${plugin.reason}${plugin.installCli ? `; install: ${plugin.installCli}` : ""})`,
          )
          .join("; ")}.`
      : selected.hubPluginCount > 0
        ? "Hub plugin catalog is available; resolve plugin needs dynamically before declaring a tool unavailable."
        : selected.hubPluginError
          ? `Hub plugin catalog lookup failed for this run: ${selected.hubPluginError}.`
          : "";
  const inventoryPreview = selected.localInventory.slice(0, 24).join(", ");
  const inventoryMore = selected.localInventory.length > 24 ? `, +${selected.localInventory.length - 24} more` : "";
  return [
    "Agentlas MCP plugin auto-selection is active.",
    `Agentlas plugin universe is active: ${selected.localPluginCount} local plugin/tool entries + ${selected.hubPluginCount} Hub plugins.`,
    modeLine,
    hubLine,
    computerUseReady
      ? "Computer Use is available for desktop/screen interaction. Prefer Agentlas Browser for authenticated web pages when both tools can complete the task."
      : computerUseSelected && browserReady
        ? "The native Computer Use driver is unavailable in this run. Do not claim OS-level control; use Agentlas Browser only for work that stays inside the authenticated browser."
        : computerUseSelected
          ? "The native Computer Use driver is unavailable in this run. Do not claim screen interaction or OS-level control."
          : "",
    selected.localInventory.length > 0
      ? `Local inventory for Hub plugin resolution: ${inventoryPreview}${inventoryMore}.`
      : "",
    selected.needsNote ? `Tool selection note: ${selected.needsNote}` : "",
    installed.length > 0
      ? `Installed/enabled tools available this run: ${installed.map((tool) => `${tool.id} (${tool.name})`).join(", ")}.`
      : "No additional installable local tools were available for this run.",
    hubCandidates,
    "Use the available MCP tools directly when they are relevant. Do not ask the user to install a tool that is already listed as available.",
    "Before saying a tool/plugin is unavailable, resolve against both local inventory and Agentlas Hub. If an agentlas_resolve_plugins MCP tool is exposed, call it with the needed capabilities and localInventory. Otherwise use the Hephaestus Network MCP tools to route Hub specialists/plugins.",
    "Only ask the user when the selected Hub plugin requires login, OAuth, credentials, paid/credit approval, or a macOS/browser permission. Include the exact plugin slug or install command in that question.",
    blocked.length > 0
      ? `Tools matched but need credentials before use: ${blocked
          .map((tool) => `${tool.id} missing ${tool.missingEnv.join(", ")}`)
          .join("; ")}. Ask for secure vault setup only if the task truly needs them.`
      : "",
    unavailable.length > 0
      ? `Unavailable MCP state (value-free): ${unavailable
          .map((tool) => `${tool.id}=${tool.state}${tool.required ? "(required)" : ""}`)
          .join("; ")}. Healthy MCPs remain available; degrade only the function that depends on an unavailable capability.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
