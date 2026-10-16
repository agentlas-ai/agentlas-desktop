import type { OneTeamPreflightProposal } from "../../shared/one-team-preflight";

/**
 * Automatic team confirmation after an owner message: what one refused attempt means.
 *
 * A proposal is bound to one exact Task version (status waiting-decision), roster and runtime. Every run
 * that starts in the room, a recovery turn included, moves that Task to running and so ends the binding.
 * The renderer used to ask One to recover after EVERY refused attempt, the first transient one included
 * (runtime_changed, then a 1 s wait and a retry). The recovery turn moved the Task, the retry had to fail
 * stale_binding, the owner read "the conversation changed", and the recovery turn answered about earlier
 * work instead of the owner's message (production 1.3.47 Yotube room; P17 replay 2026-10-16: proposal
 * f2866142, recovery da6f3ac0 pending 1.1 s later, Task waiting-decision -> running, then stale_binding).
 *
 * Rules, on typed codes only (Main's `[agentlas:code=...]` marker or an own `code`), never on prose:
 *  - while attempts remain and Main has not said the binding is gone, wait and retry; recover nothing;
 *  - a final outcome hands the owner's exact text back to the composer (it was never saved: the run that
 *    would save it did not start), except when startRun already refused and reported the start itself;
 *  - a typed refusal is a product state with its own notice, not an incident: no recovery turn;
 *  - only an unclassified failure may ask One to recover, and only once the proposal is no longer pending,
 *    so the recovery can never be what invalidates a proposal that could still start.
 */
export const ONE_TEAM_PREFLIGHT_AUTO_START_MAX_ATTEMPTS = 3;

const CODE_RE = /^[a-z][a-z0-9_]{1,99}$/;
const MARKER_RE = /\[agentlas:code=([a-z][a-z0-9_]{1,99})\]/;

/** The machine code of a refused attempt, or undefined when none was carried. */
export function oneTeamPreflightFailureCode(cause: unknown): string | undefined {
  let message = typeof cause === "string" ? cause : "";
  if (cause && typeof cause === "object") {
    const { code, message: text } = cause as { code?: unknown; message?: unknown };
    if (typeof code === "string" && CODE_RE.test(code)) return code;
    if (typeof text === "string") message = text;
  }
  // Electron IPC keeps only the message of a Main error; Main writes its code there as a fixed marker.
  return MARKER_RE.exec(message)?.[1];
}

export type OneTeamPreflightAutoStartStep =
  | { kind: "retry"; delayMs: number }
  | {
    kind: "final";
    /** start_rejected: startRun refused the reserved start and already said why. */
    outcome: "start_rejected" | "binding_gone" | "refused" | "unclassified";
    code: string | undefined;
  };

export function oneTeamPreflightAutoStartStep(input: {
  code: string | undefined;
  /** Refused attempts for this proposal, this one included. */
  failures: number;
  startRejected: boolean;
  bindingGoneCodes: ReadonlySet<string>;
}): OneTeamPreflightAutoStartStep {
  const { code } = input;
  if (input.startRejected) return { kind: "final", outcome: "start_rejected", code };
  if (code !== undefined && input.bindingGoneCodes.has(code)) return { kind: "final", outcome: "binding_gone", code };
  if (input.failures >= ONE_TEAM_PREFLIGHT_AUTO_START_MAX_ATTEMPTS) {
    return { kind: "final", outcome: code === undefined ? "unclassified" : "refused", code };
  }
  return { kind: "retry", delayMs: 1_000 * 2 ** Math.max(0, input.failures - 1) };
}

const PENDING_STATUSES = new Set(["proposed", "blocked", "deferred", "team_reserved", "workforce_reserved", "solo_reserved"]);

/** Main still holds this proposal open for a start (the same states the auto-start effect acts on). */
export function oneTeamPreflightProposalPending(
  current: Pick<OneTeamPreflightProposal, "proposalId" | "status"> | null | undefined,
  proposalId: string,
): boolean {
  return Boolean(current && current.proposalId === proposalId && PENDING_STATUSES.has(current.status));
}

/** May One be asked to recover after this step? Never while retrying, never for a typed refusal. */
export function oneTeamPreflightRecoveryAllowed(
  step: OneTeamPreflightAutoStartStep,
  proposalStillPending: boolean,
): boolean {
  return step.kind === "final" && step.outcome === "unclassified" && !proposalStillPending;
}

/** The owner's exact text back in the composer, keeping anything typed since (same rule as a refused submit). */
export function restoreOwnerDraft(current: string, text: string): string {
  if (!current.trim()) return text;
  if (current === text) return current;
  return `${text}\n${current}`;
}
