import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InvocationRunOwner } from "./invocation-owner-core";

/**
 * Proof that the owner of a TERMINAL run lease is gone — the Desktop/daemon half of the terminal's own recovery
 * (agentlas_terminal engine/sessions/terminal-owner-liveness.cjs; change both together).
 *
 * A terminal that dies without releasing (kill -9, OOM, a crash, power loss) left its invocation_run_owners row active for good.
 * Nothing of Desktop's or the daemon's kind ever releases a terminal row (releaseAbandoned is "every other process of MY kind", sound
 * only under a single-instance lock), so the chat — the shared One conversation included — refused every turn on every surface
 * (invocation_chat_owned_by_other_run) and the owner's messages waited in the send queue forever. Custody is an identity, never a
 * PID or a timer: a row is released only on PROOF that its owner process and the native agent processes it started no longer exist.
 *
 * The terminal writes <userData>/terminal-owners/<ownerId>.json while it holds any lease:
 *   { schemaVersion: 1, ownerId, pid, startToken, host, claimedAt, children: [{ pid, startToken }] }
 * startToken fingerprints the process start so a reused PID is not mistaken for the owner:
 *   linux   linux:<boot_id>:<starttime ticks>   exact
 *   unix    ps:<start epoch seconds>            from `ps -o etime=`, within 3 s (timezone-proof)
 *   win32   win:<start epoch ms>                within 3 s
 * Gone = no process with that pid, or a different start token. A live pid whose token cannot be read is unverifiable: kept.
 * A row with no record (an older terminal) is released only when no terminal engine process is running at all.
 */
export const TERMINAL_OWNER_RECORD_DIR = "terminal-owners";
const SCHEMA_VERSION = 1;
const TOLERANCE_MS = 3_000;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENGINE_COMMAND_RE = /engine[\\/]agentlas\.cjs(?:\s|$)/;

export type TerminalOwnerProof =
  | { gone: true; via: "record" | "no_engine_process" }
  | { gone: false; code: "terminal_owner_alive" | "terminal_owner_child_alive" | "terminal_owner_unverifiable" | "terminal_owner_record_missing" | "terminal_owner_other_host"; pid?: number };

export interface TerminalOwnerProofDeps {
  platform?: NodeJS.Platform;
  hostname?: string;
  exec?(file: string, args: string[]): string;
  readFile?(file: string): string;
  isPidAlive?(pid: number): boolean;
  processStartToken?(pid: number): string | null;
  engineProcessIds?(): number[] | null;
}

interface RecordedChild { pid: number; startToken: string | null }
interface TerminalOwnerRecord { ownerId: string; pid: number; startToken: string | null; host: string; children: RecordedChild[] }

export function terminalOwnerRecordPath(userDataDir: string, ownerId: string): string | null {
  return typeof ownerId === "string" && OWNER_ID_RE.test(ownerId) ? path.join(userDataDir, TERMINAL_OWNER_RECORD_DIR, `${ownerId}.json`) : null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; } // exists, not signalable
}

/** `ps -o etime=` forms: ss | mm:ss | hh:mm:ss | dd-hh:mm:ss, in seconds. */
export function parseElapsedSeconds(text: string): number | null {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(text || ""));
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (Number(days || 0) * 24 + Number(hours || 0)) * 3600 + Number(minutes) * 60 + Number(seconds);
}

const defaultExec = (file: string, args: string[]): string =>
  execFileSync(file, args, { encoding: "utf8", timeout: 4_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: "C" } });

/** The start-time fingerprint of a live process, or null when the OS will not tell. Never throws. */
export function processStartToken(pid: number, deps: TerminalOwnerProofDeps = {}): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  try {
    if (platform === "linux") {
      try {
        const stat = readFile(`/proc/${pid}/stat`);
        const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22: starttime
        if (/^\d+$/.test(ticks ?? "")) {
          let bootId = "";
          try { bootId = readFile("/proc/sys/kernel/random/boot_id").trim(); } catch { /* the ticks alone still discriminate */ }
          return `linux:${bootId}:${ticks}`;
        }
      } catch { /* no readable /proc (a sandbox): ask ps below */ }
    }
    if (platform === "win32") {
      const out = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Subtract([DateTime]'1970-01-01').TotalMilliseconds`]);
      const ms = Math.round(Number(String(out).trim()));
      return Number.isFinite(ms) && ms > 0 ? `win:${ms}` : null;
    }
    const seconds = parseElapsedSeconds(exec("/bin/ps", ["-o", "etime=", "-p", String(pid)]));
    return seconds === null ? null : `ps:${Math.round(Date.now() / 1000 - seconds)}`;
  } catch {
    return null;
  }
}

export function tokensMatch(recorded: string | null | undefined, current: string | null | undefined): boolean {
  if (typeof recorded !== "string" || typeof current !== "string") return false;
  const a = /^(win|ps):(\d+)$/.exec(recorded);
  const b = /^(win|ps):(\d+)$/.exec(current);
  if (a && b) {
    if (a[1] !== b[1]) return false;
    return Math.abs(Number(a[2]) - Number(b[2])) * (a[1] === "win" ? 1 : 1000) <= TOLERANCE_MS;
  }
  return recorded === current;
}

let ownTokenCache: string | null | undefined;
/** This process's own start fingerprint, read once (cheap on Windows: no PowerShell). Null when the OS will not tell. Never throws. */
export function ownProcessStartToken(deps: TerminalOwnerProofDeps = {}): string | null {
  const cached = deps.platform === undefined && deps.exec === undefined && deps.readFile === undefined;
  if (cached && ownTokenCache !== undefined) return ownTokenCache;
  const platform = deps.platform ?? process.platform;
  // Taking an agent run lease records this token, so it must never start a process (the owned agent-evolution fixture counts any
  // external effect as a failure): the process's own uptime is the same "ps:<start epoch seconds>" fingerprint another reader gets
  // from `ps etime` (within the tolerance), and /proc is read directly on Linux. Only an injected reader (tests) is asked instead.
  const uptimeToken = () => `ps:${Math.round(Date.now() / 1000 - process.uptime())}`;
  const token = platform === "win32" ? `win:${Math.round(Date.now() - process.uptime() * 1000)}`
    : deps.exec ? processStartToken(process.pid, deps)
    : platform === "linux" ? (processStartToken(process.pid, { ...deps, exec: () => { throw new Error("own_token_never_spawns"); } }) ?? uptimeToken())
    : uptimeToken();
  if (cached) ownTokenCache = token;
  return token;
}

/** "gone" | "alive" | "unknown" for one recorded process. Also how an agent run lease proves its holder gone (agents/workspace-service.ts). */
export function processState(pid: number, recordedToken: string | null, deps: TerminalOwnerProofDeps = {}): "gone" | "alive" | "unknown" {
  if (!(deps.isPidAlive ?? pidAlive)(pid)) return "gone";
  if (typeof recordedToken !== "string" || !recordedToken) return "unknown"; // a live pid and nothing to tell it from a reused one
  const current = (deps.processStartToken ?? ((p: number) => processStartToken(p, deps)))(pid);
  if (current === null) return "unknown";
  // Two readers that fingerprint differently (e.g. /proc readable for one, only ps for the other) say nothing about a reuse.
  if (recordedToken.split(":")[0] !== current.split(":")[0]) return "unknown";
  return tokensMatch(recordedToken, current) ? "alive" : "gone"; // a different start time: the pid now belongs to another process
}

function readRecord(userDataDir: string, ownerId: string, deps: TerminalOwnerProofDeps): TerminalOwnerRecord | null {
  const file = terminalOwnerRecordPath(userDataDir, ownerId);
  if (!file) return null;
  try {
    const raw = deps.readFile ? deps.readFile(file) : (() => {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("terminal_owner_record_invalid");
      return fs.readFileSync(file, "utf8");
    })();
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (!record || record.schemaVersion !== SCHEMA_VERSION || record.ownerId !== ownerId || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
      || typeof record.host !== "string" || !Array.isArray(record.children)) return null;
    return {
      ownerId, pid: record.pid as number, startToken: typeof record.startToken === "string" ? record.startToken : null, host: record.host,
      children: (record.children as Array<Record<string, unknown>>)
        .filter((child) => child && Number.isSafeInteger(child.pid) && (child.pid as number) > 1)
        .map((child) => ({ pid: child.pid as number, startToken: typeof child.startToken === "string" ? child.startToken : null })),
    };
  } catch {
    return null;
  }
}

/** Process ids whose command line is a terminal engine (`.../engine/agentlas.cjs`), or null when the OS cannot list them. */
export function terminalEngineProcessIds(deps: TerminalOwnerProofDeps = {}): number[] | null {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  try {
    if (platform === "win32") {
      const out = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"]);
      return String(out).split(/\r?\n/).flatMap((line) => {
        const [pid, ...rest] = line.split("\t");
        return Number(pid) > 0 && ENGINE_COMMAND_RE.test(rest.join("\t")) ? [Number(pid)] : [];
      });
    }
    const out = exec("/bin/ps", ["-axww", "-o", "pid=,command="]);
    return String(out).split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match && ENGINE_COMMAND_RE.test(match[2]) ? [Number(match[1])] : [];
    });
  } catch {
    return null;
  }
}

/** Is the owner of this terminal lease provably gone? Machine codes only; prose is never parsed. */
export function proveTerminalOwnerGone(userDataDir: string, ownerId: string, deps: TerminalOwnerProofDeps = {}): TerminalOwnerProof {
  const record = readRecord(userDataDir, ownerId, deps);
  if (!record) {
    const engines = (deps.engineProcessIds ?? (() => terminalEngineProcessIds(deps)))();
    if (Array.isArray(engines) && engines.length === 0) return { gone: true, via: "no_engine_process" };
    return { gone: false, code: "terminal_owner_record_missing" };
  }
  if (record.host !== (deps.hostname ?? os.hostname())) return { gone: false, code: "terminal_owner_other_host" };
  const owner = processState(record.pid, record.startToken, deps);
  if (owner === "alive") return { gone: false, code: "terminal_owner_alive", pid: record.pid };
  if (owner === "unknown") return { gone: false, code: "terminal_owner_unverifiable", pid: record.pid };
  for (const child of record.children) {
    const state = processState(child.pid, child.startToken, deps);
    if (state === "alive") return { gone: false, code: "terminal_owner_child_alive", pid: child.pid };
    if (state === "unknown") return { gone: false, code: "terminal_owner_unverifiable", pid: child.pid };
  }
  return { gone: true, via: "record" };
}

export interface TerminalOwnerStore {
  listActiveOwners(): InvocationRunOwner[];
  releaseAbandonedOwners(ownerKind: InvocationRunOwner["ownerKind"], deadOwnerIds: readonly string[]): InvocationRunOwner[];
}

export interface TerminalOwnerSweep {
  released: InvocationRunOwner[];
  /** One entry per terminal owner that could not be proven gone: the typed cause, for the log. */
  kept: Array<{ ownerId: string; runIds: string[]; code: string; pid?: number }>;
}

/**
 * Release the leases of terminal owners that are provably gone (optionally only those holding `chatId`). A live or unverifiable
 * terminal's rows stay exactly as they are. Never throws: recovery must not become a new way for a send to fail.
 */
export function releaseGoneTerminalOwners(store: TerminalOwnerStore, userDataDir: string,
  options: { chatId?: string; deps?: TerminalOwnerProofDeps } = {}): TerminalOwnerSweep {
  const sweep: TerminalOwnerSweep = { released: [], kept: [] };
  try {
    const terminal = store.listActiveOwners().filter((owner) => owner.ownerKind === "terminal"
      && (options.chatId === undefined || owner.chatId === options.chatId));
    if (terminal.length === 0) return sweep;
    const byOwner = new Map<string, InvocationRunOwner[]>();
    for (const lease of terminal) byOwner.set(lease.ownerId, [...(byOwner.get(lease.ownerId) ?? []), lease]);
    const gone: string[] = [];
    // One scan of the process table at most, however many record-less owners there are.
    let scan: number[] | null | undefined;
    const deps: TerminalOwnerProofDeps = { ...options.deps, engineProcessIds: options.deps?.engineProcessIds
      ?? (() => (scan === undefined ? (scan = terminalEngineProcessIds(options.deps)) : scan)) };
    for (const [ownerId, leases] of byOwner) {
      const proof = proveTerminalOwnerGone(userDataDir, ownerId, deps);
      if (proof.gone) gone.push(ownerId);
      else sweep.kept.push({ ownerId, runIds: leases.map((lease) => lease.runId), code: proof.code, ...(proof.pid !== undefined ? { pid: proof.pid } : {}) });
    }
    if (gone.length) sweep.released = store.releaseAbandonedOwners("terminal", gone);
  } catch {
    // A locked or unreadable store: nothing is released and the next sweep tries again.
  }
  return sweep;
}
