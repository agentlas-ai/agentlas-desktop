import { execFile } from "node:child_process";
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
