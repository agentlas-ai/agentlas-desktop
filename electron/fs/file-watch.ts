import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsFileWatchSnapshot, FsReadScope } from "../../shared/types";
import { FsAccessDeniedError, resolveFsReadPath } from "./access";

interface WatchRecord {
  ownerId: number;
  absPath: string;
  scope: FsReadScope;
  watcher: fs.FSWatcher;
  revision: number;
  timer: ReturnType<typeof setTimeout> | null;
  sink: (snapshot: FsFileWatchSnapshot) => void;
}

const watches = new Map<string, WatchRecord>();

function isMissingPathError(error: unknown): boolean {
  return error instanceof FsAccessDeniedError && error.message === "The requested path does not exist.";
}

function unavailableSnapshot(absPath: string): FsFileWatchSnapshot {
  return {
    watchId: "",
    path: typeof absPath === "string" && path.isAbsolute(absPath) ? path.resolve(absPath) : "",
    exists: false,
    size: null,
    mtimeMs: null,
    revision: 0,
    error: "unavailable",
  };
}

function snapshot(watchId: string, record: WatchRecord): FsFileWatchSnapshot {
  try {
    const approved = resolveFsReadPath(record.absPath, record.scope);
    const stat = fs.statSync(approved);
    if (!stat.isFile()) throw new Error("not-file");
    return {
      watchId,
      path: record.absPath,
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      revision: record.revision,
      error: null,
    };
  } catch {
    return {
      watchId,
      path: record.absPath,
      exists: false,
      size: null,
      mtimeMs: null,
      revision: record.revision,
      error: "unavailable",
    };
  }
}

export function watchFsPreviewFile(
  ownerId: number,
  absPath: string,
  scope: FsReadScope,
  sink: (snapshot: FsFileWatchSnapshot) => void,
): FsFileWatchSnapshot {
  let approved: string;
  try {
    approved = resolveFsReadPath(absPath, scope);
  } catch (error) {
    // A transcript can outlive its generated file. That is a recoverable preview state,
    // not an IPC failure worth surfacing as an Electron handler error. Other access errors
    // still throw and keep the read boundary fail-closed.
    if (isMissingPathError(error)) return unavailableSnapshot(absPath);
    throw error;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(approved);
  } catch {
    return unavailableSnapshot(approved);
  }
  if (!stat.isFile()) return unavailableSnapshot(approved);
  const watchId = randomUUID();
  let record!: WatchRecord;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(path.dirname(approved), { persistent: false }, (_event, filename) => {
      if (filename && path.basename(String(filename)) !== path.basename(approved)) return;
      if (record.timer) clearTimeout(record.timer);
      record.timer = setTimeout(() => {
        record.timer = null;
        record.revision += 1;
        record.sink(snapshot(watchId, record));
      }, 140);
    });
  } catch {
    // The file may disappear between stat and fs.watch. Treat that small race like any
    // other stale preview rather than rejecting the renderer's IPC invocation.
    return unavailableSnapshot(approved);
  }
  record = { ownerId, absPath: approved, scope, watcher, revision: 0, timer: null, sink };
  watcher.on("error", () => {
    record.revision += 1;
    sink(snapshot(watchId, record));
  });
  watches.set(watchId, record);
  return snapshot(watchId, record);
}

export function unwatchFsPreviewFile(ownerId: number, watchId: string): { ok: boolean } {
  const record = watches.get(watchId);
  if (!record || record.ownerId !== ownerId) return { ok: false };
  watches.delete(watchId);
  if (record.timer) clearTimeout(record.timer);
  record.watcher.close();
  return { ok: true };
}

export function unwatchFsPreviewFilesForOwner(ownerId: number): void {
  for (const [watchId, record] of watches) {
    if (record.ownerId !== ownerId) continue;
    watches.delete(watchId);
    if (record.timer) clearTimeout(record.timer);
    record.watcher.close();
  }
}
