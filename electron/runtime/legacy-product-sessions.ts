// One-time move of product sessions that older installs wrote into the person's own CLI homes.
//
// Owner decision 2026-10-13 ("제품 저장소로 이동"): product sessions live only on the Agentlas side. New runs already stay
// out (Codex since the product store, Claude/Copilot/Kimi/Cursor since claude-product-home.ts / cli-product-homes.ts), but
// sessions written before that still filled the person's apps: on the owner's Mac 7,931 threads in the Codex app index,
// 394 Claude session files and 5,728 Copilot sessions pointed at the product's folders.
//
// Product sessions are identified by machine facts only, never by reading conversation text:
//   - Codex: a thread whose cwd is inside Agentlas's app data, or whose originator is "agentlas-desktop";
//   - Claude: a project folder named after a cwd inside Agentlas's app data;
//   - Copilot: a session whose workspace cwd is inside Agentlas's app data or whose client_name is agentlas-desktop.
// Each file moves into the product store (so the product can still resume it); the index rows the person's app lists are
// removed after a backup copy of that index is written under Agentlas's app data. Runs once, in the background, and never
// fails a launch: a store that is locked or unreadable is left for the next launch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export interface LegacyCleanupReport {
  codexThreads: number; codexFiles: number;
  claudeProjects: number; claudeFiles: number;
  copilotSessions: number; copilotRows: number;
  errors: string[];
}

function inside(dir: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const root = path.resolve(dir), target = path.resolve(candidate);
  return target === root || target.startsWith(root + path.sep);
}

function moveFile(from: string, to: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  if (fs.existsSync(to)) { fs.rmSync(from, { force: true }); return true; }
  try { fs.renameSync(from, to); } catch { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); }
  return true;
}

function moveTree(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  if (!fs.existsSync(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    try { fs.renameSync(from, to); return 1; } catch { /* cross-device: merge below */ }
  }
  let moved = 0;
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) moved += moveTree(a, b);
    else if (moveFile(a, b)) moved += 1;
  }
  fs.rmSync(from, { recursive: true, force: true });
  return moved;
}

function backupDb(file: string, backupDir: string, label: string): void {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { db.prepare("VACUUM INTO ?").run(path.join(backupDir, `${label}-${Date.now()}.sqlite`)); } finally { db.close(); }
}

export function moveLegacyCodexSessions(p: NonNullable<LegacyCleanupPaths["codex"]>, userDataDir: string, backupDir: string, report: LegacyCleanupReport): void {
  const states = fs.existsSync(p.realHome) ? fs.readdirSync(p.realHome).filter((name) => /^state_\d+\.sqlite$/.test(name)) : [];
  for (const name of states) {
    const file = path.join(p.realHome, name);
    const probe = new Database(file, { readonly: true, fileMustExist: true });
    let rows: Array<{ id: string; rollout_path: string | null; cwd: string | null; originator: string | null }>;
    try {
      rows = (probe.prepare("SELECT id, rollout_path, cwd, originator FROM threads").all() as typeof rows)
        .filter((row) => inside(userDataDir, row.cwd) || row.originator === "agentlas-desktop");
    } finally { probe.close(); }
    if (!rows.length) continue;
    backupDb(file, backupDir, `codex-${name.replace(/\.sqlite$/, "")}`);
    const moved = new Set<string>();
    for (const row of rows) {
      if (row.rollout_path && inside(p.realHome, row.rollout_path)) {
        const rel = path.relative(p.realHome, row.rollout_path);
        if (moveFile(row.rollout_path, path.join(p.productStore, rel))) report.codexFiles += 1;
      }
      moved.add(row.id);
    }
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      const ids = [...moved];
      db.transaction(() => {
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500), marks = chunk.map(() => "?").join(",");
          db.prepare(`DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${marks}) OR child_thread_id IN (${marks})`).run(...chunk, ...chunk);
          for (const table of ["thread_attachments", "thread_dynamic_tools"]) db.prepare(`DELETE FROM ${table} WHERE thread_id IN (${marks})`).run(...chunk);
          report.codexThreads += db.prepare(`DELETE FROM threads WHERE id IN (${marks})`).run(...chunk).changes;
        }
      }).immediate();
    } finally { db.close(); }
    // Codex CLI's own index of the person's sessions.
    const index = path.join(p.realHome, "session_index.jsonl");
    try {
      const lines = fs.readFileSync(index, "utf8").split("\n");
      const kept = lines.filter((line) => { try { return !moved.has(String((JSON.parse(line) as { id?: unknown }).id)); } catch { return true; } });
      if (kept.length !== lines.length) fs.writeFileSync(index, kept.join("\n"), { mode: 0o600 });
    } catch { /* no CLI index */ }
  }
}

/** Claude names a project's folder after its cwd: every non-alphanumeric becomes "-". */
function claudeKey(dir: string): string {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
}

export function moveLegacyClaudeSessions(p: NonNullable<LegacyCleanupPaths["claude"]>, userDataDir: string, report: LegacyCleanupReport): void {
  const projects = path.join(p.realDir, "projects");
  if (!fs.existsSync(projects)) return;
  const prefix = claudeKey(userDataDir);
  for (const name of fs.readdirSync(projects)) {
    if (name !== prefix && !name.startsWith(prefix + "-")) continue;
    report.claudeFiles += moveTree(path.join(projects, name), path.join(p.mirrorDir, "projects", name));
    report.claudeProjects += 1;
  }
}

function copilotWorkspace(dir: string): { cwd: string | null; client: string | null } {
  try {
    const head = fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8").slice(0, 2048);
    const field = (key: string) => (new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head)?.[1] ?? "").trim().replace(/^["']|["']$/g, "") || null;
    return { cwd: field("cwd"), client: field("client_name") };
  } catch { return { cwd: null, client: null }; }
}

export function moveLegacyCopilotSessions(p: NonNullable<LegacyCleanupPaths["copilot"]>, userDataDir: string, backupDir: string, report: LegacyCleanupReport): void {
  const states = path.join(p.realHome, "session-state");
  const moved = new Set<string>();
  if (fs.existsSync(states)) {
    for (const id of fs.readdirSync(states)) {
      const dir = path.join(states, id);
      const ws = copilotWorkspace(dir);
      if (!inside(userDataDir, ws.cwd) && ws.client !== "agentlas-desktop") continue;
      moveTree(dir, path.join(p.mirrorHome, "session-state", id));
      moved.add(id); report.copilotSessions += 1;
    }
  }
  const store = path.join(p.realHome, "session-store.db");
  if (!fs.existsSync(store)) return;
  const probe = new Database(store, { readonly: true, fileMustExist: true });
  let ids: string[];
  try {
    ids = (probe.prepare("SELECT id, cwd FROM sessions").all() as Array<{ id: string; cwd: string | null }>)
      .filter((row) => moved.has(row.id) || inside(userDataDir, row.cwd)).map((row) => row.id);
  } finally { probe.close(); }
  if (!ids.length) return;
  backupDb(store, backupDir, "copilot-session-store");
  const db = new Database(store, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.transaction(() => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500), marks = chunk.map(() => "?").join(",");
        for (const table of ["session_files", "session_refs", "checkpoints", "assistant_usage_events"]) db.prepare(`DELETE FROM ${table} WHERE session_id IN (${marks})`).run(...chunk);
        report.copilotRows += db.prepare(`DELETE FROM sessions WHERE id IN (${marks})`).run(...chunk).changes;
      }
    }).immediate();
  } finally { db.close(); }
}

export function moveLegacyProductSessions(paths: LegacyCleanupPaths): LegacyCleanupReport {
  const report: LegacyCleanupReport = { codexThreads: 0, codexFiles: 0, claudeProjects: 0, claudeFiles: 0, copilotSessions: 0, copilotRows: 0, errors: [] };
  const step = (label: string, run: () => void) => { try { run(); } catch (error) { report.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); } };
  if (paths.codex) step("codex", () => moveLegacyCodexSessions(paths.codex!, paths.userDataDir, paths.backupDir, report));
  if (paths.claude) step("claude", () => moveLegacyClaudeSessions(paths.claude!, paths.userDataDir, report));
  if (paths.copilot) step("copilot", () => moveLegacyCopilotSessions(paths.copilot!, paths.userDataDir, paths.backupDir, report));
  return report;
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
