// Records the slow keystrokes of this window as timings only (shared/input-latency.ts says what a report may hold).
// Browser Event Timing + Long Tasks; no listener on the keys themselves, so typing pays nothing for it. Anything that
// goes wrong in here is swallowed: a diagnostic must never be able to hurt the field it watches.
import {
  INPUT_LATENCY_EVENTS,
  INPUT_LATENCY_LONG_TASK_WINDOW_MS,
  INPUT_LATENCY_THRESHOLD_MS,
  createInputLatencyLimiter,
  makeInputLatencyReport,
  type InputLatencyReport,
  type InputLatencyTarget,
  type InputTimingEntry,
} from "@shared/input-latency";

declare global {
  interface Window {
    /** Optional dedicated bridge (electron/preload.ts); absent in a plain browser. */
    agentlasInputLatency?: { report: (report: InputLatencyReport) => Promise<unknown> };
  }
}

interface EventTimingEntry extends InputTimingEntry {
  target: Node | null;
}

function targetKind(node: Node | null): InputLatencyTarget {
  if (!(node instanceof Element)) return "other";
  if (node.closest("[data-chat-input]")) return "chat-composer";
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || (node as HTMLElement).isContentEditable) return "text-field";
  return "other";
}

/** Where a report goes: Main's diagnostics folder through the bridge, or the console of a plain browser (dev renderer). */
export function sendInputLatencyReport(report: InputLatencyReport): void {
  const bridge = typeof window === "undefined" ? undefined : window.agentlasInputLatency;
  if (bridge) { void bridge.report(report).catch(() => undefined); return; }
  console.warn("[input-latency]", JSON.stringify(report));
}

export function startInputLatencyRecorder(send: (report: InputLatencyReport) => void = sendInputLatencyReport): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return () => undefined;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supported.includes("event")) return () => undefined;
  const allow = createInputLatencyLimiter();
  const longTasks: Array<{ end: number; duration: number }> = [];
  const observers: PerformanceObserver[] = [];
  try {
    if (supported.includes("longtask")) {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push({ end: entry.startTime + entry.duration, duration: entry.duration });
        const cut = performance.now() - INPUT_LATENCY_LONG_TASK_WINDOW_MS;
        while (longTasks.length > 0 && longTasks[0]!.end < cut) longTasks.shift();
      });
      longTaskObserver.observe({ type: "longtask" });
      observers.push(longTaskObserver);
    }
    const eventObserver = new PerformanceObserver((list) => {
      try {
        for (const raw of list.getEntries()) {
          const entry = raw as unknown as EventTimingEntry;
          if (!(INPUT_LATENCY_EVENTS as readonly string[]).includes(entry.name)) continue;
          const cut = entry.startTime - INPUT_LATENCY_LONG_TASK_WINDOW_MS;
          const near = longTasks.filter((task) => task.end >= cut && task.end <= entry.startTime + entry.duration);
          const report = makeInputLatencyReport({
            entry,
            target: targetKind(entry.target),
            longTasks: near.length,
            longTaskMs: near.reduce((sum, task) => sum + task.duration, 0),
            hidden: document.visibilityState !== "visible",
            at: Date.now(),
          });
          if (report && allow(Date.now())) send(report);
        }
      } catch { /* diagnostics only */ }
    });
    eventObserver.observe({ type: "event", durationThreshold: INPUT_LATENCY_THRESHOLD_MS } as PerformanceObserverInit);
    observers.push(eventObserver);
  } catch {
    for (const observer of observers) observer.disconnect();
    return () => undefined;
  }
  return () => { for (const observer of observers) observer.disconnect(); };
}
