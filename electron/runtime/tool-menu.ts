import { randomUUID } from "node:crypto";
import { preparedMcpTransport } from "../mcp-tools/prepared-transport";
import { mcpToolSchemaDigest } from "../mcp-tools/tool-schema";
import { toolSchemaVariants, type ToolSchemaVariant } from "./tool-schema-selection";
import { closestToolNames, resolveToolNameAlias } from "./tool-name-alias";
import type { OpenAiToolDef, ResolvedTool } from "./local-tool-loop";

const LIST = "agentlas_tools_list";
const PREPARE = "agentlas_tools_prepare";
const VARIANTS = "agentlas_tools_variants";
const PREPARE_VARIANT = "agentlas_tools_prepare_variant";
const CALL = "agentlas_tools_call";
const NAMES = new Set([LIST, PREPARE, VARIANTS, PREPARE_VARIANT, CALL]);
export function isToolMenuTool(name: string): boolean {
  return NAMES.has(name);
}
// Match tool-result-context's inline UTF-8 byte limit so ordinary metadata
// pages retain complete JSON instead of becoming text-result references.
const MAX_MENU_RESPONSE_BYTES = 8_192;
const MAX_PREPARED_SCHEMA_BYTES = 16_384;
interface Menu {
  invalid?: boolean;
  descriptors: Map<string, OpenAiToolDef>;
  tokens: Map<string, { name: string; selector: ToolSchemaVariant["selector"] }>;
  prepared: Map<string, string>;
  metrics: { mode: "lazy"; inventoryDigest: string; initialSchemaBytes: number; eagerSchemaBytes: number; loadedSchemaBytes: number; preparedCount: number };
}
const menus = new WeakMap<Map<string, ResolvedTool>, Menu>();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function metadataPage<T>(page: T[], response: () => string): string {
  let content = response();
  while (page.length > 1 && Buffer.byteLength(content, "utf8") > MAX_MENU_RESPONSE_BYTES) {
    page.pop(); content = response();
  }
  // One oversized row still advances the cursor and retains its full metadata.
  // The ordinary tool-result projection can externalize it without truncation.
  return content;
}
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): OpenAiToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
const MENU_TOOLS = [
  definition(LIST, "List MCP tools (page; server filter). Prepare a name before calling.",
    { server: { type: "string" }, cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  definition(PREPARE, "Full input schema + token for one exact tool name (required for agentlas_tools_call). Large schemas: first variants page.",
    { name: { type: "string" } }, ["name"]),
  definition(VARIANTS, "Page variants of a large tool schema; pick an index for agentlas_tools_prepare_variant.",
    { name: { type: "string" }, cursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["name"]),
  definition(PREPARE_VARIANT, "One variant schema + token (name, variant index).",
    { name: { type: "string" }, variant: { type: "integer", minimum: 0 } }, ["name", "variant"]),
  definition(CALL, "Call a prepared tool: token + arguments per its schema. Approval applies.",
    { token: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, ["token", "arguments"]),
];

/** Stable provider schemas work with adapters that snapshot their wire menu once.
 * Workforce uses its exact eager broker inventory until it supports menu handles. */
/**
 */
const LAZY_MIN_TOOLS = 8;
const LAZY_MIN_SCHEMA_BYTES = 6_144;
const INDEX_NAMES_PER_SERVER = 12;

/** One short line per MCP server (key, tool count, first tool names) so the model can prepare an exact name without browsing first. */
export function toolMenuServerIndex(tools: OpenAiToolDef[], byName: Map<string, ResolvedTool>): string {
  const perServer = new Map<string, string[]>();
  for (const tool of tools) {
    const resolved = byName.get(tool.function.name);
    if (resolved?.kind !== "mcp") continue;
    const names = perServer.get(resolved.serverConfigKey) ?? [];
    names.push(tool.function.name);
    perServer.set(resolved.serverConfigKey, names);
  }
  return [...perServer].map(([key, names]) => {
    const prefix = `mcp__${key.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
    const shown = names.slice(0, INDEX_NAMES_PER_SERVER).map(name => name.startsWith(prefix) ? name.slice(prefix.length) : name);
    return `${key} (${names.length}): ${shown.join(", ")}${names.length > shown.length ? ", …" : ""}`;
  }).join("; ");
}

/**

 */
const DIRECT_ENTRY_TOOLS = new Set(["harness_search", "harness_describe", "harness_call"]);
export function isDirectEntryTool(resolved: ResolvedTool | undefined): boolean {
  return resolved?.kind === "mcp" && resolved.server.catalogId === "agentlas-turn" && DIRECT_ENTRY_TOOLS.has(resolved.serverToolName);
}

/**

 */
export function installLazyToolMenu(tools: OpenAiToolDef[], byName: Map<string, ResolvedTool>, enabled: boolean, oversizedOnly = false, earlyDeferral = false): OpenAiToolDef[] {
  const descriptors = new Map(tools.filter(tool => byName.get(tool.function.name)?.kind === "mcp"
    && !isDirectEntryTool(byName.get(tool.function.name))
    && (!oversizedOnly || bytes(tool) > MAX_PREPARED_SCHEMA_BYTES)).map(tool => [tool.function.name, tool]));
  const descriptorBytes = bytes([...descriptors.values()]);
  const small = descriptors.size < 32 && descriptorBytes < MAX_PREPARED_SCHEMA_BYTES
    && (!earlyDeferral || descriptors.size < LAZY_MIN_TOOLS || descriptorBytes < LAZY_MIN_SCHEMA_BYTES);
  if (!enabled || !descriptors.size || (!oversizedOnly && small)
    || [...NAMES].some(name => byName.has(name))) return tools;
  const index = toolMenuServerIndex([...descriptors.values()], byName);
  const menuTools = structuredClone(MENU_TOOLS);
  if (index) menuTools[0].function.description = `${menuTools[0].function.description} MCP servers (tool names without the mcp__<server>__ prefix): ${index}. The exact tool name is the prefix plus that short name.`;
  const exposed = [...tools.filter(tool => !descriptors.has(tool.function.name)), ...menuTools];
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
type NextAction = { tool: string; arguments: Record<string, unknown> };
function invalidArguments(invalidFields: string[], nextAction: NextAction, code = "tool_menu_arguments_invalid"): never {
  throw Object.assign(new Error(JSON.stringify({ code, invalidFields, nextAction })), { code });
}
function keys(args: Record<string, unknown>, allowed: string[], nextAction: NextAction): void {
  const invalidFields = Object.keys(args).filter(key => !allowed.includes(key));
  if (invalidFields.length) invalidArguments(invalidFields, nextAction);
}
export type MenuResolution = { kind: "result"; content: string } | { kind: "call"; toolName: string; arguments: string } | null;
/** Main-only request-scoped resolution. Tokens never grant authority; the
 * canonical dispatch still checks the prepared transport and approval. */
export function resolveToolMenu(byName: Map<string, ResolvedTool>, name: string, input: string): MenuResolution {
  const menu = menus.get(byName);
  if (!menu) return null;
  if (menu.invalid && (NAMES.has(name) || byName.get(name)?.kind === "mcp")) throw new Error("tool_menu_inventory_changed");
  if (!NAMES.has(name)) {
    if (menu.descriptors.has(name)) throw new Error("tool_menu_prepare_required");
    return null;
  }
  let args: unknown;
  try { args = JSON.parse(input || "{}"); } catch { invalidArguments(["$"], { tool: name, arguments: {} }); }
  if (!object(args)) invalidArguments(["$"], { tool: name, arguments: {} });
  // An auth/config/permission change invalidates even cached metadata.
  for (const resolved of byName.values()) if (resolved.kind === "mcp") preparedMcpTransport(resolved.prepared, resolved.server);
  if (name === LIST) {
    keys(args, ["server", "cursor", "limit"], { tool: LIST, arguments: {} });
    if (args.server !== undefined && typeof args.server !== "string") throw new Error("tool_menu_arguments_invalid");
    const cursor = args.cursor ?? 0, limit = args.limit ?? 30;
    if (!Number.isInteger(cursor) || (cursor as number) < 0 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error("tool_menu_arguments_invalid");
    const rows = [...menu.descriptors.values()].filter(tool => args.server === undefined || (byName.get(tool.function.name) as Extract<ResolvedTool, {kind:"mcp"}>).serverConfigKey === args.server);
    const page = rows.slice(cursor as number, (cursor as number) + (limit as number));
    const response = () => JSON.stringify({ schemaVersion: "agentlas.tool-menu.v1", inventoryDigest: menu.metrics.inventoryDigest, metrics: menu.metrics, total: rows.length,
      tools: page.map(tool => { const resolved = byName.get(tool.function.name) as Extract<ResolvedTool, {kind:"mcp"}>;
        return { name: tool.function.name, server: resolved.serverConfigKey, description: tool.function.description?.slice(0, 320), schemaDigest: resolved.schemaDigest,
          schemaBytes: bytes(tool), requiresVariant: bytes(tool) > MAX_PREPARED_SCHEMA_BYTES }; }),
      nextCursor: (cursor as number) + page.length < rows.length ? (cursor as number) + page.length : null });
    const content = metadataPage(page, response);
    return { kind: "result", content };
  }
  if (name === PREPARE || name === VARIANTS || name === PREPARE_VARIANT) {
    const exactName = typeof args.name === "string" ? { name: args.name } : {};
    const prepareAction = { tool: PREPARE, arguments: exactName };
    if (typeof args.name !== "string") invalidArguments(["name"], { tool: LIST, arguments: {} });
    const descriptor = typeof args.name === "string"
      ? menu.descriptors.get(args.name) ?? menu.descriptors.get(resolveToolNameAlias(menu.descriptors.keys(), args.name) ?? "")
      : undefined;
    if (!descriptor) throw new Error(`tool_menu_exact_name_unknown${typeof args.name === "string"
      ? (() => { const near = closestToolNames(menu.descriptors.keys(), args.name as string); return near.length ? `: exact names ${near.join(", ")}` : ""; })() : ""}`);
    const toolName = descriptor.function.name;
    let preparedDescriptor = descriptor;
    let selector: ToolSchemaVariant["selector"] = {};
    const oversized = bytes(descriptor) > MAX_PREPARED_SCHEMA_BYTES;
    // Retain the old large-schema selectors for adapters with a snapshotted
    // menu. Newly exposed controls have one stable shape each.
    keys(args, name === PREPARE ? oversized ? ["name", "variant", "cursor", "limit"] : ["name"]
      : name === VARIANTS ? ["name", "cursor", "limit"] : ["name", "variant"], prepareAction);
    const selectingVariant = name === PREPARE_VARIANT || (name === PREPARE && args.variant !== undefined);
    if (selectingVariant && (!Number.isInteger(args.variant) || (args.variant as number) < 0)) {
      invalidArguments(["variant"], { tool: VARIANTS, arguments: exactName });
    }
    if (selectingVariant && (args.cursor !== undefined || args.limit !== undefined)) {
      invalidArguments(["cursor", "limit"].filter(key => args[key] !== undefined), { tool: PREPARE_VARIANT, arguments: { ...exactName, variant: args.variant } });
    }
    if (oversized) {
      const variants = toolSchemaVariants(descriptor.function.parameters);
      if (!variants?.length) throw new Error("tool_menu_schema_too_large");
      if (!selectingVariant) {
        const cursor = args.cursor === undefined ? 0 : args.cursor, limit = args.limit === undefined ? 30 : args.limit;
        const invalidFields = [
          ...(!Number.isInteger(cursor) || (cursor as number) < 0 ? ["cursor"] : []),
          ...(!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50 ? ["limit"] : []),
        ];
        if (invalidFields.length) invalidArguments(invalidFields, { tool: VARIANTS, arguments: exactName });
        const page = variants.slice(cursor as number, (cursor as number) + (limit as number));
        const response = () => JSON.stringify({ schemaVersion: "agentlas.tool-menu.v1", kind: "schema_variants", name: toolName,
          schemaDigest: (byName.get(toolName) as Extract<ResolvedTool, {kind:"mcp"}>).schemaDigest,
          total: variants.length, variants: page.map(variant => ({ index: variant.index, selector: variant.selector, alternatives: variant.alternatives, schemaBytes: bytes(variant.schema) })),
          nextCursor: (cursor as number) + page.length < variants.length ? (cursor as number) + page.length : null,
          variantsTool: VARIANTS, prepareVariantTool: PREPARE_VARIANT });
        const content = metadataPage(page, response);
        return { kind: "result", content };
      }
      const variant = variants.find(item => item.index === args.variant);
      if (!variant) invalidArguments(["variant"], { tool: VARIANTS, arguments: exactName }, "tool_menu_variant_unknown");
      selector = variant.selector;
      preparedDescriptor = { ...descriptor, function: { ...descriptor.function, parameters: variant.schema } };
    } else if (name !== PREPARE) {
      invalidArguments(name === PREPARE_VARIANT ? ["variant"] : ["name"], prepareAction, "tool_menu_variant_not_required");
    }
    // Every selected alternative remains complete. Unsupported large schemas
    // produce a bounded error rather than a truncated or permissive contract.
    if (bytes(preparedDescriptor) > MAX_PREPARED_SCHEMA_BYTES) throw new Error("tool_menu_schema_too_large");
    const preparedKey = JSON.stringify([toolName, args.variant ?? null]);
    let token = menu.prepared.get(preparedKey);
    if (!token) {
      token = randomUUID(); menu.tokens.set(token, { name: toolName, selector }); menu.prepared.set(preparedKey, token);
      menu.metrics.loadedSchemaBytes += bytes(preparedDescriptor); menu.metrics.preparedCount++;
    }
    return { kind: "result", content: JSON.stringify({ token,
      schemaDigest: (byName.get(toolName) as Extract<ResolvedTool, {kind:"mcp"}>).schemaDigest,
      preparedSchemaDigest: mcpToolSchemaDigest(preparedDescriptor.function.parameters),
      ...(args.variant !== undefined ? { variant: args.variant } : {}), ...preparedDescriptor.function }) };
  }
  keys(args, ["token", "arguments"], { tool: CALL, arguments: {} });
  const prepared = typeof args.token === "string" ? menu.tokens.get(args.token) : undefined;
  if (!prepared) throw new Error("tool_menu_prepared_token_invalid");
  if (!object(args.arguments)) throw new Error("tool_menu_arguments_invalid");
  const argumentsObject = args.arguments;
  if (Object.entries(prepared.selector).some(([key, value]) => argumentsObject[key] !== value)) throw new Error("tool_menu_variant_arguments_invalid");
  return { kind: "call", toolName: prepared.name, arguments: JSON.stringify(argumentsObject) };
}
