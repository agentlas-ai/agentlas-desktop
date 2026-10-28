import * as path from "node:path";
import { planMcpToolIsMutating } from "./proxy-server";
import { workSessionReadPermissionCall } from "../../shared/work-session-tools";
import { HARNESS_EFFECT_FREE_READ_OPERATIONS } from "../harness/capability-ports";

/*
 * Main-work recovery only (invocation/main-work-recovery.ts): which MCP calls are effect-free reads. A call that ended without its
 * answer (a provider's 30 s limit, an abort, a lost transport) is then closed as a failed read, and its identical repeat runs. Any
 * other call is held and its identical repeat is refused main_work_same_action_outcome_unknown (Finance 1008 rs7 rs-V02/V03,
 * 2026-10-23: a World Bank fetch timed out and the same fetch could never run again; H8-f).
 *
 * This is NOT an approval input. Approval keeps mcpToolIsMutating (proxy-server.ts), which on purpose lets effectful controls run
 * under read permission (work_session_delegate/steer/cancel, finance.monitor.pause, ask_form, memory_note): reusing that set here
 * would run a delegation or a pause again after a timeout. This list is closed and exact, keyed by Main's dispatcher identity (a
 * static first-party catalog id, or an app-bundled plugin release verified by its digest), never by a tool's own claims or by
 * words in its name. Anything not listed, an unknown tool or an unexpected argument shape, stays an effect (fail closed).
 */

/** harness_call operations (agentlas-turn) that only read: each port declares effectFreeRead in its own declaration
 * (harness/capability-ports.ts, finance/tools.ts) and is a `kind: "query"` port. A query port that shows a card for the owner to act on
 * (finance.portfolio.propose), maps or opens apps (reach.map), renders files (document.render) or reads another MCP server
 * (mcp.app.resource.read) does not declare it. The set is still closed: an operation without the declaration is an effect. */
export const MAIN_WORK_HARNESS_READ_OPERATIONS: ReadonlySet<string> = HARNESS_EFFECT_FREE_READ_OPERATIONS;

/** one-team tools whose first-party definitions declare readOnlyHint (shared/graph-authoring.ts ONE_GRAPH_TOOLS,
 * shared/work-session-tools.ts WORK_SESSION_TOOL_DEFINITIONS). Delegation, steering, cancelling, reporting and enabling are not. */
export const MAIN_WORK_ONE_TEAM_READ_TOOLS: ReadonlySet<string> = new Set([
  "one_graph_schema", "one_graph_inspect", "one_graph_result", "toolchain_search", "work_session_agents", "work_session_status",
]);

/** agentlas-ui returns constant reference text. */
const UI_READ_TOOLS: ReadonlySet<string> = new Set(["read_ui_schema", "read_surface_protocol", "read_automation_protocol"]);

/** App-bundled plugin servers (plugins/<slug>, scripts/copy-builtin-plugins.cjs) whose tools only read. Their catalog id is the
 * plugin's own tool id, which an installed community plugin could also declare, so it counts only together with a launch verified
 * to run the app-bundled release (verifiedBundledPluginRelease below). */
export const MAIN_WORK_BUNDLED_PLUGIN_READS: ReadonlyMap<string, { slug: string; tools: ReadonlySet<string> }> = new Map([
  // plugins/agentlas-economic-data: one bounded keyless GET to api.worldbank.org (capabilities.json requestPolicy), or its constant contract.
  ["agentlas-economic-data", { slug: "agentlas-economic-data", tools: new Set(["fetch_world_bank_indicator", "describe_economic_data_capabilities"]) }],
]);

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * True only for a listed effect-free read. `bundledRelease` is the slug of the app-bundled plugin release this server was verified
 * to run (verifiedBundledPluginRelease), or null.
 */
export function mainWorkEffectFreeRead(input: {
  catalogId?: string | null; toolName: string; args?: unknown; bundledRelease?: string | null;
}): boolean {
  const catalogId = input.catalogId ?? "";
  if (catalogId === "agentlas-turn") {
    if (input.toolName === "harness_search" || input.toolName === "harness_describe") return true;
    if (input.toolName !== "harness_call" || !plain(input.args)) return false;
    const a = input.args;
    // Only the declared form: the operation under `operation`, its arguments under `args` as an object. The aliases the dispatcher
    // also reads (operationId/id/name, input/arguments, a JSON string) are not admitted here; such a call simply stays an effect.
    if (!Object.keys(a).every((key) => key === "operation" || key === "args")) return false;
    if (typeof a.operation !== "string" || a.operation !== a.operation.trim()) return false;
    if (a.args !== undefined && !plain(a.args)) return false;
    return MAIN_WORK_HARNESS_READ_OPERATIONS.has(a.operation);
  }
  // The exact observation calls Plan already admits for these two host runtimes (argument-closed: browser_tabs list only, …).
  if (catalogId === "agentlas-browser" || catalogId === "cua-driver") {
    return !planMcpToolIsMutating({ authority: catalogId, toolName: input.toolName, args: input.args });
  }
  if (catalogId === "agentlas-ui") return UI_READ_TOOLS.has(input.toolName);
  if (catalogId === "one-team") {
    if (!MAIN_WORK_ONE_TEAM_READ_TOOLS.has(input.toolName)) return false;
    return input.toolName.startsWith("work_session_") ? workSessionReadPermissionCall(input) : true;
  }
  const bundled = MAIN_WORK_BUNDLED_PLUGIN_READS.get(catalogId);
  return !!bundled && input.bundledRelease === bundled.slug && bundled.tools.has(input.toolName);
}

const bundledDigests = new Map<string, string>();

/**
 * The slug of the app-bundled plugin release this server's actual launch runs, or null. The plugin launcher's arguments
 * (plugins/tool-provider.ts: launcher --plugin-root <root> --release-digest <digest> --entry …) must name that slug's directory and
 * the exact digest of the release shipped inside this app (plugins/materialize.ts bundledPluginRelease). Never throws.
 */
export async function verifiedBundledPluginRelease(catalogId: string | null | undefined,
  readLaunch: () => { kind: string; args?: readonly string[] }): Promise<string | null> {
  const bundled = MAIN_WORK_BUNDLED_PLUGIN_READS.get(catalogId ?? "");
  // Read only for a listed plugin catalog id: every other call never touches its sealed launch here.
  if (!bundled) return null;
  try {
    const launch = readLaunch();
    if (launch.kind !== "stdio" || !launch.args) return null;
    const args = launch.args;
    if (args[1] !== "--plugin-root" || args[3] !== "--release-digest" || typeof args[2] !== "string" || typeof args[4] !== "string") return null;
    if (path.basename(args[2]) !== bundled.slug || !/^sha256:[a-f0-9]{64}$/.test(args[4])) return null;
    let digest = bundledDigests.get(bundled.slug);
    if (!digest) {
      digest = (await import("../plugins/materialize")).bundledPluginRelease(bundled.slug).digest;
      bundledDigests.set(bundled.slug, digest);
    }
    return args[4] === digest ? bundled.slug : null;
  } catch {
    return null;
  }
}
