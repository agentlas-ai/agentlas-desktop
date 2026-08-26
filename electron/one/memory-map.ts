import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ONE_MEMORY_MAP_CONTRACT_VERSION,
  type OneMemoryMapEdge,
  type OneMemoryMapKind,
  type OneMemoryMapNode,
  type OneMemoryMapScope,
  type OneMemoryMapSnapshot,
} from "../../shared/one-memory-map";
import { getDb } from "../store/db";
import type { OneDurableMemoryEntryUi } from "../../shared/types";

import { BUILTIN_ONE_AGENT_ID as ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
const MAX_RENDERED_RELATIONS_PER_NODE = 12;
const MAX_RENDERED_RELATIONS = 40_000;

interface MemoryMapRow {
  id: string;
  scope: string;
  kind: string;
  content: string;
  project_id: string | null;
  project_path: string | null;
  evidence_json: string;
  embedding_json: string | null;
  created_at: string;
}

interface RelationRow {
  from_memory_id: string;
  to_memory_id: string;
  relation_type: "similar_to" | "supersedes" | "contradicts";
  score: number | null;
}

interface CachedMap {
  signature: string;
  snapshot: OneMemoryMapSnapshot;
}

let cachedMap: CachedMap | null = null;

function oneRoot(): string {
  return process.env.AGENTLAS_ONE_DIR || path.join(os.homedir(), ".agentlas", "one");
}

function safeFileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

function safeSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || null;
}

function normalizedContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalized || null;
}

/**
 * The durable One importer intentionally stores no raw workspace path on the
 * renderer projection. Match the local ticket content to its separately stored
 * project slug in Main, then send only that short slug across IPC.
 */
function readTicketSlugIndex(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const metadataRoot = path.join(root, ".agentlas");
  const slugPath = path.join(metadataRoot, "ticket-slugs.json");
  const ticketPath = path.join(metadataRoot, "memory-tickets.jsonl");
  try {
    const rawSlugs = JSON.parse(fs.readFileSync(slugPath, "utf8")) as Record<string, unknown>;
    const slugs = new Map<string, string>();
    for (const [ticketId, raw] of Object.entries(rawSlugs)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const slug = safeSlug((raw as Record<string, unknown>).slug);
      if (slug) slugs.set(ticketId, slug);
    }
    for (const line of fs.readFileSync(ticketPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const ticketId = typeof record.ticketId === "string" ? record.ticketId : null;
        const candidate = record.candidate && typeof record.candidate === "object" && !Array.isArray(record.candidate)
          ? record.candidate as Record<string, unknown>
          : null;
        const content = normalizedContent(candidate?.content);
        const slug = ticketId ? slugs.get(ticketId) : null;
        if (content && slug) result.set(content, slug);
      } catch {
        // One malformed historical ticket must not hide the rest of the map.
      }
    }
  } catch {
    return result;
  }
  return result;
}

function parseStringArrayCount(value: string): number {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").length : 0;
  } catch {
    return 0;
  }
}

function parseEmbedding(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    const vector = parsed.map(Number);
    return vector.every(Number.isFinite) ? vector : null;
  } catch {
    return null;
  }
}

function vectorNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function normalizeVector(vector: number[]): number[] | null {
  const norm = vectorNorm(vector);
  if (!Number.isFinite(norm) || norm < 1e-10) return null;
  return vector.map((value) => value / norm);
}

function covarianceProduct(centered: number[][], vector: number[]): number[] {
  const output = new Array<number>(vector.length).fill(0);
  for (const row of centered) {
    let score = 0;
    for (let index = 0; index < vector.length; index += 1) score += row[index] * vector[index];
    for (let index = 0; index < vector.length; index += 1) output[index] += row[index] * score;
  }
  return output;
}

function principalDirection(centered: number[][], seed: number, orthogonalTo?: number[]): number[] | null {
  const dimensions = centered[0]?.length ?? 0;
  if (dimensions === 0) return null;
  let vector = normalizeVector(Array.from(
    { length: dimensions },
    (_value, index) => Math.sin((index + 1) * seed) + Math.cos((index + 1) * (seed + 0.37)),
  ));
  if (!vector) return null;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let next = covarianceProduct(centered, vector);
    if (orthogonalTo) {
      const overlap = next.reduce((sum, value, index) => sum + value * orthogonalTo[index], 0);
      next = next.map((value, index) => value - overlap * orthogonalTo[index]);
    }
    const normalized = normalizeVector(next);
    if (!normalized) return null;
    vector = normalized;
  }
  return vector;
}

function robustUnit(values: number[]): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) * 0.03)];
  const high = sorted[Math.ceil((sorted.length - 1) * 0.97)];
  const range = high - low;
  if (!Number.isFinite(range) || range < 1e-9) return values.map(() => 0.5);
  return values.map((value) => Math.max(0, Math.min(1, (value - low) / range)));
}

function hashUnit(value: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 0xffffffff;
}

/** Deterministic 2D PCA over the existing local embedding vectors. */
export function projectMemoryEmbeddings(
  rows: Array<{ id: string; embedding: number[] | null }>,
): Map<string, { x: number; y: number }> {
  const dimensionCounts = new Map<number, number>();
  for (const row of rows) {
    if (row.embedding) dimensionCounts.set(row.embedding.length, (dimensionCounts.get(row.embedding.length) ?? 0) + 1);
  }
  const dimensions = [...dimensionCounts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  const valid = rows.filter((row): row is { id: string; embedding: number[] } => Boolean(row.embedding?.length === dimensions));
  const projected = new Map<string, { x: number; y: number }>();
  if (valid.length >= 2 && dimensions >= 2) {
    const means = new Array<number>(dimensions).fill(0);
    for (const { embedding } of valid) {
      for (let index = 0; index < dimensions; index += 1) means[index] += embedding[index] / valid.length;
    }
    const centered = valid.map(({ embedding }) => embedding.map((value, index) => value - means[index]));
    const first = principalDirection(centered, 0.73);
    const second = first ? principalDirection(centered, 1.91, first) : null;
    if (first && second) {
      const rawX = centered.map((row) => row.reduce((sum, value, index) => sum + value * first[index], 0));
      const rawY = centered.map((row) => row.reduce((sum, value, index) => sum + value * second[index], 0));
      const x = robustUnit(rawX);
      const y = robustUnit(rawY);
      valid.forEach((row, index) => projected.set(row.id, { x: x[index], y: y[index] }));
    }
  }
  for (const row of rows) {
    if (projected.has(row.id)) continue;
    projected.set(row.id, { x: hashUnit(row.id, 17), y: hashUnit(row.id, 97) });
  }
  return projected;
}

function normalizeKind(value: string): OneMemoryMapKind {
  const kinds: readonly string[] = [
    "fact", "decision", "preference", "risk", "procedure",
    "hypothesis", "evidence", "deprecation", "conflict",
  ];
  return (kinds.includes(value) ? value : "hypothesis") as OneMemoryMapKind;
}

function normalizeScope(value: string): OneMemoryMapScope {
  const scopes: readonly string[] = ["user_identity", "team_memory", "agent_repo", "agent_team", "project", "session"];
  return (scopes.includes(value) ? value : "agent_repo") as OneMemoryMapScope;
}

function readRelations(): RelationRow[] {
  try {
    return getDb().prepare(
      `SELECT relation.from_memory_id, relation.to_memory_id, relation.relation_type, relation.score
       FROM memory_relation_edges relation
       JOIN memory_entries source ON source.id = relation.from_memory_id
       JOIN memory_entries target ON target.id = relation.to_memory_id
       WHERE source.agent_id = ? AND target.agent_id = ?
         AND source.superseded_at IS NULL AND target.superseded_at IS NULL`,
    ).all(ONE_AGENT_ID, ONE_AGENT_ID) as RelationRow[];
  } catch {
    return [];
  }
}

function mapSignature(root: string): string {
  const summary = getDb().prepare(
    `SELECT COUNT(*) AS count, MAX(created_at) AS newest,
            COALESCE(SUM(LENGTH(COALESCE(embedding_json, ''))), 0) AS embedding_bytes
     FROM memory_entries WHERE agent_id = ? AND superseded_at IS NULL`,
  ).get(ONE_AGENT_ID) as { count: number; newest: string | null; embedding_bytes: number };
  let relationSummary = "none";
  try {
    const value = getDb().prepare(
      `SELECT COUNT(*) AS count, MAX(relation.created_at) AS newest
       FROM memory_relation_edges relation
       JOIN memory_entries source ON source.id = relation.from_memory_id
       JOIN memory_entries target ON target.id = relation.to_memory_id
       WHERE source.agent_id = ? AND target.agent_id = ?
         AND source.superseded_at IS NULL AND target.superseded_at IS NULL`,
    ).get(ONE_AGENT_ID, ONE_AGENT_ID) as { count: number; newest: string | null };
    relationSummary = `${value.count}:${value.newest ?? "none"}`;
  } catch {
    // Older stores can still render nodes before the relation migration exists.
  }
  const metadataRoot = path.join(root, ".agentlas");
  const raw = [
    summary.count,
    summary.newest ?? "none",
    summary.embedding_bytes,
    relationSummary,
    safeFileSignature(path.join(metadataRoot, "ticket-slugs.json")),
    safeFileSignature(path.join(metadataRoot, "memory-tickets.jsonl")),
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function rendererEdges(relations: RelationRow[]): OneMemoryMapEdge[] {
  const degree = new Map<string, number>();
  const result: OneMemoryMapEdge[] = [];
  const sorted = [...relations].sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
  for (const row of sorted) {
    if (result.length >= MAX_RENDERED_RELATIONS) break;
    if ((degree.get(row.from_memory_id) ?? 0) >= MAX_RENDERED_RELATIONS_PER_NODE) continue;
    if ((degree.get(row.to_memory_id) ?? 0) >= MAX_RENDERED_RELATIONS_PER_NODE) continue;
    result.push({
      from: row.from_memory_id,
      to: row.to_memory_id,
      relation: row.relation_type,
      score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
    });
    degree.set(row.from_memory_id, (degree.get(row.from_memory_id) ?? 0) + 1);
    degree.set(row.to_memory_id, (degree.get(row.to_memory_id) ?? 0) + 1);
  }
  return result;
}

/** Main-owned, read-only projection of One's actual durable memory graph. */
export function getOneMemoryMap(): OneMemoryMapSnapshot {
  const root = oneRoot();
  const signature = mapSignature(root);
  if (cachedMap?.signature === signature) return cachedMap.snapshot;

  const rows = getDb().prepare(
    `SELECT id, scope, kind, content, project_id, project_path, evidence_json,
            embedding_json, created_at
     FROM memory_entries
     WHERE agent_id = ? AND superseded_at IS NULL
     ORDER BY created_at ASC, id ASC`,
  ).all(ONE_AGENT_ID) as MemoryMapRow[];
  const ticketSlugs = readTicketSlugIndex(root);
  const positions = projectMemoryEmbeddings(rows.map((row) => ({ id: row.id, embedding: parseEmbedding(row.embedding_json) })));
  const relations = readRelations();
  const relationCounts = new Map<string, number>();
  const relationWeights = new Map<string, number>();
  for (const relation of relations) {
    const weight = relation.relation_type === "similar_to"
      ? Math.max(0.05, relation.score ?? 0.5)
      : 1;
    for (const id of [relation.from_memory_id, relation.to_memory_id]) {
      relationCounts.set(id, (relationCounts.get(id) ?? 0) + 1);
      relationWeights.set(id, (relationWeights.get(id) ?? 0) + weight);
    }
  }
  const weighted = rows.map((row) => relationWeights.get(row.id) ?? 0);
  const positive = weighted.filter((value) => value > 0).sort((a, b) => a - b);
  const densityCeiling = positive[Math.floor(Math.max(0, positive.length - 1) * 0.94)] ?? 1;

  const nodes: OneMemoryMapNode[] = rows.map((row) => {
    const normalized = normalizedContent(row.content);
    const pathSlug = row.project_path ? safeSlug(path.basename(row.project_path)) : null;
    const projectSlug = (normalized ? ticketSlugs.get(normalized) : null) ?? pathSlug;
    const position = positions.get(row.id) ?? { x: 0.5, y: 0.5 };
    const density = Math.min(1, (relationWeights.get(row.id) ?? 0) / Math.max(0.001, densityCeiling));
    return {
      id: row.id,
      kind: normalizeKind(row.kind),
      scope: normalizeScope(row.scope),
      projectSlug: projectSlug ?? null,
      x: position.x,
      y: position.y,
      density,
      relationCount: relationCounts.get(row.id) ?? 0,
      evidenceCount: parseStringArrayCount(row.evidence_json),
    };
  });
  const clusterCount = new Set(nodes.map((node) => node.projectSlug ?? `one-${node.kind}`)).size;
  const snapshot: OneMemoryMapSnapshot = {
    contractVersion: ONE_MEMORY_MAP_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    sourceRevision: signature,
    nodes,
    edges: rendererEdges(relations),
    clusterCount,
  };
  cachedMap = { signature, snapshot };
  return snapshot;
}

/**
 * The rows behind the map, listed. Same table, same filter (One's live entries),
 * so the count in the sheet equals the node count on the map. Content is bounded
 * and control characters stripped; only the project folder's basename travels.
 */
export function listOneDurableMemoryEntries(limit = 300): OneDurableMemoryEntryUi[] {
  const capped = Math.min(1_000, Math.max(1, Math.floor(limit) || 300));
  const rows = getDb().prepare(
    `SELECT id, scope, kind, content, project_path, evidence_json, created_at
     FROM memory_entries
     WHERE agent_id = ? AND superseded_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(ONE_AGENT_ID, capped) as Array<{
    id: string; scope: string; kind: string; content: string; project_path: string | null; evidence_json: string; created_at: string;
  }>;
  return rows.map((row) => {
    let evidenceCount = 0;
    try {
      const evidence = JSON.parse(row.evidence_json || "[]");
      evidenceCount = Array.isArray(evidence) ? evidence.length : 0;
    } catch {
      evidenceCount = 0;
    }
    const content = String(row.content ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
    return {
      id: row.id,
      kind: row.kind,
      scope: row.scope,
      content: content.length > 600 ? `${content.slice(0, 599)}…` : content,
      projectSlug: row.project_path ? safeSlug(path.basename(row.project_path)) : null,
      evidenceCount,
      createdAt: row.created_at,
    };
  });
}

/** "잊기": supersede one of One's live entries. Non-destructive (history stays); the map drops the node. */
export function forgetOneDurableMemoryEntry(memoryId: string): { ok: boolean; memoryId: string; forgottenAt: string | null } {
  const id = typeof memoryId === "string" ? memoryId.trim() : "";
  if (!id) return { ok: false, memoryId: "", forgottenAt: null };
  const now = new Date().toISOString();
  const result = getDb().prepare(
    "UPDATE memory_entries SET superseded_at = ? WHERE id = ? AND agent_id = ? AND superseded_at IS NULL",
  ).run(now, id, ONE_AGENT_ID);
  if (result.changes > 0) cachedMap = null;
  return { ok: result.changes > 0, memoryId: id, forgottenAt: result.changes > 0 ? now : null };
}
