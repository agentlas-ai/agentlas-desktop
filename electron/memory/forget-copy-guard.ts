// 하위 저장소에 줄을 "복사해 넣는" 모든 코드가 지킬 규칙 한 개 (#10 + #1·B1).
//
// 문제: 저장소는 "잊기를 몇 번까지 적용했나"(`memory_store_meta.forget_epoch_applied`)를 갖는다. 따라잡기(`stores.ts catchUp`)는 그 번호보다 새 도장만 본다.
//   번호가 이미 높은 저장소에 — 그 번호 *뒤*가 아니라 *앞*에 잊은 문장이 든 — 줄을 복사해 넣으면 그 문장은 영영 안 지워진다.
// 규칙(이 함수 한 개): 복사한 같은 트랜잭션 안에서 번호를 `min(이쪽 번호, 들어온 줄이 따라잡은 번호)` 로 내린다. 들어온 줄이 어디까지 따라잡았는지 모르면
//   (`null`) 0 이다 — 다음에 이 저장소를 여는 모든 읽기·쓰기가 장부를 처음부터 다시 대조한다(없는 것은 아무것도 안 지우므로 비용은 한 번의 대조뿐).
//   번호를 올리는 일은 하지 않는다(올리는 것은 따라잡기뿐이다).
// 부르는 곳: 폴더 합치기 `agents/home-move.ts mergeMemoryStoreResult`(원본 저장소의 번호를 안다). 앞으로 줄을 옮기는 코드(분류·이사)도 같은 함수를 부른다.
//   복사가 끝나고 *커밋하기 전에*, 같은 연결로. 이 파일은 Electron·`stores.ts` 를 가져오지 않는다.
import type Database from "better-sqlite3";

export const FORGET_EPOCH_KEY = "forget_epoch_applied";

function parse(value: unknown): number {
  const n = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `schema` 쪽 저장소(`main` 또는 붙인 이름)의 잊기 번호를 복사 직후 규칙대로 내린다. 내렸으면 새 번호, 그대로면 null.
 * `sourceEpoch`: 줄을 가져온 저장소가 따라잡은 번호, 모르면 null(= 0).
 */
export function lowerForgetEpochAfterCopy(db: Database.Database, schema: string, sourceEpoch: number | null): number | null {
  const has = db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name='memory_store_meta'`).get();
  if (!has) return null;
  const row = db.prepare(`SELECT value FROM ${schema}.memory_store_meta WHERE key=?`).get(FORGET_EPOCH_KEY) as { value: unknown } | undefined;
  const mine = parse(row?.value);
  const theirs = sourceEpoch === null ? 0 : Math.max(0, Math.trunc(sourceEpoch));
  if (theirs >= mine) return null;
  db.prepare(`INSERT INTO ${schema}.memory_store_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(FORGET_EPOCH_KEY, String(theirs));
  return theirs;
}

/** 원본 저장소(붙인 이름 `schema`)가 적어 둔 잊기 번호. 표·키가 없으면 null(= 모른다). */
export function forgetEpochOf(db: Database.Database, schema: string): number | null {
  try {
    const has = db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name='memory_store_meta'`).get();
    if (!has) return null;
    const row = db.prepare(`SELECT value FROM ${schema}.memory_store_meta WHERE key=?`).get(FORGET_EPOCH_KEY) as { value: unknown } | undefined;
    return row ? parse(row.value) : null;
  } catch { return null; }
}
