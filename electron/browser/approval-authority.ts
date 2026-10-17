import { createHash, randomUUID } from "node:crypto";
import type { BrowserApprovalRequestEvent } from "../../shared/types";

type Authority = {
  owner: NonNullable<BrowserApprovalRequestEvent["owner"]>;
  permission: "read" | "write" | "full";
  signal: AbortSignal;
  unattended: boolean;
  /** Ends the revocation watch of an authority minted by another process. The caller calls it when its request ends. */
  release?: () => void;
};
const authorities = new Map<string, Authority>();

/**
 * Authorities are also recorded in the shared store, so the process that serves approvals can resolve one minted by
 * another process. The approval server runs only in Main, but a run the daemon owns builds its MCP config, and so its
 * browser authority, in the daemon. Resolved from Main's memory alone, every approval a daemon-owned run asked for came
 * back "cancelled" without anyone seeing it: production 2026-10-15..17, Yotube room, every browser_evaluate /
 * browser_run_code a teammate ran in a daemon-owned run (11 of 11) was cancelled, while the same teammate in a
 * Main-owned run and One (325) ran theirs. Only a hash of the handle is stored; the handle stays in the minting
 * process and the launcher's environment.
 */
const TABLE = "browser_approval_authorities";
const RETAIN_REVOKED_MS = 24 * 3_600_000;
const REVOCATION_POLL_MS = 2_000;

type Db = import("better-sqlite3").Database;
let ensured: Db | null = null;
function store(): Db | null {
  try {
    const db = (require("../store/db") as typeof import("../store/db")).getDb();
    if (ensured !== db) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        token_hash TEXT PRIMARY KEY,
        owner_json TEXT NOT NULL,
        permission TEXT NOT NULL,
        unattended INTEGER NOT NULL,
        minted_pid INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`);
      ensured = db;
    }
    return db;
  } catch {
    return null;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Any MCP builder (Main or the daemon) mints authority; request bodies carry an opaque handle. */
export function registerBrowserApprovalAuthority(
  owner: Authority["owner"], permission: Authority["permission"], options: { unattended?: boolean } = {},
): { token: string; revoke: () => void } {
  const token = randomUUID();
  const controller = new AbortController();
  const unattended = options.unattended === true;
  authorities.set(token, Object.freeze({ owner: Object.freeze({ ...owner }), permission, signal: controller.signal, unattended }));
  const hash = tokenHash(token);
  const now = Date.now();
  const db = store();
  try {
    db?.prepare(`DELETE FROM ${TABLE} WHERE revoked_at IS NOT NULL AND revoked_at < ?`).run(now - RETAIN_REVOKED_MS);
    db?.prepare(`INSERT INTO ${TABLE} (token_hash, owner_json, permission, unattended, minted_pid, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(hash, JSON.stringify(owner), permission, unattended ? 1 : 0, process.pid, now);
  } catch (error) {
    // The authority still works in this process; only another process cannot resolve it.
    console.warn(`[browser-approval] authority not shared: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    token,
    revoke: () => {
      authorities.delete(token);
      controller.abort();
      try { db?.prepare(`UPDATE ${TABLE} SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(Date.now(), hash); } catch { /* the minting process's exit ends it */ }
    },
  };
}

type Row = { owner_json: string; permission: string; unattended: number; minted_pid: number; revoked_at: number | null };

function liveRow(db: Db, hash: string): Row | null {
  const row = db.prepare(`SELECT owner_json, permission, unattended, minted_pid, revoked_at FROM ${TABLE} WHERE token_hash = ?`).get(hash) as Row | undefined;
  // An authority this process minted lives in its memory; a row it left behind (revoked, or from an earlier process
  // with the same pid) is not one. Another process's authority ends with that process.
  if (!row || row.revoked_at !== null || row.minted_pid === process.pid || !processAlive(row.minted_pid)) return null;
  return row;
}

export function resolveBrowserApprovalAuthority(token: unknown): Authority | null {
  if (typeof token !== "string" || !token) return null;
  const local = authorities.get(token);
  if (local) return local;
  const db = store();
  if (!db) return null;
  const hash = tokenHash(token);
  let row: Row | null;
  try { row = liveRow(db, hash); } catch { return null; }
  if (!row) return null;
  let owner: Authority["owner"];
  try { owner = JSON.parse(row.owner_json) as Authority["owner"]; } catch { return null; }
  if (row.permission !== "read" && row.permission !== "write" && row.permission !== "full") return null;
  // The minting process revokes its authority when its run ends; a pending approval sheet ends with it.
  const controller = new AbortController();
  const timer = setInterval(() => {
    let live = false;
    try { live = liveRow(db, hash) !== null; } catch { live = false; }
    if (!live) { clearInterval(timer); controller.abort(); }
  }, REVOCATION_POLL_MS);
  timer.unref?.();
  return Object.freeze({
    owner: Object.freeze({ ...owner }),
    permission: row.permission,
    signal: controller.signal,
    unattended: row.unattended === 1,
    release: () => clearInterval(timer),
  });
}
