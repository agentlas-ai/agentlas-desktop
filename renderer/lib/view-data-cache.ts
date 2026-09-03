// Small process-local stale-while-revalidate cache for data shared by route
// surfaces. Next route navigation remounts React trees but not the renderer
// process, so keeping verified IPC snapshots here avoids blank-first paints and
// deduplicates identical reads mounted by adjacent dashboard panels.

type CacheEntry<T> = {
  value?: T;
  updatedAt: number;
  pending?: Promise<T>;
};

const entries = new Map<string, CacheEntry<unknown>>();
// Invalidating a pending read removes it from the map, but its promise still
// settles later. Keep an epoch so an old response cannot repopulate the cache
// after a runtime/store change has already requested fresh data.
let invalidationEpoch = 0;

export function readViewData<T>(key: string): { value: T; updatedAt: number } | null {
  const entry = entries.get(key) as CacheEntry<T> | undefined;
  return entry?.value === undefined ? null : { value: entry.value, updatedAt: entry.updatedAt };
}

export function writeViewData<T>(key: string, value: T): T {
  entries.set(key, { value, updatedAt: Date.now() });
  return value;
}

export async function loadViewData<T>(
  key: string,
  loader: () => Promise<T>,
  options: { maxAgeMs: number; force?: boolean },
): Promise<T> {
  const now = Date.now();
  const current = entries.get(key) as CacheEntry<T> | undefined;
  if (!options.force && current?.value !== undefined && now - current.updatedAt < options.maxAgeMs) {
    return current.value;
  }
  if (current?.pending) return current.pending;

  const requestEpoch = invalidationEpoch;
  let pending!: Promise<T>;
  pending = loader().then(
    (value) => {
      const latest = entries.get(key) as CacheEntry<T> | undefined;
      // Return the value to the original caller, but never let a stale
      // response overwrite the newer cache generation.
      if (requestEpoch !== invalidationEpoch || latest?.pending !== pending) return value;
      return writeViewData(key, value);
    },
    (error) => {
      const latest = entries.get(key) as CacheEntry<T> | undefined;
      // Do not delete a replacement request that started after this one.
      if (latest?.pending === pending) {
        if (latest.value !== undefined) entries.set(key, { value: latest.value, updatedAt: latest.updatedAt });
        else entries.delete(key);
      }
      throw error;
    },
  );
  entries.set(key, {
    ...(current?.value !== undefined ? { value: current.value } : {}),
    updatedAt: current?.updatedAt ?? 0,
    pending,
  });
  return pending;
}

export function invalidateViewData(prefix: string): void {
  invalidationEpoch += 1;
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}

const STORE_ENTITY_TO_VIEW_PREFIXES: Record<string, string[]> = {
  chat: ["dashboard.tasks", "dashboard.confirm", "dashboard.active-chats"],
  task: ["dashboard.tasks"],
  agent: ["dashboard.team"],
  firm: ["dashboard.firms", "dashboard.team"],
  project: ["dashboard.projects", "dashboard.tasks"],
  runtime: ["dashboard.runtimes", "dashboard.runtime-role-pool"],
};

/** Main의 store:changed 영수증을 화면 스냅샷 캐시에도 동일하게 적용한다. */
export function invalidateViewDataForStoreChange(change: { entity: string; id?: string }): void {
  const prefixes = STORE_ENTITY_TO_VIEW_PREFIXES[change.entity];
  if (!prefixes) return;
  for (const prefix of prefixes) invalidateViewData(prefix);
}
