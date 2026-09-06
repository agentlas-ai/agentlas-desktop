// window.agentlas 관문에 얹는 얇은 읽기 캐시 계층.
import { invalidateViewData, invalidateViewDataForStoreChange } from "./view-data-cache";
//
// 배경(2026-08-10 실측): 렌더러에는 데이터 캐시가 사실상 없어 모든 화면이 마운트마다
// 0에서 다시 페치했다. 대시보드 한 번 진입에 team.list() 4회 등 30+ IPC가 중복
// 발사되고, 화면을 오갈 때마다 방금 본 데이터가 스피너로 바뀐다(SWR 기준 위반).
// ipc()는 모든 데이터의 유일한 관문이므로, 157개 호출부를 건드리지 않고 여기서
// 해결한다.
//
// 동작 규칙 (보수적):
// - 화이트리스트에 있는 순수 읽기 메서드만 캐시한다. TTL 안에서는 캐시 값을 즉시
//   돌려주고(재방문 즉시 페인트), TTL이 지나면 실제 IPC를 다시 탄다.
// - 진행 중(in-flight) 동일 호출은 promise를 공유한다 — 같은 틱의 중복 발사 제거.
//   TTL이 0인 항목(휘발성)은 이 dedup만 적용한다.
// - 화이트리스트에 없는 메서드 호출(잠재적 쓰기)은 같은 네임스페이스의 캐시를
//   즉시 비운다. 교차 네임스페이스 변이는 기존 이벤트 버스(agent-roster,
//   hub-bookmarks, agentlas:projects/tasks-changed)가 비우고, 나머지는 TTL이
//   상한을 보장한다.
// - 캐시 값은 호출자마다 structuredClone으로 복사해 준다 — 호출부가 받은 배열을
//   제자리 정렬(.sort())해도 다른 화면이 오염되지 않는다(기존 계약과 동일).
// - 실패는 캐시하지 않는다. 호출부의 .catch 계약은 그대로다.

const READ_TTL_MS: Record<string, number> = {
  "team.list": 15_000,
  "firms.list": 15_000,
  "firms.getResolvedOrg": 15_000,
  "projects.list": 10_000,
  "projects.get": 10_000,
  "projects.timeline": 5_000,
  "tasks.list": 5_000,
  "runtime.detect": 300_000,
  "runtime.listModels": 300_000,
  "runtime.listRoleMembers": 300_000,
  "env.list": 15_000,
  "mcpTools.listInstalled": 15_000,
  "mcpTools.catalog": 60_000,
  "marketplace.bookmarks": 15_000,
  "marketplace.listMine": 60_000,
  // Hub 검색은 코드 주석 기준 10초+ 걸리는 네트워크 호출인데 /marketplace 진입마다
  // 빈 쿼리로 재실행됐다. 목록 변동은 분 단위이므로 60초면 재방문이 즉시 그려진다.
  "marketplace.search": 60_000,
  "marketplace.status": 30_000,
  "agents.exactBindings": 15_000,
  "agents.usageSummary": 15_000,
  "agents.borrowedProfiles": 15_000,
  "usage.snapshot": 10_000,
  "auth.getSession": 60_000,
  "billing.getCredits": 60_000,
  "app.getVersion": 3_600_000,
  "updater.getState": 30_000,
  "agentEvolution.listGrowth": 15_000,
  "quests.list": 30_000,
  "automations.list": 15_000,
  "appFactory.listApps": 15_000,
  // One 홈은 5초 폴링을 유지하되, 고차원 메모리 투영은 변경 전까지 재사용한다.
  // 같은 namespace의 실제 mutation은 아래 기본 경로에서 둘 다 무효화한다.
  "oneMemory.getState": 5_000,
  "oneMemory.getMap": 30_000,
  // 휘발성 — TTL 없이 in-flight dedup만 (0은 "겹침 제거만" 표식).
  "confirm.listPending": 0,
  "invoke.activeChats": 0,
};

const MAX_CACHE_ENTRIES = 200;

interface CacheEntry {
  at: number;
  value: unknown;
}

const valueCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
// An invalidated in-flight IPC call can still resolve after a newer call has
// started. Its result must not become the post-update cache snapshot.
let invalidationEpoch = 0;
const namespaceProxies = new WeakMap<object, unknown>();
// 브릿지/테스트 목이 교체되더라도 이전 객체에 바인딩된 함수를 재사용하지 않는다.
// 전역 spec 키만 쓰면 `team.list`처럼 이름이 같은 새 브릿지가 옛 target을 호출한다.
const methodWrappers = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>();

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function isForcedRead(args: unknown[]): boolean {
  return args.some((arg) => (
    arg !== null
    && typeof arg === "object"
    && (arg as { force?: unknown }).force === true
  ));
}

function evictIfOverfull(): void {
  if (valueCache.size <= MAX_CACHE_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, entry] of valueCache) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = key;
    }
  }
  if (oldestKey) valueCache.delete(oldestKey);
}

/** 네임스페이스(예: "team") 또는 전체(인자 없음) 캐시를 비운다. */
export function invalidateIpcCache(namespace?: string): void {
  invalidationEpoch += 1;
  if (!namespace) {
    valueCache.clear();
    inFlight.clear();
    return;
  }
  const prefix = `${namespace}.`;
  for (const key of valueCache.keys()) {
    if (key.startsWith(prefix)) valueCache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

function wrapMethod(
  namespace: string,
  method: string,
  target: object,
  fn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  const spec = `${namespace}.${method}`;
  let targetWrappers = methodWrappers.get(target);
  if (!targetWrappers) {
    targetWrappers = new Map();
    methodWrappers.set(target, targetWrappers);
  }
  const cachedWrapper = targetWrappers.get(spec);
  if (cachedWrapper) return cachedWrapper;
  const ttl = READ_TTL_MS[spec];
  const wrapper = (...args: unknown[]): unknown => {
    if (ttl === undefined) {
      // 잠재적 쓰기: 이 네임스페이스의 읽기 캐시를 비우고 그대로 통과.
      invalidateIpcCache(namespace);
      return fn.apply(target, args);
    }
    let key: string;
    try {
      key = `${spec}:${JSON.stringify(args)}`;
    } catch {
      return fn.apply(target, args);
    }
    // runtime.detect uses a boolean force flag at the IPC boundary.
    const forced = (spec === "runtime.detect" && args[0] === true) || isForcedRead(args);
    if (ttl > 0 && !forced) {
      const hit = valueCache.get(key);
      if (hit && Date.now() - hit.at < ttl) {
        return Promise.resolve(cloneValue(hit.value));
      }
    }
    const pending = inFlight.get(key);
    if (pending) return pending.then(cloneValue);
    if (spec === "runtime.detect" && forced) {
      // A reconnect refresh supersedes ordinary detection snapshots too.
      // Detach older reads so a late response cannot restore the old cache.
      for (const cachedKey of valueCache.keys()) {
        if (cachedKey.startsWith("runtime.detect:")) valueCache.delete(cachedKey);
      }
      for (const pendingKey of inFlight.keys()) {
        if (pendingKey.startsWith("runtime.detect:")) inFlight.delete(pendingKey);
      }
      invalidateViewData("dashboard.runtimes");
    }
    const requestEpoch = invalidationEpoch;
    let flight!: Promise<unknown>;
    flight = Promise.resolve(fn.apply(target, args)).then(
      (result) => {
        // Only the request currently registered for this key may clear or
        // write it. An older response may still be delivered to its caller,
        // but it cannot erase a newer request or restore stale data.
        if (inFlight.get(key) === flight) {
          inFlight.delete(key);
          if (ttl > 0 && !forced && requestEpoch === invalidationEpoch) {
            valueCache.set(key, { at: Date.now(), value: result });
            evictIfOverfull();
          }
        }
        return result;
      },
      (error) => {
        if (inFlight.get(key) === flight) inFlight.delete(key);
        throw error;
      },
    );
    inFlight.set(key, flight);
    return flight.then(cloneValue);
  };
  targetWrappers.set(spec, wrapper);
  return wrapper;
}

function wrapNamespace(name: string, ns: object): unknown {
  const existing = namespaceProxies.get(ns);
  if (existing) return existing;
  // contextBridge가 노출한 객체는 속성이 non-configurable/read-only다. 그 객체를
  // Proxy target으로 삼고 다른 함수/객체를 반환하면 JS Proxy invariant 위반으로
  // 패키지 앱이 즉시 죽는다. 빈 facade를 target으로 두고 원본은 클로저로 읽는다.
  const proxy = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      const value = Reflect.get(ns, prop, ns);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return wrapMethod(name, prop, ns, value as (...args: unknown[]) => unknown);
    },
  });
  namespaceProxies.set(ns, proxy);
  return proxy;
}

/** window.agentlas 전체를 읽기 캐시 프록시로 감싼다. 참조는 네임스페이스별로 안정. */
export function wrapIpcWithReadCache<T extends object>(raw: T): T {
  const existing = namespaceProxies.get(raw);
  if (existing) return existing as T;
  const proxy = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      const value = Reflect.get(raw, prop, raw);
      if (!value || typeof value !== "object" || typeof prop !== "string") return value;
      return wrapNamespace(prop, value as object);
    },
  });
  namespaceProxies.set(raw, proxy);
  return proxy as T;
}

// 메인의 store:changed 방송(entity/id뿐, 행 내용 없음)을 정확한 무효화 신호로 쓴다.
// 구 preload(브릿지 미탑재)에서는 조용히 건너뛰고 TTL이 상한을 보장한다.
const STORE_ENTITY_TO_NAMESPACES: Record<string, string[]> = {
  chat: ["chats", "tasks", "confirm", "invoke"],
  task: ["tasks"],
  agent: ["team", "agents"],
  firm: ["firms", "team"],
  project: ["projects", "tasks"],
  automation: ["automations"],
  runtime: ["runtime"],
};

export function connectIpcCacheToStoreEvents(
  subscribe: ((handler: (change: { entity: string; id?: string }) => void) => () => void) | undefined,
): () => void {
  if (!subscribe) return () => undefined;
  try {
    return subscribe((change) => {
      invalidateViewDataForStoreChange(change);
      const namespaces = STORE_ENTITY_TO_NAMESPACES[change.entity];
      if (!namespaces) return;
      for (const namespace of namespaces) invalidateIpcCache(namespace);
    });
  } catch {
    // 방송 미지원 환경(구 preload·목 브리지)에서는 TTL만으로 동작한다.
    return () => undefined;
  }
}

// 기존 이벤트 버스를 무효화 채널로 연결한다 — 캐시를 넣어도 무효화 문제를 새로
// 풀지 않는다(이미 검증된 인프라 재사용).
if (typeof window !== "undefined") {
  window.addEventListener("agentlas:agent-roster-changed", () => {
    invalidateIpcCache("team");
    invalidateIpcCache("agents");
    invalidateIpcCache("firms");
    invalidateViewData("dashboard.team");
    invalidateViewData("dashboard.firms");
  });
  window.addEventListener("agentlas:hub-bookmarks-changed", () => {
    invalidateIpcCache("marketplace");
  });
  window.addEventListener("agentlas:projects-changed", () => {
    invalidateIpcCache("projects");
    invalidateIpcCache("tasks");
    invalidateViewData("dashboard.projects");
    invalidateViewData("dashboard.tasks");
  });
  window.addEventListener("agentlas:tasks-changed", () => {
    invalidateIpcCache("tasks");
    invalidateViewData("dashboard.tasks");
  });
  window.addEventListener("agentlas:attention-refresh", () => {
    invalidateIpcCache("confirm");
    invalidateViewData("dashboard.confirm");
  });
}
