// 잊기가 하위 저장소에 닿는 부분 (엔진 짝: Agentlas-OS agentlas_cloud/memory_split.py `forget`).
//
// 순서(크래시 어디서 죽어도 다음 열기가 끝낸다): ① 뿌리 한 트랜잭션이 철회 장부(도장)·시계·잊을 행 id 연결·에피소드 비움을 커밋한다(`revocations.ts revokeOneMemoryEntry`)
//   ② 그 뒤 이 파일이 영향받은 저장소를 *연다* — 열기가 곧 따라잡기라서(`stores.ts openStore → catchUp`) 장부가 가리키는 행(id 와 같은 글)의 본문을 비운다
//   ③ 파생물: 저장소 옆 `recall-index.sqlite`(엔진이 만든 검색 색인)를 지운다 — 색인 안의 삭제는 빈 페이지에 글을 남기므로 파일째 지우고 다음 검색이 다시 만든다.
//   ②에서 죽어도 도장은 이미 있다: 그 저장소를 다음에 여는 모든 읽기·쓰기가 같은 따라잡기를 한다(`forgetCatchUpAll` 이 앱 시작 때 한 번 모아 한다).
// ★이 파일은 행을 *찾는* 느린 길을 갖는다(저장소 전부 순회). 사용자가 잊기·삭제를 누른 때만 부른다. 타이머도, 일반 회수 경로의 호출도 없다.
// ★글을 비교하는 해시는 stores.ts `contentHash`(= revocations.ts `memoryContentHash` 와 같은 정규화)다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { accountDir, forgottenIds, layoutOf, listExistingStores, openStore, rootClock, contentHash, closeStoresUnder, type ExistingStore, type StoreRef } from "./stores";
import { dropRecallIndex, removeMemoryMdBeside } from "./forget-derived";

export interface StoreRow {
  id: string; scope: string; kind: string; content: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null;
  superseded_at: string | null; actor_id: string | null; owner_namespace: string | null;
}
export interface StoreMatch { row: StoreRow; ref: StoreRef }

const ROW_SQL = `SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,m.superseded_at,b.actor_id,b.owner_namespace
  FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id`;

function hasTable(db: Database.Database, name: string): boolean {
  try { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; } catch { return false; }
}
function ownedBy(row: StoreRow, owner: string): boolean { return !row.owner_namespace || row.owner_namespace === owner; }

/** id 하나의 행을 저장소 전부에서 찾는다(뿌리는 부르는 쪽이 이미 봤다). 사용자 잊기 동작 중에만. */
export function findRowInStores(context: { memoryRoot: string; owner: string; rootDb: Database.Database }, memoryId: string, actorIds: readonly (string | null)[], bindingActor: boolean): StoreMatch | null {
  for (const candidate of listExistingStores(context.memoryRoot, context.owner)) {
    const { store } = openStore(candidate.ref, context.owner, context.rootDb, context.memoryRoot);
    if (!store) continue;
    try {
      const row = store.db.prepare(`${ROW_SQL} WHERE m.id=? AND m.superseded_at IS NULL AND m.content<>'' LIMIT 1`).get(memoryId) as StoreRow | undefined;
      if (!row || store.withheld.has(row.id) || !ownedBy(row, context.owner)) continue;
      const actor = bindingActor ? ((row.actor_id ?? "").trim() || row.agent_id) : row.agent_id;
      if (!actorIds.includes(actor ?? null)) continue;
      return { row, ref: candidate.ref };
    } catch { /* 이 저장소는 읽지 못한다 — 다음 */ }
  }
  return null;
}

/** 같은 종류·같은 글(정규화 해시, 원문 쪽 글 포함)의 살아 있는 행을 저장소 전부에서 모은다. 엔진 `forget` 의 계정 전체 일치와 같다. */
export function matchRowsInStores(context: { memoryRoot: string; owner: string; rootDb: Database.Database }, kind: string, hashes: ReadonlySet<string>, rule?: { variants: (text: string) => string[]; kindBlind: boolean }): { matches: StoreMatch[]; natives: Map<string, string> } {
  // K7'': with `rule` (the forget stamp's own: every spelling of a row's text against the stamp hashes, the kind ignored when the stamp is kind-blind) the lines found are the lines the stamp refuses to write again.
  const variants = rule?.variants ?? ((text: string) => [contentHash(text)]);
  const kindClause = rule?.kindBlind ? "" : "m.kind=? AND ";
  const matches: StoreMatch[] = [];
  const natives = new Map<string, string>();
  for (const candidate of listExistingStores(context.memoryRoot, context.owner)) {
    const { store } = openStore(candidate.ref, context.owner, context.rootDb, context.memoryRoot);
    if (!store) continue;
    try {
      const rows = store.db.prepare(`${ROW_SQL} WHERE ${kindClause}m.content<>''`).all(...(rule?.kindBlind ? [] : [kind])) as StoreRow[];
      const nativeText = new Map<string, string>();
      if (hasTable(store.db, "memory_entry_native")) {
        for (const item of store.db.prepare("SELECT entry_id,content_native FROM memory_entry_native").all() as Array<{ entry_id: string; content_native: string }>) nativeText.set(item.entry_id, item.content_native);
      }
      for (const row of rows) {
        if (store.withheld.has(row.id) || !ownedBy(row, context.owner)) continue;
        const native = nativeText.get(row.id);
        if (variants(row.content).some(h => hashes.has(h)) || (native !== undefined && variants(native).some(h => hashes.has(h)))) {
          matches.push({ row, ref: candidate.ref });
          if (native !== undefined) natives.set(row.id, native);
        }
      }
    } catch { /* 이 저장소는 읽지 못한다 — 열 때 따라잡기가 한다 */ }
  }
  return { matches, natives };
}

/** 저장소 행이 가리키는 티켓(에피소드 요약·관찰된 턴을 비울 대상). 엔진은 `memory-ticket`, 데스크탑은 `ticket` 으로 적는다. */
export function ticketsOfRows(matches: readonly StoreMatch[]): string[] {
  const byStore = new Map<string, { ref: StoreRef; ids: string[] }>();
  for (const match of matches) { const group = byStore.get(match.ref.path) ?? { ref: match.ref, ids: [] }; group.ids.push(match.row.id); byStore.set(match.ref.path, group); }
  const tickets = new Set<string>();
  for (const { ref, ids } of byStore.values()) {
    let db: Database.Database | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      db = new Database(ref.path, { readonly: true, fileMustExist: true, timeout: 200 });
      if (!hasTable(db, "memory_origin_links")) continue;
      for (let start = 0; start < ids.length; start += 400) {
        const part = ids.slice(start, start + 400);
        for (const row of db.prepare(`SELECT source_id FROM memory_origin_links WHERE source_kind IN ('ticket','memory-ticket') AND memory_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ source_id: string }>) tickets.add(row.source_id);
      }
    } catch { /* 티켓을 못 읽으면 그 에피소드는 보존 기간이 지우게 둔다 */ } finally { try { db?.close(); } catch { /* 닫힘 */ } }
  }
  return [...tickets];
}

export { dropRecallIndex };
/** 잊기가 끝난 뒤 보존된 이전 에이전트 루트를 정리한다(기다리지 않는다). 보존본이 없으면 저널 파일 하나를 읽고 끝난다. 던지지 않는다. */
function retireRetainedAgentRoot(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    void (require("../agents/root-move") as typeof import("../agents/root-move")).retireRetainedRootAfterErase();
  } catch { /* 이 프로세스에는 에이전트 루트 모듈이 없다 */ }
}
/** 옛 엔진이 에이전트 저장소 옆에 둔 `MEMORY.md`(와 임시 파일)를 지운다 — 아무도 읽지 않고 잊은 글을 디스크에 남긴다. */
export function removeAgentMemoryMd(ref: StoreRef): boolean {
  if (ref.kind !== "agent") return false;
  return removeMemoryMdBeside(ref.path);
}

/** 끝내지 못한 잊기의 사유 코드(문장 아님). 프로세스 안에만 있다 — 시작 때 따라잡기가 다시 계산한다. 상한 16개, 읽는 곳: `listSkippedMemoryStores`(기억 화면의 기존 "읽지 못한 저장소" 줄). */
const openForgetCodes = new Set<string>();
export function forgetOpenCodes(): string[] { return [...openForgetCodes]; }
export function noteForgetCodes(codes: readonly string[]): void {
  for (const code of codes) { openForgetCodes.add(code); while (openForgetCodes.size > 16) openForgetCodes.delete(openForgetCodes.values().next().value as string); }
}

/**
 * K7''' (P4b): the root file's rewrite (`storage/db-retention.ts rewriteRootIfOwed`) could not be done: `too_large` (over the size it is held to), `disk_low`, `rewrite_failed`, `no_file`. One word at a time, shown in the same list of unfinished forgets;
 * `null` takes it back (the rewrite finished, or the root owes none). Not recomputed by the stores' catch-up (`dropStoreForgetCodes` drops `forget_partial:*` only): it stays until the pass that owns it says otherwise or the app closes.
 */
export function setRootResidueCode(reason: string | null): void {
  for (const code of [...openForgetCodes]) if (code.startsWith("forget_root_residue:")) openForgetCodes.delete(code);
  if (reason && /^[a-z_]{1,24}$/.test(reason)) noteForgetCodes([`forget_root_residue:${reason}`]);
}

/** Only the codes a look at the stores recomputes (`forget_partial:*`); a code with another source (`supersede_depth`: a replacement chain too long to follow) is the owner's to settle and stays. */
function dropStoreForgetCodes(): void { for (const code of [...openForgetCodes]) if (code.startsWith("forget_partial:")) openForgetCodes.delete(code); }
let lastForgetRecheck = 0;
/**
 * Audit 62 (memory B10): an "unfinished forget" code is a fact about a store at one moment, and the only place that took it back was the next app start - a store that was busy for a second
 * kept the memory screen's "could not read this store" line for as long as the app ran. When the screen asks and a code is open, the stores are looked at again (the same catch-up the start
 * runs, which writes the codes it finds and none for the stores that are clean now). Not a timer: the question is the signal, and no more than once in ten seconds. Never throws.
 */
export function recheckForgetCodes(now = Date.now()): void {
  if (![...openForgetCodes].some(code => code.startsWith("forget_partial:")) || now - lastForgetRecheck < 10_000) return;
  lastForgetRecheck = now;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const database = require("./database") as typeof import("./database");
    dropStoreForgetCodes();
    forgetCatchUpAll({ memoryRoot: database.memoryRoot(), owner: database.getMemoryStoreInfo().ownerNamespace, rootDb: database.getMemoryDb() });
  } catch { /* the codes the look could not recompute are gone; the next real forget or start notes them again */ }
}

/** Put a store's forget cursor back to `to` when it is ahead (so its next open applies the stamps after `to`). True when the store is at or behind `to` afterwards (or has no cursor to move); false when it could not be written now. Never throws. */
function rewindForgetEpoch(ref: StoreRef, to: number): boolean {
  let db: Database.Database | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    db = new Database(ref.path, { fileMustExist: true, timeout: 500 });
    db.prepare("UPDATE memory_store_meta SET value=? WHERE key=? AND CAST(value AS INTEGER) > ?").run(String(Math.max(0, to)), "forget_epoch_applied", Math.max(0, to));
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException)?.code === "SQLITE_CANTOPEN" ? true : false; } finally { try { db?.close(); } catch { /* closed */ } }
}

export interface ForgetCompletion { state: "forgotten" | "partial"; pending: string[]; left: string[] }
/** 뿌리 폴더의 검색 색인을 마지막으로 지운 잊기 번호(뿌리 `memory_store_meta` 키 하나; 읽는 곳: 시작 때 따라잡기, 지우는 때: 계정 삭제가 뿌리 폴더째 지운다). */
export const ROOT_INDEX_EPOCH_KEY = "recall_index_forget_epoch";

function dropRootIndexOnce(rootDb: Database.Database, rootFolder: string, clock: number): boolean {
  try {
    const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(ROOT_INDEX_EPOCH_KEY) as { value: unknown } | undefined;
    if ((Number.parseInt(String(row?.value ?? "0"), 10) || 0) >= clock) return true; // 이 번호까지는 이미 지웠다 — 매 시작마다 색인을 버리지 않는다
    if (!dropRecallIndex(rootFolder)) return false;
    rootDb.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(ROOT_INDEX_EPOCH_KEY, String(clock));
    return true;
  } catch { return false; }
}

/**
 * 도장이 커밋된 뒤의 마무리: 영향받은 저장소를 열어 따라잡기를 시키고(본문 비움), 못 비운 저장소·못 지운 색인을 코드로 돌려준다. 던지지 않는다.
 * 뿌리 폴더의 색인(`recall-index.sqlite`)도 지운다 — 엔진 `forget` 이 같은 일을 한다.
 */
export function completeForgetInStores(context: { memoryRoot: string; owner: string; rootDb: Database.Database }, refs: readonly StoreRef[], rootFolder: string | null, epoch?: number): ForgetCompletion {
  const pending: string[] = [], left: string[] = [];
  for (const ref of refs) {
    // K7': a store's catch-up only looks at stamps newer than its own cursor. A store opened while the forget's transaction was still open (the older versions' rows are read after the stamp is written) moves its cursor
    // to the new number BEFORE the older versions are linked to the stamp, and an older version in a store was then never blanked; a later round of a long chain (the stamp is not new any more) had the same fate.
    // So the cursor of every store this forget touched is put back to just before the stamp's number, and the opening below applies the stamp's ids (all linked and committed by now) once more.
    if (typeof epoch === "number" && epoch > 0 && !rewindForgetEpoch(ref, epoch - 1)) pending.push(`${ref.kind}:forget_residue_busy`);
    try {
      const { store, code } = openStore(ref, context.owner, context.rootDb, context.memoryRoot);
      if (!store) { if (code && code !== "store_absent") pending.push(`${ref.kind}:${code}`); }
      else if (store.withheld.size) pending.push(`${ref.kind}:forget_catchup_withheld`);
      else if (store.notes.includes("forget_residue_busy")) pending.push(`${ref.kind}:forget_residue_busy`);
    } catch { pending.push(`${ref.kind}:store_unreadable`); }
    removeAgentMemoryMd(ref);
    if (!dropRecallIndex(path.dirname(ref.path))) left.push("recall_index");
  }
  if (rootFolder) {
    const clock = rootClock(context.rootDb);
    if (clock !== null ? !dropRootIndexOnce(context.rootDb, rootFolder, clock) : !dropRecallIndex(rootFolder)) left.push("recall_index");
  }
  if (pending.length || left.length) { noteForgetCodes([...pending, ...left].map(code => `forget_partial:${code}`)); console.warn(`[memory-forget] not complete everywhere yet: ${[...pending, ...left].join(",")}`); }
  retireRetainedAgentRoot(); // 루트 이동 뒤 보존된 이전 루트의 사본에도 잊은 글이 남아 있다(Agentlas 2.0 #3): 보존본이 없으면 비용 0
  return { state: pending.length || left.length ? "partial" : "forgotten", pending, left };
}

/** 뿌리 `memory_store_meta` 키 하나: "모든 저장소가 이 잊기 번호·이 저장소 집합에서 따라잡기를 끝냈다"의 지문. 읽는 곳: 시작 때 따라잡기(같으면 저장소를 열지 않는다). 지우는 때: 폴더 합치기가 저장소의 번호를 내렸을 때(`invalidateCatchUpMarker`), 계정 삭제가 뿌리를 지울 때. */
export const CATCHUP_DONE_KEY = "forget_catchup_done";

function readRootMeta(rootDb: Database.Database, key: string): string | null {
  try { const row = rootDb.prepare("SELECT value FROM memory_store_meta WHERE key=?").get(key) as { value: unknown } | undefined; return row ? String(row.value) : null; } catch { return null; }
}
function writeRootMeta(rootDb: Database.Database, key: string, value: string | null): void {
  try {
    if (value === null) rootDb.prepare("DELETE FROM memory_store_meta WHERE key=?").run(key);
    else rootDb.prepare("INSERT INTO memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  } catch { /* 못 쓰면 다음 시작에 한 번 더 연다 — 안전한 쪽 */ }
}
/** 이 잊기 번호와 이 저장소 집합(경로)의 지문. 저장소가 새로 생기거나 사라지거나 잊기가 생기면 달라진다. 저장소 안의 쓰기로는 달라지지 않는다(쓰는 길은 열 때 항상 따라잡는다). */
function catchUpSignature(clock: number, stores: readonly ExistingStore[]): string {
  const hash = createHash("sha256");
  for (const item of stores.map(store => store.ref.path).sort()) hash.update(item).update("\0");
  return `${clock}|${stores.length}|${hash.digest("hex").slice(0, 16)}`;
}
/** 폴더 합치기·복사가 저장소의 잊기 번호를 내렸다 — 시작 때 따라잡기가 다시 모든 저장소를 대조해야 한다. 던지지 않는다. */
export function invalidateCatchUpMarker(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const database = require("./database") as typeof import("./database");
    if (!fs.existsSync(path.join(database.memoryRoot(), "owners"))) return;
    writeRootMeta(database.getMemoryDb(), CATCHUP_DONE_KEY, null);
  } catch { /* 뿌리를 못 열면 지문도 못 읽는다 — 다음 시작은 어차피 전부 연다 */ }
}

/**
 * 앱이 한 번 모아 하는 따라잡기(앱 시작 때 한 번 — `runStartupForgetCatchUp`): 뿌리 시계가 0 이 아니고 저장소가 있을 때만 모든 저장소를 연다. 타이머 없음.
 * 저장소를 여는 것이 곧 따라잡기라서 본문·로그 파일·검색 색인·`MEMORY.md` 가 함께 정리된다(`stores.ts catchUp`). 뿌리 폴더의 색인은 번호 표시로 한 번만 지운다.
 * 한 번 *깨끗이* 끝나면(`skipped` 가 없음) 뿌리 메타에 지문을 남기고, 다음 시작은 번호와 저장소 집합이 같으면 하나도 열지 않는다(#6: 330개에서 매 시작 124~134ms 였다).
 * 열린 만큼만 센다 — 시험이 숫자로 단언한다. 던지지 않는다.
 */
export function forgetCatchUpAll(context: { memoryRoot: string; owner: string; rootDb: Database.Database }): { opened: number; skipped: string[]; upToDate?: boolean } {
  const skipped: string[] = [];
  let opened = 0;
  try {
    const clock = rootClock(context.rootDb);
    if (!clock) return { opened, skipped };
    if ((forgottenIds(context.rootDb, 0)?.size ?? 0) === 0) return { opened, skipped };
    if (!dropRootIndexOnce(context.rootDb, accountDir(context.memoryRoot, context.owner), clock)) skipped.push("personal:recall_index");
    const stores = listExistingStores(context.memoryRoot, context.owner);
    const signature = catchUpSignature(clock, stores);
    if (!skipped.length && readRootMeta(context.rootDb, CATCHUP_DONE_KEY) === signature) return { opened, skipped, upToDate: true };
    for (const candidate of stores) {
      const { store, code } = openStore(candidate.ref, context.owner, context.rootDb, context.memoryRoot);
      opened += 1;
      if (!store) { if (code && code !== "store_absent") skipped.push(`${candidate.ref.kind}:${code}`); }
      else if (store.withheld.size) skipped.push(`${candidate.ref.kind}:forget_catchup_withheld`);
      else if (store.notes.includes("forget_residue_busy")) skipped.push(`${candidate.ref.kind}:forget_residue_busy`);
    }
    dropStoreForgetCodes();
    noteForgetCodes(skipped.map(code => `forget_partial:${code}`));
    writeRootMeta(context.rootDb, CATCHUP_DONE_KEY, skipped.length ? null : signature);
  } catch { /* 다음 시작에 다시 한다 */ }
  return { opened, skipped };
}

let engineRetry: Promise<{ agents: number; projects: number }> | null = null;
/**
 * 엔진이 끝내지 못한 삭제(에이전트·프로젝트)를 *한 번* 다시 한다. 호출하는 신호는 둘뿐이다: 앱 시작(`runStartupForgetCatchUp`)과 엔진을 쓸 수 있게 됐다는 신호(`hephaestus/engine.ts resetHephaestusCache` —
 * 런타임 설치·갱신 뒤). 타이머 없음. 동시에 둘이 불러도 한 번만 돈다. 대기가 0이면 메타 한 줄만 읽는다. 던지지 않는다 — 실패하면 조용히 다음 신호를 기다린다. 부르는 쪽은 기다리지 않아도 된다.
 */
export function retryEngineForgetsOnce(): Promise<{ agents: number; projects: number }> {
  if (engineRetry) return engineRetry;
  const run = (async () => {
    const result = { agents: 0, projects: 0 };
    // 한 묶음(5건)을 돌려 줄어들면 다음 묶음도 — 엔진이 돌아왔는데 밀린 것이 수십 건이어도 한 신호에 정리된다(최대 10묶음). 엔진이 안 닿으면 첫 묶음에서 멈춘다(`pending` 이 안 줄어든다).
    const drain = async (retry: () => Promise<{ pending: number; retried: number; before: number }>): Promise<number> => {
      let pending = 0;
      for (let round = 0; round < 10; round += 1) { const step = await retry(); pending = step.pending; if (pending === 0 || pending >= step.before || step.retried === 0) break; }
      return pending;
    };
    try { result.agents = await drain(async () => (await import("../agents/agent-forget")).retryPendingAgentForgets()); } catch { /* 다음 신호가 다시 한다 */ }
    try { result.projects = await drain(async () => (await import("./store-delete")).retryPendingProjectForgets()); } catch { /* 다음 신호가 다시 한다 */ }
    return result;
  })().finally(() => { engineRetry = null; });
  engineRetry = run;
  return run;
}

/**
 * 앱 시작 때 한 번(`main.ts` 의 시작 뒤 유지보수 줄, 에이전트 폴더 합치기 다음): ① 잊기 따라잡기(저장소 파일만 읽고 쓴다 — 엔진 없음)
 * ② 엔진이 끝내지 못한 에이전트·프로젝트 삭제 다시 하기 — 이것은 *기다리지 않고* 따로 띄운다(엔진이 답하지 않아도 아래 단계가 밀리지 않는다, #3: 대기가 있으면 시작마다 최대 125초).
 * 레이아웃 스위치가 꺼져 있으면(`central`) ①은 아무것도 열지 않는다(②의 에이전트 삭제는 레이아웃과 무관하다). 던지지 않는다. 돌려주는 값은 로그용이다. `engineRetries` 는 시험이 기다리는 용도다.
 */
export async function runStartupForgetCatchUp(): Promise<{ opened: number; skipped: string[]; projectsPending: number; upToDate?: boolean; engineRetries: Promise<{ agents: number; projects: number }> }> {
  const engineRetries = retryEngineForgetsOnce();
  const none = { opened: 0, skipped: [] as string[], projectsPending: 0, engineRetries };
  try {
    const database = await import("./database");
    if (!fs.existsSync(path.join(database.memoryRoot(), "owners"))) return none;
    const rootDb = database.getMemoryDb();
    // K7'' (audit D1, the chain limit): the rest of a replacement chain a forget could not follow in one go is a debt in the root file (`forget_chain_left`); the start of the app goes on from it, in every layout.
    try { (require("./revocations") as typeof import("./revocations")).resumeOlderVersions(); } catch { /* the next start looks again */ }
    if (layoutOf(rootDb) === "central") {
      // K7': with the switch OFF no store is opened, but a forget killed between its commit and the deletion of the engine's search index beside the root store (it quotes the words) is finished here: one clock read
      // and, when a forget happened and the index was not dropped for it yet, one file delete (the marker `recall_index_forget_epoch` makes it once per forget).
      try { const clock = rootClock(rootDb); if (clock) dropRootIndexOnce(rootDb, accountDir(database.memoryRoot(), database.getMemoryStoreInfo().ownerNamespace), clock); } catch { /* the next start looks again */ }
      return none;
    }
    const caught = forgetCatchUpAll({ memoryRoot: database.memoryRoot(), owner: database.getMemoryStoreInfo().ownerNamespace, rootDb });
    let projectsPending = 0;
    try { projectsPending = (await (await import("./store-delete")).pendingProjectForgetCount()); } catch { /* 다음 시작에 다시 */ }
    if (caught.skipped.length || projectsPending) console.warn(`[memory-forget] startup: opened ${caught.opened} stores, skipped ${[...new Set(caught.skipped)].join(",") || "none"}, project forgets pending ${projectsPending}`);
    return { ...caught, projectsPending, engineRetries };
  } catch { return none; }
}

export type { ExistingStore };
export { closeStoresUnder };
