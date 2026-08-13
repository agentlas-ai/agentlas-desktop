// 파일/폴더 감시(설계 §3.4 Tier 0 #1) — Node fs.watch(macOS FSEvents 백킹)로 경로당 watcher
// 1개만 유지한다. 유휴 CPU 0%(커널 푸시), watcher당 수십 KB. 같은 경로를 여러 자동화가
// 구독하면 watcher를 공유한다(설계 §3.3 "이벤트 소스는 리스너 1개씩만" — 자동화당 X).
//
// 절대 하지 않는 것: 자동화당 watcher-프로세스 스폰(설계 §3.1 "절대 금지"). 하나의 공유
// 매니저가 경로→구독자 맵을 들고, fs.watch 콜백을 debounce해 구독자에게 팬아웃한다.
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

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
  watcher: FSWatcher | null;
  subs: FsSubscription[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  rootIsDirectory: boolean;
  /** watcher 연결 시점의 실제 경로 집합. debounce 끝에서 비교해 rename을 생성/삭제로 나눈다. */
  knownPaths: Set<string>;
  renamedPaths: Set<string>;
  changedPaths: Set<string>;
}

const entries = new Map<string, PathEntry>();
const RECONNECT_DELAY_MS = 1_000;
// 프로젝트 루트가 node_modules 같은 거대한 트리를 포함해도 Main thread를 무한 순회하지 않는다.
// cap 밖 경로의 삭제는 rename 후 부재 상태로 여전히 판별되고, 이후 관측부터 knownPaths에 들어간다.
const MAX_INITIAL_SNAPSHOT_PATHS = 20_000;

/**
 * 경로를 감시하도록 구독 등록. 같은 경로면 watcher를 공유한다. 경로가 아직 없거나
 * 감시 중 삭제되어도 구독 자체는 유지하고, 경로가 돌아오면 watcher를 다시 연결한다.
 * @returns 구독 해제 함수.
 */
export function watchPath(path: string, sub: FsSubscription): () => void {
  if (!path) return () => {};
  let entry = entries.get(path);
  if (!entry) {
    const created: PathEntry = {
      watcher: null,
      subs: [],
      debounceTimer: null,
      reconnectTimer: null,
      rootIsDirectory: false,
      knownPaths: new Set(),
      renamedPaths: new Set(),
      changedPaths: new Set(),
    };
    entries.set(path, created);
    entry = created;
  }
  entry.subs.push(sub);
  ensureWatcher(path, entry);
  return () => {
    const e = entries.get(path);
    if (!e) return;
    e.subs = e.subs.filter((s) => s !== sub);
    if (e.subs.length === 0) closePath(path);
  };
}

function ensureWatcher(watchedPath: string, entry: PathEntry): void {
  if (entry.watcher || entry.reconnectTimer || entry.subs.length === 0) return;
  if (!existsSync(watchedPath)) {
    scheduleReconnect(watchedPath, entry);
    return;
  }
  try {
    entry.rootIsDirectory = statSync(watchedPath).isDirectory();
    entry.knownPaths = snapshotPaths(watchedPath, entry.rootIsDirectory);
  } catch {
    scheduleReconnect(watchedPath, entry);
    return;
  }

  let watcher: FSWatcher;
  try {
    // recursive는 macOS/Windows에서 지원(FSEvents). 폴더면 하위까지, 파일이면 그 파일만.
    watcher = watch(watchedPath, { recursive: true, persistent: false });
  } catch {
    try {
      watcher = watch(watchedPath, { persistent: false });
    } catch {
      scheduleReconnect(watchedPath, entry);
      return;
    }
  }
  entry.watcher = watcher;
  watcher.on("change", (eventType, filename) => {
    const changedPath = typeof filename === "string" ? filename : filename ? filename.toString() : null;
    const key = changedPath && entry.rootIsDirectory ? changedPath : "";
    if (eventType === "rename") entry.renamedPaths.add(key);
    else entry.changedPaths.add(key);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    const wait = Math.max(...entry.subs.map((s) => s.debounceMs), 50);
    entry.debounceTimer = setTimeout(() => flush(watchedPath), wait);
    entry.debounceTimer.unref?.();
  });
  watcher.on("error", () => disconnectAndRetry(watchedPath, entry));
}

function snapshotPaths(watchedPath: string, rootIsDirectory: boolean): Set<string> {
  const out = new Set<string>([""]);
  if (!rootIsDirectory) return out;
  const pending = [""];
  while (pending.length > 0 && out.size < MAX_INITIAL_SNAPSHOT_PATHS) {
    const relative = pending.pop()!;
    const absolute = relative ? path.join(watchedPath, relative) : watchedPath;
    let children: Array<import("node:fs").Dirent<string>>;
    try {
      children = readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (out.size >= MAX_INITIAL_SNAPSHOT_PATHS) break;
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      out.add(childRelative);
      if (child.isDirectory() && !child.isSymbolicLink()) pending.push(childRelative);
    }
  }
  return out;
}

function scheduleReconnect(watchedPath: string, entry: PathEntry): void {
  if (entry.reconnectTimer || entry.subs.length === 0) return;
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (entries.get(watchedPath) === entry) ensureWatcher(watchedPath, entry);
  }, RECONNECT_DELAY_MS);
  entry.reconnectTimer.unref?.();
}

function disconnectAndRetry(watchedPath: string, entry: PathEntry): void {
  if (entry.watcher) {
    try {
      entry.watcher.close();
    } catch {
      /* ignore */
    }
    entry.watcher = null;
  }
  scheduleReconnect(watchedPath, entry);
}

function flush(watchedPath: string): void {
  const entry = entries.get(watchedPath);
  if (!entry) return;
  const createPaths = new Set<string>();
  const deletePaths = new Set<string>();
  const modifyPaths = new Set<string>();
  const transitions = new Map<string, "create" | "delete" | "stable">();
  for (const key of entry.renamedPaths) {
    const absolute = key && entry.rootIsDirectory ? path.join(watchedPath, key) : watchedPath;
    const wasPresent = entry.knownPaths.has(key);
    const isPresent = existsSync(absolute);
    const transition = !isPresent ? "delete" : wasPresent ? "stable" : "create";
    transitions.set(key, transition);
    if (transition === "create") {
      createPaths.add(key);
      entry.knownPaths.add(key);
    } else if (transition === "delete") {
      deletePaths.add(key);
      entry.knownPaths.delete(key);
    } else if (transition === "stable") {
      // Atomic-save rename over an existing file is a modification, not create.
      modifyPaths.add(key);
    }
  }
  for (const key of entry.changedPaths) {
    const transition = transitions.get(key);
    if (!transition || transition === "stable") modifyPaths.add(key);
  }
  entry.renamedPaths.clear();
  entry.changedPaths.clear();
  entry.debounceTimer = null;
  // fs.watch의 rename은 create/delete 공용 신호다. watcher 연결 시점의 snapshot과
  // debounce 종료 상태를 비교하므로 macOS의 중복 rename도 반대 이벤트로 오인하지 않는다.
  for (const sub of entry.subs) {
    const matchedPaths = sub.on === "modify"
      ? modifyPaths
      : sub.on === "create"
        ? createPaths
        : deletePaths;
    for (const relative of matchedPaths) {
      try {
        sub.fire({ path: watchedPath, changedPath: relative || null, kind: sub.on });
      } catch {
        /* 개별 구독자 오류가 다른 구독자를 막지 않게 */
      }
    }
  }
  // macOS에서는 루트 폴더 삭제가 error 없이 rename 한 번으로 끝날 수 있다. 그 경우에도
  // 죽은 watcher를 붙잡지 않고 경로 재생성을 기다린다.
  if (!existsSync(watchedPath)) disconnectAndRetry(watchedPath, entry);
}

function closePath(path: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.watcher) {
    try {
      entry.watcher.close();
    } catch {
      /* ignore */
    }
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
