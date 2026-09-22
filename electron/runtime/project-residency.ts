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

export const WORK_PROJECT_RESIDENCY_BUSY_CODE = "work_project_residency_busy";

export interface ProjectResidencyBusyBlocker {
  chatId: string | null;
  runtimeKind: string;
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
    .map((entry) => ({ chatId: entry.chatId, runtimeKind: entry.runtimeKind }));
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
