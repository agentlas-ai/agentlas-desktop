import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface OwnedShellLaunch {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cleanup?: () => void;
}
export interface OwnedShellResult {
  code: number | null;
  out: string;
  err: string;
  stopReason: string | null;
}
interface ProcessIdentity { pid: number; ppid: number; group: number; identity: string; zombie: boolean }
const PS_ARGS = ["-ax", "-o", "pid=,ppid=,pgid=,lstart=,stat="];

function parsePs(stdout: string): ProcessIdentity[] | null {
  const rows: ProcessIdentity[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s*$/.exec(line);
    if (!m) return null;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), group: Number(m[3]), identity: m[4], zombie: m[5].startsWith("Z") });
  }
  return rows;
}

function linuxProcesses(): ProcessIdentity[] | null {
  try {
    const rows: ProcessIdentity[] = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8"), tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.push({ pid: Number(entry), ppid: Number(tail[1]), group: Number(tail[2]), identity: tail[19], zombie: tail[0] === "Z" });
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; }
    }
    return rows;
  } catch { return null; }
}

/** One bounded metadata read before yielding: even a very short-lived shell's
 * original PID has not yet been reaped by this event loop. Capture its start
 * identity and group while custody is still anchored; never infer a new owner
 * from that numeric group after the shell has disappeared. No command executes
 * synchronously. macOS ps is capped at 250ms; ordinary polling stays async. */
function initialProcesses(): ProcessIdentity[] | null {
  if (process.platform === "linux") return linuxProcesses();
  try { return parsePs(execFileSync("/bin/ps", PS_ARGS, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 250,
    maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}

/** Only process metadata is inspected. Linux start ticks fence recycled PIDs;
 * macOS uses the process start stamp together with the original parent/group.
 * No command lines or environment values are read. */
async function processes(): Promise<ProcessIdentity[] | null> {
  if (process.platform === "linux") {
    return linuxProcesses();
  }
  return new Promise(resolve => {
    execFile("/bin/ps", PS_ARGS,
      { env: { ...process.env, LC_ALL: "C" }, timeout: 1_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) { resolve(null); return; }
        resolve(parsePs(stdout));
      });
  });
}

/** The execution result and the request to stop are separate facts. An abort,
 * timeout or output cap cannot settle while the original child/known descendants
 * are still running. Unconfirmed termination retains the launch's owned scratch.
 * Detached descendants seen before reparenting remain tracked by start identity;
 * this is process cleanup, not an OS containment boundary for arbitrary daemons. */
export function executeOwnedShell(launch: OwnedShellLaunch, options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  stopWaitMs?: number;
  maxOutputBytes?: number;
}): Promise<OwnedShellResult> {
  const cleanup = () => launch.cleanup?.();
  if (options.signal?.aborted) {
    cleanup();
    return Promise.reject(Object.assign(new Error("cancelled before shell start"), { code: "SHELL_CANCELLED" }));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.file, launch.args, { cwd: options.cwd, env: options.env,
        detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      try { cleanup(); } catch (cleanupError) { reject(cleanupError); return; }
      reject(error); return;
    }
    let closed = false, exited = false, settled = false, inspecting = false, delivered = false;
    let code: number | null = null, failure: Error | null = null, stopReason: string | null = null;
    let bytes = 0, out = "", err = "", stopDeadline = Infinity;
    let windowsKill: "idle" | "pending" | "confirmed" | "unknown" = "idle";
    const known = new Map<number, ProcessIdentity>(), stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
    let originalGroupIdentity: string | null = null, groupRetired = false;
    const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const stopWaitMs = options.stopWaitMs ?? 5_000;
    let poll: ReturnType<typeof setInterval>;
    const rootLive = () => !!child.pid && !exited && child.exitCode === null && child.signalCode === null;

    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearInterval(poll);
      options.signal?.removeEventListener("abort", abort);
      if (!confirmed) {
        if (delivered) console.warn("SHELL_STOP_UNCONFIRMED: owned background scratch retained");
        reject(Object.assign(new Error(`SHELL_STOP_UNCONFIRMED: ${stopReason ?? "shell termination"}; owned scratch retained`), { code: "SHELL_STOP_UNCONFIRMED" }));
        return;
      }
      try { cleanup(); } catch (error) {
        reject(Object.assign(new Error(`SHELL_CLEANUP_FAILED: ${error instanceof Error ? error.message : "unknown"}`), { code: "SHELL_CLEANUP_FAILED" })); return;
      }
      if (failure && !stopReason) { reject(failure); return; }
      resolve({ code, out, err, stopReason });
    };
    const retainBackground = (rows: ProcessIdentity[] = []) => {
      if (delivered || settled) return;
      if (rows.some(row => row.group === child.pid && known.get(row.pid)?.identity === row.identity)) {
        for (const row of rows) if (row.group === child.pid && !known.has(row.pid)) known.set(row.pid, row);
      }
      delivered = true;
      clearTimeout(timeout); clearInterval(poll);
      // A normal shell exit may intentionally leave a background service. Its
      // scratch remains owned until the observed descendants stop; the original
      // run's AbortSignal still closes that service when the run is cancelled.
      poll = setInterval(() => { void inspect(); }, 1_000);
      poll.unref?.();
      resolve({ code, out, err, stopReason: null });
    };
    const killWindows = () => {
      if (windowsKill !== "idle" || !rootLive()) return;
      windowsKill = "pending";
      const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
      execFile(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: Math.max(250, Math.min(stopWaitMs, 3_000)) }, error => {
          windowsKill = error ? "unknown" : "confirmed"; void inspect();
        });
    };
    const stop = (reason: string) => {
      if (settled) return;
      if (!stopReason) { stopReason = reason; stopDeadline = Date.now() + stopWaitMs; }
      if (delivered) {
        clearInterval(poll);
        poll = setInterval(() => { void inspect(); }, 50);
        poll.unref?.();
      }
      if (process.platform === "win32") killWindows();
      else if (rootLive()) {
        // detached:true established this group while the ChildProcess still
        // owns its leader. Never discover/kill a recycled numeric root later.
        try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* observation still required */ } }
      }
      void inspect();
    };
    const abort = () => stop("cancelled");
    const collect = (chunk: Buffer, output: "out" | "err") => {
      if (settled || stopReason) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { stop("output exceeded 8MB, truncated"); return; }
      // The protocol renders 12,000 characters; bounded storage avoids keeping
      // megabytes merely to truncate them after the process ends.
      if (output === "out") out = (out + stdout.write(chunk)).slice(0, 12_000);
      else err = (err + stderr.write(chunk)).slice(0, 12_000);
    };
    const inspect = async () => {
      if (settled || inspecting) return;
      inspecting = true;
      try {
        if (process.platform === "win32") {
          if (closed && (!stopReason || windowsKill === "confirmed" || !child.pid)) finish(true);
        } else if (!child.pid) {
          if (closed) finish(true);
        } else {
          const observedAfterExit = exited, observedRootLive = rootLive();
          const rows = await processes();
          if (settled) return;
          if (!rows && closed && !stopReason) retainBackground();
          if (rows) {
            const current = new Map(rows.map(row => [row.pid, row]));
            const root = current.get(child.pid);
            const rootAnchor = !groupRetired && observedRootLive && root?.ppid === process.pid && root.group === child.pid
              && (!known.has(root.pid) || known.get(root.pid)?.identity === root.identity);
            if (rootAnchor && root && !known.has(root.pid)) known.set(root.pid, root);
            if (rootAnchor && root) originalGroupIdentity ??= root.identity;
            // The detached group was captured while its original leader was
            // still ours. Keep that custody across the leader's exit, but retire
            // it permanently on observed absence or a replacement leader stamp.
            // Descendants born after the initial snapshot otherwise fall in a
            // gap when a short shell exits before the next ps callback.
            const group = rows.filter(row => row.group === child.pid && !row.zombie);
            if (originalGroupIdentity && (root && root.identity !== originalGroupIdentity || group.length === 0)) groupRetired = true;
            const groupAnchor = !groupRetired && (rootAnchor || originalGroupIdentity !== null
              || rows.some(row => row.group === child.pid && known.get(row.pid)?.identity === row.identity));
            if (groupAnchor) for (const row of rows) {
              if (row.group === child.pid && !known.has(row.pid)) known.set(row.pid, row);
            }
            // Follow every generation, including descendants which called
            // setsid. Once captured, reparenting does not discard their identity.
            let added = true;
            while (added) {
              added = false;
              for (const row of rows) {
                if (known.has(row.pid)) continue;
                const parent = known.get(row.ppid), actual = current.get(row.ppid);
                if (parent && actual?.identity === parent.identity) { known.set(row.pid, row); added = true; }
              }
            }
            const live = [...known.values()].filter(row => {
              const actual = current.get(row.pid);
              return actual?.identity === row.identity && !actual.zombie;
            });
            if (stopReason) {
              if (!groupRetired && group.some(row => known.get(row.pid)?.identity === row.identity)) {
                try { process.kill(-child.pid, "SIGKILL"); } catch { /* per-process checks and observation still own proof */ }
              }
              for (const row of live) {
                // Each signal uses the snapshot's same start identity; no PID
                // is rediscovered after its tracked process disappeared.
                if (process.platform === "linux") {
                  try {
                    const stat = fs.readFileSync(`/proc/${row.pid}/stat`, "utf8");
                    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== row.identity) continue;
                  } catch { continue; }
                }
                try { process.kill(row.pid, "SIGKILL"); } catch { /* next snapshot proves exit or retains custody */ }
              }
            }
            if (closed && live.length === 0 && group.length === 0) finish(true);
            else if (closed && observedAfterExit && !stopReason) retainBackground(rows);
          }
        }
        if (!settled && Date.now() >= stopDeadline) finish(false);
      } catch { if (!settled && Date.now() >= stopDeadline) finish(false); }
      finally { inspecting = false; }
    };
    const timeout = setTimeout(() => stop(`timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    poll = setInterval(() => { void inspect(); }, 50);
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "err"));
    child.once("error", error => { failure = error; });
    child.once("exit", () => { exited = true; void inspect(); });
    child.once("close", exit => {
      closed = true; exited = true; code = exit;
      // Full-access background services have no owned sandbox scratch to keep.
      // Preserve their existing successful-return behavior without an implicit stop.
      if (!stopReason && !launch.cleanup) finish(true);
      else void inspect();
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (process.platform !== "win32" && child.pid) {
      const rows = initialProcesses(), root = rows?.find(row => row.pid === child.pid);
      if (root?.ppid === process.pid && root.group === child.pid) {
        originalGroupIdentity = root.identity;
        known.set(root.pid, root);
        for (const row of rows!) if (row.group === child.pid) known.set(row.pid, row);
      }
    }
    // The signal can fire between the preflight and listener registration.
    if (options.signal?.aborted) abort();
    else void inspect();
  });
}
