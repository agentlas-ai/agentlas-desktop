// agentlasd idle exit — the safety net behind the GUI quit policy.
//
// A GUI quit with login continuity OFF asks the service to stop. This module
// covers the paths where that request never arrives: the GUI crashed or was
// killed (kill -9), or the owner chose "keep running in the background" and
// the work has since finished. In those cases a detached service with nothing
// to do must not live forever (measured 2026-09-30: seven QA daemons from the
// night before, ppid 1, still alive).
//
// Pure logic only — no timers, no store, no Electron — so a plain-Node gate can
// drive it (scripts/test-daemon-idle-exit.cjs).

export interface DaemonResidencyInput {
  /** A live Desktop GUI is attached (daemon.attach, parent pid still alive). */
  desktopAttached: boolean;
  /** Owner opted into login continuity (store meta daemon_autostart === "1"). */
  loginContinuity: boolean;
  /** graph.run requests being executed for a terminal/automation client. */
  graphRuns: number;
  /** Owned CLI run children still alive in this process. */
  runChildren: number;
  science: { state: string; settled: boolean; activeToolRequests: number | null } | null;
  localModel: { state: string; pendingOperations: number; settled: boolean } | null;
  /** Background tasks this service started and is still running (backgroundTasks.start). */
  backgroundTasks?: number;
  /** Foreground harnesses owned here, or actively connected through this broker. */
  invocationRuns?: number;
  /** Authenticated durable One domain custody includes future check-ins. */
  supervisorDomain?: boolean;
}

/** Work that would be cut if the service stopped now. Attachment/continuity are not work. */
export function daemonActiveWorkReasons(input: DaemonResidencyInput): string[] {
  const reasons: string[] = [];
  if (input.graphRuns > 0) reasons.push("graph-run");
  if (input.runChildren > 0) reasons.push("run-children");
  if ((input.backgroundTasks ?? 0) > 0) reasons.push("background-tasks");
  if ((input.invocationRuns ?? 0) > 0) reasons.push("invocation-runs");
  const science = input.science;
  if (science && (science.state === "starting"
    || (science.state === "ready" && (!science.settled || (science.activeToolRequests ?? 0) > 0)))) {
    reasons.push("science");
  }
  const local = input.localModel;
  if (local && (local.state === "starting" || local.pendingOperations > 0)) reasons.push("local-model");
  return reasons;
}

/** Every reason the service must stay up. Empty means it may exit after the grace period. */
export function daemonResidencyReasons(input: DaemonResidencyInput): string[] {
  const reasons: string[] = [];
  if (input.desktopAttached) reasons.push("desktop-attached");
  if (input.loginContinuity) reasons.push("login-continuity");
  if (input.supervisorDomain) reasons.push("one-supervisor");
  return [...reasons, ...daemonActiveWorkReasons(input)];
}

export const DEFAULT_DAEMON_IDLE_EXIT_MS = 60_000;

/** AGENTLAS_DAEMON_IDLE_EXIT_MS: unset → 60 s; "off"/"never"/"0" → disabled; else clamped 1 s..1 h. */
export function parseDaemonIdleExitMs(raw: string | undefined): number | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_DAEMON_IDLE_EXIT_MS;
  if (value === "off" || value === "never" || value === "0") return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_DAEMON_IDLE_EXIT_MS;
  return Math.min(3_600_000, Math.max(1_000, Math.round(ms)));
}

export interface IdleExitObservation {
  /** null while something keeps the service resident. */
  idleSince: number | null;
  dueAt: number | null;
  expired: boolean;
  reasons: string[];
}

/** Grace clock: any residency reason resets it; it expires only after graceMs of continuous idleness. */
export function createIdleExitClock(graceMs: number | null) {
  let idleSince: number | null = null;
  return {
    observe(reasons: string[], now: number): IdleExitObservation {
      if (graceMs === null || reasons.length > 0) {
        idleSince = null;
        return { idleSince, dueAt: null, expired: false, reasons };
      }
      idleSince ??= now;
      const dueAt = idleSince + graceMs;
      return { idleSince, dueAt, expired: now >= dueAt, reasons };
    },
  };
}
