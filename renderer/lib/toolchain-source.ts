// Toolchain provenance for an answer's work block ("this answer used / published a
// Toolchain"). Read only from typed fields the host itself writes into two tools'
// results — the one_graph_run receipt's `invoked_as` and the toolchain_publish
// receipt — and only when the row is one of those two tools, so a command that
// merely prints a receipt can never claim a source. Never inferred from prose.
//
// Runtimes cap a tool result near 12k characters before it reaches the renderer,
// and a graph run's result carries up to 32k characters of node output after the
// receipt fields. The receipt's own fields come first, so a cut result is read
// field by field from its start instead of being dropped.

import type { OneWorkCell } from "./one-turn-work";

export interface ToolchainSourceRef {
  kind: "run" | "publish";
  automationId: string;
  name: string | null;
  /** publish only: what the fresh-session test decided. */
  state: "callable" | "draft" | "deprecated" | null;
}

const RUN_RECEIPT = "agentlas.one-graph-receipt.v1";
const PUBLISH_RECEIPT = "agentlas.toolchain-publish.v1";
const MAX_RESULT_CHARS = 64_000;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

/** `mcp__one-team__one_graph_run` / `one-team.one_graph_run` / `one_graph_run` → `one_graph_run`. */
export function bareToolName(name: string | undefined): string {
  const token = String(name ?? "").match(/[A-Za-z0-9_]+\s*$/)?.[0].trim() ?? "";
  return (token.split("__").filter(Boolean).at(-1) ?? "").toLowerCase();
}

/** Decode a JSON string starting at the opening quote; a cut string returns what was read. */
function readString(text: string, start: number): { value: string; end: number; complete: boolean } {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") return { value, end: index + 1, complete: true };
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        value += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += ESCAPES[next] ?? next;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  return { value, end: text.length, complete: false };
}

/** Skip a nested object/array (string-aware). False when the text ends inside it. */
function skipNested(text: string, start: number): number | null {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") {
      const read = readString(text, index);
      if (!read.complete) return null;
      index = read.end;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

/** The leading top-level scalar fields of a JSON object that may be cut off. */
export function leadingJsonFields(text: string): Record<string, unknown> | null {
  let index = text.indexOf("{");
  if (index < 0) return null;
  index += 1;
  const fields: Record<string, unknown> = {};
  const space = () => { while (index < text.length && /\s/.test(text[index])) index += 1; };
  while (index < text.length) {
    space();
    if (text[index] !== "\"") break;
    const key = readString(text, index);
    if (!key.complete) break;
    index = key.end;
    space();
    if (text[index] !== ":") break;
    index += 1;
    space();
    const char = text[index];
    if (char === "\"") {
      const value = readString(text, index);
      if (!value.complete) break;
      fields[key.value] = value.value;
      index = value.end;
    } else if (char === "{" || char === "[") {
      const end = skipNested(text, index);
      if (end === null) break;
      index = end;
    } else {
      const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index, index + 40))?.[0];
      if (!literal) break;
      fields[key.value] = literal === "true" ? true : literal === "false" ? false : literal === "null" ? null : Number(literal);
      index += literal.length;
    }
    space();
    if (text[index] !== ",") break;
    index += 1;
  }
  return Object.keys(fields).length ? fields : null;
}

/** Receipt objects in a tool result: whole JSON first, then a cut MCP envelope or receipt. */
function receiptsIn(raw: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || found.length >= 4) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return;
      try { visit(JSON.parse(text), depth + 1); } catch { /* cut or not JSON: handled below */ }
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 16)) visit(item, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    const bag = value as Record<string, unknown>;
    if (typeof bag.schemaVersion === "string") { found.push(bag); return; }
    if (Array.isArray(bag.content)) visit(bag.content, depth + 1);
    if (typeof bag.text === "string") visit(bag.text, depth + 1);
    if (bag.structuredContent) visit(bag.structuredContent, depth + 1);
  };
  visit(raw, 0);
  if (found.length) return found;
  // Cut result. Either the receipt itself (text-joined results) or an MCP envelope
  // whose first text block holds the receipt as an escaped string.
  const texts = [raw];
  const envelopeText = /"text"\s*:\s*"/.exec(raw);
  if (envelopeText) texts.push(readString(raw, envelopeText.index + envelopeText[0].length - 1).value);
  for (const text of texts) {
    const start = text.search(/\{\s*"schemaVersion"/);
    const fields = start >= 0 ? leadingJsonFields(text.slice(start)) : null;
    if (fields && typeof fields.schemaVersion === "string") return [fields];
  }
  return [];
}

export function toolchainSourceOf(cell: OneWorkCell): ToolchainSourceRef | null {
  if (cell.kind !== "call" || cell.status === "failed" || !cell.result || cell.result.length > MAX_RESULT_CHARS) return null;
  const tool = bareToolName(cell.toolName ?? cell.label);
  if (tool !== "one_graph_run" && tool !== "toolchain_publish") return null;
  for (const receipt of receiptsIn(cell.result)) {
    const automationId = typeof receipt.graph_id === "string" && receipt.graph_id.trim() ? receipt.graph_id.trim() : null;
    if (!automationId) continue;
    const name = typeof receipt.name === "string" && receipt.name.trim() ? receipt.name.trim().slice(0, 120) : null;
    if (tool === "one_graph_run" && receipt.schemaVersion === RUN_RECEIPT && receipt.invoked_as === "toolchain") {
      return { kind: "run", automationId, name, state: null };
    }
    if (tool === "toolchain_publish" && receipt.schemaVersion === PUBLISH_RECEIPT) {
      const state = receipt.state === "callable" || receipt.state === "draft" || receipt.state === "deprecated" ? receipt.state : null;
      return { kind: "publish", automationId, name, state };
    }
  }
  return null;
}

/** One chip per (kind, toolchain); the latest row wins, so a re-publish replaces an earlier draft. */
export function toolchainSourcesOf(cells: readonly OneWorkCell[]): ToolchainSourceRef[] {
  const sources = new Map<string, ToolchainSourceRef>();
  for (const cell of cells) {
    const source = toolchainSourceOf(cell);
    if (source) sources.set(`${source.kind}:${source.automationId}`, source);
  }
  return [...sources.values()];
}
