/**
 * Main-owned admission for resident provider CLIs in a Work project.
 *
 * Conversation identity remains the provider pool key (chat × runtime ×
 * configuration). This module is only the cross-pool project partition: it
 * closes idle siblings before a new owner is opened and refuses to create a
 * second owner while another project's turn is in use.
 */
import {
  dropAgentResidency,
  holdingAgentResidency,
  type AgentResidencyEntry,
} from "./agent-residency";
import type { AgentProcessLifecycleReason } from "../../shared/types";

import { WORK_PROJECT_RESIDENCY_BUSY_CODE as PRE_DISPATCH_WORK_PROJECT_RESIDENCY_BUSY_CODE } from "./runner-pre-dispatch";
export const WORK_PROJECT_RESIDENCY_BUSY_CODE = PRE_DISPATCH_WORK_PROJECT_RESIDENCY_BUSY_CODE;

export interface ProjectResidencyBusyBlocker {
  chatId: string | null;
  runtimeKind: string;
  /** "in-use": another turn holds the project's provider. "closing": a retired process has not exited yet. */
  state: "in-use" | "closing";
  /** For a closing blocker, the registry's typed reason (e.g. "evicted"); null for an in-use one. */
  closeReason: AgentProcessLifecycleReason | null;
}

function blocker(entry: AgentResidencyEntry): ProjectResidencyBusyBlocker {
  return entry.closing
    ? { chatId: entry.chatId, runtimeKind: entry.runtimeKind, state: "closing", closeReason: entry.closeReason ?? null }
    : { chatId: entry.chatId, runtimeKind: entry.runtimeKind, state: "in-use", closeReason: null };
}

export class ProjectResidencyBusyError extends Error {
  readonly code = WORK_PROJECT_RESIDENCY_BUSY_CODE;
  readonly projectId: string;
  readonly blockers: readonly ProjectResidencyBusyBlocker[];

  constructor(projectId: string, blockers: readonly ProjectResidencyBusyBlocker[] = []) {
    super(
      blockers.length > 0
        ? `Work project ${projectId} already has an active provider turn; wait for it to finish before starting another chat.`
        : `Work project ${projectId} is already admitting a provider turn; wait for it to finish before trying again.`,
    );
    this.name = "ProjectResidencyBusyError";
    this.projectId = projectId;
    this.blockers = blockers;
  }
}

interface ProjectResidencyAdmissionInput {
  projectId?: string | null;
  /** Keep the currently checked-out/reused entry in the same pool. */
  keepResidencyKey?: string | null;
}

let admissionSequence = 0;
const admissions = new Map<string, string>();

function normalizedProjectId(value: string | null | undefined): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return id || null;
}

function projectEntries(projectId: string): AgentResidencyEntry[] {
  return holdingAgentResidency().filter((entry) => entry.projectId === projectId);
}

/**
 * Reserve a project admission before an asynchronous provider open. The
 * reservation closes idle siblings first, but never interrupts a checked-out
 * turn. A second concurrent opener fails closed rather than racing into two
 * CLIs for the same project.
 */
export function beginProjectResidencyAdmission(input: ProjectResidencyAdmissionInput): string | null {
  const projectId = normalizedProjectId(input.projectId);
  if (!projectId) return null;

  if (admissions.has(projectId)) throw new ProjectResidencyBusyError(projectId);

  const keep = input.keepResidencyKey ?? null;
  const entries = projectEntries(projectId);
  const blockers = entries
    .filter((entry) => entry.inUse && entry.key !== keep)
    .map(blocker);
  if (blockers.length > 0) throw new ProjectResidencyBusyError(projectId, blockers);

  const token = `project-residency:${++admissionSequence}`;
  admissions.set(projectId, token);
  for (const entry of entries) {
    if (!entry.inUse && entry.key !== keep) {
      dropAgentResidency(entry.key, { close: true, reason: "evicted" });
    }
  }
  return token;
}

/** Default bound for a retired project sibling to exit (the same bound as a Codex thread-writer hand-over). */
export const PROJECT_SIBLING_EXIT_WAIT_MS = 15_000;

/**







 */
export async function awaitProjectResidencySiblingsExit(
  projectId: string | null | undefined,
  keepResidencyKey: string | null | undefined,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const normalized = normalizedProjectId(projectId);
  if (!normalized) return;
  const closing = (): AgentResidencyEntry[] => projectEntries(normalized)
    .filter((entry) => entry.closing && entry.key !== (keepResidencyKey ?? null));
  const pending = closing();
  if (pending.length === 0) return;
  const refuse = (entries: AgentResidencyEntry[]): never => {
    throw new ProjectResidencyBusyError(normalized, entries.map(blocker));
  };
  const completions = pending.map((entry) => entry.closeCompletion);
  if (pending.some((entry) => entry.closeFailed) || completions.some((completion) => !completion) || options.signal?.aborted) {
    refuse(pending);
  }
  const waitMs = Math.max(0, Math.min(options.waitMs ?? PROJECT_SIBLING_EXIT_WAIT_MS, 120_000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      Promise.allSettled(completions),
      // Not unref'd: an admitting turn is live work and must keep its host up until the bound.
      new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
      new Promise<void>((resolve) => { onAbort = () => resolve(); options.signal?.addEventListener("abort", onAbort, { once: true }); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
  const remaining = closing();
  if (remaining.length > 0 || options.signal?.aborted) refuse(remaining.length > 0 ? remaining : pending);
}

/** Release a successful or failed asynchronous admission reservation. */
export function finishProjectResidencyAdmission(
  projectId: string | null | undefined,
  token: string | null | undefined,
): void {
  const normalized = normalizedProjectId(projectId);
  if (!normalized || !token) return;
  if (admissions.get(normalized) === token) admissions.delete(normalized);
}

/**
 * A release is the safe point at which an idle sibling can be reclaimed. This
 * also handles old pools that were registered before project admission was
 * introduced, as long as their metadata carries the project id.
 */
export function enforceProjectResidencyIdle(
  projectId: string | null | undefined,
  keepResidencyKey?: string | null,
): number {
  const normalized = normalizedProjectId(projectId);
  if (!normalized) return 0;
  const keep = keepResidencyKey ?? null;
  let closed = 0;
  for (const entry of projectEntries(normalized)) {
    if (entry.inUse || entry.key === keep) continue;
    dropAgentResidency(entry.key, { close: true, reason: "evicted" });
    closed += 1;
  }
  return closed;
}

/** Test-only reset; production admission state is process-local and ephemeral. */
export function __resetProjectResidencyForTests(): void {
  admissions.clear();
  admissionSequence = 0;
}
