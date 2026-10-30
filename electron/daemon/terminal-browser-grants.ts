import type { ControlSocketPeer } from "./control-socket";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { NativeBrowserRelayGrant } from "../browser/native-cdp-relay";

type TerminalOwner = Pick<InvocationRunOwner, "chatId" | "runId" | "ownerId" | "leaseId">;
type Entry = { peer: ControlSocketPeer; owner: TerminalOwner; controller: AbortController;
  grant: NativeBrowserRelayGrant | null; removeClose: () => void; timer: NodeJS.Timeout | null };

/** A terminal gets only a run-scoped relay, never the Main-to-daemon broker capability. */
export function createTerminalBrowserGrants(ports: {
  current(peer: ControlSocketPeer, owner: TerminalOwner): boolean;
  authorize(peer: ControlSocketPeer, owner: TerminalOwner, approvalDigest: string): Promise<boolean>;
  create(input: { chatId: string; runId: string; permission: "full"; signal: AbortSignal;
    presentation: "background"; terminalApprovalHash: string; terminalApprovalLeaseId: string }): Promise<NativeBrowserRelayGrant>;
}) {
  const entries = new Map<string, Entry>();
  let closed = false;
  const release = (id: string): Promise<void> => {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve();
    entries.delete(id);
    if (entry.timer) clearInterval(entry.timer);
    try { entry.removeClose(); } catch { /* Release never depends on a listener. */ }
    entry.controller.abort();
    try {
      const grant = entry.grant as (NativeBrowserRelayGrant & { releaseAcknowledged?: () => Promise<void> }) | null;
      if (grant?.releaseAcknowledged) return grant.releaseAcknowledged();
      grant?.release();
      return Promise.resolve();
    } catch (error) { return Promise.reject(error); }
  };
  const current = (entry: Entry) => {
    try { return !closed && !entry.controller.signal.aborted && ports.current(entry.peer, entry.owner); }
    catch { return false; }
  };
  return {
    async acquire(peer: ControlSocketPeer, owner: TerminalOwner, id: string, approvalDigest: string) {
      if (closed || entries.size >= 64 || entries.has(id) || !/^[0-9a-f-]{36}$/i.test(id)
        || !/^[a-f0-9]{64}$/.test(approvalDigest) || !ports.current(peer, owner)) throw new Error("native-browser-task-unbound");
      const entry: Entry = { peer, owner: Object.freeze({ ...owner }), controller: new AbortController(),
        grant: null, removeClose: () => {}, timer: null };
      entries.set(id, entry);
      try {
        entry.removeClose = peer.onClose(() => { void release(id).catch(() => {}); });
        if (!current(entry) || entries.get(id) !== entry) throw new Error("native-browser-grant-revoked");
        entry.timer = setInterval(() => { if (!current(entry)) void release(id).catch(() => {}); }, 1_000);
        entry.timer.unref?.();
        // Ask the registered execution owner for its actual permission. A
        // caller-supplied permission is not authority, even on this socket.
        if (!await ports.authorize(peer, owner, approvalDigest) || !current(entry) || entries.get(id) !== entry) {
          throw new Error("native-browser-task-unbound");
        }
        const grant = await ports.create({ chatId: owner.chatId, runId: owner.runId, permission: "full",
          signal: entry.controller.signal, presentation: "background", terminalApprovalHash: approvalDigest,
          terminalApprovalLeaseId: owner.leaseId });
        if (!current(entry) || entries.get(id) !== entry) {
          grant.release(); throw new Error("native-browser-grant-revoked");
        }
        entry.grant = grant;
        return { id, endpoint: grant.endpoint, token: grant.token, executable: process.execPath };
      } catch (error) { await release(id).catch(() => {}); throw error; }
    },
    async release(peer: ControlSocketPeer, id: string): Promise<boolean> {
      if (entries.get(id)?.peer !== peer) return false;
      await release(id);
      return true;
    },
    close() { closed = true; for (const id of entries.keys()) void release(id).catch(() => {}); },
  };
}
