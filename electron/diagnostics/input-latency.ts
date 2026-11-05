import fs from "node:fs";
import path from "node:path";
import { sanitizeInputLatencyReport } from "../../shared/input-latency";

// Slow keystrokes the renderer measured (shared/input-latency.ts: timings only, never typed text), kept in
// <userData>/diagnostics/input-latency.jsonl next to the resource sampler's files. Async writes, a size cap with one rotation,
// and one summary line in main.log at most every 10 s: this must never become one more thing that blocks Main.
const MAX_LOG_BYTES = 256 * 1024;
const MIN_WARN_GAP_MS = 10_000;
let lastWarnAt = 0;

export async function recordInputLatency(directory: string, value: unknown, now = Date.now()): Promise<boolean> {
  const report = sanitizeInputLatencyReport(value);
  if (!report) return false;
  try {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "input-latency.jsonl");
    try {
      if ((await fs.promises.stat(file)).size >= MAX_LOG_BYTES) await fs.promises.rename(file, `${file}.1`);
    } catch { /* no file yet */ }
    await fs.promises.appendFile(file, `${JSON.stringify({ schemaVersion: 1, ...report })}\n`, { mode: 0o600 });
  } catch {
    return false;
  }
  if (now - lastWarnAt >= MIN_WARN_GAP_MS) {
    lastWarnAt = now;
    console.warn(
      `[input-latency] ${report.target} ${report.event} took ${report.durationMs} ms = waited ${report.inputDelayMs} before the handlers`
      + ` + handlers ${report.processingMs} + paint ${report.presentationMs}; long tasks in the 2 s before: ${report.longTasks} (${report.longTaskMs} ms); points at: ${report.cause}`,
    );
  }
  return true;
}
