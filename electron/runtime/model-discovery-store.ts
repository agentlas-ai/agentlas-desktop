// Last-good model discovery persistence (PRD 2026-08-15 D-2).
//
// Before this, DISCOVERED_CLI_MODELS lived only in process memory: the first
// parse failure after a restart froze the picker empty until the next restart,
// and no one could tell whether "0 models" was new or had always been so.
//
// Now every ok probe is written to <userData>/model-discovery.json as
// { [runtime]: { count, at, models } }. A failed probe is backfilled from that
// file (stale: true) so the picker keeps the last real inventory, and the
// classifier gets `previousCount` to raise a yield warning on sharp drops.
//
// Store path resolution (no Electron needed, so contract tests can run under
// plain node): AGENTLAS_MODEL_DISCOVERY_PATH > Electron userData > tmpdir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyDiscovery, type DiscoveryOutcome, type DiscoverySource } from "../../shared/model-discovery";

interface StoredRun {
  count: number;
  at: string;
  models: string[];
  source?: DiscoverySource;
}

interface StoreFile {
  schemaVersion: "agentlas.model-discovery-store.v1";
  runtimes: Record<string, StoredRun>;
}

const MAX_MODELS_PERSISTED = 500;

let cachedPath: string | null = null;

export function modelDiscoveryStorePath(): string {
  if (cachedPath) return cachedPath;
  const override = process.env.AGENTLAS_MODEL_DISCOVERY_PATH?.trim();
  if (override) return (cachedPath = override);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { getPath?: (name: string) => string; isPackaged?: boolean } };
    // Same isolation rule as store/db.ts: a dev/QA instance never writes into
    // the live product's userData (2026-08-11 incident: 51 gates opened the
    // live DB). Packaged app → userData; anything else → tmpdir.
    const userData = electron?.app?.isPackaged ? electron.app.getPath?.("userData") : undefined;
    if (userData) return (cachedPath = path.join(userData, "model-discovery.json"));
  } catch {
    /* not inside Electron */
  }
  return (cachedPath = path.join(os.tmpdir(), `agentlas-model-discovery-${process.pid}.json`));
}

/** Test hook: forget the cached path so a new env override is honoured. */
export function resetModelDiscoveryStorePathForTests(): void {
  cachedPath = null;
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(modelDiscoveryStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed && parsed.schemaVersion === "agentlas.model-discovery-store.v1" && parsed.runtimes && typeof parsed.runtimes === "object") {
      return { schemaVersion: "agentlas.model-discovery-store.v1", runtimes: parsed.runtimes as Record<string, StoredRun> };
    }
  } catch {
    /* first run / corrupt → empty (never overwrite a corrupt file until a good write) */
  }
  return { schemaVersion: "agentlas.model-discovery-store.v1", runtimes: {} };
}

function writeStore(store: StoreFile): void {
  const target = modelDiscoveryStorePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
    fs.renameSync(tmp, target); // atomic replace, never truncate-in-place
  } catch {
    /* persistence is best-effort; discovery itself already succeeded */
  }
}

export function lastGoodDiscovery(runtime: string): StoredRun | null {
  const run = readStore().runtimes[runtime];
  return run && Array.isArray(run.models) && run.models.length > 0 ? run : null;
}

/** Record an ok outcome; failed/unsupported outcomes never overwrite last-good. */
export function recordDiscovery(runtime: string, outcome: DiscoveryOutcome): void {
  if (outcome.status !== "ok" || outcome.models.length === 0) return;
  const store = readStore();
  store.runtimes[runtime] = {
    count: outcome.models.length,
    at: outcome.at ?? new Date().toISOString(),
    models: outcome.models.slice(0, MAX_MODELS_PERSISTED),
    ...(outcome.source ? { source: outcome.source } : {}),
  };
  writeStore(store);
}

/**
 * Finish a probe: classify against the last good count, persist if ok, and on
 * failure hand back the last good models marked stale so callers never see an
 * empty menu that they cannot distinguish from "nothing installed".
 */
export function settleDiscovery(
  runtime: string,
  input: { stdout: string; models: readonly string[]; exitCode?: number | null; timedOut?: boolean; source?: DiscoverySource; idRe?: RegExp },
): DiscoveryOutcome {
  const previous = lastGoodDiscovery(runtime);
  const outcome = classifyDiscovery({ ...input, previousCount: previous?.count ?? null });
  outcome.at = new Date().toISOString();
  if (outcome.status === "ok") {
    recordDiscovery(runtime, outcome);
    return outcome;
  }
  if (outcome.status === "failed" && previous) {
    return { ...outcome, models: [...previous.models], stale: true, previousCount: previous.count, at: previous.at };
  }
  return outcome;
}

/** Log a failed/stale discovery once per (runtime, reason) until it changes. */
const lastLogged = new Map<string, string>();
export function reportDiscoveryLoudly(runtime: string, outcome: DiscoveryOutcome, log: (message: string) => void = (m) => console.error(m)): boolean {
  if (outcome.status !== "failed" && !outcome.yieldWarning) {
    lastLogged.delete(runtime);
    return false;
  }
  const signature = `${outcome.status}:${outcome.reason ?? ""}:${outcome.stale ? "stale" : ""}`;
  if (lastLogged.get(runtime) === signature) return false;
  lastLogged.set(runtime, signature);
  const stale = outcome.stale ? ` (showing ${outcome.models.length} stale models from ${outcome.at})` : "";
  log(`[model-discovery] ${runtime}: ${outcome.status} — ${outcome.reason ?? "unknown"} (${outcome.rawLineCount} raw lines)${stale}`);
  return true;
}
