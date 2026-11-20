import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessRow { pid: number; ppid: number; command: string }

const TABLE_TIMEOUT_MS = 10_000;
const TABLE_MAX_BYTES = 32 * 1024 * 1024;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TABLE_TIMEOUT_MS, maxBuffer: TABLE_MAX_BYTES, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

/** Every process on the machine, or null when the table cannot be read: a caller must then assume nothing. */
export async function readProcessTable(): Promise<ProcessRow[] | null> {
  const windows = process.platform === "win32";
  const output = windows
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"])
    : await run("ps", ["-axo", "pid=,ppid=,command="]);
  if (output === null) return null;
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = windows ? /^(\d+)\t(\d+)\t(.*)$/.exec(line) : /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return rows.length > 0 ? rows : null;
}

/** The installed app's own folder: `.../Agentlas.app/Contents` on macOS, the executable's folder elsewhere. */
export function appInstallRoot(execPath = process.execPath): string {
  const bundle = /^(.*\.app[\\/]Contents)[\\/]/.exec(execPath);
  return bundle ? bundle[1]! : path.dirname(execPath);
}

/**
 * Whether anything under `rootPid` is more than the CLI and the app's own tool servers: a dev server or shell an agent
 * left running. It lives and dies with the CLI, so closing an idle CLI would end it. Tool servers all start through the
 * app's executable or its wrapper, and what those start is theirs, so the walk stops at them.
 */
export function hasBackgroundDescendant(table: readonly ProcessRow[], rootPid: number, installRoot = appInstallRoot()): boolean {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row); else children.set(row.ppid, [row]);
  }
  const pending = [rootPid];
  const seen = new Set<number>(pending);
  while (pending.length) {
    for (const child of children.get(pending.pop() as number) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (!child.command.includes(installRoot)) return true;
    }
  }
  return false;
}

/**
 * Every process on a POSIX machine, read synchronously (a few milliseconds), or null when the table cannot be read or the host is Windows. For the one
 * moment a run's CLI is about to be ended: what it started must be listed before the leader dies, because afterwards the survivors answer to PID 1 and
 * nothing links them to the run (macOS `ps` does not show another process's environment either).
 */
export function readProcessTableSync(): ProcessRow[] | null {
  if (process.platform === "win32") return null;
  try {
    const output = String(execFileSync("ps", ["-axo", "pid=,ppid=,command="], { timeout: 2_000, maxBuffer: TABLE_MAX_BYTES, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
    const rows: ProcessRow[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
    }
    return rows.length > 0 ? rows : null;
  } catch { return null; }
}

/**
 * What an agent started under `rootPid` that is not the CLI's own group or the app's tool servers: every descendant below the root, the same walk as
 * hasBackgroundDescendant (it stops at the app's tool servers; what they start is theirs). The root itself is not listed.
 */
export function agentStartedDescendants(table: readonly ProcessRow[], rootPid: number, installRoot = appInstallRoot()): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row); else children.set(row.ppid, [row]);
  }
  const found: ProcessRow[] = [];
  const pending = [rootPid];
  const seen = new Set<number>(pending);
  while (pending.length) {
    for (const child of children.get(pending.pop() as number) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (child.command.includes(installRoot)) continue;
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

/** The command line of one process now (null = gone or unreadable): the identity check before a late signal, so a recycled PID is never signalled. */
export function commandOfProcessSync(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = String(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { timeout: 1_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })).trim();
    return out || null;
  } catch { return null; }
}

/** `ps` elapsed time ("12", "01:02", "1:02:03", "2-01:02:03") in seconds; null when it is not that shape. */
export function parseElapsedSeconds(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  return (Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

export interface YoungOrphan { pid: number; command: string; ageSeconds: number }

/**
 * Processes that started no longer than `maxAgeSeconds` ago and answer to PID 1 (or to the user's own systemd: nothing of the run's tree holds them any
 * more), POSIX only. A server an agent started with `&` from a shell tool is one: its shell ended with the command, so it is no descendant of the CLI and
 * the lineage poll (every 1.5 s) may never have seen it. Read with one `ps`; null when the table cannot be read.
 */
export function youngOrphansIn(rows: ReadonlyArray<{ pid: number; ppid: number; etime: string; command: string }>, maxAgeSeconds: number,
  reaperPids: ReadonlySet<number> = new Set([1]), installRoot = appInstallRoot()): YoungOrphan[] {
  const found: YoungOrphan[] = [];
  for (const row of rows) {
    if (!reaperPids.has(row.ppid)) continue;
    const age = parseElapsedSeconds(row.etime);
    if (age === null || age > maxAgeSeconds) continue;
    if (row.command.includes(installRoot)) continue;
    found.push({ pid: row.pid, command: row.command, ageSeconds: age });
  }
  return found;
}

async function youngProcessRows(): Promise<Array<{ pid: number; ppid: number; etime: string; command: string }> | null> {
  if (process.platform === "win32") return null;
  const output = await run("ps", ["-axo", "pid=,ppid=,etime=,command="]);
  if (output === null) return null;
  const rows: Array<{ pid: number; ppid: number; etime: string; command: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), etime: match[3]!, command: match[4]! });
  }
  return rows;
}

/** The current working directory of each pid (lsof, one call); a pid it cannot read is absent. */
export async function cwdOfProcesses(pids: readonly number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (process.platform === "win32" || pids.length === 0) return result;
  // lsof exits 1 when one of the pids is already gone yet still prints the others: its stdout is read whatever the exit code.
  const output = await new Promise<string | null>((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { timeout: TABLE_TIMEOUT_MS, maxBuffer: TABLE_MAX_BYTES, windowsHide: true },
      (error, stdout) => resolve(error && !String(stdout).trim() ? null : String(stdout)));
  });
  if (output === null) return result;
  let current = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current) result.set(current, line.slice(1));
  }
  return result;
}

/**
 * The processes a run left behind in its working folder: young (started during the run), orphaned (no CLI or shell holds them) and working in `folder`
 * (their cwd is inside it). Three facts about the process, no name list: a server the person started by hand elsewhere, or a program that was already
 * running, fails one of them. A reaper other than PID 1 (a systemd user manager on Linux) is named by `reaperPids`.
 */
export async function orphansLeftInFolder(folder: string, maxAgeSeconds: number): Promise<YoungOrphan[]> {
  if (process.platform === "win32" || !folder) return [];
  const rows = await youngProcessRows();
  if (!rows) return [];
  const reapers = new Set<number>([1]);
  for (const row of rows) if (/(^|\/)systemd(\s|$).*--user/.test(row.command)) reapers.add(row.pid);
  const candidates = youngOrphansIn(rows, maxAgeSeconds, reapers).slice(0, 60);
  if (candidates.length === 0) return [];
  const cwds = await cwdOfProcesses(candidates.map((row) => row.pid));
  let root = folder;
  try { root = fs.realpathSync(folder); } catch { /* an unreadable folder keeps its spelling */ }
  const inside = (dir: string): boolean => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  return candidates.filter((row) => { const cwd = cwds.get(row.pid); return cwd !== undefined && inside(cwd); });
}

/** The pids among `pids` that hold a listening TCP socket (lsof, one call; an unreadable answer or no lsof is the empty set: nothing is spared). */
function parseListeningPids(output: string): Set<number> {
  const found = new Set<number>();
  for (const line of output.split(/\r?\n/)) if (line.startsWith("p") && Number(line.slice(1))) found.add(Number(line.slice(1)));
  return found;
}
export async function listeningProcesses(pids: readonly number[]): Promise<Set<number>> {
  if (process.platform === "win32" || pids.length === 0) return new Set();
  const output = await new Promise<string | null>((resolve) => {
    execFile("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fp", "-p", pids.join(",")], { timeout: TABLE_TIMEOUT_MS, maxBuffer: TABLE_MAX_BYTES, windowsHide: true },
      (error, stdout) => resolve(error && !String(stdout).trim() ? null : String(stdout)));
  });
  return output === null ? new Set() : parseListeningPids(output);
}
export function listeningProcessesSync(pids: readonly number[]): Set<number> {
  if (process.platform === "win32" || pids.length === 0) return new Set();
  try {
    return parseListeningPids(String(execFileSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fp", "-p", pids.join(",")], { timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })));
  } catch (error) {
    // lsof exits 1 when one of the pids is already gone yet still prints the others.
    const out = (error as { stdout?: unknown }).stdout;
    return out ? parseListeningPids(String(out)) : new Set();
  }
}
