// 지우기 사슬 — 프로젝트 삭제·계정 삭제·에이전트 저장소 핸들 닫기 (엔진 짝: memory_split.py `forget_project`·`delete_account_stores`).
//
// ★분리 스위치가 `central` 이면 아무것도 하지 않는다(`state: "skipped", reason: "layout_central"`): 저장소 파일이 없으므로 지울 것이 없고, 옛 동작은 한 비트도 바뀌지 않는다.
// ★데스크탑이 하는 것: ① 이 프로젝트를 가리키는 줄이 *에이전트 저장소 안에* 남은 것 비우기(엔진 `forget-project` 는 뿌리와 프로젝트 저장소만 안다 — N-B08)
//   ② 엔진 `forget-project` 를 폴더가 있을 때 부르기(뿌리 원장·프로젝트 저장소 폴더·검색 색인) ③ 결과가 `partial` 이면 "다 지웠다"고 하지 않고 대기 목록(`meta` 키 하나)에 남겨
//   다음 프로젝트 삭제 때와 앱 시작 때(`retryPendingProjectForgets`, 타이머 없음) 다시 한다.
// ★데스크탑이 하지 않는 것: 사용자의 프로젝트 폴더를 지우거나 고치는 일(절대). 이사(행 옮기기) 구현.
// ★핸들: 저장소 파일을 지우거나 폴더를 옮기기 *전에* 열린 읽기 연결을 닫는다(Windows 에서 열린 연결이 삭제·이동을 막는다).
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { accountDir, closeAllStores, closeStoreHandle, closeStoresUnder, layoutOf, listExistingStores, projectKeys, projectRef, storeAgentId } from "./stores";
import { dropRecallIndex } from "./forget-stores";
import { leftToRetry, noteLeftThatEndsHere, readLeftReasons, type LeftReasons } from "./engine-left";

export const PROJECT_PENDING_KEY = "project-forget-pending:v1";
/** 대기 줄은 프로젝트당 하나, 항목 하나는 약 150바이트라 상한을 넉넉히 둔다. 가득 차도 *버리지 않는다* — 새 항목을 못 넣고 `pending_list_full` 코드로 알린다(#11). */
export const PROJECT_PENDING_CAP = 500;

export type EngineState = "forgotten" | "partial" | "skipped" | "unavailable" | "not_called";
export interface ProjectForgetOutcome {
  state: "skipped" | "forgotten" | "partial";
  /** 코드만 — 문장은 화면이 만든다. */
  left: string[];
  agentRowsRemoved: number;
  engine: EngineState;
  /** Desktop repair 6: why the engine left what it left (`left: ["views"]` -> `{views: "views_path_too_long" | "views_file_busy" | "views_retry"}`), when it said. A left that cannot change is not queued for a retry. */
  leftReasons?: LeftReasons;
}
/** `tries` 는 표시용 횟수일 뿐 상한이 아니다 — 끝날 때까지 시작·다음 프로젝트 삭제마다 한 번씩 다시 한다. `code` 는 마지막으로 남았다고 한 사유(코드). */
interface Pending { id: string; path: string | null; tries: number; at: string; code?: string }

let engineForTests: ((args: string[]) => Promise<{ state: EngineState; left: string[]; leftReasons?: LeftReasons }>) | null = null;
/** Test seam: replaces the engine call. `null` restores the real one. */
export function setProjectForgetEngineForTests(fn: typeof engineForTests): void { engineForTests = fn; }

/** `memory_split` 을 한 번 부른다(JSON 한 줄). 엔진이 없거나 끝나지 않으면 `partial` + `engine_*` 코드 — 던지지 않는다. */
export async function runSplitEngine(args: string[]): Promise<{ state: EngineState; left: string[]; leftReasons?: LeftReasons }> {
  if (engineForTests) return engineForTests(args);
  try {
    const [{ runHephaestus }, { trustedMemoryOwnerEnvironment }] = await Promise.all([import("../hephaestus/engine"), import("./trusted-owner-binding")]);
    let env: Record<string, string> = {};
    try { env = trustedMemoryOwnerEnvironment(); } catch { /* 소유자를 못 묶으면 엔진이 deferred 로 답한다 */ }
    const result = await runHephaestus<{ state?: string; left?: unknown }>("agentlas_cloud.memory_split" as unknown as Parameters<typeof runHephaestus>[0], args, { timeoutMs: 15_000, env });
    const text = `${result.stderr ?? ""}\n${result.error ?? ""}`;
    if (!result.json && /No module named|ModuleNotFoundError/i.test(text)) return { state: "unavailable", left: [] };
    const state = result.json?.state;
    if (state === "forgotten" || state === "deleted") return { state: "forgotten", left: [] };
    if (state === "skipped" || state === "deferred") return { state: "skipped", left: [] };
    const left = Array.isArray(result.json?.left) ? result.json!.left.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
    const leftReasons = left.length ? readLeftReasons(result.json) : undefined;
    return { state: "partial", left: left.length ? left : ["engine_no_answer"], ...(leftReasons ? { leftReasons } : {}) };
  } catch { return { state: "partial", left: ["engine_not_started"] }; }
}

// --- 에이전트 저장소 안의 프로젝트 줄 -------------------------------------------------------------------------------------------

/**
 * 모든 에이전트 저장소에서 `project_id = X`(또는 이 폴더 경로에 묶인) 줄을 지운다 — 엔진 `_delete_rows` 와 같은 범위(항목·딸린 표·번역 작업). 한 저장소 한 트랜잭션, secure_delete.
 * 못 지운 저장소는 코드(`store_locked` 등)로 알린다. 지운 행 수를 돌려준다. 던지지 않는다.
 */
export function purgeProjectRowsFromAgentStores(context: { memoryRoot: string; owner: string }, project: { id: string; path: string | null }): { removed: number; left: string[] } {
  let removed = 0;
  const left: string[] = [];
  for (const item of listExistingStores(context.memoryRoot, context.owner)) {
    if (item.ref.kind !== "agent") continue;
    closeStoreHandle(item.ref.path);
    let db: Database.Database | null = null;
    try {
      db = new Database(item.ref.path, { fileMustExist: true, timeout: 500 });
      db.pragma("foreign_keys=ON");
      db.pragma("secure_delete=ON");
      // 프로젝트를 지우면 "그 프로젝트의 기억"만 간다(엔진 `forget-project` 와 같은 뜻, #4): 에이전트 전역 줄(`agent_repo`, 프로젝트 경로 없음 — 어느 프로젝트에서나 실리는
      // 에이전트 자신의 요령)은 출처 꼬리표(`project_id`)가 이 프로젝트여도 남긴다. 프로젝트에 묶인 줄(경로가 이 폴더인 것)과 에이전트 저장소 안의 다른 범위 줄은 간다.
      const where = project.path
        ? "(scope <> 'agent_repo' AND (project_id = ? OR project_path = ?)) OR (scope = 'agent_repo' AND project_path = ?)"
        : "(scope <> 'agent_repo' AND project_id = ?)";
      const args = project.path ? [project.id, project.path, project.path] : [project.id];
      const ids = (db.prepare(`SELECT id FROM memory_entries WHERE ${where}`).all(...args) as Array<{ id: string }>).map(row => row.id);
      if (!ids.length) continue;
      const handle = db;
      handle.transaction(() => {
        for (let start = 0; start < ids.length; start += 400) {
          const part = ids.slice(start, start + 400), marks = part.map(() => "?").join(",");
          handle.prepare(`DELETE FROM memory_entries WHERE id IN (${marks})`).run(...part); // bindings, links, edges and the original-wording twin go with it (foreign keys)
        }
      }).immediate();
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 다른 연결이 읽는 중 — 다음 체크포인트가 비운다 */ } // 지운 글이 본 파일에 남지 않게(#1 과 같은 이유)
      removed += ids.length;
      if (!dropRecallIndex(path.dirname(item.ref.path))) left.push("recall_index");
    } catch (error) { left.push(/busy|locked/i.test(String(error)) ? "store_locked" : "store_files"); }
    finally { try { db?.close(); } catch { /* 닫힘 */ } }
  }
  return { removed, left: [...new Set(left)] };
}

// --- 뿌리(root) 쪽 줄 지우기: 엔진 없이도 데스크탑이 스스로 끝낼 수 있는 부분 (#1·#5) ---------------------------------------------------

/** 줄 id 묶음을 한 번에 지운다(딸린 표·관계 선·원문 쌍둥이 포함). 호출하는 쪽이 트랜잭션을 쥔다. */
function deleteEntryRows(db: Database.Database, ids: readonly string[]): void {
  for (let start = 0; start < ids.length; start += 400) {
    const part = ids.slice(start, start + 400), marks = part.map(() => "?").join(",");
    try { db.prepare(`DELETE FROM memory_relation_edges WHERE from_memory_id IN (${marks}) OR to_memory_id IN (${marks})`).run(...part, ...part); } catch { /* 관계 표 없음 */ }
    try { db.prepare(`DELETE FROM memory_entry_native WHERE entry_id IN (${marks})`).run(...part); } catch { /* 원문 쌍둥이 표 없음 */ }
    db.prepare(`DELETE FROM memory_entries WHERE id IN (${marks})`).run(...part); // bindings, links go with it (foreign keys)
  }
}

/**
 * 지운 에이전트의 뿌리 쪽 흔적을 데스크탑이 직접 비운다 — 엔진 `forget-agent` 가 못 끝냈을 때(엔진·Python 없음, 응답 없음, 낡음) 사용자가 지운 에이전트의 기억이 뿌리에 남아 있지 않게.
 * 지우는 것: 그 에이전트가 소유한 줄(`agent_id` 가 별칭 중 하나이고 소유 범위가 에이전트인 줄 — 엔진과 같은 판정), 그 에이전트의 턴 기록(티켓·에피소드·결정, 관찰된 턴). 폴더 안의 저장소는 폴더 몫.
 * 안 지우는 것: 다른 에이전트·프로젝트·개인 줄, 철회 장부, One·`host:*`·허브(저장소 없는 행위자 — `storeAgentId` 가 거른다). 엔진이 나중에 답하면 남은 것(뷰·번역 작업)을 마저 한다.
 * 한 트랜잭션. 던지지 않는다 — 못 하면 코드를 돌려준다.
 */
export function purgeAgentRowsFromRoot(rootDb: Database.Database, aliases: readonly string[]): { removed: number; tickets: number; left: string[] } {
  const ids = [...new Set(aliases.filter(alias => typeof alias === "string" && alias && storeAgentId(alias) !== null))];
  if (!ids.length) return { removed: 0, tickets: 0, left: [] };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ownerScopeOf } = require("./store-write") as typeof import("./store-write");
    const marks = ids.map(() => "?").join(",");
    let removed = 0, tickets = 0;
    rootDb.transaction(() => {
      const rows = rootDb.prepare(`SELECT id,scope,agent_id,project_id,project_path,chat_id FROM memory_entries WHERE agent_id IN (${marks})`).all(...ids) as Array<{ id: string; scope: string; agent_id: string | null; project_id: string | null; project_path: string | null; chat_id: string | null }>;
      const owned = rows.filter(row => ownerScopeOf({ scope: row.scope, agentId: row.agent_id, projectId: row.project_id, projectPath: row.project_path, chatId: row.chat_id })?.kind === "agent").map(row => row.id);
      if (owned.length) deleteEntryRows(rootDb, owned);
      removed = owned.length;
      const ticketIds = (rootDb.prepare(`SELECT ticket_id FROM memory_tickets WHERE agent_id IN (${marks})`).all(...ids) as Array<{ ticket_id: string }>).map(row => row.ticket_id);
      for (let start = 0; start < ticketIds.length; start += 400) {
        const part = ticketIds.slice(start, start + 400), partMarks = part.map(() => "?").join(",");
        try { rootDb.prepare(`DELETE FROM memory_operations WHERE operation_id IN (${partMarks})`).run(...part); } catch { /* 이 저장소에는 관찰된 턴 표가 없다 */ }
        rootDb.prepare(`DELETE FROM memory_episodes WHERE ticket_id IN (${partMarks})`).run(...part);
        rootDb.prepare(`DELETE FROM memory_decisions WHERE ticket_id IN (${partMarks})`).run(...part);
        rootDb.prepare(`DELETE FROM memory_tickets WHERE ticket_id IN (${partMarks})`).run(...part);
      }
      tickets = ticketIds.length;
    }).immediate();
    const left: string[] = [];
    if (removed || tickets) {
      try { (require("./selected-context-cache") as typeof import("./selected-context-cache")).clearSelectedMemoryContextCache(); } catch { /* 캐시 없음 */ }
      try { // 뿌리 폴더의 검색 색인은 파생물 — 지운 글이 빈 페이지에 남으니 파일째 지운다(다음 검색이 다시 만든다)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getMemoryStoreInfo, memoryRoot } = require("./database") as typeof import("./database");
        if (!dropRecallIndex(accountDir(memoryRoot(), getMemoryStoreInfo().ownerNamespace))) left.push("recall_index");
      } catch { left.push("recall_index"); }
    }
    return { removed, tickets, left };
  } catch (error) { return { removed: 0, tickets: 0, left: [/busy|locked/i.test(String(error)) ? "root_locked" : "root_unreadable"] }; }
}

/** 프로젝트를 지울 때 뿌리에 남는 "그 프로젝트 경로가 붙은 에이전트 줄"(개인 에이전트·폴더 없는 에이전트 것)을 지운다 — 에이전트 저장소의 같은 줄과 같은 조건이다(#5). 던지지 않는다. */
export function purgeProjectAgentRowsFromRoot(rootDb: Database.Database, project: { id: string; path: string | null }): { removed: number; left: string[] } {
  if (!project.path) return { removed: 0, left: [] };
  try {
    let removed = 0;
    rootDb.transaction(() => {
      const ids = (rootDb.prepare("SELECT id FROM memory_entries WHERE scope='agent_repo' AND project_path = ?").all(project.path) as Array<{ id: string }>).map(row => row.id);
      if (ids.length) deleteEntryRows(rootDb, ids);
      removed = ids.length;
    }).immediate();
    if (removed) { try { (require("./selected-context-cache") as typeof import("./selected-context-cache")).clearSelectedMemoryContextCache(); } catch { /* 캐시 없음 */ } }
    return { removed, left: [] };
  } catch (error) { return { removed: 0, left: [/busy|locked/i.test(String(error)) ? "root_locked" : "root_unreadable"] }; }
}

/** 루트 이동 뒤 보존된 이전 에이전트 루트를 정리한다(새 쪽에서 지워진 것은 되살리지 않는다). 보존본이 없으면 저널 파일 하나를 읽고 끝난다. 던지지 않는다. */
async function retireRetainedAgentRoot(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await (require("../agents/root-move") as typeof import("../agents/root-move")).retireRetainedRootAfterErase();
  } catch { /* 이 프로세스에는 에이전트 루트 모듈이 없다 */ }
}

/** 에이전트 폴더 안의 이 계정의 기억 폴더(`.agentlas-local/memory/o-<해시>/`: 기억 파일·검색 색인·MEMORY.md)를 파일째 지운다. 링크는 따라가지 않는다. 못 지운 경로를 돌려준다. 엔진 `forget-agent` 와 같은 일을 데스크탑이 직접 한다. */
export function purgeAgentAccountStore(folder: string, accountFolder: string): string[] {
  const store = path.join(folder, ".agentlas-local", "memory", accountFolder);
  if (!present(store)) return [];
  closeStoresUnder(folder);
  if (!removeOwned(store, folder)) return [store];
  try { fs.rmdirSync(path.dirname(store)); } catch { /* 다른 계정의 폴더가 남아 있다 */ }
  return [];
}

// --- 프로젝트 삭제 -----------------------------------------------------------------------------------------------------------

/** 대기 목록은 뿌리 `meta` 키 하나(`PROJECT_PENDING_KEY`): 쓰는 곳 = 끝내지 못한 프로젝트 삭제, 읽는 곳 = 앱 시작 때와 다음 프로젝트 삭제, 지우는 때 = 그 프로젝트가 끝났을 때. 프로젝트당 한 줄. */
function pendingStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const meta = require("../store/meta") as typeof import("../store/meta");
  const read = (): Pending[] => {
    try {
      const parsed: unknown = JSON.parse(meta.getMeta(PROJECT_PENDING_KEY) ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item): Pending[] => {
        const entry = item as Partial<Pending>;
        return typeof entry?.id === "string" && entry.id ? [{ id: entry.id, path: typeof entry.path === "string" ? entry.path : null, tries: Number.isInteger(entry.tries) ? Number(entry.tries) : 0, at: typeof entry.at === "string" ? entry.at : new Date().toISOString(), ...(typeof entry.code === "string" && entry.code ? { code: entry.code.slice(0, 64) } : {}) }] : [];
      }).slice(0, PROJECT_PENDING_CAP);
    } catch { return []; }
  };
  const write = (entries: Pending[]) => { try { meta.setMeta(PROJECT_PENDING_KEY, JSON.stringify(entries.slice(0, PROJECT_PENDING_CAP))); } catch { /* 다음 삭제·시작 때 엔진이 다시 본다 */ } };
  return { read, write };
}

/**
 * 끝내지 못한 프로젝트 삭제의 표시 코드(읽기만, 문장 아님). `project_forget_pending` = 아직 남은 것이 있다, `project_forget_stuck:<코드>` = 여러 번 다시 해도 같은 사유로 남는다
 * (`engine_unavailable` 이면 엔진을 고쳐야 끝난다). 대기가 없으면 빈 배열. 던지지 않는다.
 */
export function projectForgetPendingCodes(): string[] {
  try {
    const entries = pendingStore().read();
    if (!entries.length) return [];
    const codes = new Set<string>(["project_forget_pending"]);
    for (const entry of entries) if (entry.tries >= 5 && entry.code) codes.add(`project_forget_stuck:${entry.code}`);
    return [...codes].slice(0, 5);
  } catch { return []; }
}

/** 읽기만: 지금 남은 프로젝트 삭제 개수(엔진을 부르지 않는다). */
export function pendingProjectForgetCount(): number { try { return pendingStore().read().length; } catch { return 0; } }

/**
 * Audit 62 (memory B9b): a forget that stopped on a lock (a store or the root held by another writer for a moment) was tried again only at the next app start or the next project delete - the lock was gone
 * a second later and the traces stayed for days. A lock code is a cause that ends by itself, so the forget is tried again after 5 s, 30 s and 2 min (one timer at a time, three tries, then the start-up
 * and next-delete signals as before). Not a poll: the timer exists only while a lock-stopped forget waits, and it is the end time of that wait.
 */
const TRANSIENT_CODES = new Set(["store_locked", "root_locked"]);
let transientDelays: readonly number[] = [5_000, 30_000, 120_000];
let transientTimer: ReturnType<typeof setTimeout> | null = null;
let transientAttempt = 0;
/** Test seam: the waits of the lock retry. `null` restores them. */
export function setTransientRetryDelaysForTests(delays: readonly number[] | null): void { transientDelays = delays ?? [5_000, 30_000, 120_000]; transientAttempt = 0; if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; } }
function armTransientRetry(): void {
  if (transientTimer || transientAttempt >= transientDelays.length) return;
  let waiting = false;
  try { waiting = pendingStore().read().some(entry => entry.code !== undefined && TRANSIENT_CODES.has(entry.code)); } catch { /* none */ }
  if (!waiting) { transientAttempt = 0; return; }
  const delay = transientDelays[transientAttempt++]!;
  transientTimer = setTimeout(() => {
    transientTimer = null;
    void retryPendingProjectForgets().then(() => armTransientRetry(), () => armTransientRetry());
  }, delay);
  transientTimer.unref?.();
}

let serial: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> { const run = serial.then(task, task); serial = run.catch(() => undefined); return run; }

/**
 * 프로젝트 하나의 기억 흔적을 지운다. 스위치가 `central` 이면 `skipped`. 프로젝트 행·사용자 폴더는 건드리지 않는다(호출자의 몫이고 폴더는 절대 안 지운다).
 * 부르는 순서: 프로젝트 행을 지우기 *전에*(폴더 경로·id 가 필요하다).
 * 끝내지 못하면(엔진 없음·고장·잠긴 저장소) `partial` 과 사유 코드를 돌려주고 대기 목록에 *남긴다* — 횟수로 버리지 않는다(#11).
 */
export async function forgetProjectTraces(project: { id: string; path: string | null }): Promise<ProjectForgetOutcome> {
  await retireRetainedAgentRoot(); // 루트 이동 뒤 보존된 이전 루트의 사본에도 이 프로젝트의 줄이 있다(Agentlas 2.0 #3): 먼저 정리하고 아래에서 지운다 — 보존본이 없으면 비용 0
  let context: { memoryRoot: string; owner: string; rootDb: Database.Database };
  try {
    const database = await import("./database");
    // No memory root yet = no store was ever made = the central layout: nothing to read, and nothing is created here.
    if (!fs.existsSync(path.join(database.memoryRoot(), "owners"))) return { state: "skipped", left: [], agentRowsRemoved: 0, engine: "not_called" };
    const rootDb = database.getMemoryDb();
    if (layoutOf(rootDb) === "central") return { state: "skipped", left: [], agentRowsRemoved: 0, engine: "not_called" };
    context = { memoryRoot: database.memoryRoot(), owner: database.getMemoryStoreInfo().ownerNamespace, rootDb };
  } catch { return { state: "skipped", left: [], agentRowsRemoved: 0, engine: "not_called" }; }
  // 핸들을 먼저 닫는다: 이 프로젝트의 저장소(가능한 모든 키)와 에이전트 저장소들.
  for (const key of projectKeys(project.path, project.id)) closeStoreHandle(projectRef(context.memoryRoot, context.owner, key).path);
  const agents = purgeProjectRowsFromAgentStores(context, project);
  // 뿌리에 남는 "이 프로젝트 경로가 붙은 에이전트 줄"도 같은 조건으로(엔진 `forget-project` 는 뿌리에서 프로젝트 소유 줄만 지운다 — #5). 엔진이 없어도 데스크탑이 한다.
  const rootRows = purgeProjectAgentRowsFromRoot(context.rootDb, project);
  agents.removed += rootRows.removed; agents.left.push(...rootRows.left);
  const args = ["forget-project", "--project-id", project.id, ...(project.path ? ["--project-path", project.path] : [])];
  const engine = await runSplitEngine(args);
  const left = [...agents.left, ...(engine.state === "partial" ? engine.left : []), ...(engine.state === "unavailable" ? ["engine_unavailable"] : [])];
  const partial = left.length > 0 || engine.state === "partial" || engine.state === "unavailable";
  // Desktop repair 6 (engine `leftReasons`): a left the engine says no retry changes (the views path is too long for this machine) is told in the answer and in the memory screen's open codes, and is NOT put on
  // the pending list (it would be tried at every start for ever). Everything else - and an engine that gives no reasons - is queued as before.
  const leftReasons = engine.state === "partial" ? engine.leftReasons : undefined;
  const retryable = partial && (left.length === 0 || leftToRetry(left, leftReasons).length > 0);
  if (partial) noteLeftThatEndsHere(left, leftReasons);
  if (retryable) {
    await exclusive(async () => {
      const store = pendingStore();
      const entries = store.read().filter(entry => entry.id !== project.id);
      if (entries.length >= PROJECT_PENDING_CAP) { left.push("pending_list_full"); console.warn(`[project-forget] pending list is full (${PROJECT_PENDING_CAP}); ${project.id} was not queued`); return; }
      entries.push({ id: project.id, path: project.path, tries: 1, at: new Date().toISOString(), ...(left[0] ? { code: left[0].slice(0, 64) } : {}) });
      store.write(entries);
    });
    if (!transientTimer) transientAttempt = 0;   // a new forget gets its own three tries
    armTransientRetry();
  }
  return { state: partial ? "partial" : "forgotten", left: [...new Set(left)], agentRowsRemoved: agents.removed, engine: engine.state, ...(leftReasons ? { leftReasons } : {}) };
}

/**
 * 끝내지 못한 프로젝트 삭제를 다시 한다(타이머 없음 — 앱 시작·다음 삭제가 부른다). 한 번에 5개까지(남는 것은 뒤로 돌려 돌아가며), 대기가 0이면 아무것도 하지 않는다.
 * 끝난 것만 목록에서 빠진다. `except` 는 방금 끝내지 못한 프로젝트(바로 다시 하지 않는다).
 */
export async function retryPendingProjectForgets(options: { except?: string } = {}): Promise<{ pending: number; retried: number; before: number }> {
  if (pendingStore().read().length === 0) return { pending: 0, retried: 0, before: 0 };
  return exclusive(async () => {
    const store = pendingStore();
    const all = store.read();
    const eligible = all.filter(entry => entry.id !== options.except);
    const batch = eligible.slice(0, 5);
    const remaining: Pending[] = [...all.filter(entry => entry.id === options.except), ...eligible.slice(5)];
    let retried = 0, engineDown = false;
    for (const entry of batch) {
      // 엔진이 안 닿는 것이 확인되면 같은 묶음의 나머지도 같은 이유로 실패한다 — 엔진을 건건이 10~15초씩 기다리지 않는다(횟수도 올리지 않는다).
      if (engineDown) { remaining.push(entry); continue; }
      retried += 1;
      const outcome = await forgetProjectTracesOnce(entry);
      if (outcome.done) continue;
      if (outcome.code?.startsWith("engine_")) engineDown = true;
      remaining.push({ ...entry, tries: Math.min(entry.tries + 1, 1_000_000), ...(outcome.code ? { code: outcome.code } : {}) });
    }
    store.write(remaining);
    return { pending: remaining.length, retried, before: all.length };
  });
}
async function forgetProjectTracesOnce(entry: Pending): Promise<{ done: boolean; code?: string }> {
  try {
    const database = await import("./database");
    if (!fs.existsSync(path.join(database.memoryRoot(), "owners"))) return { done: true };
    const rootDb = database.getMemoryDb();
    if (layoutOf(rootDb) === "central") return { done: true };
    const context = { memoryRoot: database.memoryRoot(), owner: database.getMemoryStoreInfo().ownerNamespace };
    // 데스크탑이 하는 부분(에이전트 저장소·뿌리의 경로 붙은 에이전트 줄)은 첫 시도에서 끝났다. 지난번에 엔진이 문제였으면 다시 저장소를 전부 열지 않는다(저장소 수백 개를 시작마다 여는 일 방지).
    const agentsDone = Boolean(entry.code?.startsWith("engine_"));
    const agents = agentsDone ? { left: [] as string[] } : purgeProjectRowsFromAgentStores(context, { id: entry.id, path: entry.path });
    const rootRows = agentsDone ? { left: [] as string[] } : purgeProjectAgentRowsFromRoot(rootDb, { id: entry.id, path: entry.path });
    const engine = await runSplitEngine(["forget-project", "--project-id", entry.id, ...(entry.path ? ["--project-path", entry.path] : [])]);
    // 엔진이 답했으면 한 번은 데스크탑 부분도 다시 확인한다(이전에 건너뛰었을 수 있다).
    if (agentsDone && engine.state !== "partial" && engine.state !== "unavailable") {
      agents.left.push(...purgeProjectRowsFromAgentStores(context, { id: entry.id, path: entry.path }).left);
      rootRows.left.push(...purgeProjectAgentRowsFromRoot(rootDb, { id: entry.id, path: entry.path }).left);
    }
    // Desktop repair 6: what the engine says no retry changes does not keep the entry (an entry an older build queued for it ends here, with its code noted).
    const engineRetry = engine.state === "partial" ? leftToRetry(engine.left, engine.leftReasons) : [];
    if (engine.state === "partial") noteLeftThatEndsHere(engine.left, engine.leftReasons);
    const code = agents.left[0] ?? rootRows.left[0] ?? (engine.state === "partial" ? engineRetry[0] : engine.state === "unavailable" ? "engine_unavailable" : undefined);
    if (engine.state === "partial" && !code && engine.left.length > 0 && engineRetry.length === 0) return { done: true };
    return code || engine.state === "partial" || engine.state === "unavailable" ? { done: false, code: code ?? "engine_no_answer" } : { done: true };
  } catch { return { done: false, code: "retry_failed" }; }
}

// --- 에이전트 저장소 핸들 -----------------------------------------------------------------------------------------------------

/** 에이전트 폴더를 지우거나 옮기기 전에 그 안의 저장소 연결을 닫는다(엔진 `forget-agent` 호출과 폴더 휴지통 이동 앞). 닫은 수. */
export function closeAgentStoreHandles(folder: string | null | undefined): number {
  if (!folder) return 0;
  try { return closeStoresUnder(folder); } catch { return 0; }
}

// --- 계정 삭제 ---------------------------------------------------------------------------------------------------------------

export interface AccountDeleteOutcome {
  state: "deleted" | "incomplete" | "refused";
  /** 코드만(`agent_store`·`owner_folder`). 같은 코드는 한 번. 경로 원문은 로그에만 — `leftCount` 는 남은 경로 수. */
  left: string[];
  leftCount?: number;
  reason?: string;
}

function removeOwned(target: string, boundary: string): boolean {
  try {
    const real = path.resolve(target);
    if (!real.startsWith(path.resolve(boundary) + path.sep)) return false;
    let part = real;
    while (part !== path.resolve(boundary)) { if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) return false; part = path.dirname(part); }
    fs.rmSync(real, { recursive: true, force: true });
    return !fs.existsSync(real);
  } catch { return false; }
}

/** 없다고 확신할 때만 false(ENOENT·ENOTDIR). 권한이 없어 들여다볼 수 없으면 "있다"로 본다 — 못 본 것을 "없음"이라 하고 "deleted" 라고 하지 않는다(#8). */
function present(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch (error) { const code = (error as NodeJS.ErrnoException | undefined)?.code; return !(code === "ENOENT" || code === "ENOTDIR"); }
}

/**
 * 에이전트 폴더 안에 보존된 옛 사본(`.agentlas-local/absorbed-*`)에서 이 계정의 기억 폴더(`memory/o-<해시>/`)를 지운다. 엔진 `forget-agent`·`delete-account` 는 `absorbed-*` 를 모른다 —
 * 30일 된 보존본이 폴더 합치기 점검(`sweepAbsorbed`)에서 살아 있는 저장소로 되살아났다(#2). 폴더·상태 폴더·보존 폴더가 링크면 따라가지 않는다. 못 지운 경로를 돌려준다(없으면 빈 배열).
 */
export function purgeAbsorbedAccountMemory(folder: string, accountFolder: string): string[] {
  const failed: string[] = [];
  const state = path.join(folder, ".agentlas-local");
  let names: string[] = [];
  try { if (fs.lstatSync(state).isSymbolicLink()) return failed; names = fs.readdirSync(state).filter(name => name.startsWith("absorbed-")); } catch (error) { const code = (error as NodeJS.ErrnoException | undefined)?.code; if (!(code === "ENOENT" || code === "ENOTDIR")) failed.push(state); return failed; }
  for (const name of names) {
    const target = path.join(state, name, "memory", accountFolder);
    if (!present(target)) continue;
    if (!removeOwned(target, folder)) failed.push(target);
    else { try { fs.rmdirSync(path.dirname(target)); } catch { /* 다른 계정의 폴더가 남아 있다 */ } }
  }
  return failed;
}

/**
 * 한 계정의 기억을 이 컴퓨터에서 지운다: 모든 에이전트 폴더 안의 이 계정 폴더(`.agentlas-local/memory/o-<해시>/`와 보존본 `absorbed-*` 안의 같은 폴더) 다음 그 계정의 뿌리 폴더(`owners/<해시>/`: 뿌리 DB·세션 파일·프로젝트 저장소·색인) 전체.
 * 엔진 `delete-account` 는 부르지 않는다 — 그것은 *엔진이 묶인 현재 계정*만 지우는데 여기서 지우는 것은 지금 쓰지 않는 계정이다. 같은 범위를 소유자 이름으로 직접 한다.
 * 에이전트 폴더가 링크(허용된 모양)여도 따라가서 본다. 에이전트 루트 밖에 등록된 폴더는 `extraFolders` 로 받는다. 남은 것이 있으면 `incomplete` + 코드 + 남은 경로 수(원문은 로그).
 * 지금 쓰고 있는 계정(`activeOwner`)이면 거절한다 — 그 뿌리 DB 는 열려 있다(먼저 로그아웃). 모든 연결을 먼저 닫고, 지운 뒤 경로를 다시 읽어 남은 것이 없을 때만 `deleted`.
 * 이 함수를 부르는 화면은 이 묶음에 없다(·계정 삭제 흐름이 부른다).
 */
export async function deleteAccountMemory(input: { memoryRoot: string; owner: string; activeOwner: string; agentsRoot: string; extraFolders?: readonly string[] }): Promise<AccountDeleteOutcome> {
  if (input.owner === input.activeOwner) return { state: "refused", left: [], reason: "owner_active" };
  const { accountDir, agentAccountFolder } = await import("./stores");
  const base = path.resolve(accountDir(input.memoryRoot, input.owner));
  if (path.basename(path.dirname(base)) !== "owners" || !base.startsWith(path.resolve(input.memoryRoot) + path.sep)) return { state: "refused", left: [], reason: "path_outside_root" };
  await retireRetainedAgentRoot(); // 보존된 이전 에이전트 루트에도 이 계정의 기억 폴더가 있다(Agentlas 2.0 #3)
  closeAllStores();
  try { (await import("./session-store")).closeSessionStore(); } catch { /* 열려 있지 않다 */ }
  const left: string[] = [];
  const remaining: string[] = [];
  const folders: string[] = [];
  try { for (const name of fs.readdirSync(input.agentsRoot)) folders.push(path.join(input.agentsRoot, name)); } catch { /* 에이전트 루트 없음 */ }
  // 예전 위치(`userData/agents`)에 아직 있는 에이전트 폴더: 에이전트 루트 밖이라 폴더 색인은 모르지만 거기에 저장소가 생긴 적이 있을 수 있다 — 보지 않고 "deleted"라고 하지 않는다.
  try {
    const legacy = path.resolve((await import("../agents/home")).legacyAgentsRoot());
    if (legacy !== path.resolve(input.agentsRoot)) for (const name of fs.readdirSync(legacy)) folders.push(path.join(legacy, name));
  } catch { /* 예전 루트 없음 */ }
  for (const extra of input.extraFolders ?? []) if (typeof extra === "string" && path.isAbsolute(extra)) folders.push(extra);
  const account = agentAccountFolder(input.owner);
  const seen = new Set<string>();
  for (const folder of folders) {
    if (seen.has(folder)) continue;
    seen.add(folder);
    const store = path.join(folder, ".agentlas-local", "memory", account);
    // 링크된 에이전트 폴더도 에이전트 폴더다(`stores.ts` 폴더 색인이 링크를 따라간다) — `statSync` 는 따라가고 `lstatSync` 는 건너뛰었다(#7).
    // 없는 것(ENOENT·ENOTDIR·끊긴 링크)은 건너뛰지만 권한 때문에 못 들여다본 폴더는 남은 것으로 센다 — 그 안에 저장소가 있는지 모른다(#8).
    try { if (!fs.statSync(folder).isDirectory()) continue; } catch (error) { const code = (error as NodeJS.ErrnoException | undefined)?.code; if (code !== "ENOENT" && code !== "ENOTDIR") remaining.push(folder); continue; }
    if (present(store)) {
      if (!removeOwned(store, folder)) remaining.push(store);
      else { try { fs.rmdirSync(path.dirname(store)); } catch { /* 다른 계정의 폴더가 남아 있다 */ } }
    }
    remaining.push(...purgeAbsorbedAccountMemory(folder, account));
  }
  if (remaining.length) left.push("agent_store");
  let ownerLeft = false;
  try { if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) { ownerLeft = true; } else if (!removeOwned(base, path.dirname(base))) ownerLeft = true; } catch { ownerLeft = true; }
  if (fs.existsSync(base)) ownerLeft = true;
  if (ownerLeft) { left.push("owner_folder"); remaining.push(base); }
  if (remaining.length) console.warn(`[account-delete] ${remaining.length} path(s) could not be removed:`, remaining.join(" | "));
  return { state: left.length ? "incomplete" : "deleted", left: [...new Set(left)], ...(remaining.length ? { leftCount: remaining.length } : {}) };
}
