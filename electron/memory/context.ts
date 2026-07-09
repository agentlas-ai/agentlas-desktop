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
import { readProjectSoul, readSitemap } from "./project-files";

const SOUL_MAX_CHARS = 1800;
const MAX_ENTRIES = 12;
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
    const mapFile = path.join(projectPath, ".agentlas", "code-map", "project-map.json");
    if (!fs.existsSync(mapFile)) return null;
    const m = JSON.parse(fs.readFileSync(mapFile, "utf8")) as {
      project?: string;
      stats?: { codeFiles?: number; symbols?: number };
      modules?: { id: string; role: string }[];
      entryPoints?: { path: string }[];
      topSymbols?: { name: string; defAt: string }[];
    };
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
  const sm = readSitemap(projectPath);
  if (!sm || typeof sm !== "object") return null;
  const nodes = (sm as { nodes?: unknown[] }).nodes;
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
    const dir = path.join(projectPath, ".agentlas");
    const configFile = path.join(dir, "career-graph.json");
    const sourceManifestFile = path.join(dir, "career-graph-sources.json");
    if (!fs.existsSync(configFile)) return null;
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
      dbPath?: string;
      sourceManifest?: string;
      canonicalSourcePolicy?: { fallbackWhenStale?: string; sourceOfTruth?: string };
    };
    const dbPath = config.dbPath || path.join(dir, "career-graph.sqlite");
    const dbExists = fs.existsSync(dbPath);
    const canonical = [
      "project-soul-memory.md",
      "memory-log.jsonl",
      "curator-decisions.jsonl",
      "sitemap.json",
      "code-map/project-map.json",
      "ledgers/routing-decisions.jsonl",
      "ledgers/executions.jsonl",
      "ledgers/agent-evolution-proposals.jsonl",
    ]
      .map((rel) => `.agentlas/${rel}`)
      .filter((rel) => fs.existsSync(path.join(projectPath, rel)))
      .slice(0, CAREER_GRAPH_SOURCES);
    const manifestPath = config.sourceManifest || sourceManifestFile;
    const registered =
      fs.existsSync(manifestPath)
        ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { sources?: unknown[] }).sources
        : [];
    const lines = [
      `Career Graph: ${dbExists ? "indexed" : "configured, index pending"} (${path.relative(projectPath, dbPath) || dbPath}).`,
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
    .slice(0, MAX_ENTRIES)
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

/**
 * Returns a memory context block (or empty string). When `projectPath` is set, prefers
 * the folder's curated memory + soul + sitemap; otherwise falls back to global memory.
 */
export function buildMemoryContext(
  projectPath: string | null,
  agentId?: string | null,
): string {
  const sections: string[] = [];
  // agentId가 주어지면 per-agent 스코프(공유 + 본인 agent_repo만)로 읽어, 각 본부/전문가
  // 세션이 자기 메모리만 보게 한다. 미지정이면 기존 동작(전체) 유지(단일 에이전트 경로).
  const perAgent = agentId !== undefined;

  if (projectPath) {
    const soul = readProjectSoul(projectPath);
    if (soul && soul.trim()) {
      const trimmed =
        soul.length > SOUL_MAX_CHARS ? soul.slice(0, SOUL_MAX_CHARS) + "\n…(truncated)" : soul;
      sections.push(`### Project memory (${projectPath})\n${trimmed.trim()}`);
    }
    const sitemap = summarizeSitemap(projectPath);
    if (sitemap) sections.push(sitemap);
    const careerGraph = summarizeCareerGraph(projectPath);
    if (careerGraph) sections.push(careerGraph);
    // Code map: generate in background if missing, inject its seed if present.
    ensureCodeMap(projectPath);
    const codeMap = summarizeCodeMap(projectPath);
    if (codeMap) sections.push(codeMap);
    const entries = (
      perAgent
        ? listMemoryByPathForAgent(projectPath, agentId ?? null, MAX_ENTRIES)
        : listMemoryByPath(projectPath, MAX_ENTRIES)
    ).filter((e) => e.scope !== "session");
    if (entries.length > 0) {
      sections.push(`### Recent curated memory\n${entryLines(entries)}`);
    }
  } else {
    const entries = perAgent
      ? listGlobalMemoryForAgent(agentId ?? null, MAX_ENTRIES)
      : listGlobalMemory(MAX_ENTRIES);
    if (entries.length > 0) {
      sections.push(`### Curated memory (global)\n${entryLines(entries)}`);
    }
  }

  if (sections.length === 0) return "";
  return [
    "## Agentlas memory (read before answering; five-scope + request_context recall)",
    ...sections,
  ].join("\n\n");
}
