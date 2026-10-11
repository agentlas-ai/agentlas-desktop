import { getInvocationAdmission } from "../store/invocation-admissions";
import { invocationRunOwners } from "../store/invocation-run-owners";

export type DaemonOwnedObservation = { chatId: string; runId: string; inputDigest: string };

/**
 * READ-ONLY binding for a run this daemon boot owns durably but did not receive through the GUI native start or the
 * One supervisor (One Team dispatch, room follow-up, scheduled graph run): the admission was made by this boot, the
 * owner row names this boot as a daemon, and the lease is not released. It authorizes progress observation only
 * (event stream, active chats, attach, recovery value, receipt). Owner text, unsteer, stop and approvals keep the
 * strict capture rules in native-invocation-runtime.ts.
 */
export function daemonOwnedObservation(bootId: string, chatId: unknown, runId: unknown): DaemonOwnedObservation | null {
  if (typeof chatId !== "string" || typeof runId !== "string" || !chatId || !runId) return null;
  const admission = getInvocationAdmission(runId), custody = invocationRunOwners.getRunOwner(chatId, runId);
  if (!admission || admission.chatId !== chatId || admission.ownerProcessEpoch !== bootId
    || !custody || custody.ownerKind !== "daemon" || custody.ownerId !== bootId || custody.state === "released") return null;
  return { chatId, runId, inputDigest: admission.inputDigest };
}
