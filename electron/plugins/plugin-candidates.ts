// Installed plugins as routing candidates — generic, manifest-driven.
//
// ★Why this exists (owner, 2026-09-23): "애초에 툴이랑 플러그인 서치도 라우팅하는거 아닌가."
// The per-turn tool judge only ever saw MCP servers. A plugin that ships skills
// (design, and every future domain pack such as an investment-analysis plugin)
// was listed as one line in the system prompt and its router was opened only on
// an explicit `@slug` — production opened the design router twice, ever.
//
// Every candidate here is built from the plugin's own manifest (slug, surface
// text, router description, workflow names, provided tool ids, optional
// keywords/capabilities). There is no per-plugin table: a new plugin becomes
// routable the moment it is installed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  autoLocalEmbedding,
  cosineSimilarity,
  lexicalOverlap,
  MODEL2VEC_HYBRID_NAME,
} from "../memory/local-embedding";

/** Judge label prefix for a skill/tool plugin — never collides with an MCP catalog id. */
export const PLUGIN_CANDIDATE_PREFIX = "plugin:";

export interface InstalledPluginCandidate {
  slug: string;
  name: string;
  /** English-first one-paragraph description shown to the resident judge. */
  description: string;
  /** Every searchable word the manifest offers (English first, then localized text). */
  searchText: string;
  hasSkills: boolean;
  /** MCP tool ids this plugin provides (dedicated plugin tools appear in the MCP catalog under these ids). */
  toolIds: string[];
  /** implicit:"never" plugins are only reachable by explicit mention. */
  implicit: "never" | "router" | "always";
  mention: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Same root the plugin router prompt reads (HOME-relative, so an isolated HOME isolates it). */
export function pluginCandidatesRoot(): string {
  return path.join(os.homedir(), ".agentlas", "plugins");
}

function str(value: unknown, max = 600): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, max) : "";
}

function strings(value: unknown, maxItems = 24, max = 200): string[] {
  return Array.isArray(value) ? value.map((item) => str(item, max)).filter(Boolean).slice(0, maxItems) : [];
}

function frontmatterDescription(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match) return "";
  const line = /^description:\s*(.*)$/mu.exec(match[1]);
  return line ? line[1].trim().replace(/^["']|["']$/gu, "") : "";
}

export function readPluginCandidate(directory: string): InstalledPluginCandidate | null {
  try {
    const manifestPath = path.join(directory, "plugin.json");
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^﻿/u, "")) as Record<string, any>;
    const slug = str(manifest.slug, 64);
    if (!SLUG.test(slug)) return null;
    const provides = manifest.provides && typeof manifest.provides === "object" ? manifest.provides : {};
    const skills = provides.skills && typeof provides.skills === "object" ? provides.skills : null;
    const tools: any[] = Array.isArray(provides.tools) ? provides.tools : [];
    const toolIds = tools.map((tool) => str(tool?.id, 128)).filter((id) => /^[a-z0-9][a-z0-9_-]{1,127}$/u.test(id));
    if (!skills && toolIds.length === 0) return null;
    let routerDescription = "";
    if (skills) {
      try {
        const routerRel = str(skills.router, 300) || "skills/index/SKILL.md";
        const routerPath = path.resolve(directory, routerRel);
        const rel = path.relative(directory, routerPath);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
          routerDescription = frontmatterDescription(fs.readFileSync(routerPath, "utf8").slice(0, 16_000));
        }
      } catch { /* A plugin without a readable router is still a tool candidate. */ }
    }
    const surface = manifest.surface && typeof manifest.surface === "object" ? manifest.surface : {};
    const workflows = skills ? strings(skills.workflows, 40, 64) : [];
    const toolText = tools.flatMap((tool) => [
      str(tool?.capability, 80),
      str(tool?.surface?.nameEn, 120) || str(tool?.surface?.name, 120),
      str(tool?.surface?.descriptionEn, 300) || str(tool?.surface?.description, 300),
    ]).filter(Boolean);
    const keywords = [...strings(manifest.keywords), ...strings(manifest.capabilities), ...strings(surface.keywords)];
    const english = [
      str(surface.displayName, 120) || str(manifest.name, 120),
      str(surface.tagline, 300),
      str(surface.description, 600) || str(manifest.description, 600),
      routerDescription,
      keywords.join(", "),
      workflows.length ? `workflows: ${workflows.join(", ")}` : "",
      toolText.join(" · "),
    ].filter(Boolean);
    const localized = [
      str(surface.displayNameKo, 120),
      str(surface.taglineKo, 300),
      str(surface.descriptionKo, 600),
      ...strings(surface.defaultPrompts, 12, 200),
    ].filter(Boolean);
    const implicitRaw = str(manifest.invocation?.implicit, 16);
    const kinds = [skills ? "skills" : "", toolIds.length ? `tools: ${toolIds.join(", ")}` : ""].filter(Boolean).join("; ");
    return {
      slug,
      name: str(surface.displayName, 120) || str(manifest.name, 120) || slug,
      description: [english.slice(1, 5).join(" — ") || english[0] || slug, kinds ? `(provides ${kinds})` : ""]
        .filter(Boolean).join(" ").slice(0, 900),
      searchText: [slug.replace(/-/gu, " "), ...english, ...localized].join("\n"),
      hasSkills: Boolean(skills),
      toolIds,
      implicit: implicitRaw === "never" || implicitRaw === "always" ? implicitRaw : "router",
      mention: str(manifest.invocation?.mention, 64) || `@${slug}`,
    };
  } catch {
    return null;
  }
}

let cache: { at: number; root: string; plugins: InstalledPluginCandidate[] } | null = null;
const CACHE_MS = 5_000;

export function listInstalledPluginCandidates(root = pluginCandidatesRoot()): InstalledPluginCandidate[] {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.at < CACHE_MS) return cache.plugins;
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  const plugins = names
    .map((name) => readPluginCandidate(path.join(root, name)))
    .filter((plugin): plugin is InstalledPluginCandidate => plugin !== null);
  cache = { at: now, root, plugins };
  return plugins;
}

export function resetPluginCandidateCache(): void {
  cache = null;
}

export function pluginCandidateId(slug: string): string {
  return `${PLUGIN_CANDIDATE_PREFIX}${slug}`;
}

export function pluginSlugFromCandidateId(id: string): string | null {
  if (!id.startsWith(PLUGIN_CANDIDATE_PREFIX)) return null;
  const slug = id.slice(PLUGIN_CANDIDATE_PREFIX.length);
  return SLUG.test(slug) ? slug : null;
}

export interface RelevanceItem {
  id: string;
  text: string;
}

export interface RelevanceHit {
  id: string;
  score: number;
  lexical: number;
  semantic: number;
}

// Calibration (local, deterministic): lexical overlap is the cosine of the
// two token sets. A genuine domain hit ("stock portfolio risk" against an
// investment/portfolio/risk description) scores ~0.12-0.35; unrelated text
// sharing only a stop-word scores < 0.06. The multilingual Model2Vec asset (when
// verified on this machine) adds cross-language recall: genuine matches score
// 0.39-0.50 on the installed catalogue, a near-miss scored 0.352 (measured
// 2026-09-23 with the pinned multilingual asset), so the floor sits at 0.38.
const LEXICAL_MIN = 0.1;
const SEMANTIC_MIN = 0.38;
const RELATIVE_FLOOR = 0.6;
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "your", "you", "are", "all",
  "any", "can", "use", "using", "make", "please", "our", "its", "it's", "was", "has", "have", "will", "not"]);

function contentTokens(text: string): string {
  return text.split(/\s+/u).filter((word) => !STOP.has(word.toLowerCase().replace(/[^a-z']/gu, ""))).join(" ");
}

/**
 * Deterministic relevance ranking used when the resident judge could not answer.
 * It never reads the network, never costs a model call, and returns only items
 * that clear an absolute floor — an unrelated task selects nothing.
 */
export function rankByLocalRelevance(query: string, items: readonly RelevanceItem[], limit = 3): RelevanceHit[] {
  const cleanQuery = contentTokens(query).slice(0, 4_000);
  if (!cleanQuery.trim() || items.length === 0) return [];
  let queryVector: number[] | null = null;
  let semanticModel = false;
  try {
    const embedding = autoLocalEmbedding(cleanQuery);
    semanticModel = embedding.model === MODEL2VEC_HYBRID_NAME;
    queryVector = semanticModel ? embedding.vector : null;
  } catch {
    queryVector = null;
  }
  const scored = items.map((item) => {
    const text = contentTokens(item.text);
    const lexical = lexicalOverlap(cleanQuery, text);
    let semantic = 0;
    if (queryVector && semanticModel) {
      try { semantic = cosineSimilarity(queryVector, autoLocalEmbedding(text).vector); } catch { semantic = 0; }
    }
    const score = Math.max(lexical >= LEXICAL_MIN ? lexical : 0, semantic >= SEMANTIC_MIN ? semantic - SEMANTIC_MIN + LEXICAL_MIN : 0);
    return { id: item.id, score, lexical, semantic };
  }).filter((hit) => hit.score > 0);
  const best = Math.max(0, ...scored.map((hit) => hit.score));
  return scored
    .filter((hit) => hit.score >= best * RELATIVE_FLOOR)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

const PLUGIN_LOOKUP_TOOL = /(resolve[_-]?plugins|tool[_-]?search|search[_-]?plugins|marketplace[_.-]?list[_-]?plugins)/iu;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Installed plugins an agent named mid-turn: returned by a plugin lookup
 * (agentlas_resolve_plugins / agentlas_tool_search) or opened through its files.
 * Structured forms only — a quoted slug, an `@mention`, or a path inside the
 * plugin folder — never a loose word in prose.
 */
export function pluginSlugsNamedInToolEvent(
  event: { name: string; args?: string; result?: string },
  installed: readonly InstalledPluginCandidate[],
): string[] {
  const text = `${event.args ?? ""}\n${event.result ?? ""}`.slice(0, 64_000);
  if (!text.trim() || installed.length === 0) return [];
  const lookup = PLUGIN_LOOKUP_TOOL.test(event.name);
  const found: string[] = [];
  for (const plugin of installed) {
    const slug = escapeRegExp(plugin.slug);
    const inFolder = new RegExp(`[\\\\/]\\.agentlas[\\\\/]plugins[\\\\/]${slug}[\\\\/]`, "u").test(text);
    const named = lookup && (
      new RegExp(`"(?:slug|plugin|id|name)"\\s*:\\s*"${slug}"`, "u").test(text)
      || new RegExp(`(^|[^\\w-])@${slug}(?![\\w-])`, "u").test(text)
      || new RegExp(`(^|[\\s,\\[(])"${slug}"(?=[\\s,\\])])`, "u").test(text));
    if (inFolder || named) found.push(plugin.slug);
  }
  return found.slice(0, 8);
}
