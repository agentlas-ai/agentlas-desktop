// 세션 저장소 `session.sqlite` — 데스크탑 이어하기 체크포인트의 새 집 (데스크탑 부분, decision).
//
//   <기억 루트>/owners/<sha256(owner)>/session.sqlite       (경로는 stores.ts `sessionRef` — 엔진과 같은 고정 표)
//
// ★누가 쓰고 누가 읽나. 쓰기는 데스크탑 `session-checkpoints.ts` 의 save() 뿐이고(분리 스위치 `memory_layout = split-1` 일 때만),
//   읽기는 같은 파일의 read()/restore() 다(파일이 **있으면** 스위치와 무관하게 항상 읽는다). 엔진은 이 파일을 읽지도 쓰지도 않는다 —
// 터미널 엔진의 체크포인트는 뿌리 저장소에 그대로 있다.
// ★언제 지우나(이 파일을 만든 변경이 같이 둔 규칙).
//   · 잊기: `purgeSessionFile()` 이 `revocations.ts purgePreForgetContinuation` 안에서 두 표를 물리적으로 비운다(secure_delete).
//   · 같은 namespace 가 다시 저장되면 머리와 직전 한 줄(SESSION_CHECKPOINTS_KEPT)만 남긴다(save 안).
//   · 채팅 삭제: `forgetSessionCheckpointsForChat(chatId)`; 에이전트 삭제: `forgetSessionCheckpointsForAgent(agentId)`(행의 agent_id 열).
//   · 90일: 보존 작업(`db-retention.ts`)이 `pruneSessionFile()` 로 90일 넘은 행, 잊기 번호가 낡은 행, 머리가 없는 직전 줄을 지운다.
// ★뿌리 저장소에는 새 열도 새 표도 없다. 철회 번호(`memory_forget_clock`)는 항상 **뿌리**에서 읽는다 — 이 파일에는 그 표가 없다.
// ★열 순서와 `created_at`(ISO 문자열)은 엔진 쪽 가정(위치 기반 INSERT, 문자열 비교)을 깨지 않게 옛 뿌리 표와 같다. `agent_id` 만 끝에 더해졌다.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SESSION_CHECKPOINTS_KEPT, SESSION_FILE_ROW_DAYS } from "../storage/db-retention-policy";

export const SESSION_FILE = "session.sqlite";
export const SESSION_SCHEMA_VERSION = "1";
/** 쓰기 잠금을 기다리는 시간. 길게 기다리지 않는다 — 못 쓰면 save 는 뿌리에 저장한다(옛 길). */
export const SESSION_LOCK_WAIT_MS = 100;

export interface SessionLocation { path: string; owner: string }

const DDL = `CREATE TABLE IF NOT EXISTS memory_session_checkpoint_heads (
  namespace TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_session_checkpoints (
  checkpoint_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, payload_json TEXT NOT NULL,
  source_revision INTEGER NOT NULL, through_seq INTEGER NOT NULL, created_at TEXT NOT NULL, agent_id TEXT);
CREATE INDEX IF NOT EXISTS idx_memory_session_checkpoint_namespace ON memory_session_checkpoints(namespace, through_seq DESC);
CREATE INDEX IF NOT EXISTS idx_memory_session_checkpoint_agent ON memory_session_checkpoints(agent_id);
CREATE TABLE IF NOT EXISTS memory_store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/** 지금 소유자의 세션 파일 위치. 기억 저장소를 못 열면 null(= 세션 파일 없음으로 동작). */
export function sessionLocation(): SessionLocation | null {
  try {
    const database = require("./database") as typeof import("./database");
    const stores = require("./stores") as typeof import("./stores");
    return { path: stores.sessionRef(database.memoryRoot(), database.getMemoryStoreInfo().ownerNamespace).path, owner: database.getMemoryStoreInfo().ownerNamespace };
  } catch { return null; }
}

function identityOf(file: string): string | null {
  try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}
function metaOwner(db: Database.Database): string | null | undefined {
  try {
    const row = db.prepare("SELECT value FROM memory_store_meta WHERE key='owner_namespace'").get() as { value: string } | undefined;
    return row ? row.value : null;
  } catch { return undefined; }
}

let writer: { path: string; identity: string; db: Database.Database } | null = null;
export function closeSessionStore(): void {
  if (writer) { try { writer.db.close(); } catch { /* 이미 닫힘 */ } writer = null; }
}

/**
 * 쓰기 연결(없으면 파일·표·메타를 만든다). 다른 소유자의 파일이거나 못 열면 null — 호출자는 뿌리에 저장하는 옛 길로 간다.
 * 연결은 프로세스 안에서 재사용하고, 파일이 바뀌어 놓였으면 다시 연다.
 */
export function openSessionForWrite(loc: SessionLocation): Database.Database | null {
  try {
    if (writer && (writer.path !== loc.path || writer.identity !== identityOf(loc.path))) closeSessionStore();
    if (writer) return writer.db;
    fs.mkdirSync(path.dirname(loc.path), { recursive: true, mode: 0o700 });
    const db = new Database(loc.path, { timeout: SESSION_LOCK_WAIT_MS });
    try {
      try { db.pragma("journal_mode=WAL"); } catch { /* 읽기 전용 볼륨이면 아래에서 실패한다 */ }
      // 이 연결이 지우는 모든 행(저장 때 밀려나는 줄, 보존 작업, 따라잡기)이 파일에 평문으로 남지 않게 한다. 연결 단위 설정이라 열 때마다 켠다.
      db.pragma("secure_delete=ON");
      db.exec(DDL);
      const owner = metaOwner(db);
      if (owner && owner !== loc.owner) { db.close(); return null; }
      const meta = db.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)");
      for (const [key, value] of Object.entries({ schema_version: SESSION_SCHEMA_VERSION, core_schema_version: "agentlas.core-memory-runtime.v1", owner_namespace: loc.owner, store_kind: "session" })) meta.run(key, value);
      if (process.platform !== "win32") { try { fs.chmodSync(loc.path, 0o600); } catch { /* 소유자 아님 */ } }
    } catch (error) { try { db.close(); } catch { /* 닫힘 */ } throw error; }
    writer = { path: loc.path, identity: identityOf(loc.path) ?? "", db };
    return db;
  } catch { closeSessionStore(); return null; }
}

/** 읽기 전용 연결. 파일이 없으면 null(아무것도 만들지 않는다). 부르는 쪽이 닫는다. 다른 소유자·깨진 파일도 null. */
export function openSessionForRead(loc: SessionLocation): Database.Database | null {
  try {
    if (identityOf(loc.path) === null) return null;
    const db = new Database(loc.path, { readonly: true, fileMustExist: true, timeout: SESSION_LOCK_WAIT_MS });
    try {
      const owner = metaOwner(db);
      if (owner === undefined || (owner !== null && owner !== loc.owner)) { db.close(); return null; }
      db.prepare("SELECT 1 FROM memory_session_checkpoint_heads LIMIT 1").get();
      return db;
    } catch { try { db.close(); } catch { /* 닫힘 */ } return null; }
  } catch { return null; }
}

function withWriter<T>(loc: SessionLocation | null, fallback: T, action: (db: Database.Database) => T): T {
  if (!loc || identityOf(loc.path) === null) return fallback; // 파일이 없으면 지울 것도 없다 — 만들지 않는다
  const db = openSessionForWrite(loc);
  if (!db) return fallback;
  try { return action(db); } catch { return fallback; }
}

/** 잊기: 두 표를 물리적으로 비운다(지운 페이지를 덮어쓴다). 파일이 없거나 못 열면 false — 낡은 잊기 번호가 읽기를 막고 보존 작업이 마저 지운다. */
export function purgeSessionFile(loc: SessionLocation | null = sessionLocation()): boolean {
  return withWriter(loc, false, db => {
    db.pragma("secure_delete=ON");
    db.transaction(() => {
      db.prepare("DELETE FROM memory_session_checkpoint_heads").run();
      db.prepare("DELETE FROM memory_session_checkpoints").run();
    }).immediate();
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 다른 연결이 읽는 중 */ }
    return true;
  });
}

/**
 * K7'' (audit D6): a forget of a line only the conversations of `actors` could read empties THEIR continuation points in the session file (by the actor in the row: the `agent_id` column, or the payload's `actorId` for a row
 * written before the column) and stamps the others' points that were valid just before this forget (`epoch - 1`) with the new forget number, so the read fence and the stale-row cleanup keep them. Physically written
 * (secure_delete, log truncated). False when the file is absent or cannot be opened now (the epoch fence then hides every row; the retention pass removes them).
 */
export function forgetSessionActors(actors: readonly string[], epoch: number, loc: SessionLocation | null = sessionLocation()): boolean {
  if (!actors.length) return false;
  const marks = actors.map(() => "?").join(",");
  return withWriter(loc, false, db => {
    db.pragma("secure_delete=ON");
    db.transaction(() => {
      const namespaces = db.prepare(`SELECT DISTINCT namespace FROM memory_session_checkpoints WHERE COALESCE(agent_id, json_extract(payload_json,'$.actorId')) IN (${marks})`).all(...actors) as Array<{ namespace: string }>;
      for (const row of namespaces) {
        db.prepare("DELETE FROM memory_session_checkpoint_heads WHERE namespace=?").run(row.namespace);
        db.prepare("DELETE FROM memory_session_checkpoints WHERE namespace=?").run(row.namespace);
      }
      db.prepare("UPDATE memory_session_checkpoints SET payload_json=json_set(payload_json,'$.forgetEpoch',?) WHERE json_valid(payload_json) AND json_extract(payload_json,'$.forgetEpoch')=?").run(epoch, epoch - 1);
    }).immediate();
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* another connection is reading */ }
    return true;
  });
}

/** One namespace (the `forget(identity)` path). The file is not created for it. */
export function forgetSessionNamespace(loc: SessionLocation | null, namespace: string): number {
  return withWriter(loc, 0, db => db.transaction(() => {
    db.pragma("secure_delete=ON");
    db.prepare("DELETE FROM memory_session_checkpoint_heads WHERE namespace=?").run(namespace);
    return db.prepare("DELETE FROM memory_session_checkpoints WHERE namespace=?").run(namespace).changes;
  }).immediate());
}

function deleteBy(loc: SessionLocation | null, where: string, value: string): number {
  return withWriter(loc, 0, db => db.transaction(() => {
    db.pragma("secure_delete=ON");
    const rows = db.prepare(`SELECT checkpoint_id, namespace FROM memory_session_checkpoints WHERE ${where}`).all(value) as Array<{ checkpoint_id: string; namespace: string }>;
    for (const row of rows) {
      db.prepare("DELETE FROM memory_session_checkpoint_heads WHERE namespace=?").run(row.namespace);
      db.prepare("DELETE FROM memory_session_checkpoints WHERE namespace=?").run(row.namespace);
    }
    return rows.length;
  }).immediate());
}
/** 채팅이 지워질 때 그 채팅 namespace(visibilityDomain `chat:<id>`)의 세션 파일 행을 지운다. 지운 행 수. */
export function forgetSessionCheckpointsForChat(chatId: string, loc: SessionLocation | null = sessionLocation()): number {
  return deleteBy(loc, "json_extract(payload_json,'$.visibilityDomain') = ?", `chat:${chatId}`);
}
/** 에이전트가 지워질 때 그 에이전트의 세션 파일 행을 지운다(행의 agent_id 열). 지운 행 수. */
export function forgetSessionCheckpointsForAgent(agentId: string, loc: SessionLocation | null = sessionLocation()): number {
  return deleteBy(loc, "agent_id = ?", agentId);
}

const caughtUp = new Map<string, string>();

/**
 * 따라잡기(잊기 뒤 평문 잔류): 세션 파일을 모르는 옛 앱이 뿌리 표만 비우고 잊기 번호를 올렸다면, 이 파일에는 옛 번호의 평문 줄이 남는다. 읽기는 번호 울타리로
 * 숨기지만 파일 바이트에는 있다. 새 앱이 이 파일을 (잊기 번호가 바뀐 뒤) 처음 열 때 뿌리의 현재 번호와 대조해 뒤처진 줄을 물리적으로 지운다
 * (secure_delete + 로그 비우기). 같은 (파일, 파일 신원, 번호)는 프로세스 안에서 한 번만 본다 — 읽기 전용으로 한 번 확인하고, 지울 줄이 있을 때만 쓰기 연결을 쓴다.
 * 파일이 없으면 아무것도 만들지 않는다. 지운 행 수를 돌려주며 던지지 않는다.
 */
export function catchUpSessionFile(currentEpoch: number, loc: SessionLocation | null = sessionLocation()): number {
  try {
    if (!loc) return 0;
    const identity = identityOf(loc.path);
    if (identity === null) return 0;
    const stamp = `${identity}|${currentEpoch}`;
    if (caughtUp.get(loc.path) === stamp) return 0;
    const probe = openSessionForRead(loc);
    if (!probe) return 0; // 못 여는 파일(다른 소유자·깨짐)은 건드리지 않는다 — 기록하지 않아 다음에 다시 본다
    let stale = false;
    try { stale = probe.prepare(STALE_EPOCH_SQL).get(currentEpoch) !== undefined; } catch { stale = false; } finally { try { probe.close(); } catch { /* 닫힘 */ } }
    const deleted = stale ? withWriter(loc, 0, db => {
      const count = db.transaction(() => dropStaleEpochRows(db, currentEpoch)).immediate();
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 다른 연결이 읽는 중 — 보존 작업이 마저 비운다 */ }
      return count;
    }) : 0;
    caughtUp.set(loc.path, stamp);
    return deleted;
  } catch { return 0; }
}

const STALE_EPOCH_SQL = "SELECT 1 FROM memory_session_checkpoints WHERE COALESCE(json_extract(payload_json,'$.forgetEpoch'), -1) <> ? LIMIT 1";
function dropStaleEpochRows(db: Database.Database, currentEpoch: number): number {
  const deleted = db.prepare("DELETE FROM memory_session_checkpoints WHERE COALESCE(json_extract(payload_json,'$.forgetEpoch'), -1) <> ?").run(currentEpoch).changes;
  db.prepare("DELETE FROM memory_session_checkpoint_heads WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM memory_session_checkpoints)").run();
  return deleted;
}

/**
 * 보존 작업이 부르는 한 번의 정리. 지우는 것: 90일 넘은 행, 잊기 번호가 현재와 다른 행(잊은 대화의 평문), 머리가 아닌 줄 중 namespace 마다 최신
 * (SESSION_CHECKPOINTS_KEPT - 1)개 밖의 것, 가리키는 줄이 없는 머리. 지운 행 수를 돌려준다. 던지지 않고, 파일이 없으면 0.
 */
export function pruneSessionFile(currentEpoch: number, now: number = Date.now(), loc: SessionLocation | null = sessionLocation()): number {
  return withWriter(loc, 0, db => { db.pragma("secure_delete=ON"); const deleted = db.transaction(() => {
    const cutoff = new Date(now - SESSION_FILE_ROW_DAYS * 86_400_000).toISOString();
    let deleted = 0;
    deleted += db.prepare("DELETE FROM memory_session_checkpoints WHERE created_at < ?").run(cutoff).changes;
    deleted += db.prepare("DELETE FROM memory_session_checkpoints WHERE COALESCE(json_extract(payload_json,'$.forgetEpoch'), -1) <> ?").run(currentEpoch).changes;
    deleted += db.prepare(`DELETE FROM memory_session_checkpoints WHERE rowid IN (
      SELECT rid FROM (SELECT rowid AS rid, ROW_NUMBER() OVER (PARTITION BY namespace ORDER BY through_seq DESC, rowid DESC) AS rn
        FROM memory_session_checkpoints WHERE rowid NOT IN (SELECT c.rowid FROM memory_session_checkpoint_heads h JOIN memory_session_checkpoints c ON c.checkpoint_id = h.checkpoint_id))
      WHERE rn > ?)`).run(SESSION_CHECKPOINTS_KEPT - 1).changes;
    db.prepare("DELETE FROM memory_session_checkpoint_heads WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM memory_session_checkpoints)").run();
    return deleted;
  }).immediate();
    if (deleted) { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 다른 연결이 읽는 중 */ } }
    return deleted;
  });
}
