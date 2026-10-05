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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

  constructor(private readonly root: string, private readonly opts: {
    serviceInstance: string;
    now?: () => Date;
    shell?: string;
  }) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
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
      child = spawn(this.opts.shell ?? process.env.SHELL ?? "/bin/zsh", ["-lc", command],
        { cwd, env, detached: true, stdio: ["ignore", out, out] });
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
    if (TERMINAL.has(record.status)) return record;
    const child = this.children.get(id);
    if (!child?.pid) throw new Error("background_task_not_owned");
    this.stopRequested.add(id);
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
    const pid = child.pid;
    setTimeout(() => { if (this.children.has(id)) { try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ } } }, 5_000).unref?.();
    return { ...record };
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
    return lost;
  }

  /** Stop every task this instance runs (service shutdown). Their records end as "stopped". */
  stopAll(): void {
    for (const id of [...this.children.keys()]) {
      try { this.stop(id); } catch { /* already settled */ }
    }
  }
}
