// 기억 쓰기 라우팅 — 저장소 고르기와 하위 저장소 쓰기 (엔진 짝: Agentlas-OS agentlas_cloud/memory_stores.py `store_for`·`ensure_store`·`open_store_for_write`).
//
// ★분리 스위치(`memory_layout='split-1'`)가 꺼져 있으면 이 파일의 어떤 함수도 쓰기 경로에서 불리지 않는다 — 쓰기 입구(store.ts)가 뿌리 메타를 한 번 읽고 `split` 이 아니면
// 옛 길로 간다. 스위치를 *켜는* 코드는 여기에 없다.
// ★저장소 고르기는 `storeForRow` 한 함수다. 엔진 `store_for` 와 같은 표(`schemas/memory-scopes.json` rows.rules)를 같은 순서로 읽는다. 호출부마다 특수 케이스를 흩지 않는다.
// ★쓰기는 항상 "하위 저장소 커밋 → 뿌리 영수증"이고, 하위 저장소를 못 쓰면 던지지 않고 **뿌리에 쓴다**(엔진과 같다). 못 쓴 사유는 코드(문장 아님)로 `writeDegrades()` 에 남는다.
//   뿌리에 남은 비개인 행은 읽기(합집합)가 계속 찾고, 엔진 `step` 이사가 나중에 옮긴다.
// ★연결은 쓰기마다 열고 닫는다(캐시 없음). 오래 열린 쓰기 연결이 Windows 에서 폴더 삭제·이동을 막는 일을 만들지 않는다. 읽기 연결(LRU)은 stores.ts 가 갖고 `closeStoresUnder` 가 닫는다.
// ★Electron 을 가져오지 않는다(데몬·시험이 같은 파일을 읽는다).
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE } from "../agents/home";
import { isOneMemoryActor } from "../../shared/memory-actor-family";
import { MEMORY_STORE_SCHEMA_SQL } from "./schema";
import { specialStoreAgentId } from "./special-store-agents";
import { CORE_SCHEMA_VERSION, accountDir, agentRef, findAgentHome, layoutOf, openStore, projectKeys, projectRef, STORE_FILE, workerRef,
  type MemoryLayout, type StoreKind, type StoreRef } from "./stores";
import { COLUMNS_KEY, COLUMNS_VALUE, ensureK1Columns } from "./store-columns";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// --- 소유자 계산 (엔진 memory_scopes.owner_scope_of 와 같은 표, 저장하지 않는다) -----------------------------------------------

export type OwnerKind = "personal" | "agent" | "project" | "session" | "legacy-shared" | "worker";
export interface OwnerScope { kind: OwnerKind; ownerId: string | null }
export interface RowShape {
  scope: string;
  agentId?: string | null;
  projectId?: string | null;
  projectPath?: string | null;
  chatId?: string | null;
}
const SYSTEM_PREFIXES = ["host:", "builtin-agentlas-"];
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/**
 * 이 행의 소유자. `null` = 저장하지 않는 scope(discard). 모르는 모양은 `legacy-shared`(뿌리에 남는다).
 * `split2`(2.0 K1; 엔진 `owner_scope_of(row, split2=True)`, 계약 `splitTwoRules`): 상주 주체(One 계열·`host:*`·특수 에이전트가 아닌 `builtin-agentlas-*`)의 에이전트 줄은 `worker` 가 소유한다.
 * 이 인자 없이는 어떤 답도 1.x 와 같다 — 부르는 쪽이 아직 없다(K5 이전).
 */
export function ownerScopeOf(row: RowShape, split2 = false): OwnerScope | null {
  const scope = row.scope;
  if (typeof scope !== "string") return { kind: "legacy-shared", ownerId: null };
  if (scope === "discard") return null;
  const agent = text(row.agentId);
  const folded = agent?.trim().toLowerCase() ?? null;
  const oneActor = agent !== null && isOneMemoryActor(agent.trim());
  const special = agent !== null ? specialStoreAgentId(agent) : null;
  const systemActor = special === null && folded !== null && SYSTEM_PREFIXES.some(prefix => folded.startsWith(prefix));
  const hubActor = folded !== null && folded.startsWith("hub:");
  const projectPath = text(row.projectPath);
  const projectKey = projectPath ? "project-path:" + sha(projectPath) : null;
  const chat = text(row.chatId);
  if (scope === "user_identity") return { kind: "personal", ownerId: null };
  if (scope === "agent_repo") {
    if (split2 && (oneActor || systemActor)) return { kind: "worker", ownerId: null };
    if (oneActor) return { kind: "personal", ownerId: null };
    if (special !== null) return { kind: "agent", ownerId: special };
    if (systemActor) return { kind: "personal", ownerId: null };
    if (hubActor) return { kind: "legacy-shared", ownerId: null };
    if (agent !== null) return { kind: "agent", ownerId: agent.trim() };
  }
  if (scope === "project" && projectKey) return { kind: "project", ownerId: projectKey };
  if (scope === "session" && chat) return { kind: "session", ownerId: chat.trim() };
  // 팀 범위(`team_memory`, 옛 이름 `agent_team`)는 읽는 쪽이 뿌리와 프로젝트 저장소에서만 찾는다: 뿌리 회수 질의는 프로젝트 경로 없는 팀 줄을 모든 에이전트에게 싣고,
  // 에이전트 저장소 질의는 `agent_repo` 만 읽는다. 그래서 에이전트 id 가 붙은 팀 줄을 에이전트 저장소에 쓰면 아무도 못 읽는다(감사 40 #2). 프로젝트 경로가 없으면 뿌리에 남긴다.
  if ((scope === "team_memory" || scope === "agent_team") && projectKey) return { kind: "project", ownerId: projectKey };
  return { kind: "legacy-shared", ownerId: null };
}

export interface RouteContext { memoryRoot: string; owner: string; layout: MemoryLayout }

/** 뿌리(개인) 저장소 파일. 데스크탑 `memoryStorePath` 와 같은 경로다. */
export function rootStoreRef(memoryRoot: string, owner: string): StoreRef {
  return { kind: "personal", key: null, path: path.join(accountDir(memoryRoot, owner), STORE_FILE) };
}

export type RouteStay = "layout_not_split" | "personal" | "legacy_shared" | "session_rows" | "hub_agent" | "no_agent_home" | "no_project_key" | "never_stored";
/**
 * 새 행이 어느 저장소에 가야 하는가. 스위치가 `split` 이 아니면 항상 뿌리. 엔진 `store_for` 와 같은 답이며, 뿌리에 남는 이유를 코드로 함께 돌려준다.
 * `store` 가 뿌리(`kind==='personal'`)면 이 행은 뿌리에 쓴다. 아무것도 만들지 않는다.
 */
export function storeForRow(context: RouteContext, row: RowShape, projectRefHint?: string | null): { store: StoreRef; stay: RouteStay | null } {
  const root = rootStoreRef(context.memoryRoot, context.owner);
  // `split2`(K1: 아직 부르는 곳이 없다 — 쓰기 입구 store.ts 는 `split` 일 때만 이 함수를 부른다)는 split-1 과 같은 표에 작업 지식 저장소 하나가 더해진 것이다.
  if (context.layout !== "split" && context.layout !== "split2") return { store: root, stay: "layout_not_split" };
  const owned = ownerScopeOf(row, context.layout === "split2");
  if (owned === null) return { store: root, stay: "never_stored" };
  if (owned.kind === "worker") return { store: workerRef(context.memoryRoot, context.owner), stay: null };
  // 폴더 없는 프로젝트(Science 연구 등)의 프로젝트 줄: 프로젝트 id 가 키다. 엔진 `memory_runtime._store_target` 의 같은 예외 — 계약 JSON 의 소유자 계산은 id 만 있는 줄을 뿌리라 하지만
  // 엔진 쓰기는 `projects/sha(id)` 에 쓰므로 데스크탑도 같은 곳에 쓴다(안 그러면 같은 문장이 두 저장소에 한 줄씩 생긴다, 감사 40 #9). 힌트가 프로젝트 id 일 때만(대화 id 는 키가 아니다).
  if (row.scope === "project" && !row.projectPath && !agentHub(row)) { // 엔진처럼 문자열의 진위로 본다(공백뿐인 경로는 "있는 경로")
    const keys = projectKeys(null, text(projectRefHint));
    if (keys.length) return { store: projectRef(context.memoryRoot, context.owner, keys[0]), stay: null };
  }
  if (owned.kind === "personal" || owned.ownerId === null) return { store: root, stay: owned.kind === "personal" ? "personal" : agentHub(row) ? "hub_agent" : "legacy_shared" };
  // 엔진은 session 행을 저장소 파일로 보내지 않는다(session.sqlite 는 체크포인트 표만 갖는다, `_stay_reason` session_rows). 같은 답: 뿌리.
  if (owned.kind === "session") return { store: root, stay: "session_rows" };
  if (owned.kind === "project") {
    const keys = projectKeys(text(row.projectPath), text(projectRefHint));
    return keys.length ? { store: projectRef(context.memoryRoot, context.owner, keys[0]), stay: null } : { store: root, stay: "no_project_key" };
  }
  if (owned.kind === "agent") {
    const home = findAgentHome(owned.ownerId);
    return home ? { store: agentRef(context.owner, home, owned.ownerId), stay: null } : { store: root, stay: "no_agent_home" };
  }
  return { store: root, stay: "legacy_shared" };
}
function agentHub(row: RowShape): boolean { return (text(row.agentId)?.trim().toLowerCase() ?? "").startsWith("hub:"); }

/** 이 소유자·스위치로 새 행을 쓸 곳. `layout` 을 부르는 쪽이 읽어 넘긴다. */
export function layoutFromRoot(rootDb: Database.Database): MemoryLayout { return layoutOf(rootDb); }

// --- 저장소 만들기·쓰기용 열기 ------------------------------------------------------------------------------------------

export const SLICE_VERSION = "agentlas.memory-slice.v1";
// 2.0 K1(설계 S 4.1-3): 사건 기록 표(`memory_episodes`)가 조각에 들어간다 — 줄의 사건 기록은 그 줄을 가진 저장소로 간다. 아직 아무것도 쓰지 않는다(K5 가 옮긴다). 뿌리의 표와 다른 점 둘(엔진과 같다):
// 티켓 FK 절이 없고(티켓은 뿌리에 남는다 — 참조는 id 뿐, 기록은 줄과 함께 떠나지 cascade 로 지워지지 않는다), 요약 원문 표 `memory_episode_native` 와 잊기 트리거 둘이 같이 온다.
const ENTRY_TABLES = new Set(["memory_entries", "memory_identity_bindings", "memory_project_links", "memory_origin_links", "memory_relation_edges", "memory_episodes", "memory_store_meta"]);
const EPISODE_FK = /,\s*FOREIGN KEY\(ticket_id\) REFERENCES memory_tickets\(ticket_id\) ON DELETE CASCADE/;
/** 엔진 `EPISODE_NATIVE_DDL` 와 문자 그대로 같다(`native_embedding` 열은 데스크탑이 `native-text.ts` 에서 쓸 때 제자리에서 더한다). */
export const EPISODE_NATIVE_DDL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS memory_episode_native(episode_id TEXT PRIMARY KEY,summary_native TEXT NOT NULL,created_at TEXT NOT NULL)",
  "CREATE TRIGGER IF NOT EXISTS memory_episode_native_forget AFTER UPDATE OF summary ON memory_episodes "
    + "WHEN NEW.summary IS NULL OR NEW.summary = '' BEGIN DELETE FROM memory_episode_native WHERE episode_id = NEW.episode_id; END",
  "CREATE TRIGGER IF NOT EXISTS memory_episode_native_delete AFTER DELETE ON memory_episodes "
    + "BEGIN DELETE FROM memory_episode_native WHERE episode_id = OLD.episode_id; END",
];

/** 같은 SQL 을 조각으로 나눈다(트리거 본문 BEGIN…END 와 따옴표·주석을 지킨다). */
function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  const tokens = /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\b(?:BEGIN|CASE|END)\b|;/gi;
  for (const token of sql.matchAll(tokens)) {
    const value = token[0].toUpperCase();
    if (value === "BEGIN" || value === "CASE") depth += 1;
    else if (value === "END") depth = Math.max(0, depth - 1);
    else if (value === ";" && depth === 0) { parts.push(sql.slice(start, token.index! + 1)); start = token.index! + 1; }
  }
  if (sql.slice(start).trim()) parts.push(sql.slice(start));
  return parts.filter(part => part.trim());
}
let sliceCache: string[] | null = null;
/** 하위 저장소를 만드는 문장들: 항목 표들, 개정 트리거, 개정 씨앗. 엔진 `entries_slice_sql()` 와 같은 선택이다. 원장 표(티켓·결정·시계·철회)는 뿌리에만 있다. */
export function entriesSliceSql(): string[] {
  if (sliceCache) return sliceCache;
  const picked: string[] = [];
  for (const statement of splitStatements(MEMORY_STORE_SCHEMA_SQL)) {
    const body = statement.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n").trim();
    const table = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(body);
    const trigger = /^\s*CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\s+\w+[\s\S]*?\bON\s+(\w+)/i.exec(body);
    if ((table && ENTRY_TABLES.has(table[1])) || (trigger && trigger[1] === "memory_entries") || /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+memory_store_meta/i.test(body)) picked.push(table?.[1] === "memory_episodes" ? body.replace(EPISODE_FK, "") : body);
  }
  picked.push(...EPISODE_NATIVE_DDL);
  sliceCache = picked;
  return picked;
}

/** 원문 쪽 옆 표. 엔진 `_ensure_side_table` 이 같은 모양으로 만든다. */
export const NATIVE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS memory_entry_native (
  entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
  content_native TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

function agentFolderOf(ref: StoreRef): string { let state = ref.path; for (let i = 0; i < 3; i += 1) state = path.dirname(state); return state; }

/** 만들기 전에: 경로의 이미 있는 부분 중 링크가 있으면 사유 코드. 에이전트 폴더 자체는 링크여도 되지만 `.agentlas-local` 아래는 안 된다. */
function createProblem(ref: StoreRef, memoryRoot: string): string | null {
  const parts: string[] = [];
  if (ref.kind === "agent") {
    const state = agentFolderOf(ref);
    if (path.basename(state) !== AGENT_LOCAL_STATE_FOLDER) return "store_unwritable";
    const marker = path.join(state, AGENT_OWNER_FILE);
    try { const stat = fs.lstatSync(marker); if (stat.isSymbolicLink() || !stat.isFile()) return "agent_home_absent"; } catch { return "agent_home_absent"; }
    for (let part = ref.path; part !== path.dirname(state); part = path.dirname(part)) parts.push(part);
    parts.push(state);
    for (const part of parts) { try { if (fs.lstatSync(part).isSymbolicLink()) return "agent_local_state_symlink"; } catch { /* 아직 없다 */ } }
    return null;
  }
  const base = path.resolve(memoryRoot);
  let part = path.resolve(ref.path);
  while (part !== base && part !== path.dirname(part)) { parts.push(part); part = path.dirname(part); }
  for (const item of parts) { try { if (fs.lstatSync(item).isSymbolicLink()) return "store_symlink"; } catch { /* 아직 없다 */ } }
  return null;
}

/**
 * 빈 하위 저장소 파일을 만든다(없을 때만). 임시 이름으로 다 만든 뒤 하드링크로 자리에 놓으므로 읽는 쪽이나 둘째 만드는 쪽이 반쪽 파일을 보지 않는다.
 * 에이전트 저장소는 데스크탑이 이미 `owner.json` 으로 표시한 폴더 안에만 만든다(폴더 자체는 만들지 않는다). 사유 코드 또는 null.
 */
export function ensureStore(ref: StoreRef, owner: string, memoryRoot: string): string | null {
  const problem = createProblem(ref, memoryRoot);
  if (problem) return problem;
  try { if (fs.existsSync(ref.path)) return null; } catch { /* 아래에서 만든다 */ }
  const temporary = path.join(path.dirname(ref.path), `.${path.basename(ref.path)}.new-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(path.dirname(ref.path), { recursive: true, mode: 0o700 });
    const db = new Database(temporary);
    try {
      db.pragma("secure_delete=ON");
      for (const statement of entriesSliceSql()) db.exec(statement);
      const meta = db.prepare("INSERT OR IGNORE INTO memory_store_meta(key,value) VALUES(?,?)");
      for (const [key, value] of [["schema_version", "1"], ["core_schema_version", CORE_SCHEMA_VERSION], ["owner_namespace", owner], ["store_kind", ref.kind],
        ["store_ref", ref.key ?? ""], ["store_slice", SLICE_VERSION], ["forget_epoch_applied", "0"], [COLUMNS_KEY, COLUMNS_VALUE]]) meta.run(key, value);
    } finally { db.close(); }
    if (process.platform !== "win32") { try { fs.chmodSync(temporary, 0o600); } catch { /* 소유자 아님 */ } }
    try { fs.linkSync(temporary, ref.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") { /* 둘째 만드는 쪽이 이겼다 */ }
      else if (!fs.existsSync(ref.path)) fs.renameSync(temporary, ref.path); // 하드링크가 없는 파일 시스템
    }
  } catch { return "store_unwritable"; }
  finally { try { fs.unlinkSync(temporary); } catch { /* 이미 없다 */ } }
  return null;
}

export interface WritableStore { db: Database.Database; ref: StoreRef }
/**
 * 쓰기 연결 하나(없으면 만든다). 못 열면 `{db:null, code}`: 다른 소유자의 파일·링크·이 앱이 쓰는 것보다 새 스키마·아직 적용하지 못한 잊기가 남은 저장소.
 * 부르는 쪽은 뿌리에 쓰는 것으로 물러난다. 새 행은 잊기를 다 반영하지 못한 파일에 들어가지 않는다.
 */
export function openStoreForWrite(ref: StoreRef, owner: string, rootDb: Database.Database, memoryRoot: string): { store: WritableStore | null; code: string | null } {
  const made = ensureStore(ref, owner, memoryRoot);
  if (made) return { store: null, code: made };
  const { store, code } = openStore(ref, owner, rootDb, memoryRoot);
  if (!store) return { store: null, code: code ?? "store_unreadable" };
  if (store.withheld.size) return { store: null, code: "forget_catchup_withheld" };
  if (store.notes.some(note => note === "degraded:schema_version" || note === "degraded:core_schema_version")) return { store: null, code: "store_schema_newer" };
  try {
    const db = new Database(ref.path, { fileMustExist: true, timeout: 500 });
    try {
      db.pragma("secure_delete=ON");   // K7': a page this connection splits or rebalances keeps no copy of the cells that moved (the forget cannot reach a copy nobody points at)
      db.pragma("foreign_keys=ON");
      for (const statement of entriesSliceSql()) db.exec(statement); // 다른 도구가 반쯤 만든 저장소는 마저 채운다, 다시 만들지 않는다
      ensureK1Columns(db); // 2.0 K1: 새 칸 넷 이전에 만든 저장소는 한 번 더한다(표시된 저장소는 meta 한 줄 읽기뿐; 잠겼으면 다음에 — 쓰기는 옛 모양 그대로 간다)
    } catch (error) { try { db.close(); } catch { /* 닫힘 */ } throw error; }
    clearWriteDegradesFor(ref);   // (memory B10): the store takes a write again - its "went to the root store" line is no longer true
    return { store: { db, ref }, code: null };
  } catch { return { store: null, code: "store_unwritable" }; }
}

// --- 쓰기 못 한 사유 (조용히 멈추지 않는다) ------------------------------------------------------------------------------------

export interface WriteDegrade { kind: StoreKind; key: string | null; code: string; count: number; lastAt: string }
const MAX_DEGRADES = 64;
const degrades = new Map<string, WriteDegrade>();
/** 이 프로세스에서 뿌리로 물러난 쓰기. 같은 (종류, 키, 코드)는 한 줄에 횟수만 올린다 — 상한 64줄, 오래된 것부터 버린다. */
export function noteWriteDegrade(ref: StoreRef, code: string): void {
  const key = `${ref.kind}\0${ref.key ?? ""}\0${code}`;
  const now = new Date().toISOString();
  const prior = degrades.get(key);
  if (prior) { degrades.delete(key); degrades.set(key, { ...prior, count: prior.count + 1, lastAt: now }); return; }
  degrades.set(key, { kind: ref.kind, key: ref.key, code, count: 1, lastAt: now });
  while (degrades.size > MAX_DEGRADES) degrades.delete(degrades.keys().next().value as string);
  console.warn(`[memory] a ${ref.kind} store could not be written (${code}); the row went to the root store`);
}
export function writeDegrades(): WriteDegrade[] { return [...degrades.values()]; }
/** Every code noted for this store (one store = kind + key). Called when the store opens for writing again. */
export function clearWriteDegradesFor(ref: StoreRef): void {
  const prefix = `${ref.kind}\0${ref.key ?? ""}\0`;
  for (const key of [...degrades.keys()]) if (key.startsWith(prefix)) degrades.delete(key);
}
export function clearWriteDegradesForTests(): void { degrades.clear(); }
