import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import inspector from "node:inspector";

/**
 * Local resource evidence for one host process. Nothing here leaves the machine.
 *
 * The app had no memory measurement at all, so a daemon that held about 1.1 GB during sessions and 320 MB after a
 * restart (measured) could not say what it was holding. One line a minute shows the trend. An on-demand
 * profile answers "which function": CPU time and allocation sites only. A heap snapshot would copy process memory, keys
 * included, to disk, so this module never takes one; a profile report holds function names and numbers, never values.
 *
 * Shared by Main and the daemon, so it must not import electron.
 */
const SAMPLE_INTERVAL_MS = 60_000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PROFILE_REPORTS = 4;
const TOP_FRAMES = 40;
const DEFAULT_CPU_SECONDS = 30;
const MAX_CPU_SECONDS = 120;
const DEFAULT_HEAP_SECONDS = 120;
const MAX_HEAP_SECONDS = 1_800;
const HEAP_SAMPLING_INTERVAL_BYTES = 64 * 1024;
const IDLE_COLLECT_MIN_INTERVAL_MS = 5 * 60_000;
const IDLE_COLLECT_MIN_HEAP_BYTES = 256 * 1024 * 1024;

export type ResourceSamplerRole = "main" | "daemon";
export type ResourceSamplerOptions = {
  role: ResourceSamplerRole;
  directory: string;
  /** Host-only numbers, such as Electron process metrics. */
  extra?: () => Record<string, unknown>;
  /** True while no turn runs here, so a full collection cannot stall one. Omitted: never collects. */
  idle?: () => boolean;
  intervalMs?: number;
};
type CallFrame = { functionName?: string; url?: string; lineNumber?: number };
type CpuNode = { id: number; callFrame: CallFrame; children?: number[] };
type CpuProfile = { nodes: CpuNode[]; samples?: number[]; timeDeltas?: number[] };
type HeapNode = { callFrame: CallFrame; selfSize: number; children?: HeapNode[] };
export type ProfileFrame = { frame: string; value: number };

const megabytes = (bytes: number) => Math.round(bytes / 104_857.6) / 10;
const clampSeconds = (value: unknown, fallback: number, max: number) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.floor(seconds), max) : fallback;
};

/** Function, file tail and line. A path's leading folders can name the person, so only the tail is kept. */
function frameLabel(frame: CallFrame): string {
  const file = (frame.url ?? "").split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  return `${frame.functionName || "(anonymous)"} ${file}:${(frame.lineNumber ?? 0) + 1}`;
}
function topFrames(totals: Map<string, number>, scale: (value: number) => number): ProfileFrame[] {
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_FRAMES)
    .map(([frame, value]) => ({ frame, value: scale(value) }));
}

/** A native frame such as a SQLite `get` says nothing alone; `callerMs` charges its time to the JavaScript that called it. */
export function summarizeCpuProfile(profile: CpuProfile): { totalMs: number; selfMs: ProfileFrame[]; callerMs: ProfileFrame[] } {
  const byNode = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const callerOf = (id: number): CallFrame | null => {
    for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
      const frame = byNode.get(at);
      if (frame?.url && !frame.url.startsWith("node:")) return frame;
    }
    return null;
  };
  const totals = new Map<string, number>();
  const callers = new Map<string, number>();
  let totalMicros = 0;
  (profile.samples ?? []).forEach((id, index) => {
    const delta = profile.timeDeltas?.[index] ?? 0;
    const frame = byNode.get(id);
    if (!frame) return;
    totalMicros += delta;
    const label = frameLabel(frame);
    totals.set(label, (totals.get(label) ?? 0) + delta);
    const caller = callerOf(id);
    if (caller) {
      const callerLabel = frameLabel(caller);
      callers.set(callerLabel, (callers.get(callerLabel) ?? 0) + delta);
    }
  });
  const milliseconds = (micros: number) => Math.round(micros / 100) / 10;
  return { totalMs: Math.round(totalMicros / 1_000), selfMs: topFrames(totals, milliseconds), callerMs: topFrames(callers, milliseconds) };
}

export function summarizeHeapProfile(head: HeapNode): { liveMb: number; selfMb: ProfileFrame[] } {
  const totals = new Map<string, number>();
  let live = 0;
  const pending = [head];
  while (pending.length) {
    const node = pending.pop() as HeapNode;
    live += node.selfSize;
    if (node.selfSize > 0) {
      const label = frameLabel(node.callFrame);
      totals.set(label, (totals.get(label) ?? 0) + node.selfSize);
    }
    if (node.children) pending.push(...node.children);
  }
  return { liveMb: megabytes(live), selfMb: topFrames(totals, megabytes) };
}

function appendSample(file: string, line: string): void {
  try {
    if (fs.statSync(file).size >= MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

function writeProfileReport(directory: string, role: ResourceSamplerRole, report: Record<string, unknown>): void {
  const file = path.join(directory, `profile-${role}-${Date.now()}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 1), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  const reports = fs.readdirSync(directory).filter((name) => name.startsWith(`profile-${role}-`) && name.endsWith(".json")).sort();
  for (const name of reports.slice(0, -MAX_PROFILE_REPORTS)) fs.rmSync(path.join(directory, name), { force: true });
}

function post<T>(session: inspector.Session, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    session.post(method, params as never, (error: Error | null, result: unknown) => { if (error) reject(error); else resolve(result as T); });
  });
}
const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds).unref?.(); });

/** The CPU window comes first. Allocation sampling only sees what is allocated after it starts, so it runs on alone. */
export async function captureProcessProfile(cpuSeconds: number, heapSeconds: number): Promise<Record<string, unknown>> {
  const session = new inspector.Session();
  session.connect();
  try {
    await post(session, "HeapProfiler.startSampling", { samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES });
    await post(session, "Profiler.enable");
    await post(session, "Profiler.start");
    await pause(cpuSeconds * 1_000);
    const cpu = await post<{ profile: CpuProfile }>(session, "Profiler.stop");
    await post(session, "Profiler.disable");
    await pause(Math.max(heapSeconds - cpuSeconds, 0) * 1_000);
    const heap = await post<{ profile: { head: HeapNode } }>(session, "HeapProfiler.stopSampling");
    return { cpuSeconds, heapSeconds, cpu: summarizeCpuProfile(cpu.profile), heap: summarizeHeapProfile(heap.profile.head) };
  } finally {
    session.disconnect();
  }
}

export function resourceSample(role: ResourceSamplerRole, cpuPrevious: NodeJS.CpuUsage, elapsedMs: number, extra?: () => Record<string, unknown>): string {
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const cpu = process.cpuUsage(cpuPrevious);
  let hostMetrics: Record<string, unknown> = {};
  try { hostMetrics = extra?.() ?? {}; } catch { /* a host metric is optional */ }
  return JSON.stringify({
    schemaVersion: "agentlas.resource-sample.v1",
    at: new Date().toISOString(),
    role,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: megabytes(memory.rss),
    heapUsedMb: megabytes(memory.heapUsed),
    heapTotalMb: megabytes(memory.heapTotal),
    externalMb: megabytes(memory.external),
    arrayBuffersMb: megabytes(memory.arrayBuffers),
    heapLimitMb: megabytes(heap.heap_size_limit),
    cpuPercent: elapsedMs > 0 ? Math.round(((cpu.user + cpu.system) / 1_000 / elapsedMs) * 1_000) / 10 : 0,
    ...hostMetrics,
  });
}

let collectGarbage: (() => void) | null | undefined;
/** V8 gives memory back only under pressure, and a 4 GB limit on a large machine is rarely pressure. */
function fullCollection(): boolean {
  if (collectGarbage === undefined) {
    try {
      v8.setFlagsFromString("--expose-gc");
      collectGarbage = vm.runInNewContext("gc") as () => void;
    } catch { collectGarbage = null; }
  }
  if (!collectGarbage) return false;
  collectGarbage();
  return true;
}

/** Never throws into its host. Returns a stop function; the timer never holds a process open. */
export function startResourceSampler(options: ResourceSamplerOptions): () => void {
  if (process.env.AGENTLAS_RESOURCE_SAMPLER === "0") return () => {};
  const { role, directory, extra } = options;
  const logFile = path.join(directory, `resource-${role}.jsonl`);
  const requestFile = path.join(directory, `profile-request-${role}.json`);
  let cpuPrevious = process.cpuUsage();
  let sampledAt = Date.now();
  let profiling = false;
  let collectedAt = 0;

  const collectWhenIdle = (now: number): boolean => {
    if (profiling || !options.idle || now - collectedAt < IDLE_COLLECT_MIN_INTERVAL_MS) return false;
    if (process.memoryUsage().heapTotal < IDLE_COLLECT_MIN_HEAP_BYTES || !options.idle()) return false;
    collectedAt = now;
    return fullCollection();
  };

  const serveProfileRequest = () => {
    if (profiling || !fs.existsSync(requestFile)) return;
    let request: { cpuSeconds?: unknown; heapSeconds?: unknown } = {};
    try { request = JSON.parse(fs.readFileSync(requestFile, "utf8")); } catch { /* defaults */ }
    // Consumed first: a request that crashes the process must not run again on the next start.
    fs.rmSync(requestFile, { force: true });
    profiling = true;
    const cpuSeconds = clampSeconds(request.cpuSeconds, DEFAULT_CPU_SECONDS, MAX_CPU_SECONDS);
    const heapSeconds = Math.max(clampSeconds(request.heapSeconds, DEFAULT_HEAP_SECONDS, MAX_HEAP_SECONDS), cpuSeconds);
    void captureProcessProfile(cpuSeconds, heapSeconds)
      .then((report) => writeProfileReport(directory, role, { schemaVersion: "agentlas.resource-profile.v1", at: new Date().toISOString(), role, ...report }))
      .catch((error) => writeProfileReport(directory, role, { schemaVersion: "agentlas.resource-profile.v1", at: new Date().toISOString(), role, error: error instanceof Error ? error.message : String(error) }))
      .catch(() => { /* evidence only */ })
      .finally(() => { profiling = false; });
  };

  const tick = () => {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const collected = collectWhenIdle(now);
      appendSample(logFile, resourceSample(role, cpuPrevious, now - sampledAt, collected ? () => ({ ...extra?.(), idleCollected: true }) : extra));
      cpuPrevious = process.cpuUsage();
      sampledAt = now;
      serveProfileRequest();
    } catch { /* evidence only: never a host failure */ }
  };
  const timer = setInterval(tick, options.intervalMs ?? SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
