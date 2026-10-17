// agentlasd background tasks — a long command started once, addressed by a short id afterwards.
//
// One (or the Terminal) hands the service a command it does not want to hold a model turn for: a render, a
// download, "wait until the release workflow finishes". The service runs it, writes its output to a file as it
// goes, and answers by id: status, the output's tail, stop. A client may subscribe and is told when a task ends.
// Owner request 2026-10-05, after a Claude Code session resumed its own background tasks by id
// ("bmva82uyu, b6khqix67") across a restart.
//
// Durable state is a directory per task under the service's user data (task.json + output.log), not a store
// table: a table is a schema ladder step the Terminal would also have to learn before it could open the store.
// Output goes straight to the file descriptor, so it survives the service. A task this service instance did not
// start (the service restarted while it ran) cannot report its exit any more; it is marked "lost" with the time
// the service noticed — never "completed" — and its output so far stays readable.
//
// Every OS: the shell comes from runtime/exec (cmd.exe /d /s /c on Windows; a shell that exists on macOS and Linux),
// and stop ends the whole tree (process group, or taskkill /T). A lost task can still be stopped when its pid still
// names the process it started (pid plus process start time). output.log is capped, and finished task directories
// are removed after 7 days.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { observeLocalProcessIdentity } from "../local-model-hub/platform";
import { commandLineShellSpawn, killCliTree } from "../runtime/exec";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "lost";

export interface BackgroundTaskOwner {
  kind: "one" | "terminal" | "desktop";
  chatId: string | null;
  agentId: string | null;
}

export interface BackgroundTaskRecord {
  schemaVersion: "agentlas.background-task.v1";
  id: string;
  description: string;
  command: string;
  cwd: string;
  owner: BackgroundTaskOwner;
  status: BackgroundTaskStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string | null;
  /** The service instance that started it; another instance cannot observe its exit. */
  serviceInstance: string;
  outputPath: string;
  /**
   * The OS's start time for `pid`, recorded shortly after start. With `pid` it proves a later process is still
   * this task before a lost task is stopped. Absent in older records and when the OS would not say.
   */
  processStartedAt?: string | null;
}

export interface BackgroundTaskStartInput {
  command: string;
  description?: string;
  cwd?: string;
  owner?: Partial<BackgroundTaskOwner>;
  env?: NodeJS.ProcessEnv;
}

export interface BackgroundTaskOutput {
  id: string;
  status: BackgroundTaskStatus;
  text: string;
  /** Bytes of output.log in total; text is its last `tailBytes`. */
  bytes: number;
  truncated: boolean;
}

const ID_RE = /^b[0-9a-z]{8}$/;
const MAX_COMMAND = 16_384;
const MAX_DESCRIPTION = 240;
const DEFAULT_TAIL = 16_384;
const MAX_TAIL = 262_144;
const TERMINAL: ReadonlySet<BackgroundTaskStatus> = new Set(["completed", "failed", "stopped", "lost"]);
const STOP_GRACE_MS = 5_000;
/** output.log over this is cut to its last OUTPUT_KEEP_BYTES (a render's progress lines can run for days). */
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const OUTPUT_KEEP_BYTES = 4 * 1024 * 1024;
const FINISHED_RETENTION_MS = 7 * 86_400_000;
const MAINTENANCE_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 3_600_000;

/** The OS's start time for a pid: `ps -o lstart=` on macOS and Linux, Win32_Process.CreationDate on Windows. */
async function defaultProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform === "win32") return (await observeLocalProcessIdentity(pid))?.createdAt ?? null;
  for (const ps of ["/bin/ps", "/usr/bin/ps"]) {
    if (!fs.existsSync(ps)) continue;
    const text = await new Promise<string>((resolve) => {
      execFile(ps, ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } },
        (error, stdout) => resolve(error ? "" : String(stdout)));
    });
    return text.trim() || null;
  }
  return null;
}

function newTaskId(): string {
  // "b" + 8 base36 characters, like the ids the owner already reads in Claude Code.
  return `b${BigInt(`0x${randomBytes(6).toString("hex")}`).toString(36).padStart(8, "0").slice(-8)}`;
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class BackgroundTaskRegistry {
  private readonly children = new Map<string, ChildProcess>();
  private readonly stopRequested = new Set<string>();
  private readonly listeners = new Set<(record: BackgroundTaskRecord) => void>();
  private readonly lostStops = new Set<string>();
  private lastPruneAt = 0;

  constructor(private readonly root: string, private readonly opts: {
    serviceInstance: string;
    now?: () => Date;
    shell?: string;
    processStartTime?: (pid: number) => Promise<string | null>;
  }) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    setInterval(() => { try { this.maintain(); } catch { /* the next pass retries */ } }, MAINTENANCE_INTERVAL_MS).unref?.();
  }

  private processStartTime(pid: number): Promise<string | null> {
    return (this.opts.processStartTime ?? defaultProcessStartTime)(pid).catch(() => null);
  }

  private now(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private dir(id: string): string {
    if (!ID_RE.test(id)) throw new Error("background_task_id_invalid");
    return path.join(this.root, id);
  }
  private write(record: BackgroundTaskRecord): void {
    const file = path.join(this.dir(record.id), "task.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  get(id: string): BackgroundTaskRecord | null {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.dir(id), "task.json"), "utf8")) as BackgroundTaskRecord;
      return record?.schemaVersion === "agentlas.background-task.v1" && record.id === id ? record : null;
    } catch { return null; }
  }

  list(filter: { chatId?: string | null; status?: BackgroundTaskStatus } = {}): BackgroundTaskRecord[] {
    let ids: string[] = [];
    try { ids = fs.readdirSync(this.root).filter((name) => ID_RE.test(name)); } catch { return []; }
    return ids.map((id) => this.get(id)).filter((record): record is BackgroundTaskRecord => Boolean(record))
      .filter((record) => filter.chatId === undefined || record.owner.chatId === filter.chatId)
      .filter((record) => !filter.status || record.status === filter.status)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Tasks this service is running now (they keep the service up). */
  running(): number { return this.children.size; }

  onSettled(listener: (record: BackgroundTaskRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(input: BackgroundTaskStartInput): BackgroundTaskRecord {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) throw new Error("background_task_command_required");
    if (command.length > MAX_COMMAND) throw new Error("background_task_command_too_long");
    const cwd = path.resolve(input.cwd && input.cwd.trim() ? input.cwd : process.env.HOME || this.root);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("background_task_cwd_missing");
    let id = newTaskId();
    while (fs.existsSync(path.join(this.root, id))) id = newTaskId();
    const dir = this.dir(id);
    fs.mkdirSync(dir, { mode: 0o700 });
    const outputPath = path.join(dir, "output.log");
    const out = fs.openSync(outputPath, "a", 0o600);
    const env = { ...(input.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    let child: ChildProcess;
    try {
      // Its own process group, so stop() ends the whole command line (pipes, subshells), not only the shell.
      // On Windows, detached keeps the task out of the service's job object, so it outlives the service as on POSIX.
      const shell = commandLineShellSpawn(command, this.opts.shell);
      child = spawn(shell.file, shell.args, {
        cwd, env, detached: true, stdio: ["ignore", out, out],
        windowsHide: true, windowsVerbatimArguments: shell.windowsVerbatimArguments,
      });
    } finally {
      fs.closeSync(out);
    }
    const record: BackgroundTaskRecord = {
      schemaVersion: "agentlas.background-task.v1", id,
      description: (input.description ?? "").trim().slice(0, MAX_DESCRIPTION) || command.slice(0, 80),
      command, cwd,
      owner: { kind: input.owner?.kind ?? "terminal", chatId: input.owner?.chatId ?? null, agentId: input.owner?.agentId ?? null },
      status: "running", pid: child.pid ?? null, exitCode: null, signal: null,
      startedAt: this.now(), endedAt: null, serviceInstance: this.opts.serviceInstance, outputPath,
    };
    this.write(record);
    this.children.set(id, child);
    const settle = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (!this.children.has(id)) return;
      this.children.delete(id);
      if (spawnError) fs.appendFileSync(outputPath, `\n[agentlasd] could not start: ${spawnError.message}\n`);
      const status: BackgroundTaskStatus = this.stopRequested.delete(id) ? "stopped" : code === 0 ? "completed" : "failed";
      const settled = { ...(this.get(id) ?? record), status, exitCode: code, signal: signal ?? null, endedAt: this.now() };
      this.write(settled);
      for (const listener of this.listeners) {
        try { listener(settled); } catch { /* a listener cannot change how the task ended */ }
      }
    };
    child.once("exit", (code, signal) => settle(code, signal));
    child.once("error", (error) => settle(null, null, error));
    child.unref();
    const pid = child.pid;
    if (pid) {
      void this.processStartTime(pid).then((processStartedAt) => {
        const current = this.get(id);
        if (processStartedAt && current?.status === "running" && current.pid === pid) this.write({ ...current, processStartedAt });
      });
    }
    return record;
  }

  output(id: string, tailBytes = DEFAULT_TAIL): BackgroundTaskOutput {
    const record = this.get(id);
    if (!record) throw new Error("background_task_not_found");
    const limit = Math.min(MAX_TAIL, Math.max(1, Math.floor(tailBytes) || DEFAULT_TAIL));
    let bytes = 0;
    let text = "";
    try {
      bytes = fs.statSync(record.outputPath).size;
      const fd = fs.openSync(record.outputPath, "r");
      try {
        const length = Math.min(limit, bytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, bytes - length);
        text = buffer.toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { /* no output yet */ }
    return { id, status: record.status, text, bytes, truncated: bytes > limit };
  }

  stop(id: string): BackgroundTaskRecord {
    const record = this.get(id);
    if (!record) throw new Error("background_task_not_found");
    if (record.status === "lost") return this.stopLost(record);
    if (TERMINAL.has(record.status)) return record;
    const child = this.children.get(id);
    if (!child?.pid) throw new Error("background_task_not_owned");
    this.stopRequested.add(id);
    // Process group SIGTERM then SIGKILL on POSIX; taskkill /T then /F on Windows.
    killCliTree(child, STOP_GRACE_MS);
    return { ...record };
  }

  /**
   * A task an earlier service started may still run ("detached_still_running"). It is stopped only while its pid
   * still names that process: the OS start time must equal the one recorded at start, before each signal. A reused
   * pid is never signalled. The task stays "lost" (its exit was never observed); `signal` records the outcome:
   * stop_requested, then detached_stopped or stop_refused_process_changed.
   */
  private stopLost(record: BackgroundTaskRecord): BackgroundTaskRecord {
    const pid = record.pid;
    const expected = record.processStartedAt;
    if (!pid || !expected || !pidAlive(pid) || this.lostStops.has(record.id)) return record;
    this.lostStops.add(record.id);
    const requested: BackgroundTaskRecord = { ...record, signal: "stop_requested" };
    this.write(requested);
    const settle = (signal: string) => {
      this.lostStops.delete(record.id);
      const current = this.get(record.id);
      if (current?.status === "lost") this.write({ ...current, signal });
    };
    const sameProcess = async () => (await this.processStartTime(pid)) === expected;
    void (async () => {
      if (!await sameProcess()) return settle("stop_refused_process_changed");
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => undefined);
        killer.unref?.();
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* exited */ } }
      }
      const deadline = Date.now() + STOP_GRACE_MS;
      while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (pidAlive(pid) && process.platform !== "win32") {
        if (!await sameProcess()) return settle("stop_refused_process_changed");
        try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
      }
      settle("detached_stopped");
    })().catch(() => settle("stop_requested"));
    return requested;
  }

  /**
   * Periodic upkeep: cap the output of tasks this instance runs and of lost tasks that still run, and prune
   * finished tasks hourly. The cap keeps the last OUTPUT_KEEP_BYTES behind a one-line note. It is lossy by design:
   * a line the task writes during the cut can be lost.
   */
  maintain(): void {
    for (const id of this.children.keys()) {
      const record = this.get(id);
      if (record) this.capOutput(record.outputPath);
    }
    // A task an earlier service started keeps appending after an update restarts the service
    // (detached_still_running). Unlike stopLost, no start-time check: capping a file this service owns is harmless
    // even if the pid was reused, and maintain() stays synchronous.
    for (const record of this.list({ status: "lost" })) {
      if (record.pid && pidAlive(record.pid)) this.capOutput(record.outputPath);
    }
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.pruneFinished();
  }

  private capOutput(file: string): void {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size <= OUTPUT_CAP_BYTES) return;
    const fd = fs.openSync(file, "r+");
    try {
      const keep = Buffer.alloc(OUTPUT_KEEP_BYTES);
      const read = fs.readSync(fd, keep, 0, OUTPUT_KEEP_BYTES, size - OUTPUT_KEEP_BYTES);
      const note = Buffer.from(`[agentlasd] output passed ${OUTPUT_CAP_BYTES} bytes; the first ${size - read} bytes were dropped\n`);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, note, 0, note.length, 0);
      fs.writeSync(fd, keep, 0, read, note.length);
    } finally { fs.closeSync(fd); }
  }

  /**
   * Removes task directories that finished more than 7 days ago. A lost task whose pid is still alive is kept: it
   * may still be writing its output.
   */
  pruneFinished(): string[] {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    this.lastPruneAt = now;
    const removed: string[] = [];
    for (const record of this.list()) {
      if (!TERMINAL.has(record.status) || !record.endedAt || this.children.has(record.id)) continue;
      if (now - Date.parse(record.endedAt) < FINISHED_RETENTION_MS) continue;
      if (record.status === "lost" && pidAlive(record.pid)) continue;
      try { fs.rmSync(this.dir(record.id), { recursive: true, force: true }); removed.push(record.id); } catch { /* next pass */ }
    }
    return removed;
  }

  /**
   * At service start: a task left "running" by another service instance can no longer report its exit. It is
   * marked "lost" (whether or not its process still runs; the pid is kept so a client can tell) and returned so
   * the owner can be told it did not finish under the service.
   */
  recoverOrphans(): BackgroundTaskRecord[] {
    const lost: BackgroundTaskRecord[] = [];
    for (const record of this.list({ status: "running" })) {
      if (record.serviceInstance === this.opts.serviceInstance) continue;
      const settled: BackgroundTaskRecord = { ...record, status: "lost", endedAt: this.now(),
        signal: pidAlive(record.pid) ? "detached_still_running" : null };
      this.write(settled);
      lost.push(settled);
    }
    this.pruneFinished();
    return lost;
  }

  /** Stop every task this instance runs (service shutdown). Their records end as "stopped". */
  stopAll(): void {
    for (const id of [...this.children.keys()]) {
      try { this.stop(id); } catch { /* already settled */ }
    }
  }
}
