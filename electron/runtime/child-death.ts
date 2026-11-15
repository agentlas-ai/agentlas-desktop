// Desktop R, part 2: why a model program (a subscription CLI's child process) died, said only when the HOST measured it.
//
// A child that ends by a signal reports `code === null` and a `signal`; every runner turned that into the bare "ended without a completion receipt"
// (runtime_turn_unsettled), so a program killed because the computer ran out of memory read the same as any other cut. "Out of memory" is said only
// when a machine fact says so (decision: no wording from error text; shown only when confirmed):
//   - Windows: the child's exit status is the system's own NTSTATUS for "no memory": 0xC0000017 STATUS_NO_MEMORY or 0xC000012D STATUS_COMMITMENT_LIMIT
//     (Node reports an NTSTATUS exit as its unsigned 32-bit value).
//   - Linux: the kernel's own counter of processes it killed for memory in this process's cgroup (cgroup v2 `memory.events` `oom_kill`) rose while the
//     child lived AND the child died by SIGKILL that this app did not send.
//   - macOS: the system gives a process no machine-readable word for a memory kill (jetsam ends it with SIGKILL, the same signal as any kill), so a
//     SIGKILL there stays what it was before: unconfirmed, and nothing is claimed.
// Every other exit keeps its old word. This module reads nothing of the child's output.
//
// The fact is observed once for every child the app records (spawn-registry.ts recordSpawnedRunChild): a `close` listener keeps `{code, signal, ...}` in a
// WeakMap, so no runtime needs a second listener and the child's own flow is untouched. Pure of Electron (the daemon loads it).
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { RunnerFailure } from "./runner";

/** The closed word of a model program that ended because the computer ran out of memory (shared/run-failure-notice.ts class `memory_exhausted`). */
export const RUNTIME_OUT_OF_MEMORY_CODE = "runtime_out_of_memory";

/** Windows' own NTSTATUS values for "not enough memory" as Node reports them (unsigned 32 bit). basis: ntstatus.h STATUS_NO_MEMORY 0xC0000017, STATUS_COMMITMENT_LIMIT 0xC000012D. */
export const WINDOWS_OUT_OF_MEMORY_EXIT_CODES: ReadonlySet<number> = new Set([0xC0000017, 0xC000012D]);

export interface ChildDeathFact {
  code: number | null;
  signal: string | null;
  platform: NodeJS.Platform;
  /** This app sent the signal (a stop, a cancel, a sweep) - such an ending is never the system's. */
  hostKilled: boolean;
  /** Linux cgroup v2: how many processes the kernel killed for memory while the child lived; null = not readable here. */
  oomKillsWhileAlive: number | null;
}

export type ChildDeathClass = "clean" | "exit_code" | "signal" | "memory_exhausted";

/** The one rule. Memory only on a machine fact (above); everything else is what it always was. */
export function classifyChildDeath(fact: ChildDeathFact): ChildDeathClass {
  if (fact.code === 0 && fact.signal === null) return "clean";
  if (fact.platform === "win32" && typeof fact.code === "number" && WINDOWS_OUT_OF_MEMORY_EXIT_CODES.has(fact.code >>> 0)) return "memory_exhausted";
  if (fact.platform === "linux" && !fact.hostKilled && fact.signal === "SIGKILL" && typeof fact.oomKillsWhileAlive === "number" && fact.oomKillsWhileAlive > 0) return "memory_exhausted";
  return fact.signal !== null ? "signal" : "exit_code";
}

// ─────────────── evidence: Linux cgroup v2 ───────────────
/** The `oom_kill` count of this process's cgroup (v2), or null when it cannot be read (not Linux, cgroup v1, no permission). A read of two tiny files. */
export function readCgroupOomKills(options: { platform?: NodeJS.Platform; procSelfCgroup?: string; cgroupRoot?: string } = {}): number | null {
  if ((options.platform ?? process.platform) !== "linux") return null;
  try {
    const self = fs.readFileSync(options.procSelfCgroup ?? "/proc/self/cgroup", "utf8");
    const line = self.split("\n").find((row) => row.startsWith("0::"));
    if (!line) return null;                                         // cgroup v1 has no unified line: not confirmable here
    const relative = line.slice(3).trim().replace(/^\/+/, "");
    const events = fs.readFileSync(`${options.cgroupRoot ?? "/sys/fs/cgroup"}/${relative}/memory.events`, "utf8");
    const match = /^oom_kill (\d+)$/m.exec(events);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

// ─────────────── the observation of every recorded child ───────────────
const deaths = new WeakMap<ChildProcess, ChildDeathFact>();
const hostKills = new WeakSet<ChildProcess>();

/** The app is about to signal this child (stop, cancel, sweep): its ending is not the system's. Called by the kill helpers of runtime/exec.ts. */
export function markChildHostKilled(child: ChildProcess): void { hostKills.add(child); }

/**
 * Starts watching a child (spawn-registry.ts calls it for every child it records). The cgroup count is read once now and once at `close`;
 * the difference is "killed for memory while this child lived". Never throws into the spawn.
 */
export function observeChildDeath(child: ChildProcess, options: { platform?: NodeJS.Platform; readOom?: () => number | null } = {}): void {
  const platform = options.platform ?? process.platform;
  const readOom = options.readOom ?? (() => readCgroupOomKills({ platform }));
  let before: number | null = null;
  try { before = readOom(); } catch { before = null; }
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    let after: number | null = null;
    try { after = readOom(); } catch { after = null; }
    deaths.set(child, {
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal : null,
      platform,
      hostKilled: hostKills.has(child) || child.killed === true,
      oomKillsWhileAlive: before !== null && after !== null ? Math.max(0, after - before) : null,
    });
  });
}

export function childDeathOf(child: ChildProcess | null | undefined): ChildDeathFact | undefined { return child ? deaths.get(child) : undefined; }

/**
 * The typed cause behind an unfinished turn when - and only when - the child's death is a confirmed memory kill; otherwise undefined and the caller keeps
 * what it had. A `refused` kind with a host-owned code is the shape every host limit already uses (shared/run-failure-notice.ts HOST_FAILURE_CODE_CLASSES).
 */
export function memoryDeathCause(child: ChildProcess | null | undefined, runtime: string, fact: ChildDeathFact | undefined = childDeathOf(child)): RunnerFailure | undefined {
  if (!fact || classifyChildDeath(fact) !== "memory_exhausted") return undefined;
  return { kind: "refused", runtime, source: "exit", providerCode: RUNTIME_OUT_OF_MEMORY_CODE,
    message: "The model program was ended by the system because the computer ran out of memory.",
    ...(typeof fact.code === "number" ? { exitCode: fact.code } : {}) };
}
