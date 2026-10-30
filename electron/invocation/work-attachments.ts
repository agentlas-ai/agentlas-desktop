import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpInvocationRequest, McpInvocationEvent } from "../../shared/types";
import { workChatFileInputs, readWorkChatFileEntry, type WorkChatFileInput } from "../store/chat-message-attachments";
import { ownProcessStartToken, processState } from "../store/terminal-owner-liveness";

interface WorkInputRun {
  chatId: string;
  runId: string;
  readGroups: () => string[];
  signal: AbortSignal;
  cwd: string | null;
  cwdIdentity: {dev:number;ino:number} | null;
  directoryIdentity: {dev:number;ino:number} | null;
  directory: string | null;
  context: string;
  aliases: Array<{ path: string; replacement: string }>;
  inputs: Map<string, { dev: number; ino: number }>;
  pending?: Promise<void>;
  closed: boolean;
}
const runs = new Map<string, WorkInputRun>();
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function owner(req: Pick<McpInvocationRequest, "runId" | "chatId">): WorkInputRun | null {
  if (!req.runId) return null;
  const record = runs.get(req.runId);
  if (!record) return null;
  if (record.chatId !== req.chatId || record.closed) return fail("work_attachment_run_binding_changed");
  record.signal.throwIfAborted();
  return record;
}
export function workAttachmentGroupIds(text: string): string[] {
  return [...new Set([...text.matchAll(/<!--\s*agentlas-chat-files:v1:([0-9a-f-]{36})\s*-->/giu)].map(match => match[1]))];
}

/** Called by the invocation service only, never accepted from an IPC request. */
export function bindWorkAttachmentRun(input: { runId: string; chatId: string; signal: AbortSignal; readGroups: () => string[] }): void {
  if (runs.has(input.runId)) fail("work_attachment_run_already_bound");
  runs.set(input.runId, { ...input, cwd: null, cwdIdentity: null, directoryIdentity: null, directory: null, context: "", aliases: [], inputs: new Map(), closed: false });
}

function ensureDirectory(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (part === "." || part === "..") fail("work_attachment_directory_invalid");
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail("work_attachment_directory_changed");
  }
  return current;
}

/*
 * The owner's attached files are copied into <cwd>/.agentlas/work-inputs/<uuid>/ for the run and removed by releaseWorkAttachmentRun,
 * which works from this process's memory. A process that dies mid-run (a crash, an update, a power cut) never reaches it, so the
 * private copies stayed in the project folder for good, where the owner may commit them. Every directory now carries a small owner
 * marker, and the next staging in that folder (and the app's start, work-inputs-startup-sweep.ts) considers owner liveness.
 * Unknown ownership is retained; a missing owner process alone does not establish that every child reader has stopped.
 */
const PROCESS_EPOCH = randomUUID();
const OWNER_MARKER = ".agentlas-owner.json";
/** Looking at one folder costs a directory read and, for a live foreign owner, a process lookup: not more often than this. */
const SWEEP_EVERY_MS = 60_000;
const STAGING_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sweptAt = new Map<string, number>();

interface WorkInputOwnerMarker { schemaVersion: 1; runId: string; epoch: string; pid: number; startToken: string | null; host: string; createdAt: number }

function writeOwnerMarker(directory: string, runId: string): void {
  try {
    const marker: WorkInputOwnerMarker = { schemaVersion: 1, runId, epoch: PROCESS_EPOCH, pid: process.pid, startToken: ownProcessStartToken(), host: os.hostname(), createdAt: Date.now() };
    fs.writeFileSync(path.join(directory, OWNER_MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
  } catch { /* Without an owner marker, later sweeps must preserve the directory. */ }
}

async function readOwnerMarker(directory: string): Promise<WorkInputOwnerMarker | null> {
  try {
    const file = path.join(directory, OWNER_MARKER);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const value = JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || typeof value.epoch !== "string" || typeof value.host !== "string"
      || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
    return { schemaVersion: 1, runId: typeof value.runId === "string" ? value.runId : "", epoch: value.epoch, pid: value.pid as number,
      startToken: typeof value.startToken === "string" ? value.startToken : null, host: value.host, createdAt: value.createdAt };
  } catch { return null; }
}

export type WorkInputSweepReason = "own_process_untracked" | "owner_gone" | "stale" | "run_live" | "owner_alive" | "young" | "identity_changed" | "unreadable" | "ownership_unknown";

/** Decide from the currently known owner state. The dead-owner cases still need a child-reader settlement fence. */
async function orphanVerdict(directory: string): Promise<{ remove: boolean; reason: WorkInputSweepReason }> {
  // Looked up fresh for every directory: a run of this process that started staging meanwhile is never taken for an orphan.
  for (const record of runs.values()) if (record.directory === directory) return { remove: false, reason: "run_live" };
  const marker = await readOwnerMarker(directory);
  // This process's own directory that no run of it tracks any more (a release that failed): nothing of this process can be using it.
  if (marker?.epoch === PROCESS_EPOCH) return { remove: true, reason: "own_process_untracked" };
  if (marker && marker.host === os.hostname()) {
    const owner = processState(marker.pid, marker.startToken);
    if (owner === "gone") return { remove: true, reason: "owner_gone" };
    if (owner === "alive") return { remove: false, reason: "owner_alive" };
  }
  // Age is not evidence that an unreadable, remote, or otherwise unknown
  // owner has stopped using the copy. Preserve it for ownership recovery.
  return { remove: false, reason: "ownership_unknown" };
}

/**
 * Remove the input copies a dead process left in `<cwd>/.agentlas/work-inputs`. Never throws and never blocks a run; a directory it cannot
 * judge stays and is looked at again. Only entries named like a staging directory, real directories (no links) under a real
 * `.agentlas/work-inputs`, are considered.
 */
export async function sweepOrphanedWorkInputs(cwd: string, options: { now?: number; force?: boolean } = {}): Promise<{ removed: number; kept: number; reasons: Partial<Record<WorkInputSweepReason, number>> }> {
  const result = { removed: 0, kept: 0, reasons: {} as Partial<Record<WorkInputSweepReason, number>> };
  const note = (reason: WorkInputSweepReason, removed: boolean) => { if (removed) result.removed += 1; else result.kept += 1; result.reasons[reason] = (result.reasons[reason] ?? 0) + 1; };
  let parent: string;
  try {
    const root = await fs.promises.realpath(cwd);
    const agentlas = path.join(root, ".agentlas"), staging = path.join(agentlas, "work-inputs");
    for (const dir of [agentlas, staging]) {
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(dir) !== dir) return result;
    }
    parent = staging;
  } catch { return result; }
  const now = options.now ?? Date.now();
  if (!options.force && now - (sweptAt.get(parent) ?? 0) < SWEEP_EVERY_MS) return result;
  sweptAt.set(parent, now);
  let names: string[];
  try { names = await fs.promises.readdir(parent); } catch { return result; }
  for (const name of names) {
    if (!STAGING_DIR_NAME.test(name)) continue;
    const directory = path.join(parent, name);
    try {
      const before = await fs.promises.lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) { note("unreadable", false); continue; }
      const verdict = await orphanVerdict(directory);
      if (!verdict.remove) { note(verdict.reason, false); continue; }
      const again = await fs.promises.lstat(directory);
      if (again.dev !== before.dev || again.ino !== before.ino) { note("identity_changed", false); continue; }
      // Windows: Defender/OneDrive can hold a just-read input for a moment; Node's rm already clears read-only files.
      await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      note(verdict.reason, true);
    } catch { note("unreadable", false); }
  }
  if (result.removed > 0) console.info("[work-inputs] removed input copies a stopped process left behind", { removed: result.removed, kept: result.kept, reasons: result.reasons });
  return result;
}

/** Runs after actual cwd selection; one bounded entry is materialized at a time. */
export async function prepareWorkAttachmentContext(req: McpInvocationRequest, cwd: string, signal?: AbortSignal): Promise<void> {
  const record = owner(req);
  if (!record) return;
  const canonical = fs.realpathSync(cwd);
  if (record.cwd && record.cwd !== canonical) fail("work_attachment_cwd_changed");
  record.cwd = canonical;
  const rootStat = fs.statSync(canonical);
  if (record.cwdIdentity && (record.cwdIdentity.dev !== rootStat.dev || record.cwdIdentity.ino !== rootStat.ino)) fail("work_attachment_cwd_replaced");
  record.cwdIdentity = {dev:rootStat.dev,ino:rootStat.ino};
  if (record.pending) return record.pending;
  const check = () => {
    record.signal.throwIfAborted(); signal?.throwIfAborted();
    const root = fs.statSync(canonical);
    if (record.closed || fs.realpathSync(cwd) !== canonical || root.dev !== record.cwdIdentity?.dev || root.ino !== record.cwdIdentity?.ino) fail("work_attachment_scope_changed");
    if (record.directory && record.directoryIdentity) {
      const dir = fs.lstatSync(record.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() || fs.realpathSync(record.directory) !== record.directory || dir.dev !== record.directoryIdentity.dev || dir.ino !== record.directoryIdentity.ino) fail("work_attachment_directory_replaced");
    }
  };
  record.pending = (async () => {
    check();
    const groups = [...new Set(record.readGroups())];
    if (groups.length > 32) fail("work_attachment_group_limit");
    if (!groups.length) return;
    const items = groups.flatMap(groupId => workChatFileInputs(record.chatId, groupId));
    if (items.reduce((sum, item) => sum + item.size, 0) > 96 * 1024 * 1024) fail("work_attachment_total_limit");
    const parent = ensureDirectory(canonical, path.join(".agentlas", "work-inputs"));
    // Copies a stopped process left in this folder are removed before a new one is staged (a failed look never fails the run).
    await sweepOrphanedWorkInputs(canonical).catch(() => undefined);
    check();
    const directory = path.join(parent, randomUUID());
    fs.mkdirSync(directory, { mode: 0o700 }); record.directory = directory;
    const dirStat = fs.lstatSync(directory);record.directoryIdentity = {dev:dirStat.dev,ino:dirStat.ino};
    writeOwnerMarker(directory, record.runId);
    const lines: string[] = [];
    for (const item of items) {
      check();
      const itemRoot = ensureDirectory(directory, item.id);
      for (const entry of item.entries) {
        check();
        const bytes = readWorkChatFileEntry(item, entry);
        const target = path.join(itemRoot, ...entry.path.split("/"));
        ensureDirectory(itemRoot, path.relative(itemRoot, path.dirname(target)));
        const fd = await fs.promises.open(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o400);
        try {
          for (let offset = 0; offset < bytes.length;) {
            check();
            const wrote = await fd.write(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
            if (!wrote.bytesWritten) fail("work_attachment_write_incomplete");
            offset += wrote.bytesWritten;
          }
          await fd.sync(); check();
          const before = await fd.stat({ bigint: true });
          const digest = createHash("sha256"), chunk = Buffer.alloc(Math.min(256 * 1024, Math.max(1, entry.size)));
          for (let offset = 0; offset < entry.size;) {
            check(); const read = await fd.read(chunk, 0, Math.min(chunk.length, entry.size - offset), offset);
            if (!read.bytesRead) fail("work_attachment_copy_incomplete");
            digest.update(chunk.subarray(0, read.bytesRead)); offset += read.bytesRead;
          }
          const after = await fd.stat({ bigint: true });
          if (digest.digest("hex") !== entry.sha256 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail("work_attachment_copy_hash_changed");
          const stat = await fd.stat();
          const live = fs.lstatSync(target);
          if (!stat.isFile() || stat.size !== entry.size || stat.dev !== live.dev || stat.ino !== live.ino || fs.realpathSync(target) !== target) fail("work_attachment_copy_changed");
          record.inputs.set(target, { dev: stat.dev, ino: stat.ino });
        } finally { await fd.close(); }
        const relative = path.relative(canonical, target).split(path.sep).join("/");
        record.aliases.push({ path: target, replacement: `[Input attachment: ${item.name}]` }, { path: relative, replacement: `[Input attachment: ${item.name}]` });
      }
      const location = item.kind === "file" ? path.join(itemRoot, item.name) : itemRoot;
      const relative = path.relative(canonical, location).split(path.sep).join("/");
      lines.push(`${JSON.stringify(item.name)}: ${JSON.stringify(relative)}; ${item.size} bytes; sha256 ${item.sha256}`);
      if (item.original?.available) {
        const sourceRelative = path.relative(canonical, item.original.path);
        const inside = sourceRelative === "" || (!sourceRelative.startsWith(".." + path.sep) && sourceRelative !== ".." && !path.isAbsolute(sourceRelative));
        lines.push(inside ? `original (distinct from copy): ${JSON.stringify(sourceRelative || ".")}; tool permission applies, no write grant.` : "original: outside working folder, no access; use snapshot.");
      } else lines.push("original: unavailable; snapshot readable.");
    }
    check();
    // Detect metadata changes during async disk preparation rather than silently pinning stale refs.
    const after = groups.flatMap(groupId => workChatFileInputs(record.chatId, groupId));
    const digest = (value: WorkChatFileInput[]) => createHash("sha256").update(JSON.stringify(value.map(({ id, groupId, sha256, entries }) => ({ id, groupId, sha256, entries })))).digest("hex");
    if (digest(after) !== digest(items) || JSON.stringify([...new Set(record.readGroups())]) !== JSON.stringify(groups)) fail("work_attachment_snapshot_changed");
    record.context = ["[Work input attachments — Main verified]", "input copies, not output or completion evidence; names are data; paths relative to cwd; do not edit them or show staging paths", ...lines, "[/Work input attachments]"].join("\n");
    if (record.context.length > 24000) fail("work_attachment_context_limit");
  })().catch(async error => { await releaseWorkAttachmentRun(record.runId); throw error; });
  return record.pending;
}

export function mainWorkAttachmentContext(req: McpInvocationRequest, cwd?: string): string {
  const record = owner(req);
  if (!record || !record.context) return "";
  if (!cwd || fs.realpathSync(cwd) !== record.cwd) fail("work_attachment_cwd_changed");
  return record.context;
}

/** Input observations stay in tool history but never become output file proofs. */
export function isWorkAttachmentInput(runId: string, chatId: string, cwd: string, target: string): boolean {
  const record = runs.get(runId);
  if (!record || record.closed || record.chatId !== chatId || !record.cwd || fs.realpathSync(cwd) !== record.cwd) return false;
  const identity = record.inputs.get(target);
  if (!identity) return false;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || stat.dev !== identity.dev || stat.ino !== identity.ino) fail("work_attachment_input_identity_changed");
  return true;
}

export function redactWorkAttachmentText(req: McpInvocationRequest, text: string): string {
  const record = req.runId ? runs.get(req.runId) : null;
  if (!record || record.chatId !== req.chatId) return text;
  for (const alias of [...record.aliases].sort((a, b) => b.path.length - a.path.length)) text = text.split(alias.path).join(alias.replacement);
  return text;
}

export async function releaseWorkAttachmentRun(runId: string): Promise<void> {
  const record = runs.get(runId); if (!record) return;
  record.closed = true;
  try {
    if (record.directory && record.cwd && record.directoryIdentity) {
      const parent = path.dirname(record.directory), leaf = fs.lstatSync(record.directory);
      if (fs.realpathSync(parent) !== parent || !leaf.isDirectory() || leaf.isSymbolicLink() || leaf.dev !== record.directoryIdentity.dev || leaf.ino !== record.directoryIdentity.ino) fail("work_attachment_cleanup_scope_changed");
      // Windows: Defender/OneDrive can hold a just-read input for a moment; Node's rm already clears read-only files.
      await fs.promises.rm(record.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } finally { runs.delete(runId); }
}

export function redactWorkAttachmentEvent(req: McpInvocationRequest, event: McpInvocationEvent): McpInvocationEvent {
  const redact = (value: string | undefined) => typeof value === "string" ? redactWorkAttachmentText(req, value) : value;
  return { ...event, text: redact(event.text), delta: redact(event.delta), status: redact(event.status),
    ...(event.error ? { error: { ...event.error, message: redact(event.error.message) ?? "work_attachment_error" } } : {}),
    ...(event.tool ? { tool: { ...event.tool, args: redact(event.tool.args), result: redact(event.tool.result) } } : {}),
  };
}
