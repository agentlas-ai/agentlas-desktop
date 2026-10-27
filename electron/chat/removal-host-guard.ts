import { assertChatRemovalAllowed } from "./removal-guard";
import { attachedDaemonBootId } from "../invocation/attached-daemon-boot";
import { invocationProcessOwner, invocationRunOwners } from "../store/invocation-run-owners";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import { releaseGoneTerminalOwners, type TerminalOwnerProofDeps } from "../store/terminal-owner-liveness";
import { userDataDir } from "../runtime-paths";

/**
 * Whether a chat's run is hosted by ANOTHER process (the background service, a terminal) that is not provably gone.
 *
 * chats:remove used to ask only this process's own activity. A turn the service hosts is invisible there, so the chat row and its
 * messages were deleted under a live run: its tools kept acting, the answer could not be saved (FOREIGN KEY), and its lease stayed
 * active for ever with the Goal's root chat gone. Custody is the durable lease (invocation_run_owners): it names the owner process
 * and stays until that owner releases it, so a non-released lease of another process means that process still runs the turn.
 *
 * Not a dead end: a lease whose owner is not provably alive does not block. A terminal's lease is released here when its process is
 * proven gone (the same proof the startup sweep uses). A service's lease counts only while Main is attached to that exact boot — the
 * definition run-events.ts daemonOwnsLiveRun uses for the receipt of a service-hosted run: with no service attached, or another boot
 * attached, the lease belongs to a service that ended (a new boot releases its predecessor's leases), and a brief disconnect of a
 * live service is covered by the observed-active projection the caller passes. This process's own lease is the in-memory census'.
 */
export function chatRunHeldByOtherLiveHost(
  lease: Pick<InvocationRunOwner, "ownerKind" | "ownerId" | "state"> | null,
  self: { ownerKind: InvocationRunOwner["ownerKind"]; ownerId: string },
  attachedServiceBootId: string | undefined,
): boolean {
  if (!lease || lease.state === "released") return false;
  if (lease.ownerKind === self.ownerKind && lease.ownerId === self.ownerId) return false;
  if (lease.ownerKind === "daemon") return Boolean(attachedServiceBootId) && lease.ownerId === attachedServiceBootId;
  return true;
}

/** Refuse (chat_run_active) while another live process hosts a run of this chat. `observedActiveChatIds` is Main's projection of
 * the chats the service reports active, which also covers a run still being prepared before it holds a lease. */
export function assertChatNotRunInAnotherHost(
  chatId: string,
  observedActiveChatIds: readonly string[] = [],
  proofDeps?: TerminalOwnerProofDeps,
): void {
  assertChatRemovalAllowed(chatId, observedActiveChatIds);
  // A terminal that is gone left its lease active; prove it and release it so the owner can still delete the room.
  try { releaseGoneTerminalOwners(invocationRunOwners, userDataDir(), { chatId, ...(proofDeps ? { deps: proofDeps } : {}) }); } catch { /* the sweep never throws; a missing user-data dir keeps the lease */ }
  let lease: InvocationRunOwner | null = null;
  try { lease = invocationRunOwners.getActiveOwner(chatId); } catch { /* an id no lease can carry: nothing to protect */ }
  assertChatRemovalAllowed(chatId, chatRunHeldByOtherLiveHost(lease, invocationProcessOwner(), attachedDaemonBootId()) ? [chatId] : []);
}
