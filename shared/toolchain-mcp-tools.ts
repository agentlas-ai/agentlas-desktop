// A callable Toolchain is an MCP tool. One Team lists each one as its own tool (name, description, input schema from the
// asset's contract), so a runtime calls it like any other MCP tool instead of finding it first through toolchain_search.
// A Toolchain is MCP-shaped: not a text skill but a tool that agents call.
//
// Names: `tc_<slug>_<6 hex of the asset id>`, at most 49 characters so `mcp__one-team__` + name stays within 64 (the
// shortest tool-name limit among the runtimes' wires). The slug is readable when the contract name or capability key has
// Latin letters; the hash keeps it unique and stable across versions of the same asset.
//
// Pure: the host supplies the eligible assets (electron/toolchains/search.ts callableToolchainReleases).

import { createHash } from "node:crypto";
import type { ToolchainAssetContract } from "./toolchain-asset";

export const TOOLCHAIN_TOOL_PREFIX = "tc_";
export const TOOLCHAIN_TOOL_NAME_MAX = 49;
const SLUG_MAX = TOOLCHAIN_TOOL_NAME_MAX - TOOLCHAIN_TOOL_PREFIX.length - 1 - 6;
const NAME = /^tc_(?:[a-z0-9]+(?:_[a-z0-9]+)*_)?[0-9a-f]{6}$/;
/** Listed per conversation; beyond this a runtime is better served by toolchain_search than by a long tool list. */
export const TOOLCHAIN_TOOLS_MAX = 40;
const DESCRIPTION_MAX = 1024;

function slugOf(text: string | undefined): string {
  return String(text ?? "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, SLUG_MAX).replace(/_+$/g, "");
}

export function toolchainToolName(asset: { id: string; name: string; capabilityKey?: string }): string {
  const slug = slugOf(asset.name) || slugOf(asset.capabilityKey?.split(/[:/]/).pop());
  const hash = createHash("sha256").update(asset.id, "utf8").digest("hex").slice(0, 6);
  return `${TOOLCHAIN_TOOL_PREFIX}${slug ? `${slug}_` : ""}${hash}`;
}

export function isToolchainToolName(name: unknown): name is string {
  return typeof name === "string" && name.length <= TOOLCHAIN_TOOL_NAME_MAX && NAME.test(name);
}

export interface ToolchainToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

function outputKeys(schema: Record<string, unknown>): string {
  const properties = schema && typeof schema === "object" ? (schema as { properties?: Record<string, unknown> }).properties : undefined;
  const keys = properties && typeof properties === "object" ? Object.keys(properties) : [];
  return keys.length ? `Returns {${keys.slice(0, 12).join(", ")}}.` : "";
}

/**
 * The MCP tool for one callable release. No outputSchema is declared: a client that sees one expects structuredContent, and the
 * result travels as the same JSON text the other One Team tools return. Its keys are named in the description instead.
 */
export function toolchainToolDefinition(input: { asset: { id: string; name: string; capabilityKey?: string }; contract: ToolchainAssetContract; readOnly: boolean }): ToolchainToolDefinition {
  const { contract } = input;
  const parts = [
    contract.description.trim(),
    contract.whenToUse.length ? `Use when: ${contract.whenToUse.join("; ")}.` : "",
    contract.whenNotToUse.length ? `Not for: ${contract.whenNotToUse.join("; ")}.` : "",
    outputKeys(contract.outputSchema),
    input.readOnly ? "Reads only." : "Acts outside for real (writes, posts or sends); a repeat with the same arguments in this turn returns the first result.",
    "A deterministic Toolchain: if it fails, do the work your own way; the failure is recorded.",
  ].filter(Boolean);
  let description = parts.join(" ");
  if (description.length > DESCRIPTION_MAX) description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
  const schema = contract.inputSchema && typeof contract.inputSchema === "object" ? contract.inputSchema as Record<string, unknown> : { type: "object", properties: {} };
  return { name: toolchainToolName(input.asset), title: contract.name.slice(0, 120), description, inputSchema: schema,
    annotations: { readOnlyHint: input.readOnly, destructiveHint: false, idempotentHint: input.readOnly, openWorldHint: !input.readOnly } };
}

/** Request ids for direct tool calls: the same arguments in the same turn are one call (a lost response is retried, never re-sent). */
export function toolchainToolRequestId(scope: string, toolchainId: string, version: number, args: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return `tct-${createHash("sha256").update(JSON.stringify([scope, toolchainId, version, canonical(args)]), "utf8").digest("hex").slice(0, 40)}`;
}
