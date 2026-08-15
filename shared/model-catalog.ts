// 4-tier model catalog — pure merge/resolve logic shared by main and tests
// (PRD 2026-08-15 D-4). No I/O here: the layers are handed in.
//
//   ① snapshot  — bundled, trimmed models.dev copy (offline first run)
//   ② remote    — models.dev refreshed with a TTL; stale copy kept on failure
//   ③ probe     — what the runtime actually reported (entitlement-filtered)
//   ④ override  — ~/.agentlas/model-overrides.json (user wins)
//
// Two questions, two answers, ONE merged table (aider #3184 lesson: enumeration
// and resolution must read the same result):
//   enumerate(provider) → the models this machine can select right now
//                        (probe/override rows; the universe is not a menu)
//   resolve(provider,id) → capabilities for a model id, from any layer, with
//                        `<base>-<effort>` decomposition (agy ids fuse the
//                        reasoning effort into the id: gemini-3.7-flash-high)
//
// This table never decides *access path* (subscription CLI vs API vs local) —
// that is the runtime registry's job — and never invents a capability: a field
// that no layer knows stays undefined.

export type CatalogSource = "snapshot" | "remote" | "probe" | "override";

export interface CatalogModel {
  /** models.dev provider id (anthropic, openai, google, xai, moonshotai, …) or a runtime id for probes */
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  toolCall?: boolean;
  reasoning?: boolean;
  /** Open strings (codex/OpenRouter style), NOT an enum: low/medium/high/xhigh/max/minimal/none… */
  reasoningEfforts?: string[];
  inputModalities?: string[];
  cost?: { input?: number; output?: number };
  releaseDate?: string;
  /** Layer that supplied the row (after merge: the highest layer that mentioned it) */
  source?: CatalogSource;
  /** Probe/override rows: is the model selectable on this machine right now */
  available?: boolean;
}

export interface CatalogSnapshot {
  schemaVersion: "agentlas.model-catalog-snapshot.v1";
  generatedAt: string;
  source: string;
  attribution: string;
  upstream?: { providers: number; models: number };
  providers: Array<{ id: string; name: string }>;
  models: CatalogModel[];
}

export interface CatalogLayers {
  snapshot?: CatalogModel[];
  remote?: CatalogModel[];
  probe?: CatalogModel[];
  override?: CatalogModel[];
}

export interface MergedCatalog {
  /** provider -> id -> merged row */
  byProvider: Map<string, Map<string, CatalogModel>>;
  /** layers that actually contributed rows */
  layers: CatalogSource[];
}

const LAYER_ORDER: CatalogSource[] = ["snapshot", "remote", "probe", "override"];

/** Effort tokens accepted as an id suffix when the base exists in the catalog. */
export const KNOWN_EFFORT_SUFFIXES = ["minimal", "none", "low", "medium", "high", "xhigh", "max"] as const;

function key(provider: string, id: string): string {
  return provider.trim().toLowerCase() + "\u0000" + id.trim();
}

function mergeRow(base: CatalogModel | undefined, next: CatalogModel, source: CatalogSource): CatalogModel {
  const out: CatalogModel = { ...(base ?? { provider: next.provider, id: next.id }) };
  for (const [k, v] of Object.entries(next) as Array<[keyof CatalogModel, unknown]>) {
    if (v === undefined || v === null) continue;
    if (k === "source" || k === "available") continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  out.source = source;
  if (source === "probe" || source === "override") {
    out.available = next.available === undefined ? true : Boolean(next.available);
  }
  return out;
}

/** Merge four layers; later layers override field-by-field. */
export function mergeCatalog(layers: CatalogLayers): MergedCatalog {
  const byProvider = new Map<string, Map<string, CatalogModel>>();
  const used: CatalogSource[] = [];
  const flat = new Map<string, CatalogModel>();
  for (const source of LAYER_ORDER) {
    const rows = layers[source];
    if (!rows || rows.length === 0) continue;
    used.push(source);
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || typeof row.provider !== "string") continue;
      const k = key(row.provider, row.id);
      flat.set(k, mergeRow(flat.get(k), row, source));
    }
  }
  for (const row of flat.values()) {
    const p = row.provider.trim().toLowerCase();
    if (!byProvider.has(p)) byProvider.set(p, new Map());
    byProvider.get(p)!.set(row.id, row);
  }
  return { byProvider, layers: used };
}

/**
 * `gemini-3.7-flash-high` → { base: "gemini-3.7-flash", effort: "high" } when the
 * base exists for the provider and the suffix is a known effort (or one the base
 * itself advertises). Returns null when the id is not decomposable.
 */
export function decomposeEffortSuffix(
  catalog: MergedCatalog,
  provider: string,
  id: string,
): { base: CatalogModel; effort: string } | null {
  const table = catalog.byProvider.get(provider.trim().toLowerCase());
  if (!table) return null;
  const dash = id.lastIndexOf("-");
  if (dash <= 0) return null;
  const baseId = id.slice(0, dash);
  const effort = id.slice(dash + 1).toLowerCase();
  const base = table.get(baseId);
  if (!base) return null;
  const advertised = (base.reasoningEfforts ?? []).map((e) => e.toLowerCase());
  if (advertised.includes(effort) || (KNOWN_EFFORT_SUFFIXES as readonly string[]).includes(effort)) {
    return { base, effort };
  }
  return null;
}

/** Exact row, else the effort-decomposed base row (with the effort attached). */
export function resolveModel(
  catalog: MergedCatalog,
  provider: string,
  id: string | null | undefined,
): (CatalogModel & { effort?: string }) | undefined {
  if (!id) return undefined;
  const table = catalog.byProvider.get(provider.trim().toLowerCase());
  const exact = table?.get(id.trim());
  if (exact) return exact;
  const decomposed = decomposeEffortSuffix(catalog, provider, id.trim());
  if (decomposed) return { ...decomposed.base, id: id.trim(), effort: decomposed.effort };
  return undefined;
}

/** Selectable models for a provider — probe/override rows only, in insertion order. */
export function enumerateModels(catalog: MergedCatalog, provider: string): CatalogModel[] {
  const table = catalog.byProvider.get(provider.trim().toLowerCase());
  if (!table) return [];
  return [...table.values()].filter((row) => row.available === true);
}

/** Context window from the merged table (exact or via decomposition); undefined if nobody knows. */
export function contextWindowFor(catalog: MergedCatalog, provider: string, id: string | null | undefined): number | undefined {
  return resolveModel(catalog, provider, id)?.contextWindow;
}

/** Map an Agentlas backend/runtime to the models.dev provider ids to consult, in priority order. */
export const PROVIDER_ALIASES: Record<string, string[]> = {
  anthropic: ["anthropic"],
  openai: ["openai"],
  google: ["google"],
  xai: ["xai"],
  deepseek: ["deepseek"],
  kimi: ["moonshotai", "kimi-for-coding"],
  glm: ["zai", "zai-coding-plan"],
  minimax: ["minimax"],
  upstage: ["upstage"],
  openrouter: ["openrouter"],
  // CLI runtimes proxy vendors (runtime registry vendors[])
  "claude-code": ["anthropic"],
  codex: ["openai"],
  antigravity: ["google", "anthropic", "openai"],
  grok: ["xai"],
  cursor: ["anthropic", "openai", "google"],
  gemini: ["google"],
};

/** Resolve across every provider alias of a backend/runtime; first hit wins. */
export function resolveForBackend(catalog: MergedCatalog, backendOrRuntime: string, id: string | null | undefined) {
  const providers = PROVIDER_ALIASES[backendOrRuntime] ?? [backendOrRuntime];
  for (const provider of providers) {
    const hit = resolveModel(catalog, provider, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Turn a models.dev api.json object into catalog rows (used by the remote layer). */
export function rowsFromModelsDev(api: unknown, providers?: readonly string[]): CatalogModel[] {
  if (!api || typeof api !== "object") return [];
  const rows: CatalogModel[] = [];
  for (const [providerId, provider] of Object.entries(api as Record<string, any>)) {
    if (providers && !providers.includes(providerId)) continue;
    const models = provider && typeof provider === "object" ? provider.models : null;
    if (!models || typeof models !== "object") continue;
    for (const model of Object.values(models as Record<string, any>)) {
      if (!model || typeof model.id !== "string") continue;
      const efforts = Array.isArray(model.reasoning_options)
        ? model.reasoning_options
            .filter((o: any) => o && o.type === "effort" && Array.isArray(o.values))
            .flatMap((o: any) => o.values.map(String))
        : [];
      rows.push({
        provider: providerId,
        id: model.id,
        ...(model.name ? { name: String(model.name) } : {}),
        ...(model.limit && Number.isFinite(model.limit.context) ? { contextWindow: Number(model.limit.context) } : {}),
        ...(model.limit && Number.isFinite(model.limit.output) ? { maxOutput: Number(model.limit.output) } : {}),
        ...(typeof model.tool_call === "boolean" ? { toolCall: model.tool_call } : {}),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        ...(efforts.length ? { reasoningEfforts: [...new Set(efforts as string[])] } : {}),
        ...(model.modalities && Array.isArray(model.modalities.input) ? { inputModalities: model.modalities.input.map(String) } : {}),
        ...(model.release_date ? { releaseDate: String(model.release_date) } : {}),
      });
    }
  }
  return rows;
}
