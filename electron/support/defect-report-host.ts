/**
 * The defect report's host side (moved out of alive-organisms/index.ts, Agentlas 2.0 N1a): the lazy sender, the three IPC handlers
 * (channel names unchanged: the renderer and the preload already call them), and the offline queue's retry.
 *
 * Retry (only reports the owner pressed Send on are retried, same clientReportId, backoff): there is no 60-second
 * interval any more. One timer exists only while a queued report is waiting, set for the earliest time one of them may be tried again
 * (never sooner than the old cadence, so a report whose lease another process holds cannot spin), and it is set again after every
 * Send and every flush. With nothing queued there is no timer at all.
 */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { getDb } from "../store/db";
import { currentUiLocale } from "../ui-locale";
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import { onHostShutdown } from "../host-lifecycle";
import type { DefectReportDraftInput } from "../../shared/defect-report";
import { DefectReports } from "./defect-report";

let sender: DefectReports | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** The slowest the old interval ever ran; also the first look after the app starts is sooner (STARTUP_FLUSH_MS). */
export const DEFECT_REPORT_MIN_RETRY_MS = 60_000;
const STARTUP_FLUSH_MS = 5_000;
/** The longest the retry timer sleeps; also the longest backoff step (defect-report.ts DEFECT_REPORT_BACKOFF_MS). */
export const DEFECT_REPORT_MAX_WAIT_MS = 6 * 60 * 60_000;

/** D5 sender (lazy: the IPC can be called before anything else starts). */
export function defectReportSender(): DefectReports {
  if (sender) return sender;
  const { app } = require("electron") as typeof import("electron");
  sender = new DefectReports({
    db: getDb(),
    now: Date.now,
    appVersion: () => app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    locale: () => currentUiLocale(),
    sessionToken: () => {
      const header = getSessionCookieHeader();
      const at = header ? header.indexOf("=") : -1;
      return header && at > 0 ? header.slice(at + 1) : null;
    },
    baseUrl: webBaseUrl,
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      return { status: response.status, json: () => response.json() };
    },
  });
  return sender;
}

/** Milliseconds until the earliest queued report may be tried again, or null when none is queued. */
function nextFlushDelayMs(nowMs: number): number | null {
  try {
    const row = getDb().prepare("SELECT COUNT(*) AS n, MIN(COALESCE(next_attempt_at_ms, 0)) AS at FROM agi_bug_report_queue WHERE status = 'queued'")
      .get() as { n: number; at: number | null } | undefined;
    if (!row || !row.n) return null;
    // Bounded above too: Node turns a timer longer than 24.8 days into 1 ms and the callback then fired about 780 times a second (a retry
    // time written while the clock was ahead). A far time only means a look every few hours that finds nothing due (#7).
    return Math.min(DEFECT_REPORT_MAX_WAIT_MS, Math.max(DEFECT_REPORT_MIN_RETRY_MS, (row.at ?? 0) - nowMs));
  } catch { return null; } // the table does not exist yet (nothing was ever queued) or the store is closing
}

/** Sets the one retry timer for the earliest queued report, or none. Safe to call any number of times. */
export function scheduleDefectReportFlush(firstDelayMs?: number): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const delay = nextFlushDelayMs(Date.now());
  if (delay === null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void defectReportSender().flush().catch((error) => console.warn("[agi-bug-report] flush failed:", error)).finally(() => scheduleDefectReportFlush());
  }, firstDelayMs ?? delay);
  flushTimer.unref?.();
}

/** The app is closing (or the store with it): no timer may outlive the database. */
export function stopDefectReportFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

const invalid = (): Error => Object.assign(new Error("[agentlas:code=agi-input-invalid] agi-input-invalid"), { code: "agi-input-invalid", name: "AliveHostError" });

export function registerDefectReportIpc(deps: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  deps.ipc.handle("agi:bugReportPreview", (event, input: unknown) => {
    deps.assertTrustedSender(event);
    const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const str = (key: string, max: number): string | undefined => typeof row[key] === "string" ? (row[key] as string).slice(0, max) : undefined;
    const draft: DefectReportDraftInput = {
      chatId: str("chatId", 200) ?? null, title: str("title", 400), summary: str("summary", 8_000),
      category: str("category", 20) as DefectReportDraftInput["category"], failureCode: str("failureCode", 160), runId: str("runId", 200),
      steps: Array.isArray(row.steps) ? row.steps.filter((step): step is string => typeof step === "string").slice(0, 20) : undefined,
    };
    return defectReportSender().preview(draft);
  });
  deps.ipc.handle("agi:bugReportSend", async (event, input: unknown) => {
    deps.assertTrustedSender(event);
    const id = input && typeof input === "object" ? (input as { clientReportId?: unknown }).clientReportId : null;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw invalid();
    try { return await defectReportSender().send(id); } finally { scheduleDefectReportFlush(); }
  });
  deps.ipc.handle("agi:bugReportList", async (event) => { deps.assertTrustedSender(event); return defectReportSender().list(); });
  // The timer ends with the host, whatever else is or is not running (main.ts also stops it, earlier, while the quit waits for services).
  onHostShutdown(stopDefectReportFlush);
  // A report queued before this launch is tried soon after the app starts (the old first flush), then by the one timer above.
  scheduleDefectReportFlush(STARTUP_FLUSH_MS);
}
