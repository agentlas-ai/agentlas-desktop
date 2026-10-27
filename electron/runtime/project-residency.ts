/** Legacy project-busy diagnostic retained for stored receipts and old host callers.
 * A Work project is shared attribution, not a native writer. New dispatches wait
 * through native-writer-admission before acquiring runtime capacity.
 */
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
