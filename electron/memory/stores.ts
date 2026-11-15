// 기억 저장소 합집합 읽기 — 읽기 전용 (엔진 짝: Agentlas-OS agentlas_cloud/memory_stores.py).
//
// 기억은 네 종류 저장소로 갈린다. 뿌리(`memory.sqlite`)는 개인 기억이고 항상 있다. 나머지는 옆이나 에이전트 폴더 안에 있을 수 있다.
//   agent    <에이전트 폴더>/.agentlas-local/memory/o-<sha256(owner)[:16]>/memory.sqlite   (이 컴퓨터에만)
//   project  <기억 루트>/owners/<sha256(owner)>/projects/<sha256(프로젝트 키)[:32]>/memory.sqlite
// session <기억 루트>/owners/<sha256(owner)>/session.sqlite (체크포인트;)
//   worker   <기억 루트>/owners/<sha256(owner)>/worker/memory.sqlite   (2.0 K1: "이 컴퓨터의 작업 지식" 한 곳 — 경로만 있고 아무것도 쓰거나 읽지 않는다)
//
// ★이 파일은 읽기만 한다. 저장소 파일을 만들지 않고, 열이나 표를 더하지 않고, 행을 옮기지 않는다(쓰기·이사는).
//   예외 하나: 잊기 따라잡기(`catchUp`) — 뿌리 장부가 잊으라고 한 행이 이 저장소 파일에 아직 남아 있으면 그 행을 비운다. 엔진과 같은 규칙이다.
// ★분리 스위치는 뿌리 `memory_store_meta.memory_layout` 이다. 값이 없거나 비면 `central` — 이 파일의 어떤 것도 호출되지 않고 동작은 이 묶음 전과
// 바이트까지 같다. 정확히 `split-1` 이면 `split`, 모르는 값이면 `union`(새 레이아웃: 모든 저장소를 읽고 쓰기는 뿌리). 모르는 값을 이유로 거절하지 않는다.
// ★읽기는 을 따른다: 읽을 수 있는 것은 읽고 계속 간다. 새 스키마 저장소는 열린 만큼 읽고, 없거나 깨지거나 반쯤 쓰인 저장소는 건너뛰어 코드(문장 아님)로
//   알린다. 사유 없이 건너뛰는 것은 *다른 소유자 네임스페이스*의 저장소뿐이다.
// ★Electron 을 가져오지 않는다(데몬·시험이 같은 파일을 읽는다). 기억 루트·소유자·뿌리 DB 는 부르는 쪽이 넘긴다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE, agentHomeRoot } from "../agents/home";
import { isOneMemoryActor } from "../../shared/memory-actor-family";
import { specialStoreAgentId } from "./special-store-agents";
import { dropDerivedBesideStore } from "./forget-derived";
import { projectPathKey } from "./project-index";
import { recallReasonOfError } from "./recall-contract";

export const LAYOUT_KEY = "memory_layout";
export const SPLIT_LAYOUT = "split-1";
/** 2.0 구조 변환(K5)이 쓸 값. K1 은 읽기만 한다: `split2` 는 줄을 옮기지 않는 배치로 다뤄진다(모든 저장소를 읽고 쓰기는 뿌리) — 모르는 값(`union`)과 똑같이. */
export const SPLIT2_LAYOUT = "split-2";
/** 뿌리 메타의 첫 실행 합치기 상태 키(K5 가 쓴다; 여기서는 읽기만, 한 줄). */
export const FIRST_RUN_MERGE_KEY = "first_run_merge";
export type MemoryLayout = "central" | "split" | "union" | "split2";
export type StoreKind = "personal" | "agent" | "project" | "session" | "worker";
export interface StoreRef { kind: StoreKind; key: string | null; path: string }

export const STORE_FILE = "memory.sqlite";
/** 엔진(`memory_runtime.SCHEMA`)이 저장소 메타 `core_schema_version` 에 쓰는 값. 데스크탑이 만든 옛 저장소는 `agentlas_memory` 를 썼으므로 둘 다 받는다. */
export const CORE_SCHEMA_VERSION = "agentlas.core-memory-runtime.v1";
const CORE_SCHEMA_ACCEPTED: ReadonlySet<string> = new Set([CORE_SCHEMA_VERSION, "agentlas_memory"]);
/** 열어 두는 읽기 연결 수(LRU). 엔진 `_CACHE` 와 같은 자릿수. */
export const MAX_OPEN_STORES = 16;
/** 저장소들이 들고 있는 읽기 결과 캐시의 전체 행 상한(엔진 `_CACHE_MAX_ITEMS`). */
export const CACHE_MAX_ROWS = 20_000;
/** 잊기를 이 저장소 파일에 적용할 때 쓰기 잠금을 기다리는 시간(엔진 CATCHUP_LOCK_WAIT). 못 쓰면 그 id 를 숨기고 다음에 다시 한다. */
export const CATCHUP_LOCK_WAIT_MS = 50;

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// --- 분리 스위치 ------------------------------------------------------------------------------------------------

/** 뿌리 메타에서 레이아웃. 던지지 않는다 — 읽지 못하면 `central`. */
export function layoutOf(rootDb: Database.Database | null | undefined): MemoryLayout {
  if (!rootDb) return "central";
  try {
    const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(LAYOUT_KEY) as { value: unknown } | undefined;
    const value = row?.value;
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return "central";
    return value === SPLIT_LAYOUT ? "split" : value === SPLIT2_LAYOUT ? "split2" : "union";
  } catch { return "central"; }
}
/** 뿌리 메타의 `first_run_merge` 를 객체로. 없거나 못 읽거나 객체가 아니면 null. 던지지 않고 쓰지 않는다. */
export function firstRunMerge(rootDb: Database.Database | null | undefined): Record<string, unknown> | null {
  if (!rootDb) return null;
  try {
    const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(FIRST_RUN_MERGE_KEY) as { value: unknown } | undefined;
    const value: unknown = typeof row?.value === "string" ? JSON.parse(row.value) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export function readsUnion(rootDb: Database.Database | null | undefined): boolean { return layoutOf(rootDb) !== "central"; }

// --- 경로 (엔진과 같은 고정 표: contracts/test-vectors/memory-store-path-vectors.json) -----------------------------

export function accountDir(memoryRoot: string, owner: string): string { return path.join(memoryRoot, "owners", sha(owner)); }
/** 이 소유자의 "이 컴퓨터의 작업 지식" 저장소(2.0 §2.5). 경로뿐 — 만들지도 읽지도 않는다. */
export function workerRef(memoryRoot: string, owner: string): StoreRef { return { kind: "worker", key: null, path: path.join(accountDir(memoryRoot, owner), "worker", STORE_FILE) }; }
export function sessionRef(memoryRoot: string, owner: string): StoreRef { return { kind: "session", key: null, path: path.join(accountDir(memoryRoot, owner), "session.sqlite") }; }
export function projectRef(memoryRoot: string, owner: string, key: string): StoreRef {
  return { kind: "project", key, path: path.join(accountDir(memoryRoot, owner), "projects", sha(key).slice(0, 32), STORE_FILE) };
}
export function agentAccountFolder(owner: string): string { return "o-" + sha(owner).slice(0, 16); }
export function agentRef(owner: string, agentFolder: string, agentId: string): StoreRef {
  return { kind: "agent", key: agentId, path: path.join(agentFolder, AGENT_LOCAL_STATE_FOLDER, "memory", agentAccountFolder(owner), STORE_FILE) };
}

// --- 프로젝트 키 (엔진 project_identity.project_key 와 같은 규칙) --------------------------------------------------------

const MARKER_RELATIVE = [".agentlas", "memory-map.json"];
const MAX_MARKER_BYTES = 4 * 1024 * 1024;

/** `path:` + sha256(실제 경로). 엔진 `path_key`. */
export function pathKey(root: string): string {
  // 엔진과 같은 풀이(없는 꼬리는 그대로 붙이고 Windows 는 `realpath.native` 로 드라이브·폴더의 실제 대소문자와 8.3 이름을 푼다)와 같은 해시(결함 11).
  return projectPathKey(root);
}

/** 프로젝트 폴더의 표식 `projectUid`, 없거나 못 읽으면 경로 해시. 던지지 않고 쓰지 않는다. */
export function folderProjectKey(root: string): string {
  try {
    const file = path.join(root, ...MARKER_RELATIVE);
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size <= MAX_MARKER_BYTES) {
      const payload = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as { projectUid?: unknown };
      if (payload && typeof payload === "object" && typeof payload.projectUid === "string" && payload.projectUid.trim()) return payload.projectUid;
    }
  } catch { /* 표식 없음·깨짐 → 경로 해시 */ }
  return pathKey(root);
}

/** 후보 프로젝트 키, 좋은 순: 앱이 CLI 에 준 프로젝트 ref(= 프로젝트 id, 없으면 주지 않는다 — 대화 id 는 키가 아니다) → 폴더의 키. 데스크탑에서 한 번, 터미널에서 한 번 닿은 프로젝트도 한 프로젝트의 기억이다. */
export function projectKeys(projectPath: string | null | undefined, ref?: string | null): string[] {
  const keys: string[] = [];
  if (typeof ref === "string" && ref.trim()) keys.push(ref.trim());
  if (projectPath) keys.push(folderProjectKey(projectPath));
  return [...new Set(keys)];
}

// --- 어느 에이전트의 저장소를 여는가 (엔진 store_agent_id 와 같은 답) ---------------------------------------------------

const HUB_PREFIX = "hub:";
const SYSTEM_ACTOR_PREFIXES = ["host:", "builtin-agentlas-"];

/** 이 행위자가 자기 저장소로 읽는 에이전트 id. One·`host:*`·`builtin-agentlas-*`(등록된 특수 에이전트 제외)·`hub:*` 는 없다. */
export function storeAgentId(actor: string | null | undefined): string | null {
  if (typeof actor !== "string" || !actor.trim()) return null;
  const text = actor.trim();
  if (isOneMemoryActor(text)) return null;
  const folded = text.toLowerCase();
  // The engine's contract gives the two special agents (Science, Finance) their own agent store, ahead of the system-actor rule. Desktop common code
  // does not name them (the Finance ratchet in test-finance-harness-unified): each module registers its own id (special-store-agents.ts). With no
  // agent folder yet (until) they still read the root, as before.
  const special = specialStoreAgentId(text);
  if (special) return special;
  if (SYSTEM_ACTOR_PREFIXES.some(prefix => folded.startsWith(prefix))) return null;
  if (folded.startsWith(HUB_PREFIX)) return null;
  return text;
}

// --- 에이전트 폴더 찾기 -------------------------------------------------------------------------------------------

export const AGENT_FOLDER_ENV = "AGENTLAS_MEMORY_AGENT_FOLDER";
let agentIndex: { base: string; stamp: number; byId: Map<string, string> } | null = null;

/** 폴더의 owner.json 이 이름 붙인 id 전부: `agentId` 와(있으면) `ids[]` 별칭. */
export function ownerIds(folder: string): string[] {
  try {
    const file = path.join(folder, AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE);
    if (fs.lstatSync(file).isSymbolicLink()) return [];
    const payload = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as { agentId?: unknown; ids?: unknown };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const found: unknown[] = [payload.agentId];
    if (Array.isArray(payload.ids)) found.push(...payload.ids);
    return [...new Set(found.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch { return []; }
}

/** `{에이전트 id → 폴더}`. 별칭마다 한 줄이 생기므로 같은 폴더가 여러 id 로 나온다. 루트 폴더의 mtime 으로 프로세스 안에서 캐시한다. */
export function agentFolderIndex(root: string = agentHomeRoot(), refresh = false): Map<string, string> {
  let stamp: number;
  try { stamp = fs.statSync(root).mtimeMs; } catch { return new Map(); }
  if (!refresh && agentIndex && agentIndex.base === root && agentIndex.stamp === stamp) return agentIndex.byId;
  const byId = new Map<string, string>();
  let entries: string[];
  try { entries = fs.readdirSync(root).sort(); } catch { return new Map(); }
  for (const name of entries) {
    const folder = path.join(root, name);
    try { if (!fs.statSync(folder).isDirectory()) continue; } catch { continue; }
    for (const id of ownerIds(folder)) if (!byId.has(id)) byId.set(id, folder);
  }
  agentIndex = { base: root, stamp, byId };
  return byId;
}

/** 앱이 실행기에 준 폴더(`AGENTLAS_MEMORY_AGENT_FOLDER`)가 이 에이전트의 것이면 그것. 아니면 색인. 허브 에이전트(`hub:`)는 폴더가 없다. */
export function findAgentHome(agentId: string | null | undefined, rescan = true): string | null {
  if (typeof agentId !== "string" || !agentId || agentId.startsWith(HUB_PREFIX)) return null;
  const envFolder = process.env[AGENT_FOLDER_ENV]?.trim();
  if (envFolder && path.isAbsolute(envFolder) && ownerIds(envFolder).includes(agentId)) return envFolder;
  return agentFolderIndex().get(agentId) ?? (rescan ? agentFolderIndex(agentHomeRoot(), true).get(agentId) ?? null : null);
}

// --- 이 계정의 저장소 파일 목록 (열지 않는다, stat 만) ----------------------------------------------------------------------

export interface ExistingStore { ref: StoreRef; mtimeMs: number; size: number; /** 파일 시스템의 mtime 이 1~2초 단위여도 같은 초의 쓰기를 알아채도록 지문에 더한다(감사 40 #15). */ ctimeMs?: number }
/** 시험이 "쉬는 앱에서 저장소 순회 0" 을 숫자로 단언한다: 목록을 만든 횟수와 그때 stat 한 파일 수. 타이머가 부르지 않으므로 요청이 없으면 늘지 않는다. */
export const storeEnumerationStats = { listings: 0, statted: 0 };

/**
 * 이 계정의 프로젝트 저장소와 에이전트 저장소 파일 전부(상한 없음). 열지 않고 stat 만 한다 — 프로젝트는 디렉터리 목록 1회, 에이전트는 폴더 색인(루트 mtime 캐시)의 폴더마다 stat 1회.
 * 에이전트 폴더 하나에 별칭이 여럿이어도 한 줄이다. 요청이 있을 때만 부른다(합쳐 읽기·잊기·삭제·id 찾기). 던지지 않는다.
 */
export function listExistingStores(memoryRoot: string, owner: string): ExistingStore[] {
  storeEnumerationStats.listings += 1;
  const found: ExistingStore[] = [];
  try {
    const projects = path.join(accountDir(memoryRoot, owner), "projects");
    for (const name of fs.readdirSync(projects).sort()) {
      const file = path.join(projects, name, STORE_FILE);
      try { const stat = fs.lstatSync(file); storeEnumerationStats.statted += 1; if (stat.isFile()) found.push({ ref: { kind: "project", key: null, path: file }, mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs }); } catch { /* 이 프로젝트 저장소는 없다 */ }
    }
  } catch { /* 프로젝트 저장소 폴더 없음 */ }
  const seen = new Set<string>();
  for (const [id, folder] of agentFolderIndex()) {
    if (seen.has(folder)) continue;
    seen.add(folder);
    const ref = agentRef(owner, folder, id);
    try { const stat = fs.lstatSync(ref.path); storeEnumerationStats.statted += 1; if (stat.isFile()) found.push({ ref, mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs }); } catch { /* 이 에이전트 저장소는 없다 */ }
  }
  return found;
}

// --- 열기 --------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
interface Handle {
  ref: StoreRef;
  db: Database.Database;
  identity: string;       // dev:ino — 파일이 바뀌어 놓였으면 다시 연다
  dataVersion: number;    // 다른 연결이 커밋하면 달라진다(읽기 결과 캐시의 지문)
  rows: Map<string, Row[]>;
  notes: string[];
  forgotEpoch: number;    // 이 핸들을 만들 때 본 뿌리 시계(캐시 지문의 일부)
}
export interface OpenedStore { ref: StoreRef; db: Database.Database; notes: string[]; withheld: ReadonlySet<string>; handle: Handle }
const handles = new Map<string, Handle>();
let cachedRows = 0;

function dropHandle(key: string): void {
  const handle = handles.get(key);
  if (!handle) return;
  for (const rows of handle.rows.values()) cachedRows -= rows.length;
  handles.delete(key);
  try { handle.db.close(); } catch { /* 이미 닫힘 */ }
}
/** 열린 연결과 캐시를 전부 닫는다(시험·종료·소유자 전환). */
export function closeAllStores(): void { for (const key of [...handles.keys()]) dropHandle(key); cachedRows = 0; }
export function storeCacheStats(): { open: number; cachedRows: number } { return { open: handles.size, cachedRows }; }
/** 폴더 아래의 저장소 연결을 닫는다(에이전트 삭제·이동·교체 전, Windows 에서 열린 연결이 폴더 삭제를 막는다). 닫은 연결 수. */
export function closeStoresUnder(folder: string): number {
  const base = path.resolve(folder) + path.sep;
  let closed = 0;
  for (const key of [...handles.keys()]) if (path.resolve(key).startsWith(base)) { dropHandle(key); closed += 1; }
  return closed;
}
/** 저장소 파일 하나의 연결을 닫는다. */
export function closeStoreHandle(file: string): boolean { if (!handles.has(file)) return false; dropHandle(file); return true; }

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}
function metaOf(db: Database.Database): Record<string, string> {
  if (!hasTable(db, "memory_store_meta")) return {};
  const out: Record<string, string> = {};
  for (const row of db.prepare("SELECT key,value FROM memory_store_meta").all() as Array<{ key: unknown; value: unknown }>) out[String(row.key)] = String(row.value);
  return out;
}

/** 에이전트 저장소의 심볼릭 링크 규칙: 에이전트 폴더 자체는 링크여도 되지만 `.agentlas-local` 과 그 아래는 안 된다. 사유 코드 또는 null. */
function containedAgentPath(ref: StoreRef): string | null {
  let state = ref.path;
  for (let i = 0; i < 3; i += 1) state = path.dirname(state);
  if (path.basename(state) !== AGENT_LOCAL_STATE_FOLDER) return null;
  for (const part of [state, path.join(state, "memory"), path.dirname(ref.path), ref.path]) {
    try { if (fs.lstatSync(part).isSymbolicLink()) return "agent_local_state_symlink"; }
    catch { return "agent_local_state_unreadable"; }
  }
  return null;
}
function containedAccountPath(ref: StoreRef, memoryRoot: string): string | null {
  const base = path.resolve(memoryRoot);
  try {
    let part = path.resolve(ref.path);
    while (part !== base && part !== path.dirname(part)) {
      if (fs.lstatSync(part).isSymbolicLink()) return "store_symlink";
      part = path.dirname(part);
    }
  } catch { return "store_unreadable"; }
  return null;
}

function degradeNotes(meta: Record<string, string>, kind: StoreKind): string[] {
  const notes: string[] = [];
  if (meta.schema_version !== undefined && meta.schema_version !== "1") notes.push("degraded:schema_version");
  if (meta.core_schema_version !== undefined && !CORE_SCHEMA_ACCEPTED.has(meta.core_schema_version)) notes.push("degraded:core_schema_version");
  if (meta.store_kind !== undefined && meta.store_kind !== kind) notes.push("degraded:store_kind");
  if (!Object.keys(meta).length) notes.push("degraded:meta_missing");
  return notes;
}

/** 뿌리 시계(잊기 번호). 읽지 못하면 null. */
export function rootClock(rootDb: Database.Database): number | null {
  try {
    if (!hasTable(rootDb, "memory_forget_clock")) {
      const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key='revocation_epoch'").get() as { value: unknown } | undefined;
      return row ? Number(row.value) || 0 : 0;
    }
    const row = rootDb.prepare("SELECT epoch FROM memory_forget_clock WHERE id=1").get() as { epoch: number } | undefined;
    return row ? Number(row.epoch) : 0;
  } catch { return null; }
}

/** 뿌리 장부가 `after` 이후에 잊은 기억 id. 못 읽으면 null. */
export function forgottenIds(rootDb: Database.Database, after = 0): Set<string> | null {
  try {
    if (!hasTable(rootDb, "memory_revocations")) return new Set();
    const ids = new Set<string>();
    for (const row of rootDb.prepare("SELECT source_memory_id AS id FROM memory_revocations WHERE revoked_epoch>?").all(after) as Array<{ id: unknown }>) if (typeof row.id === "string") ids.add(row.id);
    if (hasTable(rootDb, "memory_revocation_sources")) {
      for (const row of rootDb.prepare("SELECT s.source_memory_id AS id FROM memory_revocation_sources s JOIN memory_revocations r ON r.revocation_id=s.revocation_id WHERE r.revoked_epoch>?").all(after) as Array<{ id: unknown }>) if (typeof row.id === "string") ids.add(row.id);
    }
    return ids;
  } catch { return null; }
}
/** 뿌리 `memory_store_meta` 키: 저장소 분리를 켠 순간의 잊기 번호(= 그때까지의 잊기는 "옛 잊기"). 읽는 곳: 옛 잊기의 범위를 가르는 곳(`forgottenHashes`·`exactContentRevoked`). 쓰는 곳: 스위치를 켜는 코드가 같은 트랜잭션에서(`markLayoutSwitchEpoch`). 뿌리와 함께 지워진다. */
export const SWITCH_EPOCH_KEY = "layout_switch_epoch";

/**
 * 분리를 켠 시점의 잊기 번호. 이 번호 *이하*의 잊기는 스위치를 켜기 전의 "범위 한정" 잊기다(그 에이전트·그 프로젝트의 것만 지운다는 사용자의 요청) — 이사·따라잡기·쓰기 거절이 그 범위를 계정 전체로 넓히지 않는다(#4).
 * 이 번호 *뒤*의 잊기는 계정 전체 기준이다. 표식이 없으면(스위치를 켠 코드가 안 적었거나 읽지 못함) 0 — 모든 잊기를 계정 전체로 본다(이전 동작, 개인정보에 안전한 쪽: 몰라서 덜 지우지 않는다).
 * 읽기만 한다 — 읽는 길에서 몰래 적으면 켠 뒤에 생긴 잊기를 옛 것으로 오판할 수 있다. 새 표·열 없이 기존 메타 한 줄.
 */
export function layoutSwitchEpoch(rootDb: Database.Database): number {
  try {
    if (layoutOf(rootDb) === "central") return 0;
    const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(SWITCH_EPOCH_KEY) as { value: unknown } | undefined;
    const value = Number.parseInt(String(row?.value ?? "0"), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

/**
 * 스위치를 켜는 코드(F3)가 레이아웃 값을 적는 *같은 트랜잭션에서* 부른다: 지금까지의 잊기를 "옛 잊기"로 못 박는다. 이미 적혀 있으면 그대로 둔다(스위치를 다시 켜도 처음 값이 유지된다).
 * 현재 잊기 번호를 돌려준다.
 */
export function markLayoutSwitchEpoch(rootDb: Database.Database): number {
  const clock = rootClock(rootDb) ?? 0;
  rootDb.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)").run(SWITCH_EPOCH_KEY, String(clock));
  return clock;
}

/**
 * 개인 에이전트의 집 거울(Agentlas 2.0 O-M3b, 계약 one-home-move.md §3.2): 뿌리 `memory_store_meta.one_home_state` 한 줄. 엔진의 Personal 받는 문턱(`deniedHomeStates`)과 이사 묶음의 가져오기가
 * 읽는다(`memory_classify.home_state`). 쓰는 곳: 데스크탑의 집 기록(`one/home-move.ts`)만 — 로컬 집 기록이 정본이고 이 줄은 그 뒤를 따른다. `home`·`sealed`·`away`는 그 글 그대로, `legacy`는 줄을 지운다
 * (줄이 없으면 엔진은 지금까지처럼 `home`으로 읽는다). 새 표·열 없음, 뿌리와 함께 지워진다. 성공하면 true.
 */
export const HOME_MIRROR_KEY = "one_home_state";
export function setHomeMirror(rootDb: Database.Database, state: "legacy" | "home" | "sealed" | "away"): boolean {
  try {
    if (!hasTable(rootDb, "memory_store_meta")) return false;
    if (state === "legacy") rootDb.prepare("DELETE FROM memory_store_meta WHERE key=?").run(HOME_MIRROR_KEY);
    else rootDb.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(HOME_MIRROR_KEY, state);
    return true;
  } catch { return false; }
}
export function readHomeMirror(rootDb: Database.Database): string | null {
  try {
    if (!hasTable(rootDb, "memory_store_meta")) return null;
    const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(HOME_MIRROR_KEY) as { value: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch { return null; }
}

/**
 * 이사 묶음(O-M2, 엔진 `one_pack.py`)으로 들어온 도장의 `source_memory_id` 고정 글 — 엔진 `memory_stores.ONE_PACK_STAMP_SOURCE` 와 같은 글이어야 한다(두 쪽의 같은 글을 시험이 맞춘다).
 * 줄 id 가 아니다(가져오기는 이 접두사로 시작하는 id 의 줄을 받지 않는다): id 로 숨기고 비우는 길(`forgottenIds`·`presentForgotten`)은 이 글로 어떤 줄에도 닿지 못한다.
 * 이 접두사가 있는 도장은 번호·스위치 경계·시계와 무관하게 *그 소유 열쇠(Personal)의 줄에만* 닿는다. 접두사가 없는 도장은 예전과 똑같이 읽는다(번호 대 경계).
 */
export const ONE_PACK_STAMP_SOURCE = "one-pack:personal-stamp";
export const ONE_PACK_STAMP_PREFIX = "one-pack:";
export function stampIsPersonalOnly(source: unknown): boolean { return typeof source === "string" && source.startsWith(ONE_PACK_STAMP_PREFIX); }

/** 잊은 글(종류+해시) → 그 글을 지울 수 있는 소유 열쇠 집합(K7': 계정 전체인 `null` 은 이제 없다 — 잊기는 그 잊기의 소유 열쇠와 맞는 줄에만 적용된다). */
type ForgottenHashes = Map<string, ReadonlySet<string> | null>;
function forgottenHashes(rootDb: Database.Database, after: number): ForgottenHashes {
  const result: ForgottenHashes = new Map();
  try {
    if (!hasTable(rootDb, "memory_revocations")) return result;
    // K7': every stamp reaches the OWNER it was made for (agent, project, Personal) and no other, whatever its number and whether or not a layout switch was ever turned on. It used to reach the whole account
    // for every forget after the switch (`null`), so the same words in another subject's store were blanked by a forget of someone else's line. A move bundle's stamp was already Personal-only.
    for (const row of rootDb.prepare("SELECT memory_kind AS kind, content_hash AS hash, owner_key AS owner FROM memory_revocations WHERE revoked_epoch>?").all(after) as Array<{ kind: string; hash: string; owner: string }>) {
      const key = `${row.kind}\0${row.hash}`;
      const current = result.get(key);
      if (current) (current as Set<string>).add(row.owner);
      else result.set(key, new Set([row.owner]));
    }
  } catch { /* 장부를 못 읽으면 아무것도 적용하지 않는다 — 호출하는 쪽이 `forgottenIds` 로 따로 막는다 */ }
  return result;
}

/** 소유 열쇠 계산(`revocations.ts memoryOwnerKey`). 순환 의존을 피해 늦게 불러온다. 못 불러오면 null — 호출하는 쪽이 "계정 전체"로 본다(개인정보에 안전한 쪽). */
function ownerKeyFn(): ((row: { scope: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null }) => string) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { memoryOwnerKey } = require("./revocations") as typeof import("./revocations");
    return (row) => memoryOwnerKey({ scope: row.scope as never, projectId: row.project_id, projectPath: row.project_path, agentId: row.agent_id, chatId: row.chat_id });
  } catch { return null; }
}

/**
 * K7'': the spellings and the kind rule of the forget stamp, from `revocations.ts forgetStampHashes` and the ruleset (`classification.ts forgetStampRules`); late-loaded (cycle). When they cannot be loaded the exact text and the exact kind
 * (the rule before this change): a line is then missed only when it differs in a trailing mark or its kind, never blanked by mistake.
 */
function stampMatching(): { variants: (text: string) => string[]; kindBlind: boolean } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { forgetStampHashes } = require("./revocations") as typeof import("./revocations");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { forgetStampRules } = require("./classification") as typeof import("./classification");
    return { variants: forgetStampHashes, kindBlind: forgetStampRules().kindBlind === true };
  } catch { return { variants: (text) => [contentHash(text)], kindBlind: false }; }
}

/** 뿌리 장부가 쓰는 본문 해시(revocations.ts `memoryContentHash` 와 같다). 의존을 줄이려고 여기에 둔 사본이며 시험이 두 값을 맞춘다. */
export function contentHash(value: string): string {
  return sha(value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase());
}

const BLANK_COLUMNS = `content='', evidence_json='[]', context_json='{}', chat_id=NULL, embedding_model=NULL, embedding_adapter=NULL,
  embedding_model_sha256=NULL, embedding_content_hash=NULL, embedding_dimensions=NULL, embedding_json=NULL`;

/** 잊은 id·글(해시)과 같은 행 중 이 연결에 아직 본문이 남은 것. 옛(스위치 전) 잊기의 글은 그 잊기의 소유 열쇠와 맞는 행에만 닿는다(`forgottenHashes`). */
function presentForgotten(db: Database.Database, ids: readonly string[], hashes: ForgottenHashes, unkeyedOut?: Set<string>): Set<string> {
  const present = new Set<string>();
  for (let start = 0; start < ids.length; start += 800) {
    const part = ids.slice(start, start + 800);
    for (const row of db.prepare(`SELECT id FROM memory_entries WHERE id IN (${part.map(() => "?").join(",")}) AND (content<>'' OR superseded_at IS NULL)`).all(...part) as Array<{ id: string }>) present.add(row.id);
  }
  if (hashes.size) {
    // 이 저장소가 연결되기 전에 잊은 글은 장부에 이 저장소의 id 가 없다. 글 자체(해시)가 장부의 키이므로 같은 글은 여기서도 간다.
    // K7'': "the same words" is the stamp's own rule (`forgetStampHashes`: one trailing mark may differ; the kind is ignored when the ruleset says the stamp is kind-blind), so the set of lines this blanks
    // is the set of lines the stamp refuses to write again. A row is looked up by every spelling of its own text against the stamp hashes.
    const { variants, kindBlind } = stampMatching();
    const byHash = new Map<string, Array<{ kind: string; owners: ReadonlySet<string> | null | undefined }>>();
    for (const [key, owners] of hashes) { const at = key.indexOf("\0"); const list = byHash.get(key.slice(at + 1)) ?? []; list.push({ kind: key.slice(0, at), owners }); byHash.set(key.slice(at + 1), list); }
    let ownerKey: ReturnType<typeof ownerKeyFn> | undefined;
    for (const row of db.prepare("SELECT id,kind,content,scope,project_id,project_path,agent_id,chat_id FROM memory_entries WHERE content<>''").all() as Array<{ id: string; kind: string; content: string; scope: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null }>) {
      let hit = false;
      for (const h of variants(row.content)) {
        for (const entry of byHash.get(h) ?? []) {
          if (!kindBlind && entry.kind !== row.kind) continue;
          if (entry.owners) { // 옛 잊기: 그 잊기가 닿았던 소유(에이전트·프로젝트·대화)의 행에만
            if (ownerKey === undefined) ownerKey = ownerKeyFn();
            // K7'': an owner that cannot be worked out is NOT counted as reached: a delete is never widened by a missing key (only the lines the ledger names by id are blanked), and the line is kept out of reads at this open (`unkeyedOut`,
            // withheld by the caller) - the side that never lets a forgotten text out. The engine twin does the same (`memory_stores._catch_up`).
            let mine: string | null = null; if (ownerKey) { try { mine = ownerKey(row); } catch { mine = null; } }
            if (mine === null) { unkeyedOut?.add(row.id); continue; }
            if (!entry.owners.has(mine)) continue;
          }
          hit = true; break;
        }
        if (hit) break;
      }
      if (hit) present.add(row.id);
    }
  }
  return present;
}

/** 이 저장소가 아직 모르는 잊기를 파일에 적용한다. 읽으면 안 되는 저장소면 null, 아니면 {숨길 id, 사유 코드}. */
function catchUp(file: string, kind: StoreKind, db: Database.Database, rootDb: Database.Database, meta: Record<string, string>): { withheld: Set<string>; note: string | null } | null {
  const clock = rootClock(rootDb);
  if (clock === null) return null;
  const applied = Number.parseInt(meta.forget_epoch_applied ?? "0", 10) || 0;
  // K7'': a rewrite (VACUUM) that did not finish is a fact about the file, kept in the file (`forget_residue_pending`, written in the same transaction as the cursor), so it survives a restart and a kill. The lines are not blanked again.
  let residueNote: string | null = null;
  if (meta[RESIDUE_PENDING_KEY] !== undefined && !rewriteStore(file, kind)) residueNote = "forget_residue_busy";
  if (applied >= clock) return { withheld: new Set(), note: residueNote };
  const ids = forgottenIds(rootDb, applied);
  if (ids === null) return null;
  const hashes = forgottenHashes(rootDb, applied);
  if (!ids.size && !hashes.size) return { withheld: new Set(), note: residueNote };
  if (!hasTable(db, "memory_entries")) return { withheld: new Set(), note: residueNote };
  const idList = [...ids];
  const unkeyed = new Set<string>();
  const seen = presentForgotten(db, idList, hashes, unkeyed);
  const done = applyForgets(file, kind, idList, hashes, clock);
  const held = new Set([...unkeyed].filter(id => !seen.has(id)));
  if (done.ok) return { withheld: held, note: held.size ? "forget_catchup_withheld" : done.residueFree && !residueNote ? null : "forget_residue_busy" };
  return { withheld: new Set([...seen, ...held]), note: seen.size || held.size ? "forget_catchup_withheld" : residueNote };
}

/**
 * trial (engine fc2c7131 `heal_foreign_triggers`): an earlier copy of the move put the root's recall-journal triggers (`memory_recall_watch_<table>_<event>`, each inserting into `memory_recall_changes`) into
 * a sub-store that has no such table; every write to the guarded table then fails ("no such table: main.memory_recall_changes") and the forget catch-up's DELETE of the original wording kept the forgotten line pending for ever.
 * The same three conditions as the engine, all of them or nothing: the trigger's name has exactly that shape, its SQL inserts into `memory_recall_changes`, and this file has no such table. Nothing else is dropped
 * (the user's own triggers, a similar name that writes elsewhere, a store that has the table). Returns the number dropped; runs inside the forget catch-up's write transaction.
 */
const FOREIGN_TRIGGER_NAME = /^memory_recall_watch_[a-z0-9_]+_(?:insert|update|delete)$/;
const FOREIGN_TRIGGER_BODY = /\bINSERT\s+INTO\s+["`\[]?memory_recall_changes\b/i;
export function healForeignTriggers(db: Database.Database): number {
  if (hasTable(db, "memory_recall_changes")) return 0;
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory\\_recall\\_watch\\_%' ESCAPE '\\'").all() as Array<{ name: string; sql: string | null }>;
  let dropped = 0;
  for (const row of rows) {
    if (!FOREIGN_TRIGGER_NAME.test(row.name) || !row.sql || !FOREIGN_TRIGGER_BODY.test(row.sql)) continue;
    db.exec(`DROP TRIGGER IF EXISTS "${row.name}"`);
    dropped += 1;
  }
  return dropped;
}

/**
 * K7'': meta key of a store whose old pages may still hold a forgotten text (the lines are blanked and the cursor moved, the rewrite did not finish: disk full, a reader holds the log, the app was killed).
 * Written in the same transaction as `forget_epoch_applied` (`applyForgets`); read by `catchUp` on every open of the store (the meta is already read there); deleted by `clearResidueKey` after a VACUUM and a clean TRUNCATE checkpoint.
 * The engine writes the same key (`memory_stores.py RESIDUE_PENDING_KEY`). No new table or column.
 */
export const RESIDUE_PENDING_KEY = "forget_residue_pending";
/**
 * K7'' (audit D2): the same debt for the ROOT file. Root `memory_store_meta` keys: `root_residue_pending` (the forget number whose blanking in the root is not yet followed by a rewrite of the file; written by `revokeOneMemoryEntry`
 * in its transaction) and `root_residue_done` (the forget number at which the last rewrite finished; the one-time sweep for the residue the root gathered before this change is "a stamp exists and neither key was ever written").
 * Read and cleared by the retention pass's memory VACUUM (`storage/db-retention.ts vacuumMemory`), the resting-time signal that already exists; no timer of its own. basis: see `docs/Agentlas2.0/evidence/k7pp/RESULT.md` (VACUUM time by size).
 */
export const ROOT_RESIDUE_PENDING_KEY = "root_residue_pending";
export const ROOT_RESIDUE_DONE_KEY = "root_residue_done";

/** VACUUM + TRUNCATE checkpoint on a write connection. True only when both finished and the log was fully written back. Never throws. */
function vacuumAndCheckpoint(writer: Database.Database): boolean {
  try {
    writer.exec("VACUUM");
    const after = writer.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
    return !after?.[0]?.busy;
  } catch { return false; }
}
function clearResidueKey(writer: Database.Database): void {
  try { writer.prepare("DELETE FROM memory_store_meta WHERE key=?").run(RESIDUE_PENDING_KEY); } catch { /* the next open rewrites once more: harmless */ }
}
/** Redo only the rewrite of a store (its lines are already blank). True when it is done and the key is gone. basis: a store is <= 500 (agent) / 800 (project) lines, 10-155 ms measured (k7-audit vac.cjs). */
function rewriteStore(file: string, kind: StoreKind): boolean {
  let writer: Database.Database;
  try { writer = new Database(file, { fileMustExist: true, timeout: CATCHUP_LOCK_WAIT_MS }); } catch { return false; }
  try {
    writer.pragma("secure_delete=ON");
    if (!vacuumAndCheckpoint(writer)) return false;
    clearResidueKey(writer);
    dropDerivedBesideStore(kind, file);
    return true;
  } finally { try { writer.close(); } catch { /* closed */ } }
}

/**
 * 한 쓰기 트랜잭션 안에서: 아직 본문이 남은 잊은 행을 *다시 찾고*(읽은 뒤 번호를 찍기 전에 다른 프로세스가 같은 문장을 커밋하는 창을 닫는다 — #10), 비우고, 번호를 찍는다.
 * 행이 있었으면 파생 파일(검색 색인·`MEMORY.md`)을 커밋 앞뒤로 지우고(죽어도 다음 열기가 다시 한다) 로그 파일을 본 파일에 반영한다(`wal_checkpoint(TRUNCATE)` — 안 하면 옛 글자가 본 파일에 남는다, #1).
 * 행이 없었으면 번호만 찍는다(색인은 건드리지 않는다).
 */
function applyForgets(file: string, kind: StoreKind, ids: readonly string[], hashes: ForgottenHashes, clock: number): { ok: boolean; present: number; residueFree: boolean } {
  let writer: Database.Database;
  try { writer = new Database(file, { fileMustExist: true, timeout: CATCHUP_LOCK_WAIT_MS }); } catch { return { ok: false, present: 0, residueFree: true }; }
  let present = 0;
  try {
    writer.pragma("secure_delete=ON"); // 글이 떠난 페이지를 덮어쓴다
    writer.exec("BEGIN IMMEDIATE");
    healForeignTriggers(writer);
    const rows = [...presentForgotten(writer, ids, hashes)];
    present = rows.length;
    const now = new Date().toISOString();
    for (let start = 0; start < rows.length; start += 400) {
      const part = rows.slice(start, start + 400), marks = part.map(() => "?").join(",");
      writer.prepare(`UPDATE memory_entries SET ${BLANK_COLUMNS}, superseded_at=COALESCE(superseded_at,?) WHERE id IN (${marks})`).run(now, ...part);
      if (hasTable(writer, "memory_relation_edges")) writer.prepare(`DELETE FROM memory_relation_edges WHERE from_memory_id IN (${marks}) OR to_memory_id IN (${marks})`).run(...part, ...part);
      if (hasTable(writer, "memory_entry_native")) writer.prepare(`DELETE FROM memory_entry_native WHERE entry_id IN (${marks})`).run(...part);
    }
    writer.prepare("INSERT INTO memory_store_meta(key,value) VALUES('forget_epoch_applied',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(clock));
    if (present) writer.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(RESIDUE_PENDING_KEY, String(clock));
    if (present) dropDerivedBesideStore(kind, file); // 커밋 앞: 여기서 죽으면 번호가 안 찍혀 다음 열기가 처음부터 다시 한다
    writer.exec("COMMIT");
  } catch {
    try { writer.exec("ROLLBACK"); } catch { /* 열린 트랜잭션 없음 */ }
    try { writer.close(); } catch { /* 닫힘 */ }
    return { ok: false, present, residueFree: true };
  }
  // `residueFree` 가 거짓이면 행은 비웠지만 옛 글자가 파일(다른 연결이 로그를 붙들고 있다)이나 검색 색인(Windows 에서 엔진이 연 채)에 남았을 수 있다 — 코드로 알린다.
  let residueFree = true;
  if (present) {
    try {
      const row = writer.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
      residueFree = !(row?.[0]?.busy);
    } catch { residueFree = false; }
    // K7': a b-tree page that was split or rebalanced by a writer WITHOUT secure_delete keeps the old cell bytes in the unused part of the page - no cell of any table holds them, the blanking above cannot reach them
    // (found by reading every byte of an agent store after its line was forgotten). The store is rewritten (VACUUM: one file, every page new) when it just held the words; a store is small (the agent's <= 500 lines, a project's <= 800).
    // A store that is locked or has no room for the copy keeps its old pages and says so (`forget_residue_busy`); the next open of the store looks again.
    // K7'': the rewrite is owed until it has finished: `forget_residue_pending` (written with the cursor above) is deleted only after the VACUUM and a clean TRUNCATE checkpoint, and the next open of the store does the rewrite again (`catchUp`).
    if (!vacuumAndCheckpoint(writer)) residueFree = false;
    else clearResidueKey(writer);
    if (!dropDerivedBesideStore(kind, file)) residueFree = false; // 커밋 뒤: 그 사이 엔진이 다시 만든 색인도
  }
  try { writer.close(); } catch { /* 닫힘 */ }
  return { ok: true, present, residueFree };
}

function fileIdentity(file: string): string | null {
  try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}`; } catch { return null; }
}

/** The word for a store that could not be opened or read: `store_busy` when SQLite itself says it is locked (it may be free a moment later), else `store_unreadable`. Only SQLite's own result code is read, never the message. */
function unreadableCode(error: unknown): "store_busy" | "store_unreadable" { return recallReasonOfError(error); }

/**
 * 저장소 하나를 읽기 전용으로 연다. (저장소, null) | (null, 사유 코드). `store_absent` 는 파일이 없는 정상("빈 저장소")이고 다른 코드는 있는데 건너뛴 저장소다.
 * 읽기는 아무 파일도 만들지 않는다.
 */
export function openStore(ref: StoreRef, owner: string, rootDb: Database.Database, memoryRoot: string): { store: OpenedStore | null; code: string | null } {
  let identity: string | null;
  try { identity = fileIdentity(ref.path); } catch { identity = null; }
  if (identity === null) { dropHandle(ref.path); return { store: null, code: "store_absent" }; }
  const problem = ref.kind === "agent" ? containedAgentPath(ref) : containedAccountPath(ref, memoryRoot);
  if (problem) return { store: null, code: problem };
  let handle = handles.get(ref.path);
  if (handle && handle.identity !== identity) { dropHandle(ref.path); handle = undefined; }
  if (!handle) {
    let db: Database.Database;
    try { db = new Database(ref.path, { readonly: true, fileMustExist: true, timeout: 500 }); }
    catch (error) { return { store: null, code: unreadableCode(error) }; }
    const notes: string[] = [];
    try {
      const meta = metaOf(db);
      if (meta.owner_namespace !== undefined && meta.owner_namespace !== owner) { db.close(); return { store: null, code: "owner_mismatch" }; }
      if (!hasTable(db, "memory_entries")) { db.close(); return { store: null, code: "entries_missing" }; }
      notes.push(...degradeNotes(meta, ref.kind));
    } catch (error) { try { db.close(); } catch { /* 닫힘 */ } return { store: null, code: unreadableCode(error) }; }
    handle = { ref, db, identity, dataVersion: -1, rows: new Map(), notes, forgotEpoch: -1 };
    handles.set(ref.path, handle);
    while (handles.size > MAX_OPEN_STORES) dropHandle(handles.keys().next().value as string);
  } else { handles.delete(ref.path); handles.set(ref.path, handle); } // LRU: 최근 쪽으로
  try {
    const meta = metaOf(handle.db);
    if (meta.owner_namespace !== undefined && meta.owner_namespace !== owner) { dropHandle(ref.path); return { store: null, code: "owner_mismatch" }; }
    const caught = catchUp(ref.path, ref.kind, handle.db, rootDb, meta);
    if (caught === null) return { store: null, code: "forget_clock_unreadable" };
    // The degrade notes are read from the meta every time (a store repaired or upgraded in place stops being "degraded" without a restart).
    const fresh = degradeNotes(meta, ref.kind);
    const notes = caught.note ? [...fresh, caught.note] : fresh;
    return { store: { ref, db: handle.db, notes, withheld: caught.withheld, handle }, code: null };
  } catch (error) { dropHandle(ref.path); return { store: null, code: unreadableCode(error) }; }
}

// --- 어느 저장소들을 여는가 --------------------------------------------------------------------------------------------

export interface StoreContext { memoryRoot: string; owner: string; rootDb: Database.Database }
export interface ReadScope { agentId?: string | null; projectPath?: string | null; projectId?: string | null; chatId?: string | null }

/** 이 읽기가 열 후보 저장소: 프로젝트(가능한 키마다: 프로젝트 id, 폴더 키 — 대화 id 는 키가 아니다)와 답하는 에이전트의 것. 세션 저장소는 회수 경로가 읽는 행이 없어서 넣지 않는다. */
export function storesForContext(context: StoreContext, scope: ReadScope): StoreRef[] {
  const refs: StoreRef[] = [];
  for (const key of projectKeys(scope.projectPath ?? null, scope.projectId ?? null)) refs.push(projectRef(context.memoryRoot, context.owner, key));
  const agent = storeAgentId(scope.agentId ?? null);
  const home = agent ? findAgentHome(agent, false) : null;
  if (home && agent) refs.push(agentRef(context.owner, home, agent));
  return refs;
}

// --- 행 읽기 ----------------------------------------------------------------------------------------------------

const POLICY_FILTER = `NOT EXISTS(SELECT 1 FROM memory_identity_bindings b WHERE b.memory_id=memory_entries.id
  AND (b.owner_namespace<>? OR (json_valid(b.applicability_json) AND (json_extract(b.applicability_json,'$.recallChannel')='legacy_one_overlay'
    OR json_extract(b.applicability_json,'$.enabled')=0))))`;

export interface ReadQuery {
  actors: readonly (string | null)[];
  projectPath: string | null;
  ids: readonly string[] | null;
}
export interface StoreRows { ref: StoreRef; rows: Row[]; notes: string[] }

/**
 * 한 저장소에서 회수 후보 행을 읽는다(뿌리 질의와 같은 모양, 단 깨진 applicability_json 이 던지지 않게 json_valid 로 막는다).
 * 프로젝트 저장소 안의 `project` 행은 경로·id 로 거르지 않는다 — 키가 uid 일 때 경로는 컴퓨터마다 다르다. 거름은 호출자의 정책 함수가 한다.
 * 결과는 핸들에 캐시된다: 같은 질의·같은 `data_version`·같은 시계면 SQL 을 다시 돌리지 않는다.
 */
export function readRows(store: OpenedStore, owner: string, rootDb: Database.Database, query: ReadQuery, forgotten: ReadonlySet<string>): StoreRows {
  const { handle, ref } = store;
  const notes = [...store.notes];
  let version = 0;
  try { version = Number(handle.db.pragma("data_version", { simple: true })); } catch { version = -1; }
  const clock = rootClock(rootDb) ?? -1;
  if (handle.dataVersion !== version || handle.forgotEpoch !== clock) {
    for (const rows of handle.rows.values()) cachedRows -= rows.length;
    handle.rows.clear(); handle.dataVersion = version; handle.forgotEpoch = clock;
  }
  const key = JSON.stringify([query.actors, query.projectPath, query.ids ? [...new Set(query.ids)].sort() : null, ref.kind]);
  let rows = handle.rows.get(key);
  if (!rows) {
    try { rows = querySubStore(handle.db, ref.kind, owner, query); }
    catch (error) { return { ref, rows: [], notes: [...notes, unreadableCode(error)] }; }
    if (cachedRows + rows.length > CACHE_MAX_ROWS) {
      // 상한: 가장 오래 열려 있던 저장소의 캐시부터 비운다(자기 것은 마지막).
      for (const other of handles.values()) { if (other === handle) continue; for (const old of other.rows.values()) cachedRows -= old.length; other.rows.clear(); if (cachedRows + rows.length <= CACHE_MAX_ROWS) break; }
    }
    if (rows.length <= CACHE_MAX_ROWS) { handle.rows.set(key, rows); cachedRows += rows.length; }
  }
  const hidden = store.withheld;
  const live = rows.filter(row => {
    const id = row.id;
    return typeof id === "string" && !hidden.has(id) && !forgotten.has(id);
  });
  return { ref, rows: live, notes };
}

function querySubStore(db: Database.Database, kind: StoreKind, owner: string, query: ReadQuery): Row[] {
  const ids = query.ids ? [...new Set(query.ids)] : null;
  if (ids && !ids.length) return [];
  const idSql = ids ? `AND id IN (${ids.map(() => "?").join(",")})` : "";
  const actors = query.actors.filter((actor): actor is string => typeof actor === "string");
  const branch = kind === "project"
    ? "scope='project'"
    : `scope='agent_repo' AND agent_id IN (${actors.map(() => "?").join(",") || "NULL"}) AND (project_path IS NULL OR project_path=?)`;
  const binds: unknown[] = [...(ids ?? []), owner];
  if (kind !== "project") binds.push(...actors, query.projectPath ?? null);
  const hasBindings = hasTable(db, "memory_identity_bindings");
  const sql = hasBindings
    ? `SELECT memory_entries.*, rb.owner_namespace AS binding_owner, rb.actor_id AS binding_actor, rb.applicability_json
       FROM memory_entries LEFT JOIN memory_identity_bindings rb ON rb.memory_id=memory_entries.id
       WHERE superseded_at IS NULL ${idSql} AND ${POLICY_FILTER} AND (${branch}) ORDER BY created_at DESC, id DESC`
    : `SELECT memory_entries.*, NULL AS binding_owner, NULL AS binding_actor, NULL AS applicability_json FROM memory_entries
       WHERE superseded_at IS NULL ${idSql} AND (${branch}) ORDER BY created_at DESC, id DESC`;
  const finalBinds = hasBindings ? binds : binds.filter((_, index) => index !== (ids?.length ?? 0));
  return db.prepare(sql).all(...finalBinds) as Row[];
}

/** `unread`: the closed codes of the stores this read could NOT read at all (not the stores that are merely absent, and not a line withheld while a forget catches up): `store_busy` for a lock, any other code is unreadable. The recall's `memory=partial` line is made from it. */
export interface UnionRead { rows: Row[]; notes: string[]; unread: string[] }

/**
 * 합집합 읽기: 뿌리(호출자가 이미 읽은 것)를 뺀 하위 저장소들의 후보 행. 읽는 순서는 프로젝트 → 에이전트.
 * 중복 id 는 먼저 본 쪽이 이긴다(뿌리 → 프로젝트 → 에이전트). 던지지 않는다.
 */
export function readUnionRows(context: StoreContext, scope: ReadScope, query: ReadQuery): UnionRead {
  const rows: Row[] = [];
  const notes: string[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  let forgotten: Set<string> = new Set();
  try { forgotten = forgottenIds(context.rootDb) ?? new Set(); } catch { /* 장부를 못 읽으면 저장소 단위 따라잡기가 걸러낸다 */ }
  for (const ref of storesForContext(context, scope)) {
    try {
      const { store, code } = openStore(ref, context.owner, context.rootDb, context.memoryRoot);
      if (!store) { if (code && code !== "store_absent") { notes.push(`${ref.kind}:${code}`); unread.push(code); } continue; }
      const result = readRows(store, context.owner, context.rootDb, query, forgotten);
      notes.push(...result.notes.map(note => `${ref.kind}:${note}`));
      for (const note of result.notes) if (note === "store_busy" || note === "store_unreadable") unread.push(note);
      for (const row of result.rows) {
        const id = row.id as string;
        if (seen.has(id)) continue;
        seen.add(id); rows.push(row);
      }
    } catch (error) { const code = unreadableCode(error); notes.push(`${ref.kind}:${code}`); unread.push(code); }
  }
  return { rows, notes, unread };
}

/** 같은 id 는 먼저 온 쪽, 결과는 `created_at DESC, id DESC`(엔진 merge_rows 와 같다). `base` 가 먼저다. */
export function mergeRows<T extends { id: string; created_at: string }>(base: readonly T[], extra: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of base) if (!seen.has(row.id)) seen.set(row.id, row);
  for (const row of extra) if (!seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// --- 변경 감지 지문 (생성 팩·선택 캐시가 "저장소 쪽이 바뀌었나" 를 보는 값) -----------------------------------------------

/**
 * 이 읽기가 의존하는 저장소들의 지문. `central` 이면 빈 문자열(= 이 묶음 전과 같은 키). 아니면 열린 저장소마다 (경로, data_version) 해시.
 * 핸들을 새로 열면 data_version 이 달라질 수 있으나 그건 한 번의 불필요한 재계산일 뿐 잘못된 적중이 아니다.
 */
export function unionFingerprint(context: StoreContext, scope: ReadScope): string {
  if (!readsUnion(context.rootDb)) return "";
  const parts: string[] = [];
  for (const ref of storesForContext(context, scope)) {
    const { store } = openStore(ref, context.owner, context.rootDb, context.memoryRoot);
    if (!store) continue;
    let version = -1;
    try { version = Number(store.db.pragma("data_version", { simple: true })); } catch { /* 지문에 -1 */ }
    parts.push(`${ref.path}\0${version}\0${store.handle.identity}\0${store.withheld.size}`);
  }
  return parts.length ? sha(parts.join("\n")) : "";
}

// --- 에이전트 저장소 + 뿌리 원장 한 벌 (학습 근거 읽기가 쓴다) ------------------------------------------------------------

export interface OpenSet { root: Database.Database; stores: Database.Database[]; notes: string[] }

/**
 * `openSetFor({agentId})`: 뿌리 원장과 이 에이전트의 저장소(있으면)를 함께 돌려준다. 기억 행·근거·출처 링크는 이사 뒤 에이전트 저장소에 있고
 * 영수증(티켓·실행 번호)은 뿌리에 남으므로, 근거를 따라가는 읽기(`agents/learning-evidence.ts`)는 이 둘을 같이 봐야 한다.
 * `central` 이면 stores 는 빈 배열 — 이 호출은 뿌리만 돌려준다.
 */
export function openSetFor(context: StoreContext, scope: ReadScope): OpenSet {
  if (!readsUnion(context.rootDb)) return { root: context.rootDb, stores: [], notes: [] };
  const stores: Database.Database[] = [];
  const notes: string[] = [];
  const agent = storeAgentId(scope.agentId ?? null);
  const home = agent ? findAgentHome(agent) : null;
  const refs: StoreRef[] = [];
  if (home && agent) refs.push(agentRef(context.owner, home, agent));
  for (const key of projectKeys(scope.projectPath ?? null, scope.projectId ?? null)) refs.push(projectRef(context.memoryRoot, context.owner, key));
  for (const ref of refs) {
    try {
      const { store, code } = openStore(ref, context.owner, context.rootDb, context.memoryRoot);
      if (store) stores.push(store.db);
      else if (code && code !== "store_absent") notes.push(`${ref.kind}:${code}`);
    } catch { notes.push(`${ref.kind}:store_unreadable`); }
  }
  return { root: context.rootDb, stores, notes };
}

// --- 에이전트 자신의 행 (스킬 후보 목록·기억 인스펙터가 쓴다) -------------------------------------------------------------

/**
 * 이 에이전트의 저장소 안에서 에이전트 전역(`agent_repo`, 프로젝트 없음) 행. `central` 이거나 폴더·저장소가 없으면 빈 배열 — 호출자의 뿌리 질의가 그대로 답이다.
 * 잊기 따라잡기를 못 한 저장소의 숨길 id 는 빠진다. 던지지 않는다. 호출자는 뿌리 행을 앞에 두고 `mergeRows` 로 합친다(중복 id 는 뿌리가 이긴다).
 */
export function readAgentOwnRows(context: StoreContext, agentId: string, limit: number): Row[] {
  try {
    if (!readsUnion(context.rootDb)) return [];
    const agent = storeAgentId(agentId);
    const home = agent ? findAgentHome(agent) : null;
    if (!agent || !home) return [];
    const { store } = openStore(agentRef(context.owner, home, agent), context.owner, context.rootDb, context.memoryRoot);
    if (!store) return [];
    const rows = store.db.prepare(`SELECT * FROM memory_entries WHERE superseded_at IS NULL AND agent_id=? AND scope='agent_repo'
      AND project_id IS NULL AND project_path IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`).all(agent, limit + store.withheld.size) as Row[];
    return rows.filter(row => typeof row.id === "string" && !store.withheld.has(row.id)).slice(0, limit);
  } catch { return []; }
}

// --- 읽지 못한 저장소 (기억 인스펙터의 "이 저장소를 읽지 못했어요" 한 줄) --------------------------------------------------------

export interface StoreSkip {
  kind: StoreKind;
  /** 문장이 아닌 코드: store_unreadable·owner_mismatch·store_symlink·agent_local_state_symlink·entries_missing·forget_clock_unreadable·forget_catchup_withheld … */
  code: string;
}

/**
 * 이 범위에서 합집합 읽기가 건너뛴(또는 일부를 숨긴) 저장소와 사유 코드. 파일이 없는 저장소(`store_absent`)는 정상이라 넣지 않는다. `central` 이면 빈 배열.
 * 저장소를 여는 것뿐이고 행을 읽지 않는다(열린 연결은 캐시를 같이 쓴다). 던지지 않는다.
 */
export function storeSkips(context: StoreContext, scope: ReadScope): StoreSkip[] {
  const out: StoreSkip[] = [];
  try {
    if (!readsUnion(context.rootDb)) return out;
    for (const ref of storesForContext(context, { ...scope, agentId: scope.agentId ?? null })) {
      try {
        const { store, code } = openStore(ref, context.owner, context.rootDb, context.memoryRoot);
        if (!store) { if (code && code !== "store_absent") out.push({ kind: ref.kind, code }); continue; }
        if (store.notes.includes("forget_catchup_withheld")) out.push({ kind: ref.kind, code: "forget_catchup_withheld" });
      } catch { out.push({ kind: ref.kind, code: "store_unreadable" }); }
    }
  } catch { /* 알릴 것이 없다 */ }
  return out;
}
