/** Main's decision authority. This permits no-tools diagnosis, not Goal execution. */
import { assertAgiDecisionIngress, consumeAgiDecisionIngress, onAgiDecisionIngressInvalidated, type AgiUnblockInput } from "./monitor";
import { getDb } from "../store/db";
import { getChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, longRunOwnerHold } from "../store/long-runs";
import { goalPlanOwnerControlEpoch } from "../store/goal-plans";
import { assertDesktopLongRunAdmissionOpen, desktopAppInstanceId } from "../long-run/app-runtime-coordinator";
import { assertGoalExecutionControlGeneration, peekGoalExecutionControlGeneration, bindAgiDecisionStop } from "../automation-execution-control";

export const AGI_DECISION_CONTROL_CHANGED = "agi.decision.control-changed";
declare const decisionBrand: unique symbol;
export type AgiDecisionControl = Readonly<{ [decisionBrand]: true }>;
type Identity = { goalId: string; rootChatId: string; longRunId: string };
interface Custody { input: AgiUnblockInput; identity: Identity; main: string; nativeGeneration: number; ownerEpoch: string; canonical: string; controller: AbortController; refs: number; closed: boolean;
  initialReleased: boolean; releaseNative(): void; releaseMonitor(): void }
const controls = new WeakMap<AgiDecisionControl, Custody>();
function refuse(): never { throw Object.assign(new Error(AGI_DECISION_CONTROL_CHANGED), { code: AGI_DECISION_CONTROL_CHANGED }); }
function canonical(identity: Identity): string {
  const db = getDb(), run = getLongRunByGoalId(identity.goalId);
  const chat = db.prepare("SELECT goal_id,origin_surface,archived_at FROM chats WHERE id=?").get(identity.rootChatId) as
    { goal_id: string | null; origin_surface: string; archived_at: string | null } | undefined;
  if (!run || run.id !== identity.longRunId || run.rootChatId !== identity.rootChatId || !["one", "work"].includes(run.surface)
    || (run.executionLocation != null && run.executionLocation !== "desktop-local")
    || (run.hostOwnerKind != null && run.hostOwnerKind !== "desktop") || !chat || chat.goal_id !== identity.goalId
    || chat.origin_surface !== run.surface || chat.archived_at != null || longRunOwnerHold(run.id)
    || ["completed", "failed", "cancelled", "cancelling", "draft"].includes(run.status)
    || (run.status === "paused" && run.pauseReason === "user")) refuse();
  const revision = getChatGoalRevision(identity.goalId), contract = getChatGoalContract(identity.goalId);
  if (contract && ["completed", "cancelled"].includes(contract.status)) refuse();
  if (revision && revision.chatId !== identity.rootChatId) refuse();
  // Nullable legacy bindings stay nullable: decision admission never adopts a Goal
  // or requires an executable controller in the current Main.
  return JSON.stringify([run.id, run.rootChatId, run.surface, run.executionLocation, run.hostOwnerKind, run.appInstanceId,
    revision?.revision ?? null, revision?.chatId ?? null]);
}
export function captureAgiDecisionControl(input: AgiUnblockInput): AgiDecisionControl {
  const ingress = consumeAgiDecisionIngress(input.decisionIngress, input);
  if (ingress.db !== getDb() || !ingress.chatId || !input.runId) refuse();
  assertDesktopLongRunAdmissionOpen();
  const identity = { goalId: input.goalId, rootChatId: ingress.chatId, longRunId: input.runId };
  const snapshot = canonical(identity), nativeGeneration = peekGoalExecutionControlGeneration(identity);
  // Fresh capture after a failed durable pause still encounters the held Stop.
  assertGoalExecutionControlGeneration(identity, nativeGeneration);
  const token = Object.freeze({}) as AgiDecisionControl;
  const custody: Custody = { input: { ...input }, identity, main: desktopAppInstanceId(), nativeGeneration,
    ownerEpoch: goalPlanOwnerControlEpoch(input.goalId), canonical: snapshot, controller: new AbortController(),
    refs: 1, closed: false, initialReleased: false, releaseNative: () => {}, releaseMonitor: () => {} };
  controls.set(token, custody);
  try {
    custody.releaseMonitor = onAgiDecisionIngressInvalidated(input.decisionIngress, input,
      () => custody.controller.abort(new Error(AGI_DECISION_CONTROL_CHANGED)));
    custody.releaseNative = bindAgiDecisionStop(input, nativeGeneration, custody.controller);
    assertAgiDecisionControl(token, input);
    return token;
  } catch (error) { releaseAgiDecisionControl(token); throw error; }
}
export function assertAgiDecisionControl(token: AgiDecisionControl | undefined, input?: AgiUnblockInput): void {
  const custody = token && controls.get(token);
  if (!custody || custody.closed || custody.controller.signal.aborted) refuse();
  try {
    assertAgiDecisionIngress(custody.input.decisionIngress, custody.input);
    if (input) {
      if (input.decisionIngress !== custody.input.decisionIngress) refuse();
      assertAgiDecisionIngress(custody.input.decisionIngress, input);
    }
    assertDesktopLongRunAdmissionOpen();
    if (desktopAppInstanceId() !== custody.main || canonical(custody.identity) !== custody.canonical
      || goalPlanOwnerControlEpoch(custody.identity.goalId) !== custody.ownerEpoch) refuse();
    assertGoalExecutionControlGeneration(custody.identity, custody.nativeGeneration);
  } catch { refuse(); }
}
export function agiDecisionRefusal(input: AgiUnblockInput): string | null {
  try { assertAgiDecisionControl(input.decisionControl, input); return null; } catch { return AGI_DECISION_CONTROL_CHANGED; }
}

/** The synchronous ingress reference is released once, without rechecking authority. */
export function releaseAgiDecisionControl(token: AgiDecisionControl | undefined): void {
  const custody = token && controls.get(token);
  if (!custody || custody.initialReleased) return;
  custody.initialReleased = true;
  releaseReference(custody);
}
function releaseReference(custody: Custody): void {
  if (custody.closed || --custody.refs > 0) return;
  custody.closed = true;
  try { custody.releaseNative(); } finally {
    try { custody.releaseMonitor(); } finally { custody.controller.abort(new Error(AGI_DECISION_CONTROL_CHANGED)); }
  }
}
/** Keep the original lease through model settlement AND its deterministic successor. */
export function retainAgiDecisionControl(input: AgiUnblockInput): () => void {
  assertAgiDecisionControl(input.decisionControl, input);
  const custody = controls.get(input.decisionControl!)!;
  custody.refs += 1;
  let released = false;
  return () => { if (!released) { released = true; releaseReference(custody); } };
}
export function agiDecisionAbortSignal(input: AgiUnblockInput): AbortSignal {
  assertAgiDecisionControl(input.decisionControl, input);
  return controls.get(input.decisionControl!)!.controller.signal;
}
