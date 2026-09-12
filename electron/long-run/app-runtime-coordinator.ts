import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { reconcileHostPausedLongRuns } from "./startup-reconciler";
import {
  pauseActiveDesktopLongRunsForAppShutdown,
  recoverInterruptedDesktopLongRunsAtStartup,
  resumeLongRunByUser,
  transitionLongRun,
  type LongRunRecord,
} from "../store/long-runs";

export interface AppRuntimeParticipant {
  closeAdmission?: () => void;
  interrupt: () => void | Promise<void>;
  isSettled?: () => boolean;
}

export interface AppRuntimeShutdownReport {
  appInstanceId: string;
  pausedRunIds: string[];
  participantNames: string[];
  failedParticipantNames: string[];
  participantErrorCodes: Record<string, string>;
  unsettledParticipantNames: string[];
  timedOut: boolean;
}

const participants = new Map<string, AppRuntimeParticipant>();
const appInstanceId = `desktop_${randomUUID()}`;
let initialized = false;
let admissionOpen = false;
let shutdownPromise: Promise<AppRuntimeShutdownReport> | null = null;
let removeHostShutdownHook: (() => void) | null = null;

function closeAdmissionAndInterruptBestEffort(): void {
  admissionOpen = false;
  for (const participant of participants.values()) {
    try { participant.closeAdmission?.(); } catch {}
    try {
      const pending = participant.interrupt();
      if (pending && typeof (pending as Promise<void>).catch === "function") {
        void (pending as Promise<void>).catch(() => {});
      }
    } catch {}
  }
}

export function initializeAppRuntimeCoordinator(): { appInstanceId: string; recoveredRunIds: string[] } {
  if (initialized) return { appInstanceId, recoveredRunIds: [] };
  initialized = true;
  admissionOpen = true;
  const recoveredRunIds = recoverInterruptedDesktopLongRunsAtStartup(appInstanceId);
  /*
   * Say, out loud and per run, which of those may carry on.
   *
   * Startup used to pause every interrupted run and stop there, so a goal meant to run for days
   * ended permanently the first time the person closed the window: the state read "paused" and no
   * path in the product could leave that state on its own. Deciding here — and recording the refusal
   * for the ones that may not — turns a silent dead end into something the host can act on and the
   * person can see.
   */
  try {
    for (const entry of reconcileHostPausedLongRuns(recoveredRunIds)) {
      if (entry.decision.resume) {
        console.info(`[long-run-reconcile] run=${entry.runId} resumable=yes`);
      } else {
        console.info(`[long-run-reconcile] run=${entry.runId} resumable=no reason=${entry.decision.reason}`);
      }
    }
  } catch (error) {
    // Reconciliation is a report, never a reason the app fails to start.
    console.error("[long-run-reconcile] failed", error);
  }
  removeHostShutdownHook = onHostShutdown(() => {
    // Synchronous last-chance boundary. Normal quit calls the awaited path
    // first, but SIGTERM/crash-adjacent exits still persist a manual-resume
    // pause and interrupt registered runtimes before child cleanup runs.
    try { pauseActiveDesktopLongRunsForAppShutdown(appInstanceId); } catch {}
    closeAdmissionAndInterruptBestEffort();
  });
  return { appInstanceId, recoveredRunIds };
}

export function registerAppRuntimeParticipant(
  name: string,
  participant: AppRuntimeParticipant,
): () => void {
  if (shutdownPromise) throw new Error("app_runtime_shutdown_in_progress");
  const normalized = name.trim();
  if (!normalized) throw new TypeError("app_runtime_participant_name_required");
  if (participants.has(normalized)) throw new Error(`app_runtime_participant_duplicate:${normalized}`);
  participants.set(normalized, participant);
  return () => {
    if (participants.get(normalized) === participant) participants.delete(normalized);
  };
}

export function assertDesktopLongRunAdmissionOpen(): void {
  if (!initialized || !admissionOpen) throw new Error("desktop_long_run_admission_closed");
}

export function desktopAppInstanceId(): string {
  return appInstanceId;
}

export function resumeDesktopLongRunManually(runId: string, expectedVersion: number): LongRunRecord {
  assertDesktopLongRunAdmissionOpen();
  return resumeLongRunByUser(runId, appInstanceId, expectedVersion);
}

export function confirmDesktopLongRunResumeDispatched(runId: string): LongRunRecord {
  assertDesktopLongRunAdmissionOpen();
  return transitionLongRun({
    runId,
    to: "running",
    actorKind: "host",
    reason: "resume-dispatched",
    appInstanceId,
  });
}

export function failDesktopLongRunResumeDispatch(runId: string, reason: string): LongRunRecord {
  return transitionLongRun({
    runId,
    to: "paused",
    actorKind: "host",
    reason: "runtime_unavailable",
    actorId: reason.slice(0, 120),
    appInstanceId,
  });
}

export function shutdownAppRuntimeCoordinator(timeoutMs = 15_000): Promise<AppRuntimeShutdownReport> {
  if (shutdownPromise) return shutdownPromise;
  admissionOpen = false;
  // The deadline covers interruption itself, not just the subsequent drain.
  // A synchronous callback must still return control to the JS event loop.
  const duration = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 15_000;
  const deadline = performance.now() + duration;
  // Install the single-flight promise before calling user/runtime participants:
  // a closeAdmission callback may re-enter shutdown synchronously.
  shutdownPromise = Promise.resolve().then(async () => {
    const entries = [...participants.entries()];
    const failures = new Map<string, string>();
    const interruptPending = new Set(entries.map(([name]) => name));
    let reportClosed = false;
    const failed = (name: string, error: unknown): void => {
      if (reportClosed || failures.has(name)) return;
      const raw = error instanceof Error ? error.message : String(error);
      failures.set(name, raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "participant_failed");
    };
    let pausedRunIds: string[] = [];
    try { pausedRunIds = pauseActiveDesktopLongRunsForAppShutdown(appInstanceId); }
    catch (error) {
      // A storage failure cannot prevent Stop from reaching every runtime.
      // Existing Main report consumers already handle failed participant names.
      failed("coordinator:pause-state", error);
    }
    for (const [name, participant] of entries) {
      try { participant.closeAdmission?.(); } catch (error) { failed(name, error); }
    }
    for (const [name, participant] of entries) {
      try {
        const pending = participant.interrupt();
        if (pending && typeof pending.then === "function") {
          void Promise.resolve(pending).then(
            () => { if (!reportClosed) interruptPending.delete(name); },
            (error) => { if (!reportClosed) { failed(name, error); interruptPending.delete(name); } },
          );
        } else {
          interruptPending.delete(name);
        }
      } catch (error) {
        failed(name, error);
        interruptPending.delete(name);
      }
    }
    const unsettledNames = (): string[] => entries.filter(([name, participant]) => {
      if (interruptPending.has(name)) return true;
      try { return participant.isSettled ? !participant.isSettled() : false; }
      catch (error) { failed(name, error); return true; }
    }).map(([name]) => name);
    // Let already-resolved interruption promises acknowledge even with a zero
    // budget, while a never-resolving interrupt remains explicitly unsettled.
    await Promise.resolve();
    let unsettled = unsettledNames();
    while (unsettled.length > 0 && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))));
      unsettled = unsettledNames();
    }
    reportClosed = true;
    removeHostShutdownHook?.();
    removeHostShutdownHook = null;
    return {
      appInstanceId,
      pausedRunIds: [...pausedRunIds],
      participantNames: entries.map(([name]) => name),
      failedParticipantNames: [...failures.keys()],
      participantErrorCodes: Object.fromEntries(failures),
      unsettledParticipantNames: [...unsettled],
      timedOut: unsettled.length > 0,
    };
  });
  return shutdownPromise;
}

export function __resetAppRuntimeCoordinatorForTests(): void {
  removeHostShutdownHook?.();
  removeHostShutdownHook = null;
  participants.clear();
  initialized = false;
  admissionOpen = false;
  shutdownPromise = null;
}
