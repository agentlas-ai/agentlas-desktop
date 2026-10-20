// Structural identity of a saved graph: what kind of work it is, not which item it was made for.
//
// The repeated-work detector (shared/toolchain-detector.ts) recognizes a graph that keeps being rebuilt by its
// structure, never by its name. Names, prompts, code bodies, file paths and variable names change with every item
// (for example trigger→code→code→eval check graphs, each renamed per episode), so none of them is
// part of the fingerprint. What stays is the shape: the trigger kind, each step's kind, language and declared effect,
// the native tool or Toolchain it calls, and how the steps feed each other.

import { createHash } from "node:crypto";
import type { WorkflowGraph, WorkflowNode } from "./types";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** One step as structure. Instance detail (names, code, prompts, paths, refs) never appears here. */
export function graphStepToken(node: WorkflowNode): string {
  const config = (node.config ?? {}) as Record<string, unknown>;
  const effect = text(config.effect) || "-";
  if (node.type === "trigger") return `trigger:${text(config.kind) || "manual"}`;
  if (node.type === "code") {
    const packages = Array.isArray(config.packages) ? config.packages.map(text).filter(Boolean).sort() : [];
    return `code:${text(config.codeLang) || "python"}:${effect}${packages.length ? `:${packages.join("+")}` : ""}`;
  }
  if (node.type === "toolchain_call") {
    const call = (config.toolchainCall ?? {}) as Record<string, unknown>;
    return `toolchain:${text(call.toolchainId) || text(call.toolchain_id) || "?"}`;
  }
  const mcp = config.mcpCall as Record<string, unknown> | undefined;
  if (mcp && typeof mcp === "object") return `mcp:${text(mcp.catalogId) || "?"}/${text(mcp.toolName) || "?"}:${effect}`;
  // judgment-exempt: 효과·권한을 판정하지 않는다 — 반복 감지용 구조 지문에 노드 종류를 토큰으로 적을 뿐이다.
  if (node.type === "agent" || node.type === "action") {
    const needs = Array.isArray(config.needs)
      ? config.needs.map(need => text((need as Record<string, unknown>)?.capability)).filter(Boolean).sort() : [];
    return `${node.type}:${effect}${needs.length ? `:${needs.join("+")}` : ""}`;
  }
  return node.type;
}

/** Nodes in a canonical order: topological from the trigger, ties by token then saved order; loop edges ignored. */
function canonicalOrder(graph: WorkflowGraph): WorkflowNode[] {
  const nodes = graph.nodes ?? [];
  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const forward = (graph.edges ?? []).filter(edge => !edge.maxIterations && position.has(edge.source) && position.has(edge.target));
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of forward) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  const rank = (node: WorkflowNode) => `${node.type === "trigger" ? 0 : 1}\0${graphStepToken(node)}\0${String(position.get(node.id)).padStart(4, "0")}`;
  const ready = nodes.filter(node => !indegree.get(node.id));
  const ordered: WorkflowNode[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    ready.sort((a, b) => rank(a).localeCompare(rank(b)));
    const node = ready.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id); ordered.push(node);
    for (const edge of forward.filter(candidate => candidate.source === node.id)) {
      const left = (indegree.get(edge.target) ?? 0) - 1;
      indegree.set(edge.target, left);
      if (left <= 0) { const target = nodes[position.get(edge.target)!]; if (!seen.has(target.id)) ready.push(target); }
    }
  }
  // A cycle without a declared loop bound still has a stable order: append the rest in saved order.
  for (const node of nodes) if (!seen.has(node.id)) ordered.push(node);
  return ordered;
}

export interface GraphStructure {
  /** Step tokens in canonical order, trigger excluded: the runtime-independent trace the detector compares. */
  steps: string[];
  /** 24 hex characters: equal for two graphs that do the same kind of work on different items. */
  fingerprint: string;
}

export function graphStructure(graph: WorkflowGraph): GraphStructure {
  const ordered = canonicalOrder(graph);
  const index = new Map(ordered.map((node, at) => [node.id, at]));
  const producer = new Map<string, number>();
  ordered.forEach((node, at) => {
    const name = text((node.config as Record<string, unknown> | undefined)?.produces);
    if (name && !producer.has(name)) producer.set(name, at);
  });
  // Data flow as positions: "step 2 reads what step 1 made", never the variable names themselves.
  const reads = ordered.map(node => {
    const config = (node.config ?? {}) as Record<string, unknown>;
    const names = [config.consumes, config.subject, config.evidence].flat().map(text).filter(Boolean);
    return [...new Set(names.map(name => producer.get(name)).filter((at): at is number => typeof at === "number"))].sort((a, b) => a - b);
  });
  const edges = (graph.edges ?? []).filter(edge => index.has(edge.source) && index.has(edge.target))
    .map(edge => `${index.get(edge.source)}>${index.get(edge.target)}${edge.sourceHandle ? `:${edge.sourceHandle}` : ""}${edge.maxIterations ? ":loop" : ""}`)
    .sort();
  const tokens = ordered.map(graphStepToken);
  const fingerprint = createHash("sha256").update(JSON.stringify({ v: 1, tokens, reads, edges }), "utf8").digest("hex").slice(0, 24);
  return { steps: tokens.filter((_, at) => ordered[at].type !== "trigger"), fingerprint };
}
