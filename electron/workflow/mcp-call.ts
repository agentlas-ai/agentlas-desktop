import { randomUUID } from "node:crypto";
import type { Chat, McpInvocationEvent } from "../../shared/types";
import type { McpInvocationResult } from "../mcp/client";
import type { InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { revalidateInvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { isKeylessPlaywrightMcpDuplicate, type BrowserApprovalScope } from "../mcp-tools/mcp-config";
import { buildNativeBrowserMcpConfig } from "../browser/native-mcp-config";
import { listInstalledServers } from "../mcp-tools/registry";
import { mcpToolIsMutating } from "../mcp-tools/proxy-server";
import { isReadOnlyGraphBrowserObservation } from "../../shared/graph-browser-observation";
import { READ_ONLY_BROWSER_TOOLS } from "../../shared/read-only-browser-tools";
import type { WorkflowGraph } from "../../shared/types";
import { loadMainToolInventory, runMainToolDispatch } from "../runtime/local-tool-loop";
import { transferEffectRefs } from "../runtime/effect-delivery";
import { agentRunCwd } from "../runtime/exec";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getAutomation } from "../store/automations";
import { oneGraphAuthorityOwner } from "../one/graph-ownership";
import { sha256Value } from "../../shared/graph-execution-digest";
import { isGraphControlTool } from "../../shared/graph-authoring";

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
  /** Only a retained server response proves this call returned; transport errors do not. */
  onResponse?: () => void;
}

export interface GraphMcpCallResult extends McpInvocationResult {
  /** Host-observed tool data, not an interpreted assistant envelope. */
  output: unknown;
}

/**
 * The Agentlas Browser binding refuses a gated config without an owner scope
 * (`browser-approval-scope-missing`, required since 1.2.28). Both graph paths below were added in
 * 1.2.54 without one, so every graph inventory or call that touched the browser failed — and One
 * read the machine code as "the owner must approve read access" and asked for an approval that
 * does not exist (production X room, 2026-10-03: 143 repeated questions). The scope is the chat the
 * graph acts for; an automation session that was not opened from One belongs to Work.
 */
function graphBrowserApprovalScope(chatId: string): BrowserApprovalScope {
  const surface = getChat(chatId)?.originSurface === "one" ? "one" : "work";
  return Object.freeze({ surface, chatId });
}

/** The code first (callers read the token), then what it means: no connected server provides this tool catalog on this machine. */
function catalogUnavailableMessage(catalogId: string): string {
  return `graph_mcp_catalog_unavailable: no connected tool server provides "${catalogId}" on this machine (it is not installed, not enabled, or still missing a login or key). `
    + "Use a tool catalog that is connected here, or connect this one first.";
}

/** Match only the same unconfigured aliases the config builder canonicalizes.
 * A custom profile, endpoint or credential keeps its owner's explicit binding. */
function graphUsesNativeBrowser(catalogId: string): boolean {
  return catalogId === "agentlas-browser" || listInstalledServers().some(server => server.enabled
    && (server.catalogId === catalogId || server.id === catalogId)
    && (server.catalogId === "agentlas-browser" || isKeylessPlaywrightMcpDuplicate(server)));
}

/** Inventory is read from the same prepared Main binding used for dispatch.
 * No tool is invoked and no remote definition is accepted as an authority. */
export async function inspectGraphMcpTools(input: {
  chat: Pick<Chat, "id">; catalogId: string; permission: "read" | "write" | "full"; signal?: AbortSignal;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.catalogId)) throw new Error("graph_mcp_catalog_invalid");
  input.signal?.throwIfAborted();
  const workingFolder = getChatWorkingFolder(input.chat.id);
  const inventoryId = `graph-inventory-${randomUUID()}`;
  const nativeBrowser = graphUsesNativeBrowser(input.catalogId);
  const config = await buildNativeBrowserMcpConfig({ catalogIds: [input.catalogId], requiredToolCatalogIds: [input.catalogId],
    skipDefaultSeed: true, configKey: inventoryId,
    ...(nativeBrowser ? { browserProfileKey: `automation-${inventoryId}` } : {}),
    ...(workingFolder ? { workingFolder } : {}),
    toolGate: { runtime: "graph-mcp", sessionKey: `graph-inventory:${randomUUID()}`, permission: input.permission,
      cwd: workingFolder ?? agentRunCwd(), chatId: input.chat.id, unattended: true,
      approvalScope: graphBrowserApprovalScope(input.chat.id) },
    admissionCurrent: () => !input.signal?.aborted }, nativeBrowser ? {
      chatId: input.chat.id, runId: inventoryId, permission: input.permission,
      signal: input.signal ?? new AbortController().signal, presentation: "background",
    } : null);
  if (!config) throw new Error(catalogUnavailableMessage(input.catalogId));
  try {
    const inventory = await loadMainToolInventory(config.configPath, undefined, input.permission, false, false, input.signal);
    let schemaBytes = 0;
    const tools = [...inventory.byName].filter(([, tool]) => tool.kind === "mcp"
      && (tool.server.catalogId === input.catalogId || nativeBrowser && tool.server.catalogId === "agentlas-browser"))
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

/**
 * True when no argument can make this call read-only, so a step that declares it "read" is refused on every run.
 * Mirrors the run-time check in runGraphMcpCall; only argument-independent verdicts are decided here (one-team
 * graph calls and the browser's URL- and shape-dependent reads stay with the run-time check).
 */
export function graphMcpToolNeverReadOnly(catalogId: string, toolName: string): boolean {
  if (catalogId === "one-team") return toolName === "one_graph_set_enabled";
  if (catalogId === "agentlas-browser" && !(READ_ONLY_BROWSER_TOOLS as readonly string[]).includes(toolName)) return true;
  return mcpToolIsMutating({ catalogId, toolName });
}

/**
 * Save-time twin of the effect check in runGraphMcpCall. Production 2026-10-05: a room agent saved a Toolchain whose
 * read step called agentlas-browser browser_run_code_unsafe; the run refused it (graph_mcp_effect_mismatch) on 5 of 5
 * calls because nothing checked the declared effect when the graph was saved.
 */
export function graphMcpEffectProblems(graph: Pick<WorkflowGraph, "nodes">, locale: "ko" | "en"): Array<{ nodeId: string; reason: string }> {
  const problems: Array<{ nodeId: string; reason: string }> = [];
  for (const node of graph.nodes) {
    const call = node.config?.mcpCall as Partial<GraphMcpCall> | undefined;
    if (!call || typeof call.catalogId !== "string" || typeof call.toolName !== "string") continue;
    const tool = `${call.catalogId}.${call.toolName}`;
    if (node.config?.effect === "pure") {
      problems.push({ nodeId: node.id, reason: locale === "ko"
        ? `${node.id} 단계는 도구(${tool})를 부르므로 pure 가 될 수 없습니다. 효과를 read 나 mutation 으로 정하세요.`
        : `Step ${node.id} calls a tool (${tool}), so it cannot be pure. Declare its effect as read or mutation.` });
    } else if (node.config?.effect === "read" && graphMcpToolNeverReadOnly(call.catalogId, call.toolName)) {
      problems.push({ nodeId: node.id, reason: locale === "ko"
        ? `${node.id} 단계는 효과가 read 인데 ${tool} 은 상태를 바꿀 수 있는 도구라 실행할 때마다 거부됩니다. 읽기 전용 도구(agentlas-browser 의 browser_snapshot·browser_find·browser_navigate·browser_take_screenshot 등)를 쓰거나 효과를 mutation 으로 정하세요.`
        : `Step ${node.id} declares effect read but ${tool} can change state, so every run would refuse it. Use a read-only tool (agentlas-browser browser_snapshot, browser_find, browser_navigate, browser_take_screenshot, ...) or declare the effect as mutation.` });
    }
  }
  return problems;
}

/** The launcher's typed mark on the answer it gives when the browser itself did not start (electron/mcp-tools/browser-cdp-launcher.ts). */
export const BROWSER_START_FAILED_META = "agentlas/browserStartFailed";

/** Pauses before the second and third ask of a read-only call that got no answer (graph_mcp_call_failed "timed out", observed in use). */
export const GRAPH_READ_CALL_RETRY_WAITS_MS: readonly number[] = [3_000, 9_000];

/**
 * A tool step declared `read` whose actual call (tool and arguments together) is not read-only - the browser's URL-dependent reads
 * are the case - used to be refused on every run (graph_mcp_effect_mismatch: 6 nodes and 5 graph runs, observed in use).
 * The label cannot grant read authority and the host measured the call, so a write-permitted automation runs it as the mutation it
 * is: a second pass with the effect set to mutation, the same approvals and the same kernel treatment (onAdmission reports
 * readOnly=false) as a step authored as a mutation. A read-only automation, a simulation and a `pure` step are still refused.
 */
export async function runGraphMcpCall(input: GraphMcpCallOptions): Promise<GraphMcpCallResult> {
  const first = await runGraphMcpCallOnce(input);
  return first === ESCALATE_TO_MUTATION ? runGraphMcpCallOnce({ ...input, effect: "mutation" }, false) as Promise<GraphMcpCallResult> : first;
}

const ESCALATE_TO_MUTATION = Symbol("graph-mcp-escalate-to-mutation");

async function runGraphMcpCallOnce(input: GraphMcpCallOptions, mayEscalate = true): Promise<GraphMcpCallResult | typeof ESCALATE_TO_MUTATION> {
  const raw = input.call as Partial<GraphMcpCall> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["catalogId", "toolName", "arguments", "schemaDigest"].includes(key))
    || typeof raw.catalogId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.catalogId)
    || typeof raw.toolName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(raw.toolName)
    || (raw.schemaDigest !== undefined && !/^[a-f0-9]{64}$/.test(raw.schemaDigest))) throw new Error("graph_mcp_call_invalid");
  if (isGraphControlTool(raw.catalogId, raw.toolName)) throw new Error("graph_mcp_recursive_graph_control_denied");
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
  const nativeBrowser = graphUsesNativeBrowser(raw.catalogId);
  const config = await buildNativeBrowserMcpConfig({ catalogIds: [raw.catalogId], requiredToolCatalogIds: [raw.catalogId], turnRunId: input.runId,
    skipDefaultSeed: true, configKey: sessionKey, admissionCurrent: () => {
      try { assertCurrent(); return true; } catch { return false; }
    }, ...(workingFolder ? { workingFolder } : {}), browserProfileKey: `automation-${input.automationId}`,
    toolGate: { runtime: "graph-mcp", sessionKey, permission, cwd, chatId, unattended: true,
      approvalScope: graphBrowserApprovalScope(chatId),
      ...(input.dryRun ? { simulation: true } : {}), ...(permission === "read" ? { readOnlyObservation: true } : {}) } },
    nativeBrowser ? { chatId, runId: input.runId, permission,
      signal: input.signal, presentation: "background" } : null);
  if (!config) throw new Error(catalogUnavailableMessage(raw.catalogId));
  try {
    assertCurrent();
    const inventory = await loadMainToolInventory(config.configPath, undefined, permission, false, false, input.signal);
    const matches = [...inventory.byName].filter(([, tool]) => tool.kind === "mcp"
      && (tool.server.catalogId === raw.catalogId || nativeBrowser && tool.server.catalogId === "agentlas-browser")
      && tool.serverToolName === raw.toolName);
    if (matches.length !== 1) throw new Error(matches.length ? "graph_mcp_tool_ambiguous" : "graph_mcp_tool_unavailable");
    const [toolName, tool] = matches[0];
    if (tool.kind !== "mcp") throw new Error("graph_mcp_binding_invalid");
    // Remote annotations and the blueprint's effect label cannot grant read
    // authority. Reuse Main's exact catalog policy and argument-aware browser
    // contract; an unknown tool requires ordinary write approval.
    const readOnly = !mcpToolIsMutating({ catalogId: tool.server.catalogId, toolName: tool.serverToolName, args })
      && (tool.server.catalogId !== "agentlas-browser" || isReadOnlyGraphBrowserObservation(`mcp__agentlas-browser__${tool.serverToolName}`, JSON.stringify(args)))
      && !(tool.server.catalogId === "one-team" && tool.serverToolName === "one_graph_set_enabled");
    // The step was saved against the tool's schema at that time. A tool the host measures as read-only (the measurement above does
    // not depend on the digest) cannot change anything, and its server validates the arguments itself, so a schema that moved
    // under it (an app update re-describing a browser tool) is followed instead of refusing every run until someone saves the
    // step again (graph_mcp_schema_changed). A call that can change something outside still has to match what was authored.
    if (raw.schemaDigest && raw.schemaDigest !== tool.schemaDigest && !readOnly) throw new Error("graph_mcp_schema_changed");
    if (input.effect === "read" && !readOnly && mayEscalate && !input.dryRun && input.permission === "write") return ESCALATE_TO_MUTATION;
    if (input.effect === "pure" || (input.effect === "read" && !readOnly)) throw new Error("graph_mcp_effect_mismatch");
    if (input.dryRun && !readOnly) throw new Error("graph_mcp_simulation_mutation_denied");
    input.onAdmission(readOnly);
    assertCurrent();
    const dispatchOnce = async () => {
      let started = false;
      return runMainToolDispatch(new Map([[toolName, tool]]),
        { toolName, arguments: JSON.stringify(args), providerCallId: `graph-mcp-${randomUUID()}` }, {
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
          unattended: true, signal: input.signal, assertCurrent, retainMcpToolResult: true, deferEffectDelivery: true });
    };
    let result = await dispatchOnce();
    // A read-only call that was sent and never answered (its time limit ran out, or the transport dropped: `callEnd`, read from the
    // error's type) changed nothing, so asking again is safe and is what the owner would otherwise do by hand. A slow page or a busy
    // server passes; the last answer stands. A call that can change something outside is never repeated here.
    // The one exception is typed by the browser launcher itself (`_meta["agentlas/browserStartFailed"]`, never read from words): the browser did
    // not start, so no page was reached and nothing was done, for a call that changes things as much as for one that reads.
    const browserNeverStarted = (answer: typeof result): boolean => answer.isError
      && (answer.rawMcpResult as { _meta?: Record<string, unknown> } | undefined)?._meta?.[BROWSER_START_FAILED_META] === true;
    for (const waitMs of GRAPH_READ_CALL_RETRY_WAITS_MS) {
      const again = browserNeverStarted(result) || (readOnly && result.isError && result.callEnd && !result.rawMcpResult);
      if (!again) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { input.signal.removeEventListener("abort", stop); resolve(); }, waitMs);
        const stop = (): void => { clearTimeout(timer); resolve(); };
        input.signal.addEventListener("abort", stop, { once: true });
      });
      assertCurrent();
      result = await dispatchOnce();
    }
    // Main's transport-error catch returns an error without rawMcpResult. A server
    // error response still has the retained original and settles the remote call.
    if (result.rawMcpResult) input.onResponse?.();
    if (result.isError) throw new Error(`graph_mcp_call_failed:${result.content}`);
    assertCurrent();
    const data = result.rawMcpResult && Object.hasOwn(result.rawMcpResult, "structuredContent")
      ? result.rawMcpResult.structuredContent : result.content;
    const value = result.artifactPaths?.length
      ? { data, artifacts: [...result.artifactPaths] } : data;
    const handoff = { stormbreakerContinueRequested: false, output: value,
      finalText: typeof value === "string" ? value : JSON.stringify(value) };
    transferEffectRefs(result, handoff);
    return handoff;
  } finally { config.cleanup?.(); }
}
