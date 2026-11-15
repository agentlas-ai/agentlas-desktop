// 합쳐 읽기 — 뿌리 + 이 계정의 모든 저장소 (설계 A §10: One 지도·인스펙터).
//
// ★언제 읽나: 사용자가 지도·인스펙터를 열거나 폰이 지도 스냅샷을 요청할 때뿐이다(타이머·파일 감시 없음). 쉬는 앱은 이 파일의 어떤 함수도 부르지 않는다.
// ★얼마나 읽나: 프로젝트·에이전트 저장소 전부(24개 상한 없음). 단 **바뀐 저장소만 다시 읽는다** — 저장소마다 (파일 크기, mtime, ctime) + 뿌리 잊기 시계가 같으면 지난 결과를 그대로 쓴다.
//   바뀌지 않은 저장소는 열지도 않는다(stat 한 번). 캐시는 결과 행 수 합계 20,000 상한(가장 오래 쓰지 않은 항목부터 버린다)이고 프로세스 안에만 있다. 새 표·파일 없음.
// ★잊기: 저장소를 *열 때* 따라잡기가 걸러낸다(`stores.ts openStore`). 따라잡기를 못 끝낸 저장소(잠김)는 그 호출에서 건너뛰고 코드로 알린다 — 잊은 글이 지도에 뜨지 않는다.
// ★스위치가 `central` 이면 부르는 쪽이 이 파일을 부르지 않는다(결과는 지금과 같다).
import fs from "node:fs";
import type Database from "better-sqlite3";
import { findAgentHome, listExistingStores, openStore, rootClock, storeAgentId, type ExistingStore, type StoreRef } from "./stores";

export const CACHE_MAX_ROWS = 20_000;
/** 시험이 숫자로 단언한다: 스냅샷 수, 실제로 연 저장소 수, 캐시로 건너뛴 수, 계산(질의) 수. */
export const storeSetStats = { snapshots: 0, opens: 0, cacheHits: 0, computes: 0 };

export interface SetContext { memoryRoot: string; owner: string; rootDb: Database.Database }
export interface SetFilter {
  /** `undefined` = 모든 에이전트(프로젝트 저장소 전부 + 에이전트 저장소 전부), `null` = 에이전트 저장소 없음, 문자열 = 그 에이전트의 저장소만(프로젝트 저장소는 항상). */
  agentId?: string | null;
}

const sig = (item: ExistingStore): string => `${item.size}:${item.mtimeMs}:${item.ctimeMs ?? 0}`;

/** 이 필터로 읽을 저장소 파일들(stat 만 한다). */
export function setStores(context: SetContext, filter: SetFilter = {}): ExistingStore[] {
  const all = listExistingStores(context.memoryRoot, context.owner);
  if (filter.agentId === undefined) return all;
  const wanted = filter.agentId === null ? null : storeAgentId(filter.agentId);
  const home = wanted ? findAgentHome(wanted, false) : null;
  return all.filter(item => item.ref.kind !== "agent" || (wanted !== null && item.ref.key !== null && home !== null && item.ref.path.startsWith(home)));
}

/** 저장소들의 변경 지문(stat 만). 같으면 지난 스냅샷이 아직 맞다. */
export function setFingerprint(stores: readonly ExistingStore[], clock: number | null): string {
  return `${clock ?? "x"}|` + stores.map(item => `${item.ref.path}\0${sig(item)}`).join("\n");
}

interface Entry { sig: string; clock: number; value: unknown; weight: number }
const cache = new Map<string, Entry>();
let cachedWeight = 0;
function drop(key: string): void { const old = cache.get(key); if (old) { cachedWeight -= old.weight; cache.delete(key); } }
export function closeSetCache(): void { cache.clear(); cachedWeight = 0; }
export function setCacheStats(): { entries: number; rows: number } { return { entries: cache.size, rows: cachedWeight }; }

export interface SetResult<R> { ref: StoreRef; value: R }
export interface SetRead<R> { results: Array<SetResult<R>>; skips: Array<{ kind: StoreRef["kind"]; code: string }> }

/**
 * 저장소마다 `compute(db)` 를 한 번씩(바뀐 저장소만) 돌려 결과를 모은다. `key` 가 질의의 이름이고 `weight` 는 결과가 캐시에서 차지하는 행 수다.
 * 열지 못한 저장소는 건너뛰고 코드로 알린다(파일이 없는 `store_absent` 는 정상). 던지지 않는다.
 */
export function readSet<R>(context: SetContext, stores: readonly ExistingStore[], key: string, compute: (db: Database.Database, ref: StoreRef) => R, weight: (value: R) => number): SetRead<R> {
  storeSetStats.snapshots += 1;
  const clock = rootClock(context.rootDb) ?? -1;
  const results: Array<SetResult<R>> = [];
  const skips: SetRead<R>["skips"] = [];
  for (const item of stores) {
    const cacheKey = `${item.ref.path}\0${key}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.sig === sig(item) && hit.clock === clock) {
      cache.delete(cacheKey); cache.set(cacheKey, hit); // 최근 쪽으로
      storeSetStats.cacheHits += 1;
      results.push({ ref: item.ref, value: hit.value as R });
      continue;
    }
    drop(cacheKey);
    storeSetStats.opens += 1;
    try {
      const { store, code } = openStore(item.ref, context.owner, context.rootDb, context.memoryRoot);
      if (!store) { if (code && code !== "store_absent") skips.push({ kind: item.ref.kind, code }); continue; }
      if (store.withheld.size) { skips.push({ kind: item.ref.kind, code: "forget_catchup_withheld" }); continue; }
      storeSetStats.computes += 1;
      const value = compute(store.db, item.ref);
      const rows = Math.max(1, weight(value));
      // 따라잡기가 이 열기에서 파일을 고쳤다면 그 뒤의 지문으로 적는다.
      let after = item;
      try { const stat = fs.lstatSync(item.ref.path); after = { ...item, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; } catch { /* 지문이 낡았다면 다음에 다시 읽는다 */ }
      if (rows <= CACHE_MAX_ROWS) {
        cache.set(cacheKey, { sig: sig(after), clock, value, weight: rows }); cachedWeight += rows;
        while (cachedWeight > CACHE_MAX_ROWS && cache.size > 1) drop(cache.keys().next().value as string);
      }
      results.push({ ref: item.ref, value });
    } catch { skips.push({ kind: item.ref.kind, code: "store_unreadable" }); }
  }
  return { results, skips };
}
