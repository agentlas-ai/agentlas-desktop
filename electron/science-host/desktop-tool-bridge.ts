import { createHash, randomUUID } from "node:crypto";
import { scienceStore } from "agentlas-science";
import { buildMcpConfigFile, type BrowserApprovalScope, type McpConfigResult } from "../mcp-tools/mcp-config";
import { listInstalledServers } from "../mcp-tools/registry";
import { getCatalogEntry } from "../mcp-tools/catalog";
import { mcpServerConfigurationDigest } from "../mcp-tools/prepared-transport";
import { loadMainToolInventory, runMainToolDispatch, type ResolvedTool } from "../runtime/local-tool-loop";
import { getEnvConfigurationRevision } from "../secrets/vault";
import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
import type { ToolPermission } from "../../shared/builtin-tools";
import type { InstalledMcpServer } from "../../shared/types";

export interface ScienceDesktopToolScope {
  projectId: string;
  conversationId: string;
  turnId: string;
  invocationRunId: string;
}

export interface ScienceAliveDesktopToolScope {
  projectId: string;
  conversationId: string;
  agentId: string;
  wakeId: string;
  controlEpoch: number;
  attachmentId: string;
  attachmentGeneration: number;
  scopeSha256: string;
  conversationStopEpoch: number;
  approvalPolicySha256: string;
}

type DesktopToolScope = ScienceDesktopToolScope | ScienceAliveDesktopToolScope;

function isAliveScope(scope: DesktopToolScope): scope is ScienceAliveDesktopToolScope {
  return "wakeId" in scope;
}

function runId(scope: DesktopToolScope): string {
  return isAliveScope(scope) ? scope.wakeId : scope.invocationRunId;
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Inventory {
  id: string;
  kind: "mcp" | "builtin";
  serverId: string;
  serverDigest: string;
  envRevision: number;
  config?: McpConfigResult;
  tools: ToolDescriptor[];
  byName: Map<string, ResolvedTool>;
}

interface Binding {
  scope: DesktopToolScope;
  chatId: string;
  agentId: string;
  runtimeKind: string;
  permission: ToolPermission;
  cwd?: string;
  signal?: AbortSignal;
  approvalScope?: BrowserApprovalScope;
  closed: boolean;
  metadataInventoryId: string;
  metadataDigest: string;
  envRevision: number;
  inventories: Map<string, Inventory>;
  serverInventories: Map<string, string>;
  preparations: Map<string, Promise<Inventory>>;
  pages: Map<string, { inventoryId: string; offset: number }>;
  calls: Map<string, { signature: string; result: Promise<{ content: unknown; isError?: boolean }> }>;
}

const bindings = new Map<string, Binding>();
const PAGE_SIZE = 50;
const BUILTIN_SERVER_ID = "desktop-builtin";

function scopeKey(scope: DesktopToolScope): string {
  return isAliveScope(scope)
    ? `alive:${scope.projectId}:${scope.conversationId}:${scope.agentId}:${scope.wakeId}`
    : `turn:${scope.projectId}:${scope.conversationId}:${scope.turnId}:${scope.invocationRunId}`;
}

function current(scope: DesktopToolScope): Binding {
  const binding = bindings.get(scopeKey(scope));
  if (!binding || binding.closed || JSON.stringify(binding.scope) !== JSON.stringify(scope))
    throw new Error("science_desktop_tool_run_not_bound");
  binding.signal?.throwIfAborted();
  const store = scienceStore();
  if (isAliveScope(scope)) {
    const principal = store.aliveLifetime().activeToolPrincipal({ agentId: scope.agentId,
      wakeId: scope.wakeId, controlEpoch: scope.controlEpoch,
      attachmentId: scope.attachmentId, domain: "science" }, Date.now());
    if (principal.agentId !== store.scienceAliveAgentId(scope.projectId)
      || principal.scope.projectId !== scope.projectId || principal.scope.conversationId !== scope.conversationId
      || principal.attachmentGeneration !== scope.attachmentGeneration
      || digest(principal.scope) !== scope.scopeSha256) throw new Error("alive_desktop_tool_wake_stale");
    const policy = store.aliveResearchContinuationAuthority(scope.projectId, scope.conversationId);
    if (policy.stopped || !policy.fullAutonomyStanding
      || policy.conversationStopEpoch !== scope.conversationStopEpoch
      || policy.approvalPolicySha256 !== scope.approvalPolicySha256)
      throw new Error("alive_desktop_tool_policy_stale");
    return binding;
  }
  const turn = store.getTurnForProject(scope.projectId, scope.turnId);
  const runtime = store.getConversationRuntimeBinding(scope.projectId, scope.conversationId);
  if (!turn || turn.conversationId !== scope.conversationId || turn.invocationRunId !== scope.invocationRunId
    || turn.runtimeChatId !== binding.chatId || runtime?.runtimeChatId !== binding.chatId || turn.status !== "running")
    throw new Error("science_desktop_tool_turn_stale");
  store.assertScienceTurnExecutionAuthority(turn);
  return binding;
}

function installed() {
  // The Science host's own MCP is already in the same session; a registry copy
  // would recurse back into that host. Other installed servers remain choices.
  return listInstalledServers().filter(server => server.enabled && server.configurationValid !== false
    && server.catalogId !== "agentlas-science");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function metadataDigest(servers: InstalledMcpServer[]): string {
  return digest(servers.map(server => [server.id, mcpServerConfigurationDigest(server), server.name, server.nameEn]));
}

function assertInventoryCurrent(scope: DesktopToolScope, inventory: Inventory): Binding {
  const binding = current(scope);
  if (binding.inventories.get(inventory.id) !== inventory)
    throw new Error("science_desktop_tool_inventory_stale");
  if (inventory.kind === "builtin") return binding;
  const server = installed().find(candidate => candidate.id === inventory.serverId);
  if (!server || mcpServerConfigurationDigest(server) !== inventory.serverDigest
    || getEnvConfigurationRevision() !== inventory.envRevision)
    throw new Error("science_desktop_tool_inventory_stale");
  return binding;
}

function refreshMetadata(binding: Binding): InstalledMcpServer[] {
  const available = installed();
  const next = metadataDigest(available);
  const envRevision = getEnvConfigurationRevision();
  if (next !== binding.metadataDigest || envRevision !== binding.envRevision) {
    binding.metadataDigest = next;
    binding.envRevision = envRevision;
    binding.metadataInventoryId = randomUUID();
    binding.pages.clear();
    for (const inventory of binding.inventories.values()) inventory.config?.cleanup?.();
    binding.inventories.clear();
    binding.serverInventories.clear();
  }
  return available;
}

function page<T>(binding: Binding, inventoryId: string, items: T[], cursor?: string): { items: T[]; nextPage?: string } {
  let offset = 0;
  if (cursor) {
    const selected = binding.pages.get(cursor);
    if (!selected || selected.inventoryId !== inventoryId) throw new Error("science_desktop_tool_page_invalid");
    offset = selected.offset;
  }
  const result = items.slice(offset, offset + PAGE_SIZE);
  if (offset + PAGE_SIZE >= items.length) return { items: result };
  const nextPage = randomUUID();
  binding.pages.set(nextPage, { inventoryId, offset: offset + PAGE_SIZE });
  return { items: result, nextPage };
}

/** The Science session owns a fixed menu; Desktop binds only the current ordinary turn. */
function bindDesktopToolScope(scope: DesktopToolScope, options: {
  chatId: string; agentId: string; runtimeKind: string; permission: ToolPermission;
  cwd?: string; signal?: AbortSignal; approvalScope?: BrowserApprovalScope;
}): () => void {
  const key = scopeKey(scope);
  if (bindings.has(key)) throw new Error("science_desktop_tool_run_already_bound");
  const binding: Binding = {
    scope: isAliveScope(scope)
      ? { projectId: scope.projectId, conversationId: scope.conversationId,
        agentId: scope.agentId, wakeId: scope.wakeId, controlEpoch: scope.controlEpoch,
        attachmentId: scope.attachmentId, attachmentGeneration: scope.attachmentGeneration,
        scopeSha256: scope.scopeSha256, conversationStopEpoch: scope.conversationStopEpoch,
        approvalPolicySha256: scope.approvalPolicySha256 }
      : { projectId: scope.projectId, conversationId: scope.conversationId,
        turnId: scope.turnId, invocationRunId: scope.invocationRunId },
    ...options, closed: false, metadataInventoryId: randomUUID(),
    metadataDigest: metadataDigest(installed()), envRevision: getEnvConfigurationRevision(),
    inventories: new Map(), serverInventories: new Map(), preparations: new Map(), pages: new Map(), calls: new Map(),
  };
  bindings.set(key, binding);
  return () => {
    if (binding.closed) return;
    binding.closed = true;
    bindings.delete(key);
    for (const inventory of binding.inventories.values()) inventory.config?.cleanup?.();
    binding.inventories.clear();
    binding.preparations.clear();
    binding.pages.clear();
  };
}

export function bindScienceDesktopToolTurn(scope: ScienceDesktopToolScope, options: {
  chatId: string; agentId: string; runtimeKind: string; permission: ToolPermission;
  cwd?: string; signal?: AbortSignal; approvalScope?: BrowserApprovalScope;
}): () => void {
  return bindDesktopToolScope(scope, options);
}

export function bindScienceAliveDesktopToolWake(scope: ScienceAliveDesktopToolScope, options: {
  chatId: string; agentId: string; runtimeKind: string; permission: ToolPermission;
  cwd?: string; signal?: AbortSignal; approvalScope?: BrowserApprovalScope;
}): () => void {
  if (scope.agentId !== options.agentId || scope.wakeId === "")
    throw new Error("alive_desktop_tool_wake_binding_invalid");
  return bindDesktopToolScope(scope, options);
}

export const scienceDesktopTools = {
  async list(scope: DesktopToolScope, query?: { serverId?: string; page?: string }): Promise<{
    inventoryId: string;
    servers?: Array<{ id: string; name: string; description?: string; catalogId?: string }>;
    tools: ToolDescriptor[];
    nextPage?: string;
  }> {
    const binding = current(scope);
    if (!query?.serverId) {
      const available = refreshMetadata(binding);
      const servers = [
        ...(binding.cwd ? [{ id: BUILTIN_SERVER_ID, name: "Desktop built-in tools",
          description: "Workspace file and shell tools available under this turn's permission." }] : []),
        ...available.map(server => ({ id: server.id, name: (server.nameEn || server.name).slice(0, 200),
          ...(server.catalogId ? { catalogId: server.catalogId.slice(0, 160) } : {}),
          description: (server.catalogId && getCatalogEntry(server.catalogId)?.descriptionEn
            || "Custom installed MCP server; select it to inspect its available tools.").slice(0, 2_000) })),
      ];
      const result = page(binding, binding.metadataInventoryId, servers, query?.page);
      return { inventoryId: binding.metadataInventoryId, servers: result.items, tools: [], ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    }
    const available = refreshMetadata(binding);
    if (query.serverId === BUILTIN_SERVER_ID) {
      if (!binding.cwd) throw new Error("science_desktop_tool_server_unavailable");
      let builtin = binding.serverInventories.get(BUILTIN_SERVER_ID)
        ? binding.inventories.get(binding.serverInventories.get(BUILTIN_SERVER_ID)!) : undefined;
      if (!builtin) {
        const loaded = await loadMainToolInventory(undefined, binding.cwd, binding.permission, false, false, binding.signal);
        current(scope);
        const tools = loaded.tools.map(tool => ({ name: tool.function.name,
          description: (tool.function.description ?? "").slice(0, 2_000),
          inputSchema: tool.function.parameters as Record<string, unknown> }));
        if (tools.some(tool => loaded.byName.get(tool.name)?.kind !== "builtin"
          || JSON.stringify(tool.inputSchema).length > 32_768)) throw new Error("science_desktop_tool_schema_invalid");
        builtin = { id: randomUUID(), kind: "builtin", serverId: BUILTIN_SERVER_ID,
          serverDigest: "", envRevision: 0, tools, byName: loaded.byName };
        binding.inventories.set(builtin.id, builtin);
        binding.serverInventories.set(BUILTIN_SERVER_ID, builtin.id);
      }
      const result = page(binding, builtin.id, builtin.tools, query.page);
      return { inventoryId: builtin.id, tools: result.items, ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
    }
    const server = available.find(candidate => candidate.id === query.serverId);
    if (!server) throw new Error("science_desktop_tool_server_unavailable");
    let inventory = binding.serverInventories.get(server.id)
      ? binding.inventories.get(binding.serverInventories.get(server.id)!) : undefined;
    if (inventory) assertInventoryCurrent(scope, inventory);
    if (!inventory) {
      let preparation = binding.preparations.get(server.id);
      if (!preparation) {
        const metadataInventoryId = binding.metadataInventoryId;
        preparation = (async () => {
          const config = await buildMcpConfigFile({ serverIds: [server.id], skipDefaultSeed: true,
            configKey: `science-desktop-${randomUUID()}`,
            toolGate: { runtime: binding.runtimeKind, sessionKey: `science:${runId(scope)}`,
              permission: binding.permission, cwd: binding.cwd, chatId: binding.chatId,
              approvalScope: binding.approvalScope, unattended: true } });
          if (!config || config.includedServerIds.length !== 1 || config.includedServerIds[0] !== server.id) {
            config?.cleanup?.();
            throw new Error("science_desktop_tool_selected_server_not_prepared");
          }
          const envRevision = getEnvConfigurationRevision();
          try {
            current(scope);
            const loaded = await loadMainToolInventory(config.configPath, undefined, "read", false, false, binding.signal);
            current(scope);
            const tools = loaded.tools.map(tool => ({ name: tool.function.name,
              description: (tool.function.description ?? "").slice(0, 2_000),
              inputSchema: tool.function.parameters as Record<string, unknown> }));
            if (tools.some(tool => !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)
              || !loaded.byName.has(tool.name) || loaded.byName.get(tool.name)?.kind !== "mcp"
              || !tool.inputSchema || Array.isArray(tool.inputSchema) || typeof tool.inputSchema !== "object"
              || JSON.stringify(tool.inputSchema).length > 32_768))
              throw new Error("science_desktop_tool_schema_invalid");
            const currentServer = installed().find(candidate => candidate.id === server.id);
            if (!currentServer || mcpServerConfigurationDigest(currentServer) !== mcpServerConfigurationDigest(server)
              || getEnvConfigurationRevision() !== envRevision || binding.metadataInventoryId !== metadataInventoryId)
              throw new Error("science_desktop_tool_inventory_stale");
            const ready: Inventory = { id: randomUUID(), kind: "mcp", serverId: server.id,
              serverDigest: mcpServerConfigurationDigest(server), envRevision,
              config, tools, byName: loaded.byName };
            binding.inventories.set(ready.id, ready);
            binding.serverInventories.set(server.id, ready.id);
            return ready;
          } catch (error) { config.cleanup?.(); throw error; }
        })();
        binding.preparations.set(server.id, preparation);
      }
      try { inventory = await preparation; }
      finally { if (binding.preparations.get(server.id) === preparation) binding.preparations.delete(server.id); }
    }
    assertInventoryCurrent(scope, inventory);
    const result = page(binding, inventory.id, inventory.tools, query?.page);
    return { inventoryId: inventory.id, tools: result.items, ...(result.nextPage ? { nextPage: result.nextPage } : {}) };
  },

  async call(scope: DesktopToolScope, input: {
    inventoryId: string; name: string; arguments: Record<string, unknown>; toolCallId: string;
  }): Promise<{ content: unknown; isError?: boolean }> {
    const binding = current(scope);
    const inventory = binding.inventories.get(input.inventoryId);
    if (!inventory || !inventory.byName.has(input.name)
      || inventory.byName.get(input.name)?.kind !== inventory.kind
      || !inventory.tools.some(tool => tool.name === input.name))
      throw new Error("science_desktop_tool_inventory_stale");
    assertInventoryCurrent(scope, inventory);
    if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments))
      throw new Error("science_desktop_tool_arguments_invalid");
    if (!input.toolCallId || input.toolCallId.length > 256)
      throw new Error("science_desktop_tool_call_id_invalid");
    const argumentsJson = JSON.stringify(input.arguments);
    if (argumentsJson.length > 131_072) throw new Error("science_desktop_tool_arguments_too_large");
    const signature = JSON.stringify([input.inventoryId, input.name, argumentsJson]);
    const prior = binding.calls.get(input.toolCallId);
    if (prior) {
      if (prior.signature !== signature) throw new Error("science_desktop_tool_call_id_reused");
      return prior.result;
    }
    const signatureSha256 = digest(signature);
    // Persist the exact call identity before an external effect. The in-memory
    // promise serves same-process repeats; after a crash there is no raw result
    // to replay, so the durable marker blocks redispatch for reconciliation.
    getDb().transaction(() => {
      const previous = getDb().prepare(`SELECT json_extract(payload_json, '$.signatureSha256') AS signature
        FROM run_events WHERE run_id = ? AND kind = 'science_desktop_tool_dispatch_started'
          AND json_extract(payload_json, '$.toolCallId') = ? LIMIT 1`)
        .get(runId(scope), input.toolCallId) as { signature?: string } | undefined;
      if (previous) {
        if (previous.signature !== signatureSha256) throw new Error("science_desktop_tool_call_id_reused");
        throw new Error("science_desktop_tool_effect_uncertain_not_replayed");
      }
      assertInventoryCurrent(scope, inventory);
      recordRunEvent({ runId: runId(scope), chatId: binding.chatId,
        kind: "science_desktop_tool_dispatch_started",
        sourceEventId: `science-desktop-tool:${input.toolCallId}:started`,
        payload: { toolCallId: input.toolCallId, signatureSha256,
          inventoryId: inventory.id, toolName: input.name } });
    }).immediate();
    const result = (async () => {
      assertInventoryCurrent(scope, inventory);
      const dispatched = await runMainToolDispatch(inventory.byName,
        { providerCallId: input.toolCallId, toolName: input.name, arguments: argumentsJson },
        { onStatus: () => {}, onPartial: () => {} },
        { runtimeKind: binding.runtimeKind, sessionKey: `science:${runId(scope)}`,
          permission: binding.permission, cwd: binding.cwd, chatId: binding.chatId,
          agentId: binding.agentId, unattended: true, signal: binding.signal,
          assertCurrent: () => { assertInventoryCurrent(scope, inventory); } });
      return { content: dispatched.content, isError: dispatched.isError };
    })();
    binding.calls.set(input.toolCallId, { signature, result });
    return result;
  },
};

/** Same lazy catalog and Main dispatch, with an independent Alive wake binding. */
export const scienceAliveDesktopTools = scienceDesktopTools;
