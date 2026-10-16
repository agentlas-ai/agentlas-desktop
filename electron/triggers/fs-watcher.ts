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
  /**
   * 조건 통과 시 실행할 콜백 — debounce 창 하나에 구독당 한 번. changedPaths 는 그 창에서 바뀐
   * 경로(최대 200개, 나머지는 overflowCount), changedPath 는 그 첫 경로(기존 onlyIf 조건 호환).
   */
  fire: (info: {
    path: string;
    changedPath: string | null;
    changedPaths: string[];
    overflowCount: number;
    kind: FsChangeKind;
  }) => void;
  /** 감시를 거듭 실패해 이 구독을 멈췄을 때(fs_watch_unavailable). 다음 syncTriggers 가 다시 건다. */
  onUnavailable?: (info: { path: string; reason: "fs_watch_unavailable" }) => void;
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
  /** 이번 debounce 창의 첫 변경 시각. 변경이 끊이지 않아도 maxWait 안에는 한 번 낸다. */
  windowStartedAt: number | null;
  /** 연속 감시 실패 횟수와 마지막 연결 시각. 실패만 물러나고, 경로가 없는 대기는 세지 않는다. */
  failures: number;
  connectedAt: number | null;
  parked: boolean;
}

const entries = new Map<string, PathEntry>();
const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;
const PARK_AFTER_FAILURES = 10;
/** 이만큼 버틴 연결이 끊기면 처음부터 다시 센다. */
const HEALTHY_CONNECTION_MS = 60_000;
const MAX_WAIT_DEBOUNCE_FACTOR = 5;
const MAX_CHANGED_PATHS_PER_FIRE = 200;
const MAX_CHANGED_PATH_BYTES_PER_FIRE = 64 * 1024;
// 프로젝트 루트가 node_modules 같은 거대한 트리를 포함해도 Main thread를 무한 순회하지 않는다.
// cap 밖 경로의 삭제는 rename 후 부재 상태로 여전히 판별되고, 이후 관측부터 knownPaths에 들어간다.
const MAX_INITIAL_SNAPSHOT_PATHS = 20_000;

/**
 * 경로를 감시하도록 구독 등록. 같은 경로면 watcher를 공유한다. 경로가 아직 없거나
 * 감시 중 삭제되어도 구독 자체는 유지하고, 경로가 돌아오면 watcher를 다시 연결한다.
 * @returns 구독 해제 함수.
 */
export function watchPath(requestedPath: string, sub: FsSubscription): () => void {
  if (!requestedPath) return () => {};
  // `/a/dir` 와 `/a/dir/` 가 watcher 둘을 만들지 않게 정규화한 경로를 키로 쓴다.
  const key = path.resolve(requestedPath);
  let entry = entries.get(key);
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
      windowStartedAt: null,
      failures: 0,
      connectedAt: null,
      parked: false,
    };
    entries.set(key, created);
    entry = created;
  }
  entry.subs.push(sub);
  ensureWatcher(key, entry);
  return () => {
    const e = entries.get(key);
    if (!e) return;
    e.subs = e.subs.filter((s) => s !== sub);
    if (e.subs.length === 0) closePath(key);
  };
}

/**
 * 기본으로 듣지 않는 변경: 버전 관리·의존성 폴더 내부, 편집기 임시·스왑 파일, 내려받는 중인 파일.
 * `git checkout`·`npm install` 한 번이 수백 번의 실행이 되지 않게 한다.
 */
function isIgnoredFsChange(relative: string): boolean {
  if (!relative) return false;
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === ".git" || segment === "node_modules")) return true;
  const name = segments[segments.length - 1] ?? "";
  return name === ".DS_Store"
    || name.startsWith(".#")
    || name.endsWith("~")
    || /\.(?:swp|tmp|crdownload)$/i.test(name);
}

function ensureWatcher(watchedPath: string, entry: PathEntry): void {
  if (entry.watcher || entry.reconnectTimer || entry.parked || entry.subs.length === 0) return;
  if (!existsSync(watchedPath)) {
    // 아직 없는 경로를 기다리는 것은 실패가 아니다 — 같은 1초 간격으로 다시 본다.
    scheduleReconnect(watchedPath, entry, RECONNECT_DELAY_MS);
    return;
  }
  try {
    entry.rootIsDirectory = statSync(watchedPath).isDirectory();
    entry.knownPaths = snapshotPaths(watchedPath, entry.rootIsDirectory);
  } catch {
    recordWatchFailure(watchedPath, entry);
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
      recordWatchFailure(watchedPath, entry);
      return;
    }
  }
  entry.watcher = watcher;
  entry.connectedAt = Date.now();
  watcher.on("change", (eventType, filename) => {
    const changedPath = typeof filename === "string" ? filename : filename ? filename.toString() : null;
    const key = changedPath && entry.rootIsDirectory ? changedPath : "";
    if (isIgnoredFsChange(key)) return;
    if (eventType === "rename") entry.renamedPaths.add(key);
    else entry.changedPaths.add(key);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    // 뒤따르는 debounce 에 상한을 둔다. 100ms 마다 덧붙는 로그도 maxWait 안에는 한 번 낸다.
    const now = Date.now();
    entry.windowStartedAt ??= now;
    const wait = Math.max(...entry.subs.map((s) => s.debounceMs), 50);
    const untilMaxWait = entry.windowStartedAt + wait * MAX_WAIT_DEBOUNCE_FACTOR - now;
    entry.debounceTimer = setTimeout(() => flush(watchedPath), Math.max(0, Math.min(wait, untilMaxWait)));
    entry.debounceTimer.unref?.();
  });
  watcher.on("error", () => {
    closeWatcher(entry);
    recordWatchFailure(watchedPath, entry);
  });
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
      if (isIgnoredFsChange(childRelative)) continue;
      out.add(childRelative);
      if (child.isDirectory() && !child.isSymbolicLink()) pending.push(childRelative);
    }
  }
  return out;
}

function scheduleReconnect(watchedPath: string, entry: PathEntry, delayMs: number): void {
  if (entry.reconnectTimer || entry.parked || entry.subs.length === 0) return;
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (entries.get(watchedPath) === entry) ensureWatcher(watchedPath, entry);
  }, delayMs);
  entry.reconnectTimer.unref?.();
}

function closeWatcher(entry: PathEntry): void {
  if (!entry.watcher) return;
  try {
    entry.watcher.close();
  } catch {
    /* ignore */
  }
  entry.watcher = null;
}

/**
 * 감시 실패(error 이벤트, watch/stat 실패). 1초에서 두 배씩 5분까지 물러나며, 매 재시도가
 * Main 에서 폴더를 다시 훑으므로 끝없이 돌지 않는다 — 연속 10번이면 구독을 멈추고 알린다.
 */
function recordWatchFailure(watchedPath: string, entry: PathEntry): void {
  if (entry.connectedAt !== null && Date.now() - entry.connectedAt >= HEALTHY_CONNECTION_MS) entry.failures = 0;
  entry.connectedAt = null;
  entry.failures += 1;
  if (entry.failures >= PARK_AFTER_FAILURES) {
    entry.parked = true;
    closeWatcher(entry);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    for (const sub of entry.subs) {
      try {
        sub.onUnavailable?.({ path: watchedPath, reason: "fs_watch_unavailable" });
      } catch {
        /* 개별 구독자 오류가 다른 구독자를 막지 않게 */
      }
    }
    return;
  }
  scheduleReconnect(
    watchedPath,
    entry,
    Math.min(RECONNECT_DELAY_MS * 2 ** (entry.failures - 1), RECONNECT_MAX_DELAY_MS),
  );
}

/** 감시 중이던 경로 자체가 사라졌다 — 실패가 아니라 경로가 돌아오기를 기다리는 상태다. */
function disconnectAndAwaitPath(watchedPath: string, entry: PathEntry): void {
  closeWatcher(entry);
  scheduleReconnect(watchedPath, entry, RECONNECT_DELAY_MS);
}

function boundedChangedPaths(keys: Set<string>): { paths: string[]; overflowCount: number } {
  const paths: string[] = [];
  let bytes = 0;
  let overflowCount = 0;
  for (const key of keys) {
    if (!key) continue;
    const size = Buffer.byteLength(key, "utf8");
    if (paths.length >= MAX_CHANGED_PATHS_PER_FIRE || bytes + size > MAX_CHANGED_PATH_BYTES_PER_FIRE) {
      overflowCount += 1;
      continue;
    }
    paths.push(key);
    bytes += size;
  }
  return { paths, overflowCount };
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
  entry.windowStartedAt = null;
  // 폴더 자신("")의 신호는 그 안의 파일 변경을 가리키는 중복이다. 자식이 있으면 뺀다.
  for (const set of [createPaths, deletePaths, modifyPaths]) {
    if (set.size > 1) set.delete("");
  }
  // fs.watch의 rename은 create/delete 공용 신호다. watcher 연결 시점의 snapshot과
  // debounce 종료 상태를 비교하므로 macOS의 중복 rename도 반대 이벤트로 오인하지 않는다.
  // 창 하나에 구독당 한 번만 낸다 — 파일 500개 복사가 실행 500번이 되지 않게.
  for (const sub of entry.subs) {
    const matchedPaths = sub.on === "modify"
      ? modifyPaths
      : sub.on === "create"
        ? createPaths
        : deletePaths;
    if (matchedPaths.size === 0) continue;
    const batch = boundedChangedPaths(matchedPaths);
    try {
      sub.fire({
        path: watchedPath,
        changedPath: batch.paths[0] ?? null,
        changedPaths: batch.paths,
        overflowCount: batch.overflowCount,
        kind: sub.on,
      });
    } catch {
      /* 개별 구독자 오류가 다른 구독자를 막지 않게 */
    }
  }
  // macOS에서는 루트 폴더 삭제가 error 없이 rename 한 번으로 끝날 수 있다. 그 경우에도
  // 죽은 watcher를 붙잡지 않고 경로 재생성을 기다린다.
  if (!existsSync(watchedPath)) disconnectAndAwaitPath(watchedPath, entry);
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
