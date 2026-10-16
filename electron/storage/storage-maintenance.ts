import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { clearRuntimeSession } from "../store/runtime-sessions";
import { userDataPath } from "../runtime-paths";
import { retireIdleCliTranscripts } from "./cli-transcript-retention";
import { sweepAgentIntermediates } from "./intermediate-sweep";
import { retireRunDetailSlice, type RunDetailWatermark } from "./run-detail-retention";
import { DAY_MS, STORAGE_POLICY } from "./storage-policy";

/**
 * Runs the storage budget (storage-policy.ts) shortly after start and then
 * every STORAGE_POLICY.sweepIntervalMinutes.
 * - One process at a time holds the pass; a lock file in userData names the holder.
 * - The pass is asynchronous and yields between run-detail slices, so the Desktop
 *   main thread stays responsive.
 * - When the disk is low, the pass shortens the transcript window and notifies
 *   at most once a day, naming what Agentlas uses and what it just freed.
 */

export interface DiskSpace { freeBytes: number; totalBytes: number }

export function diskSpace(dir: string): DiskSpace | null {
  try {
    const stat = fs.statfsSync(dir);
    return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

export function isLowDisk(space: DiskSpace | null): boolean {
  if (!space || space.totalBytes <= 0) return false;
  return space.freeBytes < STORAGE_POLICY.lowDisk.freeBytes
    || space.freeBytes / space.totalBytes < STORAGE_POLICY.lowDisk.freeRatio;
}

export interface StorageMaintenanceReport {
  lowDisk: boolean;
  freeBytes: number | null;
  freedBytes: number;
  intermediates: { files: number; bytes: number };
  transcripts: { sessions: number; orphans: number; bytes: number };
  runDetail: { runs: number; deleted: number; compacted: number; complete: boolean };
}

const LOCK_FILE = "storage-maintenance.lock";
const NOTICE_KEY = "storage.lowDiskNotice.v1";
const WATERMARK_KEY = "storage.runDetail.watermark.v1";
const RUN_DETAIL_SLICES_PER_PASS = 40;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function readWatermark(): RunDetailWatermark | null {
  try {
    const parsed = JSON.parse(getMeta(WATERMARK_KEY) ?? "null") as RunDetailWatermark | null;
    return parsed && typeof parsed.ts === "string" && Number.isFinite(parsed.id) ? parsed : null;
  } catch { return null; }
}

function takeLock(): (() => void) | null {
  const file = userDataPath(LOCK_FILE);
  try {
    const holder = Number(fs.readFileSync(file, "utf8").trim());
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid) {
      try { process.kill(holder, 0); return null; } catch { /* stale lock */ }
    }
  } catch { /* no lock */ }
  try { fs.writeFileSync(file, String(process.pid), { mode: 0o600 }); } catch { return null; }
  return () => { try { if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
}

export async function runStorageMaintenance(now = Date.now()): Promise<StorageMaintenanceReport | null> {
  const release = takeLock();
  if (!release) return null;
  try {
    const space = diskSpace(userDataPath());
    const lowDisk = isLowDisk(space);
    const sweep = await sweepAgentIntermediates(userDataPath("agent-cwd"), {
      idleMs: STORAGE_POLICY.intermediateIdleMinutes * 60_000,
      now,
    });
    const db = getDb();
    const transcripts = await retireIdleCliTranscripts({
      db,
      userDataRoot: userDataPath(),
      idleDays: lowDisk ? STORAGE_POLICY.lowDisk.cliTranscriptIdleDays : STORAGE_POLICY.cliTranscriptIdleDays,
      now,
      clearSession: (chatId, kind, agentId) => clearRuntimeSession(chatId, kind, agentId, { isolateOwner: true }),
    });
    const runDetail = { runs: 0, deleted: 0, compacted: 0, complete: false };
    let watermark = readWatermark();
    for (let slice = 0; slice < RUN_DETAIL_SLICES_PER_PASS; slice += 1) {
      await yieldToLoop();
      const step = retireRunDetailSlice(db, { days: STORAGE_POLICY.runDetailDays, now, watermark });
      runDetail.runs += step.runs;
      runDetail.deleted += step.deleted;
      runDetail.compacted += step.compacted;
      watermark = step.watermark;
      setMeta(WATERMARK_KEY, JSON.stringify(watermark));
      if (step.done) { runDetail.complete = true; break; }
    }
    return {
      lowDisk,
      freeBytes: space?.freeBytes ?? null,
      freedBytes: sweep.removedBytes + transcripts.bytes,
      intermediates: { files: sweep.removedFiles, bytes: sweep.removedBytes },
      transcripts: { sessions: transcripts.sessions, orphans: transcripts.orphans, bytes: transcripts.bytes },
      runDetail,
    };
  } finally {
    release();
  }
}

/** Bytes Agentlas itself keeps on disk: its userData folder and ~/.agentlas. */
export async function agentlasFootprintBytes(): Promise<number> {
  let total = 0;
  const stack = [userDataPath(), path.join(os.homedir(), ".agentlas")];
  while (stack.length) {
    const current = stack.pop()!;
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(current); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) { total += stat.size; continue; }
    try { for (const name of await fs.promises.readdir(current)) stack.push(path.join(current, name)); } catch { /* unreadable */ }
  }
  return total;
}

export function startStorageMaintenance(options: {
  notifyLowDisk: (input: { freeBytes: number; footprintBytes: number; freedBytes: number }) => void;
  firstDelayMs?: number;
}): () => void {
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    let report: StorageMaintenanceReport | null = null;
    try { report = await runStorageMaintenance(); } catch (error) {
      console.warn("[storage] maintenance pass failed:", error instanceof Error ? error.message : String(error));
      return;
    } finally {
      running = false;
    }
    if (!report) return;
    if (report.freedBytes > 0 || report.runDetail.runs > 0) {
      console.info(`[storage] freed ${report.freedBytes} bytes; intermediates ${report.intermediates.files} files; `
        + `transcripts ${report.transcripts.sessions}+${report.transcripts.orphans}; run detail ${report.runDetail.runs} runs`);
    }
    if (!report.lowDisk || report.freeBytes === null) return;
    const last = Number(getMeta(NOTICE_KEY) ?? 0);
    if (Date.now() - last < DAY_MS) return;
    setMeta(NOTICE_KEY, String(Date.now()));
    options.notifyLowDisk({ freeBytes: report.freeBytes, footprintBytes: await agentlasFootprintBytes(), freedBytes: report.freedBytes });
  };
  const first = setTimeout(() => { void pass(); }, options.firstDelayMs ?? 120_000);
  const every = setInterval(() => { void pass(); }, STORAGE_POLICY.sweepIntervalMinutes * 60_000);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
