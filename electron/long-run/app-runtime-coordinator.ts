import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
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
  shutdownPromise = (async () => {
    admissionOpen = false;
    const pausedRunIds = pauseActiveDesktopLongRunsForAppShutdown(appInstanceId);
    const entries = [...participants.entries()];
    for (const [, participant] of entries) {
      try { participant.closeAdmission?.(); } catch {}
    }
    const settlements = await Promise.allSettled(
      entries.map(([, participant]) => Promise.resolve().then(() => participant.interrupt())),
    );
    const failedParticipantNames: string[] = [];
    const participantErrorCodes: Record<string, string> = {};
    settlements.forEach((settlement, index) => {
      if (settlement.status !== "rejected") return;
      const name = entries[index]![0];
      failedParticipantNames.push(name);
      const raw = settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
      participantErrorCodes[name] = raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "participant_failed";
    });

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let unsettled = entries.filter(([, participant]) => participant.isSettled && !participant.isSettled());
    while (unsettled.length > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      unsettled = entries.filter(([, participant]) => participant.isSettled && !participant.isSettled());
    }
    removeHostShutdownHook?.();
    removeHostShutdownHook = null;
    return {
      appInstanceId,
      pausedRunIds,
      participantNames: entries.map(([name]) => name),
      failedParticipantNames,
      participantErrorCodes,
      unsettledParticipantNames: unsettled.map(([name]) => name),
      timedOut: unsettled.length > 0,
    };
  })();
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
