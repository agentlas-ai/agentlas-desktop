import { randomUUID } from "node:crypto";
import type { Chat, McpInvocationEvent } from "../../shared/types";
import type { McpInvocationResult } from "../mcp/client";
import type { InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { revalidateInvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { buildMcpConfigFile } from "../mcp-tools/mcp-config";
import { mcpToolIsMutating } from "../mcp-tools/proxy-server";
import { isReadOnlyGraphBrowserObservation } from "../../shared/graph-browser-observation";
import { loadMainToolInventory, runMainToolDispatch } from "../runtime/local-tool-loop";
import { agentRunCwd } from "../runtime/exec";
import { getChatWorkingFolder } from "../store/chats";
import { getAutomation } from "../store/automations";
import { oneGraphAuthorityOwner } from "../one/graph-ownership";
import { sha256Value } from "../../shared/graph-execution-digest";

export interface GraphMcpCall {
  catalogId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  schemaDigest?: string;
}
const reserved = new Set(["__proto__", "prototype", "constructor"]);

/** JSON projection, never code evaluation. A whole placeholder keeps its type;
 * strings with embedded placeholders accept scalars only. Scope/control values
 * are not part of the argument bag and cannot be supplied by a blueprint. */
export function projectGraphMcpArguments(input: unknown, vars: Record<string, unknown>): Record<string, unknown> {
  let entries = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number, templates: boolean): unknown => {
    if (++entries > 4096 || depth > 16) throw new Error("graph_mcp_arguments_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (!templates) return value;
      const get = (name: string) => {
        if (reserved.has(name) || !Object.hasOwn(vars, name)) throw new Error(`graph_mcp_input_missing:${name}`);
        return visit(vars[name], depth + 1, false);
      };
      const whole = value.match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/);
      if (whole) return get(whole[1]);
      const output = value.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (_match, name: string) => {
        const replacement = get(name);
        if (replacement !== null && typeof replacement === "object") throw new Error("graph_mcp_embedded_value_must_be_scalar");
        return String(replacement);
      });
      if (output.includes("{{") || output.includes("}}")) throw new Error("graph_mcp_placeholder_invalid");
      return output;
    }
    if (!value || typeof value !== "object" || seen.has(value)) throw new Error("graph_mcp_arguments_invalid");
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => visit(item, depth + 1, templates));
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("graph_mcp_arguments_invalid");
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (reserved.has(key)) throw new Error("graph_mcp_argument_key_reserved");
        out[key] = visit(item, depth + 1, templates);
      }
      return out;
    } finally { seen.delete(value); }
  };
  const output = visit(input, 0, true);
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("graph_mcp_arguments_object_required");
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > 64 * 1024) throw new Error("graph_mcp_arguments_limit");
  return output as Record<string, unknown>;
}

export interface GraphMcpCallOptions {
  call: unknown;
  vars: Record<string, unknown>;
  runId: string;
  automationId: string;
  nodeId: string;
  chatId: string;
  effect: "pure" | "read" | "mutation";
  permission: "read" | "write";
  dryRun: boolean;
  workspaceBinding: InvocationWorkspaceBinding;
  signal: AbortSignal;
  sink: (event: McpInvocationEvent) => void;
  /** Host classification for the existing graph checkpoint receipt listener. */
  onAdmission: (readOnly: boolean) => void;
}

export interface GraphMcpCallResult extends McpInvocationResult {
  /** Host-observed tool data, not an interpreted assistant envelope. */
  output: unknown;
}

/** Inventory is read from the same prepared Main binding used for dispatch.
 * No tool is invoked and no remote definition is accepted as an authority. */
export async function inspectGraphMcpTools(input: {
  chat: Pick<Chat, "id">; catalogId: string; permission: "read" | "write" | "full"; signal?: AbortSignal;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.catalogId)) throw new Error("graph_mcp_catalog_invalid");
  input.signal?.throwIfAborted();
  const workingFolder = getChatWorkingFolder(input.chat.id);
  const config = await buildMcpConfigFile({ catalogIds: [input.catalogId], requiredToolCatalogIds: [input.catalogId],
    skipDefaultSeed: true, configKey: `graph-inventory-${randomUUID()}`,
    ...(workingFolder ? { workingFolder } : {}),
    toolGate: { runtime: "graph-mcp", sessionKey: `graph-inventory:${randomUUID()}`, permission: input.permission,
      cwd: workingFolder ?? agentRunCwd(), chatId: input.chat.id, unattended: true },
    admissionCurrent: () => !input.signal?.aborted });
  if (!config) throw new Error("graph_mcp_catalog_unavailable");
  try {
    const inventory = await loadMainToolInventory(config.configPath, undefined, input.permission, false, false, input.signal);
    let schemaBytes = 0;
    const tools = [...inventory.byName].filter(([, tool]) => tool.kind === "mcp" && tool.server.catalogId === input.catalogId)
      .slice(0, 128).map(([name, tool]) => {
        if (tool.kind !== "mcp") throw new Error("graph_mcp_binding_invalid");
        const shape = inventory.tools.find(def => def.function.name === name)?.function.parameters;
        const bytes = Buffer.byteLength(JSON.stringify(shape ?? {}));
        const includeSchema = bytes <= 32 * 1024 && schemaBytes + bytes <= 64 * 1024;
        if (includeSchema) schemaBytes += bytes;
        return { toolName: tool.serverToolName, schemaDigest: tool.schemaDigest,
          ...(includeSchema ? { inputSchema: shape } : { inputSchemaOmitted: true }) };
      });
    return { catalogId: input.catalogId, tools, truncated: inventory.byName.size > tools.length };
  } finally { config.cleanup?.(); }
}

export async function runGraphMcpCall(input: GraphMcpCallOptions): Promise<GraphMcpCallResult> {
  const raw = input.call as Partial<GraphMcpCall> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["catalogId", "toolName", "arguments", "schemaDigest"].includes(key))
    || typeof raw.catalogId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.catalogId)
    || typeof raw.toolName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.toolName)
    || (raw.schemaDigest !== undefined && !/^[a-f0-9]{64}$/.test(raw.schemaDigest))) throw new Error("graph_mcp_call_invalid");
  if (raw.catalogId === "one-team" && raw.toolName.startsWith("one_graph_")) throw new Error("graph_mcp_recursive_graph_control_denied");
  const args = projectGraphMcpArguments(raw.arguments, input.vars);
  const authority = raw.catalogId === "one-team" ? getAutomation(input.automationId) : null;
  const teamOwner = authority ? oneGraphAuthorityOwner(authority) : null;
  if (raw.catalogId === "one-team" && !teamOwner) throw new Error("graph_mcp_team_authority_required");
  const authorityDigest = authority ? sha256Value({ graph: authority.graph, targetId: authority.targetId,
    targetType: authority.targetType, projectId: authority.projectId, permission: authority.executionPermission,
    hubMode: authority.hubMode, createdAt: authority.createdAt }) : null;
  const chatId = teamOwner ?? input.chatId;
  const assertCurrent = () => {
    input.signal.throwIfAborted(); revalidateInvocationWorkspaceBinding(input.workspaceBinding);
    if (teamOwner) {
      const current = getAutomation(input.automationId);
      if (!current || oneGraphAuthorityOwner(current) !== teamOwner
        || sha256Value({ graph: current.graph, targetId: current.targetId, targetType: current.targetType,
          projectId: current.projectId, permission: current.executionPermission, hubMode: current.hubMode,
          createdAt: current.createdAt }) !== authorityDigest) throw new Error("graph_mcp_team_authority_changed");
    }
  };
  assertCurrent();
  const workingFolder = revalidateInvocationWorkspaceBinding(input.workspaceBinding);
  const cwd = workingFolder ?? agentRunCwd();
  const permission = input.dryRun || input.effect !== "mutation" ? "read" : input.permission;
  const sessionKey = `graph-mcp:${input.runId}:${input.nodeId}:${randomUUID()}`;
  const config = await buildMcpConfigFile({ catalogIds: [raw.catalogId], requiredToolCatalogIds: [raw.catalogId],
    skipDefaultSeed: true, configKey: sessionKey, admissionCurrent: () => {
      try { assertCurrent(); return true; } catch { return false; }
    }, ...(workingFolder ? { workingFolder } : {}), browserProfileKey: `automation-${input.automationId}`,
    toolGate: { runtime: "graph-mcp", sessionKey, permission, cwd, chatId, unattended: true,
      ...(input.dryRun ? { simulation: true } : {}), ...(permission === "read" ? { readOnlyObservation: true } : {}) } });
  if (!config) throw new Error("graph_mcp_catalog_unavailable");
  try {
    assertCurrent();
    const inventory = await loadMainToolInventory(config.configPath, undefined, permission, false, false, input.signal);
    const matches = [...inventory.byName].filter(([, tool]) => tool.kind === "mcp"
      && tool.server.catalogId === raw.catalogId && tool.serverToolName === raw.toolName);
    if (matches.length !== 1) throw new Error(matches.length ? "graph_mcp_tool_ambiguous" : "graph_mcp_tool_unavailable");
    const [toolName, tool] = matches[0];
    if (tool.kind !== "mcp") throw new Error("graph_mcp_binding_invalid");
    if (raw.schemaDigest && raw.schemaDigest !== tool.schemaDigest) throw new Error("graph_mcp_schema_changed");
    // Remote annotations and the blueprint's effect label cannot grant read
    // authority. Reuse Main's exact catalog policy and argument-aware browser
    // contract; an unknown tool requires ordinary write approval.
    const readOnly = !mcpToolIsMutating({ catalogId: tool.server.catalogId, toolName: tool.serverToolName, args })
      && (tool.server.catalogId !== "agentlas-browser" || isReadOnlyGraphBrowserObservation(`mcp__agentlas-browser__${tool.serverToolName}`, JSON.stringify(args)))
      && !(tool.server.catalogId === "one-team" && tool.serverToolName === "one_graph_set_enabled");
    if (input.effect === "pure" || (input.effect === "read" && !readOnly)) throw new Error("graph_mcp_effect_mismatch");
    if (input.dryRun && !readOnly) throw new Error("graph_mcp_simulation_mutation_denied");
    input.onAdmission(readOnly);
    assertCurrent();
    const callId = `graph-mcp-${randomUUID()}`;
    let started = false;
    const result = await runMainToolDispatch(new Map([[toolName, tool]]),
      { toolName, arguments: JSON.stringify(args), providerCallId: callId }, {
        onPartial: () => {},
        onStatus: () => {},
        onTool: (name, argumentsText, resultText, id, isError) => {
          if (resultText === undefined) started = true;
          // A denied call has only an error result and never left Main. Do not
          // manufacture an uncertain external request for that refusal.
          if (!started) return;
          input.sink({ kind: "tool-use", tool: { name, id, args: argumentsText,
            ...(resultText !== undefined ? { result: resultText, isError } : {}) },
            ...(resultText !== undefined ? { done: true } : {}) });
        },
      }, { runtimeKind: "graph-mcp", sessionKey, permission, cwd, chatId,
        unattended: true, signal: input.signal, assertCurrent, retainMcpToolResult: true });
    if (result.isError) throw new Error(`graph_mcp_call_failed:${result.content}`);
    assertCurrent();
    const data = result.rawMcpResult && Object.hasOwn(result.rawMcpResult, "structuredContent")
      ? result.rawMcpResult.structuredContent : result.content;
    const value = result.artifactPaths?.length
      ? { data, artifacts: [...result.artifactPaths] } : data;
    return { stormbreakerContinueRequested: false, output: value,
      finalText: typeof value === "string" ? value : JSON.stringify(value) };
  } finally { config.cleanup?.(); }
}
