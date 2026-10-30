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

export function mobileBridgeOrphanMayRerun(request: {
  method: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}): boolean {
  if (request.method === "science.chat.send") return typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0;
  return mobileBridgeIsOwnerMessage(request) && typeof request.idempotencyKey === "string" && request.idempotencyKey.length > 0;
}
