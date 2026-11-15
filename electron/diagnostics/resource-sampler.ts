import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import inspector from "node:inspector";

/**
 * Local resource evidence for one host process. Nothing here leaves the machine.
 *
 * The app had no memory measurement at all, so a daemon that held about 1.1 GB during sessions and 320 MB after a
 * restart (measured) could not say what it was holding. One line a minute while there is work shows the trend; an
 * idle host writes nothing and holds no timer (see setResourceWork). An on-demand
 * profile answers "which function": CPU time and allocation sites only. A heap snapshot would copy process memory, keys
 * included, to disk, so this module never takes one; a profile report holds function names and numbers, never values.
 *
 * Shared by Main and the daemon, so it must not import electron.
 */
const SAMPLE_INTERVAL_MS = 60_000;
/** Work starting or ending writes a line at once, but not more often than this (a burst of short turns is one trend point). */
const MIN_EVENT_SAMPLE_GAP_MS = 5_000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PROFILE_REPORTS = 4;
const TOP_FRAMES = 40;
const DEFAULT_CPU_SECONDS = 30;
const MAX_CPU_SECONDS = 120;
const DEFAULT_HEAP_SECONDS = 120;
const MAX_HEAP_SECONDS = 1_800;
const HEAP_SAMPLING_INTERVAL_BYTES = 64 * 1024;
const IDLE_COLLECT_MIN_INTERVAL_MS = 10 * 60_000;
const IDLE_COLLECT_MIN_HEAP_BYTES = 256 * 1024 * 1024;
const IDLE_COLLECT_MIN_WORK_CPU_MS = 20_000;

/*
 * "Is there work" is pushed by the modules that own the work, in this process: the agent residency registry (a turn in use
 * or a resident CLI) and the daemon's background tasks. Each reports its own source name; the host is busy while any source is.
 * Main and the daemon are separate processes with separate sets. A host may add a source (for example from
 * invocationService.onActiveChats) so work this module cannot see is covered too.
 */
const workSources = new Set<string>();
const workListeners = new Set<() => void>();
export function resourceWorkActive(): boolean { return workSources.size > 0; }
export function setResourceWork(source: string, active: boolean): void {
  const before = workSources.size > 0;
  if (active) workSources.add(source); else workSources.delete(source);
  if ((workSources.size > 0) === before) return;
  for (const listener of [...workListeners]) {
    try { listener(); } catch { /* evidence only */ }
  }
}

export type ResourceSamplerRole = "main" | "daemon";
export type ResourceSamplerOptions = {
  role: ResourceSamplerRole;
  directory: string;
  /** Host-only numbers, such as Electron process metrics. */
  extra?: () => Record<string, unknown>;
  /** True while no turn runs here, so a full collection cannot stall one. Omitted: never collects. */
  idle?: () => boolean;
  /** Sampling period while there is work. */
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

type CollectGarbage = (options: { type: "major"; flavor: "last-resort"; execution: "sync" }) => void;
let collectGarbage: CollectGarbage | null | undefined;
/**
 * V8 gives memory back only under pressure, and a 4 GB limit on a large machine is rarely pressure. A plain `gc()` is not
 * enough: it frees objects but V8's page pool keeps their pages. Measured on Electron 43: after a 345 MB
 * spike heapTotal fell to 56 MB and footprint stayed at 360 MB, the daemon idled at a 600 MB footprint with heapTotal
 * 204 MB, and "last-resort" took the same spike to 14 MB. It paused about 65 ms with 74 MB live.
 */
function fullCollection(): boolean {
  if (collectGarbage === undefined) {
    try {
      v8.setFlagsFromString("--expose-gc");
      collectGarbage = vm.runInNewContext("gc") as CollectGarbage;
    } catch { collectGarbage = null; }
  }
  if (!collectGarbage) return false;
  collectGarbage({ type: "major", flavor: "last-resort", execution: "sync" });
  return true;
}

/**
 * heapTotal alone cannot ask this, because pooled pages are outside it. CPU spent since the last collection stands for
 * "pages may be pooled" on every OS, and leaves a resting host alone: "last-resort" also drops compiled code.
 */
export function idleCollectionDue(input: { now: number; collectedAt: number; workedCpuMs: number; heapTotalBytes: number }): boolean {
  if (input.now - input.collectedAt < IDLE_COLLECT_MIN_INTERVAL_MS) return false;
  return input.workedCpuMs >= IDLE_COLLECT_MIN_WORK_CPU_MS || input.heapTotalBytes >= IDLE_COLLECT_MIN_HEAP_BYTES;
}

/** Never throws into its host. Returns a stop function; no timer holds a process open, and an idle host has none. */
export function startResourceSampler(options: ResourceSamplerOptions): () => void {
  if (process.env.AGENTLAS_RESOURCE_SAMPLER === "0") return () => {};
  const { role, directory, extra } = options;
  const logFile = path.join(directory, `resource-${role}.jsonl`);
  const requestFile = path.join(directory, `profile-request-${role}.json`);
  let cpuPrevious = process.cpuUsage();
  let sampledAt = Date.now();
  let profiling = false;
  let collectedAt = 0;
  let collectedCpu = process.cpuUsage();

  const collectWhenIdle = (now: number): boolean => {
    if (profiling || !options.idle) return false;
    const worked = process.cpuUsage(collectedCpu);
    const workedCpuMs = (worked.user + worked.system) / 1_000;
    if (!idleCollectionDue({ now, collectedAt, workedCpuMs, heapTotalBytes: process.memoryUsage().heapTotal }) || !options.idle()) return false;
    collectedAt = now;
    collectedCpu = process.cpuUsage();
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

  let timer: NodeJS.Timeout | null = null;
  let idleCollectTimer: NodeJS.Timeout | null = null;
  let lastSampleAt = 0;
  let wasWorking = false;
  /** True while the newest line is the one written when this work period began. */
  let startLineIsNewest = false;
  let stopped = false;

  const sampleNow = (reset: boolean, startOfWork = false) => {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const now = Date.now();
      // After a rest the elapsed time since the last line is not CPU time spent working: measure from here.
      if (reset) { cpuPrevious = process.cpuUsage(); sampledAt = now; }
      const collected = collectWhenIdle(now);
      appendSample(logFile, resourceSample(role, cpuPrevious, now - sampledAt, collected ? () => ({ ...extra?.(), idleCollected: true }) : extra));
      cpuPrevious = process.cpuUsage();
      sampledAt = now;
      lastSampleAt = now;
      startLineIsNewest = startOfWork;
      serveProfileRequest();
    } catch { /* evidence only: never a host failure */ }
  };

  /** After work ends, a collection that is due only for the 10-minute gap gets one timer aimed at the end of the gap. */
  const aimIdleCollection = () => {
    if (idleCollectTimer || !options.idle || stopped) return;
    const gap = collectedAt + IDLE_COLLECT_MIN_INTERVAL_MS - Date.now();
    if (gap <= 0) return;
    const worked = process.cpuUsage(collectedCpu);
    const workedCpuMs = (worked.user + worked.system) / 1_000;
    if (workedCpuMs < IDLE_COLLECT_MIN_WORK_CPU_MS && process.memoryUsage().heapTotal < IDLE_COLLECT_MIN_HEAP_BYTES) return;
    idleCollectTimer = setTimeout(() => {
      idleCollectTimer = null;
      if (resourceWorkActive() || stopped) return;
      const now = Date.now();
      if (!collectWhenIdle(now)) return;
      try { appendSample(logFile, resourceSample(role, cpuPrevious, now - sampledAt, () => ({ ...extra?.(), idleCollected: true }))); } catch { /* evidence only */ }
      cpuPrevious = process.cpuUsage();
      sampledAt = now;
    }, gap + 1_000);
    idleCollectTimer.unref?.();
  };

  /** The work state changed: start or stop the periodic line, each with one line of its own. */
  const onWorkChange = () => {
    if (stopped) return;
    const working = resourceWorkActive();
    if (working === wasWorking) return;
    wasWorking = working;
    const quiet = Date.now() - lastSampleAt < MIN_EVENT_SAMPLE_GAP_MS;
    if (working) {
      if (!quiet) sampleNow(true, true);
      timer = setInterval(() => sampleNow(false), options.intervalMs ?? SAMPLE_INTERVAL_MS);
      timer.unref?.();
    } else {
      if (timer) clearInterval(timer);
      timer = null;
      // A period shorter than the gap is one line (its start); a longer one gets its end line too.
      if (!(quiet && startLineIsNewest)) sampleNow(false);
      aimIdleCollection();
    }
  };

  // A profile request is a file an operator drops in the folder: a watch on the folder tells us, no polling.
  let watcher: fs.FSWatcher | null = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
      if (!name || String(name) === path.basename(requestFile)) serveProfileRequest();
    });
    watcher.on("error", () => { try { watcher?.close(); } catch { /* gone */ } watcher = null; });
  } catch { /* an unusable folder: evidence only */ }

  // A run that never keeps a resident CLI (an API-only run) is work too. Every run takes a run slot, so the slots say when
  // this process goes from no run to one and back. Loaded here, not imported at the top: this module stays free of the
  // app's store, and a host without run slots simply has the other work sources.
  let stopRunSlots = (): void => {};
  try {
    const slots = require("../runtime/run-slots") as typeof import("../runtime/run-slots");
    stopRunSlots = slots.onRunSlotsBusyChange((busy) => setResourceWork("run-slots", busy));
    if (slots.runSlotStats().inUse > 0) setResourceWork("run-slots", true);
  } catch { /* no run slots in this host */ }

  workListeners.add(onWorkChange);
  // One baseline line at start (and a request left by an earlier run); after it, lines only follow work.
  sampleNow(true);
  if (resourceWorkActive()) onWorkChange();
  return () => {
    stopped = true;
    workListeners.delete(onWorkChange);
    stopRunSlots();
    if (timer) clearInterval(timer);
    if (idleCollectTimer) clearTimeout(idleCollectTimer);
    timer = idleCollectTimer = null;
    try { watcher?.close(); } catch { /* gone */ }
  };
}
