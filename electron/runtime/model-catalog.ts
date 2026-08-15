// Main-process model catalog: assembles the four layers and wires the
// context-window resolver into shared/models.ts (PRD 2026-08-15 D-4).
//
//   ① snapshot  shared/model-catalog.snapshot.ts (generated, offline)
//   ② remote    models.dev refreshed with TTL 24h → <userData>/model-catalog.remote.json
//               (User-Agent required; a failed refresh keeps the stale copy)
//   ③ probe     rows pushed by runtime discovery (registerProbeModels)
//   ④ override  ~/.agentlas/model-overrides.json  { "models": [ {provider,id,contextWindow,...} ] }
//
// Enumeration and resolution both read getModelCatalog() — one merged table.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergeCatalog,
  resolveForBackend,
  rowsFromModelsDev,
  type CatalogModel,
  type MergedCatalog,
} from "../../shared/model-catalog";
import { MODEL_CATALOG_SNAPSHOT } from "../../shared/model-catalog.snapshot";
import { setContextWindowResolver } from "../../shared/models";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const REMOTE_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "agentlas-desktop/1.0 (+https://agentlas.ai)";

interface RemoteCache {
  fetchedAt: string;
  etag?: string;
  rows: CatalogModel[];
}

let probeRows = new Map<string, CatalogModel[]>();
let remoteCache: RemoteCache | null | undefined;
let overrideRows: CatalogModel[] | null | undefined;
let merged: MergedCatalog | null = null;

function invalidate(): void {
  merged = null;
}

export function modelCatalogRemotePath(): string {
  const override = process.env.AGENTLAS_MODEL_CATALOG_REMOTE_PATH?.trim();
  if (override) return override;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { getPath?: (name: string) => string; isPackaged?: boolean } };
    // Dev/QA instances stay out of the live userData (see model-discovery-store.ts).
    const userData = electron?.app?.isPackaged ? electron.app.getPath?.("userData") : undefined;
    if (userData) return path.join(userData, "model-catalog.remote.json");
  } catch {
    /* plain node */
  }
  return path.join(os.tmpdir(), "agentlas-model-catalog.remote.json");
}

export function modelOverridesPath(): string {
  return process.env.AGENTLAS_MODEL_OVERRIDES_PATH?.trim() || path.join(os.homedir(), ".agentlas", "model-overrides.json");
}

function readRemoteCache(): RemoteCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCatalogRemotePath(), "utf8")) as RemoteCache;
    if (parsed && Array.isArray(parsed.rows) && typeof parsed.fetchedAt === "string") return parsed;
  } catch {
    /* none yet */
  }
  return null;
}

function readOverrides(): CatalogModel[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelOverridesPath(), "utf8")) as { models?: unknown };
    if (!parsed || !Array.isArray(parsed.models)) return [];
    return parsed.models
      .filter((m): m is CatalogModel => !!m && typeof (m as CatalogModel).id === "string" && typeof (m as CatalogModel).provider === "string")
      .map((m) => ({ ...m, available: m.available === undefined ? true : Boolean(m.available) }));
  } catch {
    return [];
  }
}

/** Runtime discovery pushes what a runtime actually offers (entitlement view). */
export function registerProbeModels(provider: string, models: readonly string[], extra?: Partial<CatalogModel>): void {
  probeRows.set(
    provider,
    models.map((id) => ({ provider, id, available: true, ...(extra ?? {}) })),
  );
  invalidate();
}

/** Assemble the merged table (cached until a layer changes). */
export function getModelCatalog(): MergedCatalog {
  if (merged) return merged;
  if (remoteCache === undefined) remoteCache = readRemoteCache();
  if (overrideRows === undefined) overrideRows = readOverrides();
  merged = mergeCatalog({
    snapshot: MODEL_CATALOG_SNAPSHOT.models,
    remote: remoteCache?.rows,
    probe: [...probeRows.values()].flat(),
    override: overrideRows ?? [],
  });
  return merged;
}

/** Test hook / settings change: drop the file-backed layers so they are re-read. */
export function resetModelCatalogForTests(): void {
  probeRows = new Map();
  remoteCache = undefined;
  overrideRows = undefined;
  invalidate();
}

export function remoteCatalogIsFresh(now = Date.now()): boolean {
  if (remoteCache === undefined) remoteCache = readRemoteCache();
  if (!remoteCache) return false;
  const fetched = Date.parse(remoteCache.fetchedAt);
  return Number.isFinite(fetched) && now - fetched < REMOTE_TTL_MS;
}

/**
 * Refresh tier ② from models.dev when the TTL expired. Failure keeps the stale
 * copy (and says so); success writes atomically. Never blocks a caller — the
 * merged table is served from whatever is on disk.
 */
export async function refreshRemoteCatalog(opts?: { force?: boolean; fetchImpl?: typeof fetch; now?: number }): Promise<{ status: "fresh" | "refreshed" | "stale" | "unavailable"; rows: number; reason?: string }> {
  const now = opts?.now ?? Date.now();
  if (!opts?.force && remoteCatalogIsFresh(now)) return { status: "fresh", rows: remoteCache?.rows.length ?? 0 };
  const doFetch = opts?.fetchImpl ?? fetch;
  try {
    const res = await doFetch(MODELS_DEV_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(remoteCache?.etag ? { "If-None-Match": remoteCache.etag } : {}),
      },
    });
    if (res.status === 304 && remoteCache) {
      remoteCache = { ...remoteCache, fetchedAt: new Date(now).toISOString() };
      writeRemote(remoteCache);
      return { status: "refreshed", rows: remoteCache.rows.length };
    }
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const api = await res.json();
    const rows = rowsFromModelsDev(api, MODEL_CATALOG_SNAPSHOT.providers.map((p) => p.id));
    if (rows.length === 0) throw new Error("models.dev returned no rows for our providers (yield regression)");
    remoteCache = { fetchedAt: new Date(now).toISOString(), etag: res.headers.get("etag") ?? undefined, rows };
    writeRemote(remoteCache);
    invalidate();
    return { status: "refreshed", rows: rows.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (remoteCache) return { status: "stale", rows: remoteCache.rows.length, reason };
    return { status: "unavailable", rows: 0, reason };
  }
}

function writeRemote(cache: RemoteCache): void {
  try {
    const target = modelCatalogRemotePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, target);
  } catch {
    /* best effort */
  }
}

/** Wire the resolver once at main startup so effectiveContextWindow() stops guessing 128k. */
export function installModelCatalogResolver(): void {
  setContextWindowResolver((backend, id) => resolveForBackend(getModelCatalog(), backend, id)?.contextWindow);
}
