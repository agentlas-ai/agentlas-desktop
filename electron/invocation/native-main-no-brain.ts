import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import { createInvocationRunOwnerStore, type InvocationRunOwner } from "../store/invocation-owner-core";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { getDb } from "../store/db";
import { RUNTIME_TURN_UNSETTLED_CODE } from "../runtime/runner";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import type { NativeMainPreparationBinding } from "./native-main-preparation-issuer";
export class NativeMainNoBrainProofError extends Error {
  readonly code = "native_main_no_brain_proof_required";
  constructor() { super("Native undispatched source proof is required."); this.name = "NativeMainNoBrainProofError"; }
}
function fail(): never { throw new NativeMainNoBrainProofError(); }
/** Main-only conjunction. Shared SQLite facts do not mint native provenance.
 * The required observer must consume Root's actual source-owned signed callback
 * evidence; no missing-row, error prose or JSON/providerDispatched flag grants it. */
export function createNativeMainNoBrainChecker(ports: {
  getChannel(): object | undefined;
  assertSourceNoBrainDispatch(channel: object, identity: NativeAuthenticatedIdentity,
    binding: Readonly<NativeMainPreparationBinding>, owner: Readonly<InvocationRunOwner>): void;
}) {
  const owners = createInvocationRunOwnerStore({ getDb });
  return function assertNoBrainDispatch(binding: Readonly<NativeMainPreparationBinding>, leaseId: string): void {
    const channel = ports.getChannel(), identity = channel && nativeGuiChannelIdentity(channel);
    if (!channel || !identity || !leaseId) fail();
    const owner = owners.getRunOwner(binding.chatId, binding.runId), admission = getInvocationAdmission(binding.runId);
    if (!owner || owner.state !== "released" || owner.ownerKind !== "daemon" || owner.ownerId !== identity.bootId
      || owner.leaseId !== leaseId || owner.chatId !== binding.chatId || owner.runId !== binding.runId
      || !admission || admission.status !== "admitted" || admission.chatId !== binding.chatId
      || admission.ownerProcessEpoch !== identity.bootId || admission.inputDigest !== binding.inputDigest) fail();
    const rows = getDb().prepare("SELECT chat_id,payload_json FROM run_events WHERE run_id=? AND kind='invoke_threw'").all(binding.runId) as { chat_id: unknown; payload_json: unknown }[];
    const nativeFailure = rows.some(row => {
      if (row.chat_id !== binding.chatId || typeof row.payload_json !== "string") return false;
      let payload: unknown; try { payload = JSON.parse(row.payload_json); } catch { return false; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const facts = payload as Record<string, unknown>;
      return facts.providerDispatched === false && (facts.errorCode === "native_preparation_cancelled" || facts.errorCode === RUNTIME_TURN_UNSETTLED_CODE);
    });
    if (!nativeFailure) fail();
    // Durable facts are necessary diagnostics, never sufficient source proof.
    const observed: unknown = ports.assertSourceNoBrainDispatch(channel, identity, binding, owner);
    if (observed !== undefined || ports.getChannel() !== channel || nativeGuiChannelIdentity(channel) !== identity) fail();
  };
}
