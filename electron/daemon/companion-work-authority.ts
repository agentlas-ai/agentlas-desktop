import type { KeyObject } from "node:crypto";
import { companionHandoffProofBytes } from "../../shared/companion-handoff-proof";
import { createCompanionWorkAdmissionVerifier } from "../one/companion-work-admission";
import type { SupervisorCommandReceipt } from "../../shared/one-supervisor";

type Actor = { userId: string; workspaceId: string };
type Device = { workspaceId: string | null; ownerUserId: string | null; accountSubject: string; accountAuthorityOrigin: string; issuedAt: string };
/** The native RPC carries evidence, never the GUI's in-memory capability.
 * The daemon independently checks the current account, persisted non-revoked
 * device, machine identity, active account and the server-signed grant. */
export function createDaemonCompanionWorkAuthority(options: {
  actor(): Actor | null; device(id: string): Device | null; hostId(): string | null; oneId(): string;
  assertOwner(): void; accountActive(device: Device): Promise<boolean>; loadKey(): Promise<KeyObject | null>;
  receive(capability: object): SupervisorCommandReceipt;
}) {
  async function admit(input: unknown): Promise<SupervisorCommandReceipt> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "binding,grant,payload") throw new Error("companion_work_input_invalid");
    const value = input as { binding: Record<string, unknown>; grant: string; payload: string };
    companionHandoffProofBytes(value.binding);
    const b = value.binding;
    if (typeof value.grant !== "string" || typeof value.payload !== "string" || typeof b.deviceId !== "string" ||
        typeof b.userId !== "string" || typeof b.workspaceId !== "string" || typeof b.accountSubject !== "string" ||
        typeof b.hostId !== "string" || typeof b.oneId !== "string" || !Number.isSafeInteger(b.authEpoch)) throw new Error("companion_work_input_invalid");
    options.assertOwner();
    const actor = options.actor(), device = options.device(b.deviceId), hostId = options.hostId(), oneId = options.oneId();
    const guard = () => {
      options.assertOwner();
      const current = options.actor(), paired = options.device(b.deviceId as string);
      if (!actor || !device || !current || !paired || current.userId !== actor.userId || current.workspaceId !== actor.workspaceId ||
          actor.userId !== b.userId || actor.workspaceId !== b.workspaceId || paired.ownerUserId !== actor.userId || paired.workspaceId !== actor.workspaceId ||
          paired.accountSubject !== b.accountSubject || paired.accountSubject !== device.accountSubject || paired.accountAuthorityOrigin !== device.accountAuthorityOrigin ||
          paired.issuedAt !== device.issuedAt || !hostId || options.hostId() !== hostId || hostId !== b.hostId || options.oneId() !== oneId || oneId !== b.oneId)
        throw new Error("companion_authority_changed");
    };
    guard();
    const [publicKey, active] = await Promise.all([options.loadKey(), options.accountActive(device!)]);
    guard();
    if (!publicKey || !active) throw new Error("companion_authority_unavailable");
    const identity = { userId: actor!.userId, workspaceId: actor!.workspaceId, authEpoch: Number(b.authEpoch), accountSubject: device!.accountSubject,
      deviceId: b.deviceId, hostId: hostId!, oneId };
    const verify = createCompanionWorkAdmissionVerifier({ publicKey, identity: () => { guard(); return identity; }, assertCurrent: guard });
    const capability = verify({ grant: value.grant, binding: b, payload: value.payload });
    if (!capability) throw new Error("companion_work_admission_invalid");
    guard();
    return options.receive(capability);
  }
  return Object.freeze({ admit });
}
