import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsFileWatchSnapshot, FsReadScope } from "../../shared/types";
import { resolveFsReadPath } from "./access";

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
  const approved = resolveFsReadPath(absPath, scope);
  const stat = fs.statSync(approved);
  if (!stat.isFile()) throw new Error("Only files can be watched.");
  const watchId = randomUUID();
  let record!: WatchRecord;
  const watcher = fs.watch(path.dirname(approved), { persistent: false }, (_event, filename) => {
    if (filename && path.basename(String(filename)) !== path.basename(approved)) return;
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = null;
      record.revision += 1;
      record.sink(snapshot(watchId, record));
    }, 140);
  });
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
