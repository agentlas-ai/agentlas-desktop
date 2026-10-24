import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createNodeHost } from "./host";
import type { PlatformProvider } from "./provider";
import {
  CAPABILITY_TIERS,
  REACH_MAP_SCHEMA,
  type AppCandidate,
  type AppKind,
  type AppRecord,
  type Capability,
  type CapabilityTier,
  type HarvestOutcome,
  type HarvestRecord,
  type ReachHost,
  type ReachLevel,
  type ReachMap,
} from "./types";

export interface ReachScan {
  map: ReachMap;
  capabilities: ReadonlyMap<string, Capability[]>;
}

export interface BuildReachMapOptions {
  host?: ReachHost;
  providers: readonly PlatformProvider[];
  concurrency?: number;
  // What was learned about an app beyond what it publishes (menu structure, probed dialogs): counted in the app's level, never written
  // back into the harvest files, so a re-scan cannot erase it.
  extra?: (appKey: string) => Promise<readonly Capability[]>;
  // What an earlier scan read for this app at this fingerprint. Used for a dictionary that can only be read while the app runs: the scan that found the
  // app running reads it, and the scans after it keep it instead of losing it again.
  previous?: (appKey: string, fingerprint: string) => Promise<readonly Capability[] | null>;
  onApp?: (record: AppRecord, done: number, total: number) => void;
}

// Display grouping only. It decides which colour an app gets on the drawn map, never what the agent is allowed to call.
// An app is "scriptable" when it publishes at least this many capabilities of its own; Apple's boilerplate suites do not count.
const SCRIPTABLE_AT = 10;

export function levelOf(usable: number, anyCapability: boolean): ReachLevel {
  if (usable >= SCRIPTABLE_AT) return "scriptable";
  if (anyCapability) return "partial";
  return "unmapped";
}

// What an agent can rely on: stated by the source (published entries carry no status), or proven by an exercise. A capability that
// was only seen (candidate) or has since failed (degraded) does not count.
export function isUsable(capability: Capability): boolean {
  if (capability.generic) return false;
  if (capability.status === "degraded") return false;
  if (capability.tier === "published" && capability.status === undefined) return true;
  return capability.status === "verified" && capability.verification !== undefined;
}

async function pool<T, R>(items: readonly T[], width: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function summarize(app: AppCandidate, harvest: HarvestRecord[], capabilities: Capability[]): AppRecord {
  const byTier: Partial<Record<CapabilityTier, number>> = {};
  for (const capability of capabilities) byTier[capability.tier] = (byTier[capability.tier] ?? 0) + 1;
  const specific = capabilities.filter((item) => !item.generic).length;
  const usable = capabilities.filter(isUsable).length;
  return {
    key: app.key,
    platform: app.platform,
    name: app.name,
    ...(app.version ? { version: app.version } : {}),
    path: app.path,
    kind: app.kind,
    signals: app.signals,
    fingerprint: app.fingerprint,
    harvest,
    capabilityCount: capabilities.length,
    specificCount: specific,
    usableCount: usable,
    capabilitiesByTier: byTier,
    operationCount: capabilities.filter((item) => item.granularity === "operation").length,
    propertyCount: capabilities.filter((item) => item.granularity === "property").length,
    level: levelOf(usable, capabilities.length > 0),
  };
}

export async function buildReachMap(options: BuildReachMapOptions): Promise<ReachScan> {
  const host = options.host ?? createNodeHost();
  const provider = options.providers.find((item) => item.platform === host.platform);
  if (!provider) throw new Error(`reach_no_provider:${host.platform}`);
  const candidates = await provider.discover(host);
  const capabilityByApp = new Map<string, Capability[]>();
  let done = 0;
  const records = await pool(candidates, options.concurrency ?? 4, async (candidate) => {
    let outcomes: HarvestOutcome[];
    try {
      outcomes = await provider.harvest(host, candidate);
    } catch (error) {
      outcomes = [{
        record: { source: "provider", tier: "published" as const, status: "failed" as const, count: 0, ms: 0, detail: error instanceof Error ? error.name : "error" },
        capabilities: [] as Capability[],
      }];
    }
    if (options.previous && outcomes.some((outcome) => outcome.record.deferred === true)) {
      let kept: readonly Capability[] | null = null;
      try { kept = await options.previous(candidate.key, candidate.fingerprint); } catch { kept = null; }
      if (kept && kept.length > 0) {
        outcomes = [{ record: { source: "sdef", tier: "published", status: "ok", count: kept.length, ms: 0, detail: "kept from an earlier scan, made while the app was running" }, capabilities: [...kept] }];
      }
    }
    const capabilities = outcomes.flatMap((outcome) => outcome.capabilities);
    capabilityByApp.set(candidate.key, capabilities);
    let learned: readonly Capability[] = [];
    try { learned = (await options.extra?.(candidate.key)) ?? []; } catch { learned = []; }
    const record = summarize(candidate, outcomes.map((outcome) => outcome.record), [...capabilities, ...learned]);
    done += 1;
    options.onApp?.(record, done, candidates.length);
    return record;
  });
  const byLevel: Record<ReachLevel, number> = { scriptable: 0, partial: 0, unmapped: 0 };
  const byKind: Partial<Record<AppKind, number>> = {};
  let capabilities = 0;
  let specific = 0;
  let usable = 0;
  for (const record of records) {
    byLevel[record.level] += 1;
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    capabilities += record.capabilityCount;
    specific += record.specificCount;
    usable += record.usableCount;
  }
  return {
    map: {
      schema: REACH_MAP_SCHEMA,
      generatedAt: host.now().toISOString(),
      platform: host.platform,
      host: { arch: host.arch, release: host.release },
      apps: records,
      totals: { apps: records.length, byLevel, byKind, capabilities, specific, usable },
    },
    capabilities: capabilityByApp,
  };
}

export function tierRank(tier: CapabilityTier): number {
  return CAPABILITY_TIERS.indexOf(tier);
}

function appFileName(key: string): string {
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `${slug}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}.json`;
}

async function writeAtomic(file: string, body: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, body, { mode: 0o600 });
  await fs.rename(temp, file);
}

// The index (map.json) stays small enough to read whole; each app's capabilities live in their own file, so one app's
// refresh rewrites one file and an agent asking about one app reads one file.
export async function writeReachScan(directory: string, scan: ReachScan): Promise<void> {
  const appsDir = path.join(directory, "apps");
  await fs.mkdir(appsDir, { recursive: true, mode: 0o700 });
  const wanted = new Set<string>();
  for (const record of scan.map.apps) {
    const name = appFileName(record.key);
    wanted.add(name);
    await writeAtomic(path.join(appsDir, name), JSON.stringify({ key: record.key, fingerprint: record.fingerprint, capabilities: scan.capabilities.get(record.key) ?? [] }));
  }
  for (const stale of await fs.readdir(appsDir)) {
    if (stale.endsWith(".json") && !wanted.has(stale)) await fs.rm(path.join(appsDir, stale), { force: true });
  }
  await writeAtomic(path.join(directory, "map.json"), JSON.stringify(scan.map));
}

export async function readReachMap(directory: string): Promise<ReachMap | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, "map.json"), "utf8")) as ReachMap;
    return parsed.schema === REACH_MAP_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

export async function readAppCapabilities(directory: string, key: string): Promise<Capability[] | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, "apps", appFileName(key)), "utf8")) as { key: string; capabilities: Capability[] };
    return parsed.key === key ? parsed.capabilities : null;
  } catch {
    return null;
  }
}
