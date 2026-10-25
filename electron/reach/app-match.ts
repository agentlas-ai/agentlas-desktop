import type { ActuatorApp } from "./actuator";

// Which running app is the app of a map record. The map names an app by the key its platform provider wrote: `bundle:<id>` on macOS, `desktop:<id>`
// for a Linux .desktop file, `appx:<package family>` / `aumid:<app user model id>` / `uninstall:<id>` on Windows. The driver names a running app by
// what the OS reports: a bundle id on macOS, a desktop id on Linux (when the toolkit gives one), and on Windows only the executable's name. The
// background service and the reach.* ports both need to go from the one to the other; they used to do it for `bundle:` keys only, so on Linux
// and Windows nothing was ever explored or called (independent review 2026-10-24, D1).
//
// Two apps whose names differ only by a symbol are two apps (Notepad and Notepad++): the name keeps its symbols, an exact name beats a partial one,
// and when two candidates are equally good nothing is matched at all - a wrong app costs a call to the wrong window and a record under the wrong name
// (review 2, N3).

export interface KnownApp { key: string; name: string; path?: string }
export type LiveApp = Pick<ActuatorApp, "name" | "pid" | "running"> & { bundleId?: string };

// separators go, symbols stay: "notepad++" is not "notepad"
const squash = (value: string): string => value.toLowerCase().replace(/\.(exe|app|desktop)$/i, "").replace(/[\s._\-]+/g, "");

export function bundleIdOfKey(key: string): string | null {
  return key.startsWith("bundle:") ? key.slice("bundle:".length).split("@")[0] : null;
}

// 3 = the id the OS gives (exact), 2 = the same name, 1 = a partial match on Windows, 0 = not this app
export function matchRank(app: KnownApp, live: LiveApp): 0 | 1 | 2 | 3 {
  if (!live.running || live.pid <= 0) return 0;
  // macOS: the bundle id, exactly. Nothing looser, so an app is never taken for another one by its name.
  const bundle = bundleIdOfKey(app.key);
  if (bundle) return live.bundleId === bundle ? 3 : 0;
  const liveName = squash(live.name);
  if (liveName.length < 2) return 0;
  // Linux: the desktop id the driver reports for the window's app
  if (app.key.startsWith("desktop:") && live.bundleId && squash(live.bundleId) === squash(app.key.slice("desktop:".length))) return 3;
  const own = squash(app.name);
  if (own === liveName) return 2;
  // Windows: the driver gives the executable ("notepad.exe"); the package family or app id carries it ("Microsoft.WindowsNotepad_8wekyb3d8bbwe").
  // Only a plain executable name (letters and digits) is looked for inside another name; one with a symbol must match exactly.
  if (liveName.length >= 4 && !live.bundleId && /^[\p{L}\p{N}]+$/u.test(liveName)) {
    const body = squash(app.key.slice(app.key.indexOf(":") + 1));
    if (body.includes(liveName)) return 1;
    if (own.length >= 4 && /^[\p{L}\p{N}]+$/u.test(own) && (own.includes(liveName) || liveName.includes(own))) return 1;
  }
  return 0;
}

export function isLiveApp(app: KnownApp, live: LiveApp): boolean {
  return matchRank(app, live) > 0;
}

// The running processes that are this app: the best-ranked ones, all of them when they are one program (several processes of the same program, an exact id);
// none when two different programs fit equally well (below an exact id).
export function findLiveCandidates<T extends LiveApp>(app: KnownApp, running: readonly T[]): T[] {
  let best = 0;
  let found: T[] = [];
  for (const live of running) {
    const rank = matchRank(app, live);
    if (rank === 0 || rank < best) continue;
    if (rank > best) { best = rank; found = []; }
    found.push(live);
  }
  if (found.length === 0) return [];
  const same = found.every((live) => squash(live.name) === squash(found[0].name) && (live.bundleId ?? "") === (found[0].bundleId ?? ""));
  return best === 3 || found.length === 1 || same ? found : [];
}

// The best match among the running apps; undefined when there is none or when two are equally good (below an exact id).
export function findLiveApp<T extends LiveApp>(app: KnownApp, running: readonly T[]): T | undefined {
  return findLiveCandidates(app, running)[0];
}

// Of several processes of one program (an Electron app has a helper with no window), the first that has the window the caller is after (review 3, R2).
export async function firstWithWindow<T extends LiveApp, W>(candidates: readonly T[], windowOf: (live: T) => Promise<W | null>): Promise<{ live: T; window: W } | null> {
  for (const live of candidates) {
    const window = await windowOf(live);
    if (window) return { live, window };
  }
  return null;
}

// The map record of a running app; undefined when the map does not know it or two records fit it equally well (below an exact id).
export function findRecordOf<T extends KnownApp>(live: LiveApp, records: readonly T[]): T | undefined {
  let best = 0;
  let found: T[] = [];
  for (const record of records) {
    const rank = matchRank(record, live);
    if (rank === 0 || rank < best) continue;
    if (rank > best) { best = rank; found = []; }
    found.push(record);
  }
  if (found.length === 0) return undefined;
  return best === 3 || found.length === 1 ? found[0] : undefined;
}
