import { randomUUID } from "node:crypto";
import { preparedMcpTransport } from "../mcp-tools/prepared-transport";
import { mcpToolSchemaDigest } from "../mcp-tools/tool-schema";
import type { OpenAiToolDef, ResolvedTool } from "./local-tool-loop";

const LIST = "agentlas_tools_list";
const PREPARE = "agentlas_tools_prepare";
const CALL = "agentlas_tools_call";
const NAMES = new Set([LIST, PREPARE, CALL]);
// Anthropic/Gemini adapters clamp tool results to 20k characters. Keep complete
// JSON below that shared consumer boundary, including names/tokens/metadata.
const MAX_MENU_RESPONSE_CHARS = 18_000;
interface Menu {
  invalid?: boolean;
  descriptors: Map<string, OpenAiToolDef>;
  tokens: Map<string, string>;
  prepared: Map<string, string>;
  metrics: { mode: "lazy"; inventoryDigest: string; initialSchemaBytes: number; eagerSchemaBytes: number; loadedSchemaBytes: number; preparedCount: number };
}
const menus = new WeakMap<Map<string, ResolvedTool>, Menu>();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): OpenAiToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
const MENU_TOOLS = [
  definition(LIST, "Browse the available MCP tool metadata. Page through names/descriptions; optionally filter by exact server key. Prepare an exact name before calling it.",
    { server: { type: "string" }, cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  definition(PREPARE, "Retrieve the complete input schema for one exact tool name from agentlas_tools_list. Returns a request-scoped prepared token; use agentlas_tools_call with that token and schema-valid arguments.",
    { name: { type: "string" } }, ["name"]),
  definition(CALL, "Execute one prepared MCP tool with its opaque token and an arguments object matching its exact prepared input schema. Normal user permissions and approval still apply.",
    { token: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, ["token", "arguments"]),
];

/** Stable provider schemas work with adapters that snapshot their wire menu once.
 * Workforce uses its exact eager broker inventory until it supports menu handles. */
export function installLazyToolMenu(tools: OpenAiToolDef[], byName: Map<string, ResolvedTool>, enabled: boolean): OpenAiToolDef[] {
  const descriptors = new Map(tools.filter(tool => byName.get(tool.function.name)?.kind === "mcp").map(tool => [tool.function.name, tool]));
  if (!enabled || descriptors.size < 32 || bytes([...descriptors.values()]) < 16_384 || [...NAMES].some(name => byName.has(name))) return tools;
  const exposed = [...tools.filter(tool => byName.get(tool.function.name)?.kind !== "mcp"), ...structuredClone(MENU_TOOLS)];
  menus.set(byName, { descriptors, tokens: new Map(), prepared: new Map(), metrics: {
    mode: "lazy", inventoryDigest: mcpToolSchemaDigest([...descriptors.keys()].map(name => [name, (byName.get(name) as Extract<ResolvedTool, {kind:"mcp"}>).schemaDigest])),
    eagerSchemaBytes: bytes(tools), initialSchemaBytes: bytes(exposed), loadedSchemaBytes: 0, preparedCount: 0,
  } });
  return exposed;
}
export function toolMenuMetrics(byName: Map<string, ResolvedTool>): Readonly<Menu["metrics"]> | null {
  const menu = menus.get(byName); return menu ? { ...menu.metrics } : null;
}
export function invalidateToolMenu(byName: Map<string, ResolvedTool>): void {
  const menu = menus.get(byName);
  if (menu) { menu.invalid = true; menu.tokens.clear(); menu.prepared.clear(); }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error("tool_menu_arguments_invalid");
}
export type MenuResolution = { kind: "result"; content: string } | { kind: "call"; toolName: string; arguments: string } | null;
/** Main-only request-scoped resolution. Tokens never grant authority; the
 * canonical dispatch still checks the prepared transport and approval. */
export function resolveToolMenu(byName: Map<string, ResolvedTool>, name: string, input: string): MenuResolution {
  const menu = menus.get(byName);
  if (!menu) return null;
  if (menu.invalid && (NAMES.has(name) || byName.get(name)?.kind === "mcp")) throw new Error("tool_menu_inventory_changed");
  if (!NAMES.has(name)) {
    if (byName.get(name)?.kind === "mcp") throw new Error("tool_menu_prepare_required");
    return null;
  }
  const args: unknown = JSON.parse(input || "{}");
  if (!object(args)) throw new Error("tool_menu_arguments_invalid");
  // An auth/config/permission change invalidates even cached metadata.
  for (const resolved of byName.values()) if (resolved.kind === "mcp") preparedMcpTransport(resolved.prepared, resolved.server);
  if (name === LIST) {
    keys(args, ["server", "cursor", "limit"]);
    if (args.server !== undefined && typeof args.server !== "string") throw new Error("tool_menu_arguments_invalid");
    const cursor = args.cursor ?? 0, limit = args.limit ?? 30;
    if (!Number.isInteger(cursor) || (cursor as number) < 0 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error("tool_menu_arguments_invalid");
    const rows = [...menu.descriptors.values()].filter(tool => args.server === undefined || (byName.get(tool.function.name) as Extract<ResolvedTool, {kind:"mcp"}>).serverConfigKey === args.server);
    const page = rows.slice(cursor as number, (cursor as number) + (limit as number));
    const response = () => JSON.stringify({ schemaVersion: "agentlas.tool-menu.v1", inventoryDigest: menu.metrics.inventoryDigest, metrics: menu.metrics, total: rows.length,
      tools: page.map(tool => { const resolved = byName.get(tool.function.name) as Extract<ResolvedTool, {kind:"mcp"}>;
        return { name: tool.function.name, server: resolved.serverConfigKey, description: tool.function.description?.slice(0, 320), schemaDigest: resolved.schemaDigest }; }),
      nextCursor: (cursor as number) + page.length < rows.length ? (cursor as number) + page.length : null });
    while (page.length > 1 && response().length > MAX_MENU_RESPONSE_CHARS) page.pop();
    const content = response();
    if (content.length > MAX_MENU_RESPONSE_CHARS) throw new Error("tool_menu_metadata_too_large");
    return { kind: "result", content };
  }
  if (name === PREPARE) {
    keys(args, ["name"]);
    const descriptor = typeof args.name === "string" ? menu.descriptors.get(args.name) : undefined;
    if (!descriptor) throw new Error("tool_menu_exact_name_unknown");
    // Never truncate schemas into a different contract.
    if (bytes(descriptor) > 16 * 1024) throw new Error("tool_menu_schema_too_large");
    const toolName = descriptor.function.name;
    let token = menu.prepared.get(toolName);
    if (!token) {
      token = randomUUID(); menu.tokens.set(token, toolName); menu.prepared.set(toolName, token);
      menu.metrics.loadedSchemaBytes += bytes(descriptor); menu.metrics.preparedCount++;
    }
    return { kind: "result", content: JSON.stringify({ token,
      schemaDigest: (byName.get(toolName) as Extract<ResolvedTool, {kind:"mcp"}>).schemaDigest, ...descriptor.function }) };
  }
  keys(args, ["token", "arguments"]);
  const toolName = typeof args.token === "string" ? menu.tokens.get(args.token) : undefined;
  if (!toolName) throw new Error("tool_menu_prepared_token_invalid");
  if (!object(args.arguments)) throw new Error("tool_menu_arguments_invalid");
  return { kind: "call", toolName, arguments: JSON.stringify(args.arguments) };
}
