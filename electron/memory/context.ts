// Builds the memory context injected into the system prompt before a run.
// Kept compact (token-bounded) on purpose — it runs on every turn.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  listGlobalMemory,
  listGlobalMemoryForAgent,
  listMemoryByPath,
  listMemoryByPathForAgent,
  type MemoryEntry,
} from "./store";
import { verifyActivatedFolderIdentity } from "../architecture/activation";
import {
  CAREER_GRAPH_CONFIG_FILE,
  CAREER_GRAPH_DB_FILE,
  CAREER_GRAPH_SOURCE_MANIFEST_FILE,
  CURATOR_DECISIONS_FILE,
  MEMORY_LOG_FILE,
  PROJECT_SOUL_FILE,
  SITEMAP_FILE,
} from "../architecture/manifest";
import {
  activatedProjectMemoryFileExists,
  PROJECT_CODE_MAP_MAX_BYTES,
  readActivatedProjectMemoryJson,
  readActivatedProjectMemoryText,
} from "./safe-project-read";
import { localEmbeddingTokens, rankHybridLocal } from "./local-embedding";

const SOUL_MAX_CHARS = 1800;
const MAX_ENTRIES = 12;
// SQLite LIMIT -1 means no pre-ranking recency cap. Governance filters still
// run in SQL; adaptive load-all/top-k is decided only after every eligible row
// has received lexical/vector evidence.
const MEMORY_CANDIDATE_LIMIT = -1;
export const MEMORY_SELECTED_MAX_APPROX_TOKENS = 800;
const CONTEXT_MAX_CHARS = 180;

// ── Code map (RECALL layer) ────────────────────────────────────────────────
// Lets the agent locate code without scanning source. The map is generated in
// the background on first project attach; here we only read its compact seed.
const CODEMAP_MODULES = 8;
const CODEMAP_ENTRIES = 4;
const CODEMAP_SYMBOLS = 6;
const CAREER_GRAPH_SOURCES = 6;
const codeMapTriggered = new Set<string>();

function codeMapGenPath(): string | null {
  const cands = [
    path.join(__dirname, "code-map-gen.mjs"),
    path.join(__dirname, "..", "..", "..", "electron", "memory", "code-map-gen.mjs"),
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Best-effort, non-blocking: generate the map once per project per session if missing.
function ensureCodeMap(projectPath: string): void {
  try {
    const mapFile = path.join(projectPath, ".agentlas", "code-map", "project-map.json");
    if (fs.existsSync(mapFile)) return;
    if (codeMapTriggered.has(projectPath)) return;
    const gen = codeMapGenPath();
    if (!gen) return;
    codeMapTriggered.add(projectPath);
    const child = spawn(process.execPath, [gen, projectPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.unref();
  } catch {
    /* never block a turn on map generation */
  }
}

function summarizeCodeMap(projectPath: string): string | null {
  try {
    const m = readActivatedProjectMemoryJson<{
      project?: string;
      stats?: { codeFiles?: number; symbols?: number };
      modules?: { id: string; role: string }[];
      entryPoints?: { path: string }[];
      topSymbols?: { name: string; defAt: string }[];
    }>(projectPath, "code-map/project-map.json", PROJECT_CODE_MAP_MAX_BYTES);
    if (!m) return null;
    const mods = (m.modules ?? [])
      .slice(0, CODEMAP_MODULES)
      .map((x) => `${x.id}(${x.role})`)
      .join(", ");
    const eps = (m.entryPoints ?? [])
      .slice(0, CODEMAP_ENTRIES)
      .map((e) => e.path)
      .join(", ");
    const tops = (m.topSymbols ?? [])
      .slice(0, CODEMAP_SYMBOLS)
      .map((s) => `${s.name} → ${s.defAt}`)
      .join(", ");
    const lines = [
      `### Code map (${m.project ?? "project"} · ${m.stats?.codeFiles ?? "?"} code files, ${m.stats?.symbols ?? "?"} symbols)`,
      `To locate code, do NOT scan source first — query the map index instead of grepping the tree.`,
    ];
    if (mods) lines.push(`Modules: ${mods}`);
    if (eps) lines.push(`Entry points: ${eps}`);
    if (tops) lines.push(`Most-referenced: ${tops}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

function summarizeSitemap(projectPath: string): string | null {
  const sm = readActivatedProjectMemoryJson<{ nodes?: unknown[] }>(projectPath, SITEMAP_FILE);
  if (!sm || typeof sm !== "object") return null;
  const nodes = sm.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const byStatus: Record<string, number> = {};
  for (const n of nodes) {
    const status = (n as { status?: string }).status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  const parts = Object.entries(byStatus).map(([s, n]) => `${s}:${n}`);
  return `AI Sitemap: ${nodes.length} nodes (${parts.join(", ")}).`;
}

function summarizeCareerGraph(projectPath: string): string | null {
  try {
    const config = readActivatedProjectMemoryJson<{
      canonicalSourcePolicy?: { fallbackWhenStale?: string; sourceOfTruth?: string };
    }>(projectPath, CAREER_GRAPH_CONFIG_FILE);
    if (!config) return null;
    const dbExists = activatedProjectMemoryFileExists(projectPath, CAREER_GRAPH_DB_FILE);
    const canonical = [
      PROJECT_SOUL_FILE,
      MEMORY_LOG_FILE,
      CURATOR_DECISIONS_FILE,
      SITEMAP_FILE,
      "code-map/project-map.json",
      "ledgers/routing-decisions.jsonl",
      "ledgers/executions.jsonl",
      "ledgers/agent-evolution-proposals.jsonl",
    ]
      .map((rel) => `.agentlas/${rel}`)
      .filter((rel) => activatedProjectMemoryFileExists(projectPath, rel.slice(".agentlas/".length)))
      .slice(0, CAREER_GRAPH_SOURCES);
    const registered = readActivatedProjectMemoryJson<{ sources?: unknown[] }>(
      projectPath,
      CAREER_GRAPH_SOURCE_MANIFEST_FILE,
    )?.sources ?? [];
    const lines = [
      `Career Graph: ${dbExists ? "indexed" : "configured, index pending"} (.agentlas/${CAREER_GRAPH_DB_FILE}).`,
      "Use it as a source-routing layer: prefer the listed canonical files before broad repo scans.",
    ];
    if (canonical.length) lines.push(`Canonical source refs: ${canonical.join(", ")}`);
    if (Array.isArray(registered) && registered.length > 0) {
      lines.push(`Registered source refs: ${registered.length} additional source(s).`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function entryLines(entries: MemoryEntry[]): string {
  return entries
    .map((e) => {
      const ctx = e.requestContext;
      const parts = [
        ctx?.userIntent,
        ctx?.targetProject ? `target:${ctx.targetProject}` : null,
        ctx?.triggerTerms && ctx.triggerTerms.length > 0 ? `terms:${ctx.triggerTerms.join(",")}` : null,
      ].filter(Boolean);
      const suffix =
        parts.length > 0
          ? ` (context: ${parts.join("; ").slice(0, CONTEXT_MAX_CHARS)})`
          : "";
      return `- [${e.kind}] ${e.content}${suffix}`;
    })
    .join("\n");
}

function approximateMemoryTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function confidencePrior(confidence: MemoryEntry["confidence"]): number {
  return confidence === "high" ? 1 : confidence === "medium" ? 0.6 : 0.2;
}

/** Scope/agent filtering happens in SQL before this ranking function. */
function selectMemoryEntries(entries: MemoryEntry[], taskPrompt?: string): MemoryEntry[] {
  const query = String(taskPrompt ?? "").trim();
  if (!query || localEmbeddingTokens(query).length === 0) return entries.slice(0, MAX_ENTRIES);
  const ranked = rankHybridLocal(query, entries.map((entry) => ({
    id: entry.id,
    text: [
      entry.content,
      entry.kind,
      entry.requestContext?.userIntent ?? "",
      ...(entry.requestContext?.triggerTerms ?? []),
    ].join(" "),
    embedding: entry.embedding.vector,
    prior: confidencePrior(entry.confidence),
    entry,
  }))).filter((result) =>
    result.lexicalScore > 0 || result.semanticEligible || result.item.entry.scope === "user_identity");
  if (ranked.length === 0) return [];
  const all = ranked.map((result) => result.item.entry);
  const allText = entryLines(all);
  if (approximateMemoryTokens(allText) <= MEMORY_SELECTED_MAX_APPROX_TOKENS) return all;
  const selected: MemoryEntry[] = [];
  for (const result of ranked) {
    if (selected.length >= MAX_ENTRIES) break;
    const proposed = entryLines([...selected, result.item.entry]);
    if (approximateMemoryTokens(proposed) > MEMORY_SELECTED_MAX_APPROX_TOKENS) continue;
    selected.push(result.item.entry);
  }
  return selected;
}

function globalMemorySections(perAgent: boolean, agentId?: string | null, taskPrompt?: string): string[] {
  const entries = perAgent
    ? listGlobalMemoryForAgent(agentId ?? null, MEMORY_CANDIDATE_LIMIT)
    : listGlobalMemory(MEMORY_CANDIDATE_LIMIT);
  const selected = selectMemoryEntries(entries, taskPrompt);
  return selected.length > 0
    ? [`### Curated memory (global)\n${entryLines(selected)}`]
    : [];
}

function formatMemorySections(sections: string[]): string {
  if (sections.length === 0) return "";
  return [
    "## Agentlas memory (read before answering; five-scope + request_context recall)",
    ...sections,
  ].join("\n\n");
}

/**
 * Returns a memory context block (or empty string). When `projectPath` is set, prefers
 * the folder's curated memory + soul + sitemap; otherwise falls back to global memory.
 */
export function buildMemoryContext(
  projectPath: string | null,
  agentId?: string | null,
  options: { materializeCodeMap?: boolean; taskPrompt?: string } = {},
): string {
  const sections: string[] = [];
  // agentId가 주어지면 per-agent 스코프(공유 + 본인 agent_repo만)로 읽어, 각 본부/전문가
  // 세션이 자기 메모리만 보게 한다. 미지정이면 기존 동작(전체) 유지(단일 에이전트 경로).
  const perAgent = agentId !== undefined;

  if (projectPath) {
    // The caller's boolean authorization is not a durable capability. Verify
    // the stored folder identity again immediately before touching any project
    // memory, and once more before returning the assembled prompt.
    if (!verifyActivatedFolderIdentity(projectPath)) {
      return formatMemorySections(globalMemorySections(perAgent, agentId, options.taskPrompt));
    }
    const soul = readActivatedProjectMemoryText(projectPath, PROJECT_SOUL_FILE);
    if (soul && soul.trim()) {
      const trimmed =
        soul.length > SOUL_MAX_CHARS ? soul.slice(0, SOUL_MAX_CHARS) + "\n…(truncated)" : soul;
      sections.push(`### Project memory (${projectPath})\n${trimmed.trim()}`);
    }
    const sitemap = summarizeSitemap(projectPath);
    if (sitemap) sections.push(sitemap);
    const careerGraph = summarizeCareerGraph(projectPath);
    if (careerGraph) sections.push(careerGraph);
    // Read-only Desktop turns may consume an existing map but must not spawn a
    // generator or create project-local state merely by asking a question.
    if (options.materializeCodeMap !== false) ensureCodeMap(projectPath);
    const codeMap = summarizeCodeMap(projectPath);
    if (codeMap) sections.push(codeMap);
    const entries = (
      perAgent
        ? listMemoryByPathForAgent(projectPath, agentId ?? null, MEMORY_CANDIDATE_LIMIT)
        : listMemoryByPath(projectPath, MEMORY_CANDIDATE_LIMIT)
    ).filter((e) => e.scope !== "session");
    const selectedEntries = selectMemoryEntries(entries, options.taskPrompt);
    if (selectedEntries.length > 0) {
      sections.push(`### Relevant curated memory\n${entryLines(selectedEntries)}`);
    }
    if (!verifyActivatedFolderIdentity(projectPath)) {
      return formatMemorySections(globalMemorySections(perAgent, agentId, options.taskPrompt));
    }
  } else {
    sections.push(...globalMemorySections(perAgent, agentId, options.taskPrompt));
  }

  return formatMemorySections(sections);
}
