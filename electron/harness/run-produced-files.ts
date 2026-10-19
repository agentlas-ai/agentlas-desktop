import { randomUUID } from "node:crypto";
import path from "node:path";































export interface RunProducedFile {
  /** Host-made id: the binding's tool id derives from it, so one write is one stable output ref. */
  recordId: string;
  operationId: string;
  /** Absolute, resolved. */
  path: string;
  at: number;
}

const MAX_FILES_PER_RUN = 64;
const MAX_OPEN_RUNS = 512;
const RECORD_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PATH_CHARS = 4096;

const runs = new Map<string, { holders: number; files: RunProducedFile[] }>();

const fresh = (file: RunProducedFile, now: number): boolean => now - file.at <= RECORD_TTL_MS;

/** The invocation of `runId` will take this run's files; returns its release (idempotent). Nested opens are counted. */
export function openRunProducedFiles(runId: string | null | undefined): () => void {
  if (!runId) return () => {};
  let entry = runs.get(runId);
  if (!entry) {
    // A holder that never released (a run whose promise never settled) must not grow the map without end.
    while (runs.size >= MAX_OPEN_RUNS) runs.delete(runs.keys().next().value as string);
    entry = { holders: 0, files: [] };
    runs.set(runId, entry);
  }
  entry.holders += 1;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders <= 0 && runs.get(runId) === held) runs.delete(runId);
  };
}

/**
 * A port wrote these files for `runId`. Recorded only while an invocation of that run is open; a later write of the same
 * path replaces the pending one (the seal binds the bytes on disk when it is taken). Returns how many were recorded.
 */
export function recordRunProducedFiles(runId: string, operationId: string, paths: readonly unknown[]): number {
  const entry = runId ? runs.get(runId) : undefined;
  if (!entry) return 0;
  const now = Date.now();
  entry.files = entry.files.filter((file) => fresh(file, now));
  let recorded = 0;
  for (const candidate of paths) {
    if (typeof candidate !== "string" || !candidate || candidate.length > MAX_PATH_CHARS || !path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    entry.files = entry.files.filter((file) => file.path !== resolved);
    if (entry.files.length >= MAX_FILES_PER_RUN) entry.files.shift();
    entry.files.push({ recordId: randomUUID(), operationId: operationId.slice(0, 120), path: resolved, at: now });
    recorded += 1;
  }
  return recorded;
}

export function hasRunProducedFiles(runId: string | null | undefined): boolean {
  return Boolean(runId && runs.get(runId)?.files.length);
}

/** Hands this run's pending files to the caller (once). */
export function takeRunProducedFiles(runId: string | null | undefined): RunProducedFile[] {
  const entry = runId ? runs.get(runId) : undefined;
  if (!entry || entry.files.length === 0) return [];
  const now = Date.now();
  const taken = entry.files.filter((file) => fresh(file, now));
  entry.files = [];
  return taken;
}
