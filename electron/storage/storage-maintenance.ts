import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../store/db";
import { pruneJudgmentVerdicts } from "../store/judgment-verdict-retention";
import { getMeta, setMeta } from "../store/meta";
import { retireManagedMigrationBackups, type MigrationBackupRetention } from "../store/migration-backup-retention";
import { clearRuntimeSession } from "../store/runtime-sessions";
import { compactDeliveredTriggerEvents } from "../store/trigger-events";
import { userDataPath } from "../runtime-paths";
import { retireIdleCliTranscripts } from "./cli-transcript-retention";
import { retireCloudAgentPackages } from "./cloud-package-retention";
import { retireNestedProductHomeMirrors } from "./product-home-retention";
import { sweepAgentIntermediates } from "./intermediate-sweep";
import { retireRunDetailSlice, type RunDetailWatermark } from "./run-detail-retention";
import { DAY_MS, STORAGE_POLICY } from "./storage-policy";
import { observationCaptureDir } from "../media/capture-artifacts";

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
  runDetail: { runs: number; deleted: number; compacted: number; complete: boolean; watermarkTs: string | null };
  triggerEvents: { compacted: number; complete: boolean };
  judgmentVerdicts: { deleted: number; complete: boolean };
  telegramAttachments: { folders: number; bytes: number };
  cloudPackages: { dirs: number; bytes: number };
  /** Product-home mirrors of another mirror, idle for the CLI-original window (product-home-retention.ts). */
  nestedProductHomes: { dirs: number; bytes: number };
  /** Managed DB-upgrade copies above the cap of three (store/migration-backup-retention.ts). */
  migrationBackups: MigrationBackupRetention;
  /** App-call image observations past the settled-run detail window (pruneObservationCaptures). */
  observationCaptures: { files: number; bytes: number };
}

const LOCK_FILE = "storage-maintenance.lock";
const NOTICE_KEY = "storage.lowDiskNotice.v1";
const WATERMARK_KEY = "storage.runDetail.watermark.v1";
const RUN_DETAIL_SLICES_PER_PASS = 40;
const TRIGGER_EVENT_BATCH = 500;
const TRIGGER_EVENT_BATCHES_PER_PASS = 20;
const JUDGMENT_VERDICT_BATCH = 500;
const JUDGMENT_VERDICT_BATCHES_PER_PASS = 20;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs one write with a 200 ms wait for another process's write lock:
 * better-sqlite3 waits synchronously, and the main thread must not stall behind
 * a long daemon write. Returns null when the database stayed busy.
 */
function withShortBusyWait<T>(db: ReturnType<typeof getDb>, write: () => T): T | null {
  const previousBusyTimeout = Number(db.pragma("busy_timeout", { simple: true }) ?? 0);
  db.pragma("busy_timeout = 200");
  try {
    return write();
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") return null;
    throw error;
  } finally {
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(previousBusyTimeout))}`);
  }
}

/**
 * Telegram attachment copies: telegram/connect.ts writes each message's files to
 * agent-cwd/.agentlas/chat-attachments/telegram/<binding8>-<messageId>-<ms>/.
 * Owner decision OD-4 (2026-10-16): they are intermediates, because Telegram
 * keeps the original. A folder goes `keepDays` after its run is over and after
 * anything in it was last written. The run is over long before
 * TELEGRAM_RUN_CEILING_MS: connect.ts caps a run at 15 minutes after a 5-minute
 * preflight.
 *
 * Never touched: desktop chat images (chat-attachments/<chat-slug>/ here or in a
 * project are conversation content), folders whose name is not that layout,
 * folders marked `.agentlas-keep`, symlinks, and the whole tree when any of
 * .agentlas, chat-attachments or telegram is a symlink.
 */
const TELEGRAM_COPY_DIR = /^[A-Za-z0-9_]{1,8}-\d+-(\d{12,14})$/;
const TELEGRAM_RUN_CEILING_MS = DAY_MS;

export async function pruneTelegramAttachmentCopies(
  workspaceRoot: string,
  options: { keepDays: number; now?: number },
): Promise<{ folders: number; bytes: number }> {
  const result = { folders: 0, bytes: 0 };
  const now = options.now ?? Date.now();
  let root: string;
  try {
    const workspace = await fs.promises.realpath(workspaceRoot);
    const expected = path.join(workspace, ".agentlas", "chat-attachments", "telegram");
    root = await fs.promises.realpath(expected);
    if (root !== expected) return result;
  } catch { return result; }
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const createdMs = Number(TELEGRAM_COPY_DIR.exec(entry.name)?.[1] ?? Number.NaN);
    if (!Number.isFinite(createdMs)) continue;
    const folder = path.join(root, entry.name);
    let newestMs = createdMs + TELEGRAM_RUN_CEILING_MS;
    let bytes = 0;
    let keep = false;
    const stack = [folder];
    while (stack.length && !keep) {
      const current = stack.pop()!;
      let stat: fs.Stats;
      try { stat = await fs.promises.lstat(current); } catch { continue; }
      newestMs = Math.max(newestMs, stat.mtimeMs);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) { bytes += stat.size; continue; }
      let names: string[] = [];
      try { names = await fs.promises.readdir(current); } catch { keep = true; continue; }
      if (names.includes(".agentlas-keep")) keep = true;
      for (const name of names) stack.push(path.join(current, name));
    }
    if (keep || now - newestMs < options.keepDays * DAY_MS) continue;
    try { await fs.promises.rm(folder, { recursive: true, force: true }); } catch { continue; }
    result.folders += 1;
    result.bytes += bytes;
  }
  return result;
}

/**
 * Images an app operation answered (app-control/service.ts saveResultImages) are saved to captures/observations so a model
 * can see them whole. They are what a model looked at, like a tool call's detail, never a run output or a chat image, so
 * they go after the same window (owner decision 2026-10-16: settled-run tool detail after 3 days). Only regular files named
 * observation-*.png|jpg directly in that folder are removed; a symlinked folder or anything else is left alone.
 */
const OBSERVATION_CAPTURE = /^observation-[0-9TZ-]+-[0-9a-f]{8}\.(?:png|jpg)$/;

export async function pruneObservationCaptures(
  folder: string,
  options: { keepDays: number; now?: number },
): Promise<{ files: number; bytes: number }> {
  const result = { files: 0, bytes: 0 };
  const now = options.now ?? Date.now();
  // lstat: a symlinked observations folder is not ours to empty.
  try { if (!(await fs.promises.lstat(folder)).isDirectory()) return result; } catch { return result; }
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isFile() || !OBSERVATION_CAPTURE.test(entry.name)) continue;
    const file = path.join(folder, entry.name);
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(file); } catch { continue; }
    if (!stat.isFile() || now - stat.mtimeMs < options.keepDays * DAY_MS) continue;
    try { await fs.promises.unlink(file); } catch { continue; }
    result.files += 1;
    result.bytes += stat.size;
  }
  return result;
}

function readWatermark(): RunDetailWatermark | null {
  try {
    // run_events.id is TEXT. A number check rejected every stored watermark,
    // so each pass restarted at the oldest marker and stopped at the same place
    // (owner Mac 2026-10-17: "run detail 1034 runs" every pass, 0 rows removed).
    const parsed = JSON.parse(getMeta(WATERMARK_KEY) ?? "null") as RunDetailWatermark | null;
    return parsed && typeof parsed.ts === "string" && typeof parsed.id === "string" ? parsed : null;
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
      unverifiedIdleMs: STORAGE_POLICY.intermediateUnverifiedIdleHours * 3_600_000,
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
    const runDetail = { runs: 0, deleted: 0, compacted: 0, complete: false, watermarkTs: null as string | null };
    let watermark = readWatermark();
    for (let slice = 0; slice < RUN_DETAIL_SLICES_PER_PASS; slice += 1) {
      await yieldToLoop();
      // A busy database ends this pass; the next pass resumes from the watermark.
      const step = withShortBusyWait(db, () => retireRunDetailSlice(db, { days: STORAGE_POLICY.runDetailDays, now, watermark }));
      if (!step) break;
      runDetail.runs += step.runs;
      runDetail.deleted += step.deleted;
      runDetail.compacted += step.compacted;
      watermark = step.watermark;
      runDetail.watermarkTs = watermark.ts || null;
      setMeta(WATERMARK_KEY, JSON.stringify(watermark));
      if (step.done) { runDetail.complete = true; break; }
    }
    const triggerEvents = { compacted: 0, complete: false };
    const deliveredCutoff = new Date(now - STORAGE_POLICY.triggerEventDeliveredDays * DAY_MS).toISOString();
    for (let batch = 0; batch < TRIGGER_EVENT_BATCHES_PER_PASS; batch += 1) {
      await yieldToLoop();
      const removed = withShortBusyWait(db, () => compactDeliveredTriggerEvents(deliveredCutoff, TRIGGER_EVENT_BATCH));
      if (removed === null) break;
      triggerEvents.compacted += removed;
      if (removed < TRIGGER_EVENT_BATCH) { triggerEvents.complete = true; break; }
    }
    const judgmentVerdicts = { deleted: 0, complete: false };
    const verdictCutoff = new Date(now - STORAGE_POLICY.judgmentVerdictDays * DAY_MS).toISOString();
    for (let batch = 0; batch < JUDGMENT_VERDICT_BATCHES_PER_PASS; batch += 1) {
      await yieldToLoop();
      const removed = withShortBusyWait(db, () => pruneJudgmentVerdicts(verdictCutoff, JUDGMENT_VERDICT_BATCH));
      if (removed === null) break;
      judgmentVerdicts.deleted += removed;
      if (removed < JUDGMENT_VERDICT_BATCH) { judgmentVerdicts.complete = true; break; }
    }
    const telegramAttachments = await pruneTelegramAttachmentCopies(userDataPath("agent-cwd"), {
      keepDays: STORAGE_POLICY.telegramAttachmentDays,
      now,
    });
    const cloudPackages = await retireCloudAgentPackages(
      process.env.AGENTLAS_CLOUD_PACKAGE_DIR || userDataPath("cloud-agent-packages"),
      { keepDays: STORAGE_POLICY.cloudPackageDays, now },
    );
    const nestedProductHomes = await retireNestedProductHomeMirrors(userDataPath(), { keepDays: STORAGE_POLICY.cliTranscriptIdleDays, now });
    const observationCaptures = await pruneObservationCaptures(observationCaptureDir(), { keepDays: STORAGE_POLICY.runDetailDays, now });
    // DB-upgrade copies: checked in a child process, never on this thread.
    const migrationBackups = await retireManagedMigrationBackups({ storePath: db.name });
    return {
      lowDisk,
      freeBytes: space?.freeBytes ?? null,
      freedBytes: sweep.removedBytes + transcripts.bytes + telegramAttachments.bytes + cloudPackages.bytes + nestedProductHomes.bytes + migrationBackups.bytes + observationCaptures.bytes,
      intermediates: { files: sweep.removedFiles, bytes: sweep.removedBytes },
      transcripts: { sessions: transcripts.sessions, orphans: transcripts.orphans, bytes: transcripts.bytes },
      runDetail,
      triggerEvents,
      judgmentVerdicts,
      telegramAttachments,
      cloudPackages,
      nestedProductHomes,
      migrationBackups,
      observationCaptures,
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
    // A blocked backup cap is printed too, so "nothing freed" is never silent about why.
    if (report.freedBytes > 0 || report.runDetail.runs > 0 || report.triggerEvents.compacted > 0 || report.judgmentVerdicts.deleted > 0
      || report.migrationBackups.skipped !== "none") {
      console.info(`[storage] freed ${report.freedBytes} bytes; intermediates ${report.intermediates.files} files; `
        + `transcripts ${report.transcripts.sessions}+${report.transcripts.orphans}; run detail ${report.runDetail.runs} runs `
        + `(deleted ${report.runDetail.deleted}, compacted ${report.runDetail.compacted}, complete ${report.runDetail.complete}, `
        + `watermark ${report.runDetail.watermarkTs ?? "none"}); `
        + `trigger events compacted ${report.triggerEvents.compacted}; telegram copies ${report.telegramAttachments.folders}; `
        + `judgment verdicts deleted ${report.judgmentVerdicts.deleted}; cloud packages ${report.cloudPackages.dirs}; `
        + `nested product homes ${report.nestedProductHomes.dirs}; observation captures ${report.observationCaptures.files}; `
        + `migration backups removed ${report.migrationBackups.removed} (${report.migrationBackups.bytes} bytes, skipped ${report.migrationBackups.skipped})`);
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
