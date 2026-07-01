// 파일/폴더 감시(설계 §3.4 Tier 0 #1) — Node fs.watch(macOS FSEvents 백킹)로 경로당 watcher
// 1개만 유지한다. 유휴 CPU 0%(커널 푸시), watcher당 수십 KB. 같은 경로를 여러 자동화가
// 구독하면 watcher를 공유한다(설계 §3.3 "이벤트 소스는 리스너 1개씩만" — 자동화당 X).
//
// 절대 하지 않는 것: 자동화당 watcher-프로세스 스폰(설계 §3.1 "절대 금지"). 하나의 공유
// 매니저가 경로→구독자 맵을 들고, fs.watch 콜백을 debounce해 구독자에게 팬아웃한다.
import { watch, type FSWatcher, existsSync } from "node:fs";

export type FsChangeKind = "create" | "modify" | "delete";

export interface FsSubscription {
  /** 이 구독의 소유 자동화 id(팬아웃 라우팅 + 해제 키). */
  automationId: string;
  /** 관심 있는 변경 종류(생성/수정/삭제). */
  on: FsChangeKind;
  /** debounce 창(ms). 저장 폭주(에디터 임시파일 연쇄)를 1회로 합친다. */
  debounceMs: number;
  /** 조건 통과 시 실행할 콜백. changedPath는 변경된 파일명(있으면). */
  fire: (info: { path: string; changedPath: string | null; kind: FsChangeKind }) => void;
}

interface PathEntry {
  watcher: FSWatcher;
  subs: FsSubscription[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 최근 debounce 창에서 관측한 rename(=create/delete) 여부. */
  sawRename: boolean;
  /** 최근 debounce 창에서 관측한 change(=modify) 여부. rename과 독립적으로 추적해
   *  한 창에서 rename+modify가 겹쳐도 modify 구독자를 놓치지 않는다. */
  sawChange: boolean;
  lastChangedPath: string | null;
}

const entries = new Map<string, PathEntry>();

/**
 * 경로를 감시하도록 구독 등록. 같은 경로면 watcher를 공유한다. 경로가 없으면(존재X)
 * 조용히 무시(자동화는 살아있되 발사 안 함 — 폴더가 나중에 생기면 재등록 필요).
 * @returns 구독 해제 함수.
 */
export function watchPath(path: string, sub: FsSubscription): () => void {
  if (!path || !existsSync(path)) {
    return () => {};
  }
  let entry = entries.get(path);
  if (!entry) {
    let watcher: FSWatcher;
    try {
      // recursive는 macOS/Windows에서 지원(FSEvents). 폴더면 하위까지, 파일이면 그 파일만.
      watcher = watch(path, { recursive: true, persistent: false });
    } catch {
      try {
        watcher = watch(path, { persistent: false });
      } catch {
        return () => {};
      }
    }
    const created: PathEntry = {
      watcher,
      subs: [],
      debounceTimer: null,
      sawRename: false,
      sawChange: false,
      lastChangedPath: null,
    };
    watcher.on("change", (eventType, filename) => {
      created.lastChangedPath = typeof filename === "string" ? filename : filename ? filename.toString() : null;
      if (eventType === "rename") created.sawRename = true;
      else created.sawChange = true;
      if (created.debounceTimer) clearTimeout(created.debounceTimer);
      const wait = Math.max(...created.subs.map((s) => s.debounceMs), 50);
      created.debounceTimer = setTimeout(() => flush(path), wait);
      if (created.debounceTimer.unref) created.debounceTimer.unref();
    });
    watcher.on("error", () => {
      // watcher가 죽으면 엔트리 제거(경로 삭제 등). 구독자는 남지만 재발사 안 함.
      closePath(path);
    });
    entries.set(path, created);
    entry = created;
  }
  entry.subs.push(sub);
  return () => {
    const e = entries.get(path);
    if (!e) return;
    e.subs = e.subs.filter((s) => s !== sub);
    if (e.subs.length === 0) closePath(path);
  };
}

function flush(path: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  const sawRename = entry.sawRename;
  const sawChange = entry.sawChange;
  const changedPath = entry.lastChangedPath;
  entry.sawRename = false;
  entry.sawChange = false;
  entry.debounceTimer = null;
  // fs.watch는 create/modify/delete를 정밀 구분하지 못한다(rename=create|delete, change=modify).
  // rename과 change를 독립 추적하므로 한 창에서 둘이 겹쳐도 각 구독자를 올바로 발사한다.
  for (const sub of entry.subs) {
    const matches =
      sub.on === "modify" ? sawChange : sawRename; // create/delete 둘 다 rename으로 관측됨
    if (matches) {
      try {
        sub.fire({ path, changedPath, kind: sub.on });
      } catch {
        /* 개별 구독자 오류가 다른 구독자를 막지 않게 */
      }
    }
  }
}

function closePath(path: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  try {
    entry.watcher.close();
  } catch {
    /* ignore */
  }
  entries.delete(path);
}

/** 특정 자동화의 모든 fs 구독 해제(트리거 매니저 재동기화용). */
export function unwatchAutomation(automationId: string): void {
  for (const [path, entry] of entries) {
    entry.subs = entry.subs.filter((s) => s.automationId !== automationId);
    if (entry.subs.length === 0) closePath(path);
  }
}

/** 모든 watcher 정리(앱 종료/테스트). */
export function closeAllWatchers(): void {
  for (const path of Array.from(entries.keys())) closePath(path);
}
