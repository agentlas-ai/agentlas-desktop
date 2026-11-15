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
import { setResourceWork } from "../diagnostics/resource-sampler";
import { observeLocalProcessIdentity } from "../local-model-hub/platform";
import { commandLineShellSpawn, killCliTree } from "../runtime/exec";
import { survivingHiddenSpawn } from "../runtime/windows-hidden-detach";

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
  /** Output the 16 MiB cap has already cut away from the start of output.log, all caps together (0 = none). `bytes` no longer counts it. */
  droppedBytes: number;
}

const ID_RE = /^b[0-9a-z]{8}$/;
const MAX_COMMAND = 16_384;
const MAX_DESCRIPTION = 240;
const DEFAULT_TAIL = 16_384;
const MAX_TAIL = 262_144;
const TERMINAL: ReadonlySet<BackgroundTaskStatus> = new Set(["completed", "failed", "stopped", "lost"]);
const STOP_GRACE_MS = 5_000;
/**
 * output.log over this is cut to its last OUTPUT_KEEP_BYTES (a render's progress lines can run for days).
 * basis: 정한 값 — 근거 없음 (both). Reached: the first bytes of the log are gone; the file starts with a one-line note that says how many (all caps added up), and output() reports it as droppedBytes.
 */
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const OUTPUT_KEEP_BYTES = 4 * 1024 * 1024;
/** The note capOutput writes at the head of a capped log. A host-written fixed line (not model or user text), so reading it back is exact. */
const OUTPUT_CAP_NOTE = /^\[agentlasd\] output passed \d+ bytes; the first (\d+) bytes were dropped\n/;
// basis: 계산 — the note is 88 characters with a 16-digit count (a safe integer is at most 16 digits), so 160 bytes always hold it whole. Reached (a longer head): the note is not recognised and droppedBytes reads 0, never an error.
const OUTPUT_CAP_NOTE_MAX_BYTES = 160;
function readCapNote(fd: number): { dropped: number; noteBytes: number } {
  try {
    const head = Buffer.alloc(OUTPUT_CAP_NOTE_MAX_BYTES);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const m = OUTPUT_CAP_NOTE.exec(head.toString("utf8", 0, n));
    return m ? { dropped: Number(m[1]), noteBytes: Buffer.byteLength(m[0]) } : { dropped: 0, noteBytes: 0 };
  } catch { return { dropped: 0, noteBytes: 0 }; }
}
const FINISHED_RETENTION_MS = 7 * 86_400_000;
/** While a task runs (or a lost one still writes), its output.log is checked against the cap this often. */
const MAINTENANCE_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 3_600_000;
/** setTimeout cannot wait longer than this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
  /** Lost tasks whose process still ran when this service started: their output.log can still grow. */
  private readonly lostAlive = new Set<string>();
  private lastPruneAt = 0;
  /** Output-cap timer: exists only while a task of this service runs or a lost task still writes. */
  private upkeepTimer: NodeJS.Timeout | null = null;
  /** One timer aimed at the moment the oldest finished task passes the retention; none when nothing is finished. */
  private pruneTimer: NodeJS.Timeout | null = null;
  private pruneDueAt = Infinity;
  private disposed = false;

  constructor(private readonly root: string, private readonly opts: {
    serviceInstance: string;
    now?: () => Date;
    shell?: string;
    processStartTime?: (pid: number) => Promise<string | null>;
  }) {
    // No timer here: an idle registry wakes nothing. Upkeep is armed by a running task or a surviving lost task,
    // and the prune timer by a task's end time (see armUpkeep, armPruneAt).
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /** Output-cap pass every 30 s, only while there is a file that can still grow. Stops itself when none is left. */
  private armUpkeep(): void {
    if (this.disposed || this.upkeepTimer || (this.children.size === 0 && this.lostAlive.size === 0)) return;
    this.upkeepTimer = setTimeout(() => {
      this.upkeepTimer = null;
      try { this.maintain(); } catch { /* the next pass retries */ }
      this.armUpkeep();
    }, MAINTENANCE_INTERVAL_MS);
    this.upkeepTimer.unref?.();
  }

  /** Aims the single prune timer at `dueMs` (epoch ms of this registry's clock) unless an earlier aim exists. */
  private armPruneAt(dueMs: number): void {
    if (this.disposed || (this.pruneTimer && this.pruneDueAt <= dueMs)) return;
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    const nowMs = (this.opts.now?.() ?? new Date()).getTime();
    this.pruneDueAt = dueMs;
    // A clock that moved makes the timer early or late; the pass re-checks every record and re-aims.
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      this.pruneDueAt = Infinity;
      try { this.pruneFinished(); } catch { /* the next signal retries */ }
    }, Math.min(MAX_TIMER_MS, Math.max(1_000, dueMs - nowMs)));
    this.pruneTimer.unref?.();
  }

  /** Ends both timers (service shutdown). */
  dispose(): void {
    this.disposed = true;
    if (this.upkeepTimer) clearTimeout(this.upkeepTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.upkeepTimer = this.pruneTimer = null;
    this.pruneDueAt = Infinity;
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
      // Its own process group, so stop() ends the whole command line (pipes, subshells), not only the shell, and it
      // outlives the service. On Windows a detached cmd.exe had no console, so every console program the command ran
      // opened its own visible window; survivingHiddenSpawn starts it from a detached launcher with a hidden console
      // instead (still outside the service's job; stop()'s tree kill on the launcher reaches the command).
      const shell = commandLineShellSpawn(command, this.opts.shell, cwd);
      const plan = survivingHiddenSpawn({
        command: shell.file, args: shell.args, cwd, env, stdio: ["ignore", out, out],
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
      });
      child = spawn(plan.command, plan.args, plan.options);
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
    setResourceWork("background-tasks", true);
    this.armUpkeep();
    const settle = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (!this.children.has(id)) return;
      this.children.delete(id);
      if (this.children.size === 0) setResourceWork("background-tasks", false);
      if (spawnError) fs.appendFileSync(outputPath, `\n[agentlasd] could not start: ${spawnError.message}\n`);
      const status: BackgroundTaskStatus = this.stopRequested.delete(id) ? "stopped" : code === 0 ? "completed" : "failed";
      const settled = { ...(this.get(id) ?? record), status, exitCode: code, signal: signal ?? null, endedAt: this.now() };
      this.write(settled);
      this.armPruneAt(Date.parse(settled.endedAt) + FINISHED_RETENTION_MS);
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
    let droppedBytes = 0;
    try {
      bytes = fs.statSync(record.outputPath).size;
      const fd = fs.openSync(record.outputPath, "r");
      try {
        const length = Math.min(limit, bytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, bytes - length);
        text = buffer.toString("utf8");
        droppedBytes = readCapNote(fd).dropped;
      } finally { fs.closeSync(fd); }
    } catch { /* no output yet */ }
    return { id, status: record.status, text, bytes, truncated: bytes > limit, droppedBytes };
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
    for (const id of [...this.lostAlive]) {
      const record = this.get(id);
      if (record?.pid && pidAlive(record.pid)) { this.capOutput(record.outputPath); continue; }
      // It ended since the last pass: it is now an ordinary finished task and may already be old enough to prune.
      this.lostAlive.delete(id);
      this.lastPruneAt = 0;
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
      // An earlier cap left its own note at the head: its dropped count carries over and its own bytes are not task output, so the new note counts everything cut since the task began.
      const earlier = readCapNote(fd);
      const dropped = earlier.dropped + (size - earlier.noteBytes - read);
      const note = Buffer.from(`[agentlasd] output passed ${OUTPUT_CAP_BYTES} bytes; the first ${dropped} bytes were dropped\n`);
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
    let nextDue = Infinity;
    for (const record of this.list()) {
      if (!TERMINAL.has(record.status) || !record.endedAt || this.children.has(record.id)) continue;
      const due = Date.parse(record.endedAt) + FINISHED_RETENTION_MS;
      if (now < due) { nextDue = Math.min(nextDue, due); continue; }
      if (record.status === "lost" && pidAlive(record.pid)) continue;
      try { fs.rmSync(this.dir(record.id), { recursive: true, force: true }); removed.push(record.id); } catch { /* next pass */ }
    }
    // Aim at the next task to expire; a surviving lost task re-enters through maintain() when its process ends.
    if (nextDue !== Infinity) this.armPruneAt(nextDue);
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
    // One look at every lost task whose process still runs; after this, only its own end is watched.
    for (const record of this.list({ status: "lost" })) if (record.pid && pidAlive(record.pid)) this.lostAlive.add(record.id);
    this.armUpkeep();
    this.pruneFinished();
    return lost;
  }

  /** Stop every task this instance runs (service shutdown). Their records end as "stopped". */
  stopAll(): void {
    this.dispose();
    for (const id of [...this.children.keys()]) {
      try { this.stop(id); } catch { /* already settled */ }
    }
  }
}
