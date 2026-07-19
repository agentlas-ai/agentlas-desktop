import { getDb } from "./db";
import { ONE_SURFACE_SNAPSHOT_EVENT_KIND, recordRunEvent } from "./run-events";
import { findCanonicalTaskForChat } from "./tasks";
import {
  isDurableOneSurfaceManifestV1,
  parseDurableOneSurfaceJson,
  type DurableOneSurfaceResult,
} from "../../shared/one-surface-durable";
import type { OneSurfaceManifestV1 } from "../../shared/one-surface";

interface SnapshotRow {
  run_id: string;
  chat_id: string | null;
  ts: string;
  payload_json: string;
}

function validBinding(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Store the exact Main-produced semantic manifest beside its append-only run
 * receipt. The Task/chat binding is checked before any bytes reach SQLite.
 */
export function recordDurableOneSurfaceResult(input: {
  runId: string;
  chatId: string;
  manifest: OneSurfaceManifestV1;
}): DurableOneSurfaceResult {
  if (!validBinding(input.runId) || !validBinding(input.chatId)) {
    throw new TypeError("OneSurface run and chat bindings are required");
  }
  const task = findCanonicalTaskForChat(input.chatId);
  if (!task || input.manifest.taskId !== task.id) {
    throw new Error("OneSurface Task/chat binding does not match canonical authority");
  }
  if (!isDurableOneSurfaceManifestV1(input.manifest, task.id)) {
    throw new Error("OneSurface manifest failed the durable safe contract");
  }
  const oneSurfaceJson = JSON.stringify(input.manifest);
  const event = recordRunEvent({
    runId: input.runId,
    kind: ONE_SURFACE_SNAPSHOT_EVENT_KIND,
    chatId: input.chatId,
    payload: {
      taskId: task.id,
      manifestId: input.manifest.manifestId,
      oneSurfaceJson,
    },
  });
  return {
    runId: input.runId,
    chatId: input.chatId,
    taskId: task.id,
    recordedAt: event.ts,
    manifest: input.manifest,
  };
}

/** Run execution must survive a projection ledger failure. */
export function tryRecordDurableOneSurfaceResult(input: {
  runId: string;
  chatId: string;
  manifest: OneSurfaceManifestV1;
}): boolean {
  try {
    recordDurableOneSurfaceResult(input);
    return true;
  } catch {
    // Live Work still owns the raw result; One simply has no durable projection.
    return false;
  }
}

/**
 * Restore only the surface for the exact Task + chat + run receipt. This keeps
 * an older structured card from being attached to a newer plain-text run.
 */
export function getDurableOneSurfaceResult(input: {
  runId: string;
  chatId: string;
  taskId: string;
}): DurableOneSurfaceResult | null {
  if (!validBinding(input.runId) || !validBinding(input.chatId) || !validBinding(input.taskId)) return null;
  const task = findCanonicalTaskForChat(input.chatId);
  if (!task || task.id !== input.taskId) return null;
  const rows = getDb()
    .prepare(
      `SELECT run_id, chat_id, ts, payload_json
       FROM run_events
       WHERE run_id = ? AND chat_id = ? AND kind = ?
       ORDER BY seq DESC
       LIMIT 20`,
    )
    .all(input.runId, input.chatId, ONE_SURFACE_SNAPSHOT_EVENT_KIND) as SnapshotRow[];

  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    if (!payload || payload.taskId !== input.taskId || typeof payload.oneSurfaceJson !== "string") continue;
    const manifest = parseDurableOneSurfaceJson(payload.oneSurfaceJson, input.taskId);
    if (!manifest) continue;
    return {
      runId: row.run_id,
      chatId: row.chat_id ?? input.chatId,
      taskId: input.taskId,
      recordedAt: row.ts,
      manifest,
    };
  }
  return null;
}
