// File-level progress of a Build turn for the window's right pane (decision: the folder tree with per-file state — written,
// being written, not yet — and the file being written line by line).
//
// A signal, not a poll: the file system's own change notification (`fs.watch`, recursive) and the Build turn's own tool/stage events call
// `poke()`; each poke arms ONE debounced single-shot timer, and one single-shot "settle" timer runs only while a file is still being
// written. Nothing runs between turns: `stop()` closes the watcher and clears both timers. Where recursive watching is unavailable the
// turn's events alone drive it.
import fs from "node:fs";
import { listBuildTree, openBuildScope, readBuildFile } from "./build-scope";

import type { BuildFileSignalEvent } from "../../shared/build-workbench";
import { createWatchGuard } from "../fs-watch-guard";
export type { BuildFileSignalEvent };

export interface BuildFilesSignal {
  /** A turn event or a watcher notification: look at the folder soon. */
  poke(): void;
  /** Paths being written right now. */
  writing(): ReadonlySet<string>;
  /** Final look, every file settles, watcher and timers are gone. Idempotent. */
  stop(): void;
}

export interface BuildFilesSignalOptions {
  folder: string;
  emit: (event: BuildFileSignalEvent) => void;
  debounceMs?: number;
  settleMs?: number;
  /** For tests; defaults to fs.watch. May throw (platform without recursive watching): the signal then runs on pokes only. */
  watch?: (folder: string, listener: () => void) => { close(): void };
}

export function createBuildFilesSignal(options: BuildFilesSignalOptions): BuildFilesSignal {
  const debounceMs = options.debounceMs ?? 120, settleMs = options.settleMs ?? 900;
  const scope = openBuildScope(options.folder);
  const known = new Map<string, string>();
  const lastChange = new Map<string, number>();
  const writing = new Set<string>();
  let debounce: NodeJS.Timeout | null = null, settle: NodeJS.Timeout | null = null, stopped = false, watcher: { close(): void } | null = null;

  const lines = (rel: string): number => {
    if (!scope.ok) return 0;
    const read = readBuildFile(scope.scope, rel);
    return read.ok ? read.file.lineCount : 0;
  };
  const stamp = (e: { size: number; mtimeMs: number }): string => `${e.size}:${Math.trunc(e.mtimeMs)}`;
  let tooBroad = false;
  if (scope.ok) {
    const initial = listBuildTree(scope.scope);
    // A folder with more files than a package ever has (an owner-chosen big folder from before agents lived in their own folders) is not
    // watched recursively: the turn's own events still drive the signal, and the OS is not asked to watch a whole project tree.
    tooBroad = initial.truncated;
    for (const entry of initial.entries) if (entry.type === "file") known.set(entry.path, stamp(entry));
  }

  const armSettle = (): void => {
    if (settle || stopped || writing.size === 0) return;
    settle = setTimeout(() => {
      settle = null;
      const now = Date.now();
      for (const rel of [...writing]) {
        if (now - (lastChange.get(rel) ?? 0) < settleMs) continue;
        writing.delete(rel);
        options.emit({ kind: "file", path: rel, state: "written", size: Number((known.get(rel) ?? "0").split(":")[0]), lineCount: lines(rel) });
      }
      armSettle();
    }, settleMs);
    settle.unref?.();
  };

  const flush = (): void => {
    if (!scope.ok) return;
    const tree = listBuildTree(scope.scope);
    const seen = new Set<string>();
    const now = Date.now();
    for (const entry of tree.entries) {
      if (entry.type !== "file") continue;
      seen.add(entry.path);
      const next = stamp(entry);
      if (known.get(entry.path) === next) continue;
      known.set(entry.path, next);
      lastChange.set(entry.path, now);
      writing.add(entry.path);
      options.emit({ kind: "file", path: entry.path, state: "writing", size: entry.size, lineCount: lines(entry.path) });
    }
    // A listing cut at the file cap does not prove a file is gone (a new name can push it past the cap): removals are reported only for whole listings.
    for (const rel of tree.truncated ? [] : [...known.keys()]) {
      if (seen.has(rel)) continue;
      known.delete(rel); lastChange.delete(rel); writing.delete(rel);
      options.emit({ kind: "file", path: rel, state: "removed", size: 0, lineCount: 0 });
    }
    armSettle();
  };

  const poke = (): void => {
    if (stopped || debounce) return;
    debounce = setTimeout(() => { debounce = null; flush(); }, debounceMs);
    debounce.unref?.();
  };

  if (scope.ok && !tooBroad) {
    try {
      watcher = options.watch
        ? options.watch(scope.scope.root, poke)
        : (() => {
          const guard = createWatchGuard({ root: scope.scope.root, close: () => { try { watcher?.close(); } catch { /* already closed */ } watcher = null; } });
          const w = fs.watch(scope.scope.root, { recursive: true }, () => { if (!guard.event()) poke(); });
          w.on("error", () => { /* the turn's events still poke */ });
          return w;
        })();
    } catch { watcher = null; }
  }

  return {
    poke,
    writing: () => writing,
    stop() {
      if (stopped) return;
      stopped = true;
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (settle) { clearTimeout(settle); settle = null; }
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
      stopped = false; flush(); stopped = true;
      for (const rel of [...writing]) options.emit({ kind: "file", path: rel, state: "written", size: Number((known.get(rel) ?? "0").split(":")[0]), lineCount: lines(rel) });
      writing.clear();
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (settle) { clearTimeout(settle); settle = null; }
      options.emit({ kind: "end", files: known.size });
    },
  };
}
