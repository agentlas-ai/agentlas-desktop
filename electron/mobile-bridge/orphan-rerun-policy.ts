// Which phone writes may be run again, under the SAME bridge key, after a Desktop restart left their ledger entry
// unsettled. Kept free of Main imports so the socket server can use it without loading the authority.
//
// A restart while a write is pending leaves its ledger entry owned by a process that no longer exists. The entry
// answers `uncertain` (idempotency_uncertain, request.status "uncertain") until it expires, so the phone can neither
// resend the message nor prove that it arrived, and its composer shows "unconfirmed" for a day. That is only safe to
// leave alone when running the command again could do harm. It cannot for a command whose own downstream layer is
// keyed by this key:
//  - invoke.start / invoke.steer (an ordinary owner message): the owner intake derives its durable row id from the
//    idempotency key (authority.ts mobileOwnerIntakeId; InvocationService.intakeOwnerMessage), so a second run of the
//    same key finds the row and returns it instead of starting or queueing the message again.
//  - science.chat.send: the bridge requires idempotencyKey === requestId (science-chat.ts) and the Science service
//    replays a request id it already accepted (`replayed: true`) instead of starting a second turn.
//
// Not here, on purpose: a Decision answer (it claims a pending confirmation, so a second run is not a no-op),
// one.invoke.start (it creates a conversation per run), science.chat.cancel (a Stop on a finished turn still leaves the
// conversation stopped, so a late repeat could stop newer work), and every method without a keyed downstream.

const DECISION_PRECONDITION_KEYS: readonly string[] = [
  "expectedQuestionMessageId",
  "expectedTaskId",
  "expectedTaskVersion",
  "expectedDecisionContractVersion",
  "expectedAuthoritativeHostRef",
  "expectedDecisionCreatedAt",
  "expectedDecisionOptionLabels",
  "expectedDecisionSelectionIndexes",
  "expectedDecisionOtherText",
  "expectedDecisionBindingDigest",
  "expectedDecisionOwnerConfirmed",
];

/** True for the two methods that go through the owner intake when they carry no Decision precondition. */
export function mobileBridgeIsOwnerMessage(request: { method: string; params: Record<string, unknown> }): boolean {
  if (request.method !== "invoke.start" && request.method !== "invoke.steer") return false;
  return !DECISION_PRECONDITION_KEYS.some((key) => request.params[key] !== undefined);
}

/**
 * Audit 62 (bridge B3, B4): an answer that only says "not now" - the state of this computer or of the server, nothing was changed - is not the command's final word for 24 hours. The ledger entry is released and nothing is stored; the same key
 * runs again when the phone sends it again. Only methods whose refusals change nothing are listed (a refusal that ran part of the command would not belong here).
 *  - one.home.deviceKey: `server_unreachable` / `one_home_unavailable` (the server did not answer; nothing was vouched).
 *  - workspace2.command: `workspace_busy`, `sign_in_required`, `account_mismatch`, `folder_unavailable`, `recovery_required`, `unavailable` (a state of the folder or the account; the command did not run).
 */
const TRANSIENT_ANSWER_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  "one.home.deviceKey": new Set(["server_unreachable", "one_home_unavailable"]),
  "workspace2.command": new Set(["workspace_busy", "sign_in_required", "account_mismatch", "folder_unavailable", "recovery_required", "unavailable"]),
};
export function mobileBridgeTransientReplayMayRerun(method: string, code: string): boolean {
  return TRANSIENT_ANSWER_CODES[method]?.has(code) === true;
}

export function mobileBridgeOrphanMayRerun(request: {
  method: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}): boolean {
  if (request.method === "science.chat.send") return typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0;
  // Audit 62 (bridge B1): a word to the personal agent is keyed downstream by its command id: the supervisor store takes the message and its receipt in ONE transaction under that id and answers a repeat with the first receipt
  // (supervisor-store.ts receive / supervisor-service.ts send), so the same key run again after a restart either finds the row (no second line) or runs once. Only when the command id IS the bridge key.
  if (request.method === "one.supervisor.send") return typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0 && request.params.commandId === request.idempotencyKey;
  // L1 D5: choosing the Desktop's model (runtime.setActive) or a role's pool (runtime.setRoleMembers) SETS a value - setActiveRuntime writes the one selection
  // the request names and setModelRoleMembers replaces the whole pool of the role in one transaction (runtime/detect.ts 1162, store/model-roles.ts 301) - so the same
  // request run again after a restart ends in the same state. It may overwrite a choice the owner made at the Desktop in between; that is the phone's own newer-looking
  // resend of its own choice, and it is the cost of not leaving the phone's model switch "unknown" for 24 hours.
  if (request.method === "runtime.setActive" || request.method === "runtime.setRoleMembers") return typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0;
  return mobileBridgeIsOwnerMessage(request) && typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0;
}
