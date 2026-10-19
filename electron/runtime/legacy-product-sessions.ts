


























import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";

export interface LegacyCleanupPaths {
  /** Agentlas's own app data: a cwd inside it is a product cwd. */
  userDataDir: string;
  /** Where index backups go before rows are removed. */
  backupDir: string;
  codex?: { realHome: string; productStore: string };
  claude?: { realDir: string; mirrorDir: string };
  copilot?: { realHome: string; mirrorHome: string };
}

/** Counts only: no path, id, title or text of any session. */
export interface LegacyCleanupReport {
  schema: "agentlas.legacy-product-sessions.v2";
  /** Codex rollout files moved into the product store. */
  codexFiles: number;
  /** Rows removed from the person's Codex index (threads their Codex app listed). */
  codexThreads: number;
  /** Lines removed from the person's Codex CLI session index. */
  codexIndexLines: number;
  claudeSessions: number;
  /** Claude files moved, session files and the files of their sidecar folders. */
  claudeFiles: number;
  copilotSessions: number;
  copilotRows: number;
  /** Moves whose destination already held that name: both kept, the arriving one under legacy-kept/. */
  keptBoth: number;
  errors: number;
}

export interface LegacyCleanupResult {
  report: LegacyCleanupReport;
  /** Stable error codes for the log (no paths). */
  errorCodes: string[];
}

export const PRODUCT_CODEX_ORIGINATOR = "agentlas-desktop";
const CODEX_EXEC_ORIGINATOR = "codex_exec";
const HEADER_MAX_BYTES = 16 * 1024 * 1024;

function emptyReport(): LegacyCleanupReport {
  return { schema: "agentlas.legacy-product-sessions.v2", codexFiles: 0, codexThreads: 0, codexIndexLines: 0,
    claudeSessions: 0, claudeFiles: 0, copilotSessions: 0, copilotRows: 0, keptBoth: 0, errors: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function insideDir(dir: string, candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate)) return false;
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const root = fold(path.resolve(dir)), target = fold(path.resolve(candidate));
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// ---------------------------------------------------------------------------------------------------------------------
// Moving without deleting
// ---------------------------------------------------------------------------------------------------------------------

/** Where a file goes when its destination name is taken: beside the store, outside what the CLI scans. */
function keptPath(storeRoot: string, rel: string): string {
  const base = path.join(storeRoot, "legacy-kept", rel);
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}.${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function moveFileSafely(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(to).size !== fs.statSync(from).size) throw Object.assign(new Error("copy size mismatch"), { code: "LPS_COPY_MISMATCH" });
    fs.unlinkSync(from);
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  return n;
}

function moveDirSafely(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  fs.mkdirSync(to, { recursive: false, mode: 0o700 });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) moveDirSafely(a, b); else moveFileSafely(a, b);
  }
  fs.rmdirSync(from);
}

/**
 * Moves `from` (file or folder) to `storeRoot/rel`; when that name is taken, both are kept and the arriving one goes to
 * legacy-kept/. Returns the number of files moved.
 */
function moveIntoStore(from: string, storeRoot: string, rel: string, report: LegacyCleanupReport): number {
  let to = path.join(storeRoot, rel);
  if (fs.existsSync(to)) { to = keptPath(storeRoot, rel); report.keptBoth += 1; }
  if (fs.statSync(from).isDirectory()) {
    const files = countFiles(from);
    moveDirSafely(from, to);
    return files;
  }
  moveFileSafely(from, to);
  return 1;
}

function removeIfEmpty(dir: string): void {
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
}

// ---------------------------------------------------------------------------------------------------------------------
// Index rows (backup first)
// ---------------------------------------------------------------------------------------------------------------------

/**




 */
function deleteWithDependents(db: Database.Database, parent: string, ids: readonly string[], alsoByColumn: ReadonlyArray<readonly [string, string]> = []): number {
  const dependents: Array<[string, string]> = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
    for (const fk of db.prepare(`SELECT "table" AS t, "from" AS c FROM pragma_foreign_key_list(?)`).all(name) as Array<{ t: string; c: string }>) {
      if (fk.t === parent) dependents.push([name, fk.c]);
    }
  }
  const existing = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const [table, column] of alsoByColumn) {
    if (existing.has(table) && !dependents.some(([t, c]) => t === table && c === column)) dependents.push([table, column]);
  }
  let removed = 0;
  db.transaction(() => {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400), marks = chunk.map(() => "?").join(",");
      for (const [table, column] of dependents) db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${marks})`).run(...chunk);
      removed += db.prepare(`DELETE FROM "${parent}" WHERE id IN (${marks})`).run(...chunk).changes;
    }
  }).immediate();
  return removed;
}

function backupDb(file: string, backupDir: string, label: string): void {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { db.prepare("VACUUM INTO ?").run(path.join(backupDir, `${label}-${Date.now()}.sqlite`)); } finally { db.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------------------------------

/** The first line of a rollout (.jsonl, or .jsonl.zst read through a streaming decoder), bounded. */
export async function readRolloutHeaderLine(file: string, maxBytes = HEADER_MAX_BYTES): Promise<string | null> {
  const compressed = file.endsWith(".zst");
  if (compressed && typeof zlib.createZstdDecompress !== "function") return null;
  return new Promise((resolve) => {
    let chunks: Buffer[] = [], size = 0, done = false;
    const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
    const decoder = compressed ? zlib.createZstdDecompress() : null;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      source.destroy();
      decoder?.destroy();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const at = chunk.indexOf(10);
      if (at >= 0) { chunks.push(chunk.subarray(0, at)); finish(Buffer.concat(chunks).toString("utf8")); return; }
      chunks.push(chunk); size += chunk.length;
      if (size > maxBytes) { chunks = []; finish(null); }
    };
    const stream = decoder ?? source;
    stream.on("data", onData);
    stream.on("end", () => finish(size > 0 ? Buffer.concat(chunks).toString("utf8") : null));
    stream.on("error", () => finish(null));
    if (decoder) { source.on("error", () => finish(null)); source.pipe(decoder); }
  });
}

/** Whether a rollout header says the product wrote this session (see the file comment). */
export function codexRolloutIsProduct(header: unknown, userDataDir: string): boolean {
  if (!isRecord(header) || header.type !== "session_meta" || !isRecord(header.payload)) return false;
  const { originator, cwd } = header.payload;
  if (originator === PRODUCT_CODEX_ORIGINATOR) return true;
  return originator === CODEX_EXEC_ORIGINATOR && insideDir(userDataDir, cwd);
}

export interface CodexProductRollout { file: string; rel: string; threadId: string | null }

function listRollouts(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) listRollouts(at, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl(\.zst)?$/.test(entry.name)) out.push(at);
  }
}

/** Every product rollout under the person's Codex home (sessions and archived_sessions), from each file's own header. */
export async function findCodexProductRollouts(realHome: string, userDataDir: string): Promise<CodexProductRollout[]> {
  const files: string[] = [];
  for (const sub of ["sessions", "archived_sessions"]) listRollouts(path.join(realHome, sub), files);
  const found: CodexProductRollout[] = [];
  for (const file of files) {
    const line = await readRolloutHeaderLine(file);
    if (!line) continue;
    let header: unknown;
    try { header = JSON.parse(line); } catch { continue; }
    if (!codexRolloutIsProduct(header, userDataDir)) continue;
    const id = isRecord(header) && isRecord(header.payload) && typeof header.payload.id === "string" ? header.payload.id : null;
    found.push({ file, rel: path.relative(realHome, file), threadId: id });
  }
  return found;
}

export async function moveLegacyCodexSessions(p: NonNullable<LegacyCleanupPaths["codex"]>, userDataDir: string, backupDir: string, report: LegacyCleanupReport): Promise<void> {
  const rollouts = await findCodexProductRollouts(p.realHome, userDataDir);
  const ids = new Set(rollouts.flatMap((item) => item.threadId ? [item.threadId] : []));
  const states = fs.existsSync(p.realHome) ? fs.readdirSync(p.realHome).filter((name) => /^state_\d+\.sqlite$/.test(name)) : [];
  // Rows first: a move that fails leaves its file where the next launch finds it again, while a row whose file already
  // sits in the product store (an earlier run that stopped after moving) is found by that file.
  for (const name of states) {
    const file = path.join(p.realHome, name);
    const probe = new Database(file, { readonly: true, fileMustExist: true });
    let rowIds: string[];
    try {
      rowIds = (probe.prepare("SELECT id, rollout_path FROM threads").all() as Array<{ id: string; rollout_path: string | null }>)
        .filter((row) => ids.has(row.id) || (!!row.rollout_path && insideDir(p.realHome, row.rollout_path)
          && !fs.existsSync(row.rollout_path) && fs.existsSync(path.join(p.productStore, path.relative(p.realHome, row.rollout_path)))))
        .map((row) => row.id);
    } finally { probe.close(); }
    if (!rowIds.length) continue;
    backupDb(file, backupDir, `codex-${name.replace(/\.sqlite$/, "")}`);
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      report.codexThreads += deleteWithDependents(db, "threads", rowIds, [
        ["thread_spawn_edges", "parent_thread_id"], ["thread_spawn_edges", "child_thread_id"],
        ["thread_attachments", "thread_id"], ["thread_dynamic_tools", "thread_id"],
      ]);
    } finally { db.close(); }
  }
  // Codex CLI's own index of the person's sessions.
  const index = path.join(p.realHome, "session_index.jsonl");
  if (ids.size && fs.existsSync(index)) {
    const lines = fs.readFileSync(index, "utf8").split("\n");
    const kept = lines.filter((line) => { try { return !ids.has(String((JSON.parse(line) as { id?: unknown }).id)); } catch { return true; } });
    if (kept.length !== lines.length) {
      fs.writeFileSync(index, kept.join("\n"), { mode: 0o600 });
      report.codexIndexLines += lines.length - kept.length;
    }
  }
  for (const rollout of rollouts) report.codexFiles += moveIntoStore(rollout.file, p.productStore, rollout.rel, report);
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------------------------

/** Claude names a project's folder after its cwd: every non-alphanumeric becomes "-". */
export function claudeProjectKey(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** The first record of a Claude session file that names its cwd, read line by line within a bound. */
function claudeSessionIdentity(file: string): { cwd: string; entrypoint: string | null } | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const buffer = Buffer.alloc(256 * 1024);
    let carry = "", read = 0, lines = 0;
    while (read < HEADER_MAX_BYTES && lines < 200) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, read);
      if (n <= 0) break;
      read += n;
      const parts = (carry + buffer.subarray(0, n).toString("utf8")).split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) {
        lines += 1;
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (isRecord(record) && typeof record.cwd === "string") {
          return { cwd: record.cwd, entrypoint: typeof record.entrypoint === "string" ? record.entrypoint : null };
        }
      }
    }
    return null;
  } finally { fs.closeSync(fd); }
}

/** Whether a Claude session file's own records say the product wrote it, in the folder Claude derives from that cwd. */
export function claudeSessionIsProduct(file: string, userDataDir: string): boolean {
  const identity = claudeSessionIdentity(file);
  if (!identity || !insideDir(userDataDir, identity.cwd)) return false;
  if (!identity.entrypoint || !identity.entrypoint.startsWith("sdk-")) return false;
  return claudeProjectKey(identity.cwd) === path.basename(path.dirname(file));
}

export interface ClaudeProductProject { dir: string; name: string; sessions: string[]; wholeFolder: boolean }

export function findClaudeProductSessions(realDir: string, userDataDir: string): ClaudeProductProject[] {
  const projects = path.join(realDir, "projects");
  if (!fs.existsSync(projects)) return [];
  const found: ClaudeProductProject[] = [];
  for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projects, entry.name);
    const sessionFiles = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    const product = sessionFiles.filter((name) => claudeSessionIsProduct(path.join(dir, name), userDataDir));
    if (!product.length) continue;
    found.push({ dir, name: entry.name, sessions: product, wholeFolder: product.length === sessionFiles.length });
  }
  return found;
}

export function moveLegacyClaudeSessions(p: NonNullable<LegacyCleanupPaths["claude"]>, userDataDir: string, report: LegacyCleanupReport): void {
  for (const project of findClaudeProductSessions(p.realDir, userDataDir)) {
    const rel = (name: string) => path.join("projects", project.name, name);
    for (const session of project.sessions) {
      report.claudeFiles += moveIntoStore(path.join(project.dir, session), p.mirrorDir, rel(session), report);
      report.claudeSessions += 1;
      // The session's sidecar folder (tool results, subagent transcripts) is named after the session id.
      const sidecar = path.join(project.dir, session.slice(0, -".jsonl".length));
      if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) {
        report.claudeFiles += moveIntoStore(sidecar, p.mirrorDir, rel(path.basename(sidecar)), report);
      }
    }
    // A folder that held only product sessions is the product's: what is left (the project's memory folder) goes too.
    // A folder that also holds a person's session (the lossy name collides) keeps everything that is not proven product.
    if (project.wholeFolder) {
      for (const name of fs.readdirSync(project.dir)) {
        if (name.endsWith(".jsonl")) continue;
        report.claudeFiles += moveIntoStore(path.join(project.dir, name), p.mirrorDir, rel(name), report);
      }
      removeIfEmpty(project.dir);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------------------------------------------------

function copilotWorkspace(dir: string): { cwd: string | null; client: string | null } {
  try {
    const head = fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8").slice(0, 2048);
    const field = (key: string) => (new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head)?.[1] ?? "").trim().replace(/^["']|["']$/g, "") || null;
    return { cwd: field("cwd"), client: field("client_name") };
  } catch { return { cwd: null, client: null }; }
}

export function moveLegacyCopilotSessions(p: NonNullable<LegacyCleanupPaths["copilot"]>, userDataDir: string, backupDir: string, report: LegacyCleanupReport): void {
  const states = path.join(p.realHome, "session-state");
  const product: string[] = [];
  if (fs.existsSync(states)) {
    for (const id of fs.readdirSync(states)) {
      const dir = path.join(states, id);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const ws = copilotWorkspace(dir);
      if (insideDir(userDataDir, ws.cwd) || ws.client === "agentlas-desktop") product.push(id);
    }
  }
  const store = path.join(p.realHome, "session-store.db");
  if (fs.existsSync(store)) {
    const moved = new Set(product);
    const probe = new Database(store, { readonly: true, fileMustExist: true });
    let ids: string[];
    try {
      ids = (probe.prepare("SELECT id, cwd FROM sessions").all() as Array<{ id: string; cwd: string | null }>)
        // Also rows whose folder an earlier run already moved into the product mirror (a run that hit a store error).
        .filter((row) => moved.has(row.id) || insideDir(userDataDir, row.cwd) || fs.existsSync(path.join(p.mirrorHome, "session-state", row.id)))
        .map((row) => row.id);
    } finally { probe.close(); }
    if (ids.length) {
      backupDb(store, backupDir, "copilot-session-store");
      const db = new Database(store, { fileMustExist: true });
      try {
        db.pragma("busy_timeout = 5000");
        report.copilotRows += deleteWithDependents(db, "sessions", ids, [
          ["session_files", "session_id"], ["session_refs", "session_id"], ["checkpoints", "session_id"], ["assistant_usage_events", "session_id"],
        ]);
      } finally { db.close(); }
    }
  }
  for (const id of product) {
    moveIntoStore(path.join(states, id), p.mirrorHome, path.join("session-state", id), report);
    report.copilotSessions += 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------

function errorCode(label: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return `${label}:${typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : error instanceof Error ? error.name : "unknown"}`;
}

export async function moveLegacyProductSessions(paths: LegacyCleanupPaths): Promise<LegacyCleanupResult> {
  const report = emptyReport();
  const errorCodes: string[] = [];
  const step = async (label: string, run: () => void | Promise<void>) => {
    try { await run(); } catch (error) { report.errors += 1; errorCodes.push(errorCode(label, error)); }
  };
  if (paths.codex) await step("codex", () => moveLegacyCodexSessions(paths.codex!, paths.userDataDir, paths.backupDir, report));
  if (paths.claude) await step("claude", () => moveLegacyClaudeSessions(paths.claude!, paths.userDataDir, report));
  if (paths.copilot) await step("copilot", () => moveLegacyCopilotSessions(paths.copilot!, paths.userDataDir, paths.backupDir, report));
  return { report, errorCodes };
}

/** Default locations for this install; each runtime is skipped when its home does not exist. */
export function defaultLegacyCleanupPaths(userDataDir: string, mirrors: { codexStore: string; claudeMirror: string; copilotMirror: string }, env: NodeJS.ProcessEnv = process.env): LegacyCleanupPaths {
  const home = env.HOME || os.homedir();
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
  const claudeDir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"));
  const copilotHome = path.resolve(env.COPILOT_HOME || path.join(home, ".copilot"));
  return {
    userDataDir, backupDir: path.join(userDataDir, "backups", "legacy-product-sessions"),
    ...(fs.existsSync(codexHome) ? { codex: { realHome: codexHome, productStore: mirrors.codexStore } } : {}),
    ...(fs.existsSync(claudeDir) ? { claude: { realDir: claudeDir, mirrorDir: mirrors.claudeMirror } } : {}),
    ...(fs.existsSync(copilotHome) ? { copilot: { realHome: copilotHome, mirrorHome: mirrors.copilotMirror } } : {}),
  };
}
