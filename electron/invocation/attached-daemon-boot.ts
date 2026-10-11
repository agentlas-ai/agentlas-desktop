/**
 * The boot id of the background daemon this Main process is attached to over the authenticated native channel, or
 * undefined while no channel is attached. Dependency-free on purpose: the receipt projection in store/run-events.ts
 * reads it, and the native channel (native-gui-controls.ts) writes it.
 *
 * Why it exists: a run the daemon started on its own (One Team dispatch, room follow-up, scheduled graph run) has no
 * record in Main's in-memory registry, so a started-without-terminal ledger is indistinguishable from a dead run
 * there. The durable owner row names the daemon boot that owns the run; while that exact boot is attached, the run is
 * alive. When the channel closes or a different boot attaches, the claim lapses and the honest "interrupted" returns.
 */
let attachedBootId: string | undefined;
export function setAttachedDaemonBootId(bootId: string): void { attachedBootId = bootId; }
/** Clears only the claim it set: a later channel's boot id is never erased by an older channel closing. */
export function clearAttachedDaemonBootId(bootId: string): void { if (attachedBootId === bootId) attachedBootId = undefined; }
export function attachedDaemonBootId(): string | undefined { return attachedBootId; }
