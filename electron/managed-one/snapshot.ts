/** Snapshot and restore of a Cloud computer's data folder.
 *
 * One snapshot is one file (`*.agsnap`): a magic line, one JSON manifest line, then the entries back to back.
 * The server reads the file through the sandbox file API, encrypts it and stores it; the host never holds a key.
 *
 * What is in it (everything the owner would miss on a new computer):
 *  - agentlas.sqlite            the app database (conversations, One, Work), copied with VACUUM INTO
 *  - memory/registry.json       the memory custody id; the memory path below is derived from it
 *  - memory/owners/<h>/memory.sqlite   the memory database, copied with VACUUM INTO
 *  - finance/{workspaces,experience,planning-reviews}/**   watchlists and Finance settings (plain files)
 * Not in it: bootstrap or credential files, the mobile bridge identity and pairings (they belong to one host id),
 * agent working folders, caches.
 *
 * Consistency: each database is read through its own connection. In WAL mode a reader sees one committed state and
 * never blocks the host's writer, and the host's writer never invalidates the copy. The two databases are copied one
 * after the other, so they are each consistent but not one transaction. Concurrent snapshot calls run one at a time. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const MANAGED_SNAPSHOT_SCHEMA = "agentlas.managed-one.snapshot.v1" as const;
export const MANAGED_SNAPSHOT_MAGIC = "AGENTLAS-MANAGED-SNAPSHOT-1\n";
export const MANAGED_RESTORE_RECEIPT = "managed-one-restore.json";
const SNAPSHOT_DIR = "snapshots";
const KEEP_SNAPSHOTS = 2;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 ** 3;
const MAX_ENTRIES = 20_000;
const FINANCE_DIRECTORIES = ["workspaces", "experience", "planning-reviews"] as const;
const ENTRY_NAME = /^(?:agentlas\.sqlite|memory\/registry\.json|memory\/owners\/[0-9a-f]{64}\/memory\.sqlite|finance\/(?:workspaces|experience|planning-reviews)(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}){1,6})$/;
const SQLITE_ENTRY = /(?:^|\/)[^/]+\.sqlite$/;

export interface ManagedSnapshotResult { path: string; bytes: number; sha256: string }
interface ManifestEntry { name: string; bytes: number; sha256: string }
interface Manifest { schema: typeof MANAGED_SNAPSHOT_SCHEMA; createdAt: string; userDataDir: string; entries: ManifestEntry[] }

export function managedMemoryRoot(root: string): string { return path.join(root, "memory"); }

function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256"); let bytes = 0;
    const stream = fs.createReadStream(file);
    stream.on("data", chunk => { hash.update(chunk); bytes += chunk.length; });
    stream.once("error", reject);
    stream.once("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
  });
}

function copyDatabase(source: string, destination: string): void {
  // A separate read-only connection: it never writes the live file and never takes the host's writer lock.
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 10000");
    db.prepare("VACUUM INTO ?").run(destination);
  } finally { db.close(); }
  const copy = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const verdict = copy.pragma("quick_check", { simple: true });
    if (verdict !== "ok") throw new Error("managed_one_snapshot_database_damaged");
  } finally { copy.close(); }
}

function isRegularFile(file: string): boolean {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
function isDirectory(dir: string): boolean {
  try { const stat = fs.lstatSync(dir); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}

/** Plain Finance files: regular files only, no dot files (locks, temporaries), bounded depth. */
function financeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    const absolute = path.join(root, relative);
    if (!isDirectory(absolute) || depth > 6) return;
    for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (item.name.startsWith(".") || item.name.endsWith(".lock") || item.name.endsWith(".tmp")) continue;
      const child = `${relative}/${item.name}`;
      if (item.isDirectory()) walk(child, depth + 1);
      else if (item.isFile() && ENTRY_NAME.test(child)) found.push(child);
    }
  };
  for (const name of FINANCE_DIRECTORIES) walk(`finance/${name}`, 1);
  return found;
}

let queue: Promise<unknown> = Promise.resolve();
/** Concurrent callers wait for the one before; a failure of one never blocks the next. */
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function pruneSnapshotDirectory(directory: string, keepName: string): void {
  const names = fs.readdirSync(directory);
  for (const name of names) {
    // Anything half-written belongs to an earlier crashed or abandoned call: calls are serialized.
    if (name !== keepName && (name.startsWith(".stage-") || name.endsWith(".tmp"))) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
  const done = names.filter(name => /^snapshot-\d+-[a-f0-9]{8}\.agsnap$/.test(name)).sort();
  for (const name of done.slice(0, Math.max(0, done.length - KEEP_SNAPSHOTS))) fs.rmSync(path.join(directory, name), { force: true });
}

async function writeContainer(target: string, manifest: Manifest, files: Map<string, string>): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256"); let total = 0;
  const handle = await fs.promises.open(target, "wx", 0o600);
  try {
    const write = async (buffer: Buffer) => { hash.update(buffer); total += buffer.length; let offset = 0; while (offset < buffer.length) offset += (await handle.write(buffer, offset, buffer.length - offset)).bytesWritten; };
    await write(Buffer.from(MANAGED_SNAPSHOT_MAGIC, "utf8"));
    await write(Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"));
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (const entry of manifest.entries) {
      const source = await fs.promises.open(files.get(entry.name)!, "r");
      try {
        let copied = 0;
        for (;;) {
          const { bytesRead } = await source.read(chunk, 0, chunk.length, copied);
          if (!bytesRead) break;
          copied += bytesRead; await write(Buffer.from(chunk.subarray(0, bytesRead)));
        }
        if (copied !== entry.bytes) throw new Error("managed_one_snapshot_changed_while_reading");
      } finally { await source.close(); }
    }
    await handle.sync();
  } finally { await handle.close(); }
  return { bytes: total, sha256: hash.digest("hex") };
}

/** Make one consistent snapshot of `root` and return where it is. Safe to call while the host is writing. */
export function createManagedOneSnapshot(root: string, now: () => number = Date.now): Promise<ManagedSnapshotResult> {
  return serialize(async () => {
    const directory = path.join(root, SNAPSHOT_DIR);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== path.join(fs.realpathSync(root), SNAPSHOT_DIR)) throw new Error("managed_one_snapshot_directory_invalid");
    const id = randomUUID().replaceAll("-", "").slice(0, 8);
    const stage = path.join(directory, `.stage-${id}`);
    const stamp = now();
    const finalName = `snapshot-${stamp}-${id}.agsnap`, partial = path.join(directory, `${finalName}.tmp`);
    pruneSnapshotDirectory(directory, path.basename(stage));
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      const staged = new Map<string, string>();
      let counter = 0;
      const stageFile = (name: string) => { const file = path.join(stage, `${counter++}.bin`); staged.set(name, file); return file; };
      const product = path.join(root, "agentlas.sqlite");
      if (!isRegularFile(product)) throw new Error("managed_one_snapshot_database_missing");
      copyDatabase(product, stageFile("agentlas.sqlite"));
      const memoryRoot = managedMemoryRoot(root);
      if (isRegularFile(path.join(memoryRoot, "registry.json"))) fs.copyFileSync(path.join(memoryRoot, "registry.json"), stageFile("memory/registry.json"));
      const owners = path.join(memoryRoot, "owners");
      if (isDirectory(owners)) for (const owner of fs.readdirSync(owners)) {
        const database = path.join(owners, owner, "memory.sqlite");
        if (/^[0-9a-f]{64}$/.test(owner) && isRegularFile(database)) copyDatabase(database, stageFile(`memory/owners/${owner}/memory.sqlite`));
      }
      for (const name of financeFiles(root)) {
        try { fs.copyFileSync(path.join(root, name), stageFile(name)); }
        catch (error) { staged.delete(name); if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const entries: ManifestEntry[] = [];
      for (const [name, file] of staged) { const { sha256, bytes } = await sha256File(file); entries.push({ name, bytes, sha256 }); }
      if (entries.length > MAX_ENTRIES) throw new Error("managed_one_snapshot_too_many_files");
      const manifest: Manifest = { schema: MANAGED_SNAPSHOT_SCHEMA, createdAt: new Date(stamp).toISOString(), userDataDir: root, entries };
      const written = await writeContainer(partial, manifest, staged);
      if (written.bytes > MAX_SNAPSHOT_BYTES) throw new Error("managed_one_snapshot_too_large");
      const target = path.join(directory, finalName);
      fs.renameSync(partial, target);
      const reread = await sha256File(target);
      if (reread.sha256 !== written.sha256 || reread.bytes !== written.bytes) throw new Error("managed_one_snapshot_write_unverified");
      pruneSnapshotDirectory(directory, finalName);
      return { path: target, bytes: written.bytes, sha256: written.sha256 };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(partial, { force: true });
    }
  });
}

interface OpenedContainer { manifest: Manifest; dataStart: number; size: number }
async function openContainer(file: string): Promise<OpenedContainer> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES || stat.size < MANAGED_SNAPSHOT_MAGIC.length) throw new Error("managed_one_restore_file_invalid");
  const handle = await fs.promises.open(file, "r");
  try {
    const head = Buffer.alloc(Math.min(stat.size, MANAGED_SNAPSHOT_MAGIC.length + MAX_MANIFEST_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (head.subarray(0, MANAGED_SNAPSHOT_MAGIC.length).toString("utf8") !== MANAGED_SNAPSHOT_MAGIC) throw new Error("managed_one_restore_file_invalid");
    const lineEnd = head.subarray(0, bytesRead).indexOf(0x0a, MANAGED_SNAPSHOT_MAGIC.length);
    if (lineEnd < 0) throw new Error("managed_one_restore_file_invalid");
    let manifest: Manifest;
    try { manifest = JSON.parse(head.subarray(MANAGED_SNAPSHOT_MAGIC.length, lineEnd).toString("utf8")) as Manifest; } catch { throw new Error("managed_one_restore_file_invalid"); }
    if (!manifest || manifest.schema !== MANAGED_SNAPSHOT_SCHEMA || typeof manifest.userDataDir !== "string" || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) throw new Error("managed_one_restore_file_invalid");
    const names = new Set<string>(); let sum = 0;
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.name !== "string" || !ENTRY_NAME.test(entry.name) || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("managed_one_restore_file_invalid");
      names.add(entry.name); sum += entry.bytes;
    }
    if (!names.has("agentlas.sqlite")) throw new Error("managed_one_restore_file_invalid");
    const dataStart = lineEnd + 1;
    if (dataStart + sum !== stat.size) throw new Error("managed_one_restore_file_invalid");
    return { manifest, dataStart, size: stat.size };
  } finally { await handle.close(); }
}

export type ManagedRestoreOutcome = "restored" | "already_restored";
/** Restore `file` into the empty data folder `root` before the host opens any database. Never overwrites existing data. */
export async function restoreManagedOneSnapshot(input: { root: string; file: string; sha256: string }): Promise<ManagedRestoreOutcome> {
  const { root, file } = input;
  const receiptFile = path.join(root, MANAGED_RESTORE_RECEIPT);
  const product = path.join(root, "agentlas.sqlite");
  if (fs.existsSync(product)) {
    try { if (JSON.parse(fs.readFileSync(receiptFile, "utf8")).sha256 === input.sha256) return "already_restored"; } catch { /* no receipt for this snapshot */ }
    throw new Error("managed_one_restore_target_not_empty");
  }
  for (const name of ["memory", "finance"]) {
    if (fs.existsSync(path.join(root, name)) && fs.readdirSync(path.join(root, name)).length) throw new Error("managed_one_restore_target_not_empty");
  }
  const whole = await sha256File(file);
  if (whole.sha256 !== input.sha256) throw new Error("managed_one_restore_hash_mismatch");
  const { manifest, dataStart } = await openContainer(file);
  if (manifest.userDataDir !== root) throw new Error("managed_one_restore_data_dir_mismatch");
  const stage = path.join(root, `.restore-${randomUUID().replaceAll("-", "").slice(0, 12)}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    const handle = await fs.promises.open(file, "r");
    const extracted = new Map<string, string>();
    try {
      let position = dataStart, counter = 0;
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      for (const entry of manifest.entries) {
        const target = path.join(stage, `${counter++}.bin`);
        const out = await fs.promises.open(target, "wx", 0o600);
        const hash = createHash("sha256");
        try {
          let remaining = entry.bytes;
          while (remaining > 0) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), position);
            if (!bytesRead) throw new Error("managed_one_restore_file_invalid");
            const part = chunk.subarray(0, bytesRead);
            hash.update(part); await out.write(part, 0, bytesRead); position += bytesRead; remaining -= bytesRead;
          }
          await out.sync();
        } finally { await out.close(); }
        if (hash.digest("hex") !== entry.sha256) throw new Error("managed_one_restore_entry_hash_mismatch");
        if (SQLITE_ENTRY.test(entry.name)) {
          const db = new Database(target, { readonly: true, fileMustExist: true });
          try { if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("managed_one_restore_database_damaged"); } finally { db.close(); }
        }
        extracted.set(entry.name, target);
      }
    } finally { await handle.close(); }
    // The app database goes in last: its presence is what marks the folder as restored, so an interrupted run repeats cleanly.
    const order = [...extracted.keys()].sort((a, b) => Number(a === "agentlas.sqlite") - Number(b === "agentlas.sqlite"));
    for (const name of order) {
      const destination = path.join(root, ...name.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      for (const sidecar of ["-wal", "-shm", "-journal"]) fs.rmSync(`${destination}${sidecar}`, { force: true });
      fs.renameSync(extracted.get(name)!, destination);
    }
    const receiptTemporary = `${receiptFile}.${process.pid}.tmp`;
    fs.writeFileSync(receiptTemporary, JSON.stringify({ sha256: input.sha256, restoredAt: new Date().toISOString(), entries: manifest.entries.length }), { mode: 0o600, flag: "w" });
    fs.renameSync(receiptTemporary, receiptFile);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  // The sandbox copy holds the owner's data in the clear; the server keeps the encrypted original.
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  return "restored";
}

/** An earlier Cloud host kept memory under the sandbox user's home. Move it into the data folder once, before the
 * memory store is first opened, so a snapshot of the data folder includes it. Returns the old path that was copied. */
export function adoptLegacyMemoryRoot(root: string, legacyRoot: string): string | null {
  const target = managedMemoryRoot(root);
  if (fs.existsSync(target) || !isDirectory(legacyRoot) || path.resolve(legacyRoot) === path.resolve(target)) return null;
  const temporary = `${target}.adopt-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.cpSync(legacyRoot, temporary, { recursive: true, verbatimSymlinks: false, errorOnExist: true });
  fs.renameSync(temporary, target);
  return legacyRoot;
}
