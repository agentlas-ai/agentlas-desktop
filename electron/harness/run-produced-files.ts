import { randomUUID } from "node:crypto";
import path from "node:path";

/*
 * Files a harness port wrote for a run, waiting for that run's invocation to seal them as One outputs.
 *
 * A/B 2026-10-18 (Haiku and GPT, deployment session): document.create / document.save and media.image.generate /
 * media.image.edit answered with the file's path, yet One Outputs stayed empty and both models ended with "no file is
 * linked to Outputs". The rail binds only paths a runtime adapter structures (onTool artifactPaths ->
 * mcp/client.ts bindInvocationOneArtifacts -> one/artifact-preview.ts bindOneRuntimeToolArtifacts), and a harness result
 * reaches every adapter as MCP text (only cua captures are read from such text).
 *
 * The port that wrote a file, or hands over one it finished earlier (speech.synthesize after a "running" answer or reused,
 * provider.request's binary answer, a succeeded media job read through media.job.status), names it (PortOutcome.produced;
 * capability-ports.ts callHarnessPort records it under the run of the capability it was called with). The run's
 * invocation takes the list at its next successful tool completion and seals each file through the same
 * bindOneRuntimeToolArtifacts boundary (canonical folders, O_NOFOLLOW, Task/run/version); a file the chat already holds
 * byte for byte binds nothing new. Nothing here comes from model text or tool arguments, and a path here grants nothing.
 *
 * A file that finishes after the run's last invocation ended (a narration or a video job in the background) is not
 * written into that run: there is no live event channel for it any more, and its receipt and verified result set are
 * settled. The next run of the same chat that asks for it (the same speech.synthesize call, media.job.status) takes it.
 *
 * In-process on purpose. A run's harness_call is answered by the turn-tools control server of the process that minted the
 * run's agentlas-turn capability (turn-tools/control-server.ts keeps capabilities in process memory), and that is the
 * process whose mcp/client.ts invocation built the run's MCP config: desktop Main for its runs, the daemon for
 * daemon-owned runs. Task-force and firm workers share the parent run's capability run id (mcp/client.ts worker configs).
 * Only a run with an open invocation (runMcpInvocation) accepts files, so UI, mobile and graph-step callers with no
 * consumer record nothing. Bounded per run, aged out, and cleared when the run's last invocation ends.
 *
 * No electron import (the daemon loads the harness).
 */

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

/** Read-only host diagnostics: the producing port and consumer must share the invocation owner. */
export function runProducedFilesConsumerIsOpen(runId: string | null | undefined): boolean {
  return Boolean(runId && runs.get(runId)?.holders);
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
