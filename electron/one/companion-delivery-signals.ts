import { isElectronMainProcess } from "../main-process-host";

/**
 * The signals that make the Desktop deliver a phone's work receipts again (direct-work-capacity R8). There is no period: a
 * receipt is sent when it is made (a task ended, the app started) and, when the server could not take it, again only when one
 * of these happens - or when the worker's single retry timer is due (companion-work-delivery.ts).
 *
 *   account_changed  - the signed-in session changed owner (auth.ts onAuthSessionOwnershipChanged / onAuthSessionRestored)
 *   pair_changed     - the owner changed what a phone may do or the home moved (home.ts onOneHomeChanged)
 *   service_reachable- the server answered after it had not (noteServiceReach: false -> true only)
 *   power_resume     - the computer woke (Electron powerMonitor; exists in the window process only)
 *
 * Read by: every delivery worker (`onCompanionDeliverySignal`). Nothing is stored; no module-level state grows.
 * No Electron import at load: the background service loads this file; the powerMonitor is read lazily and only in the
 * Electron main process (main-process-host.ts), so the background service (no powerMonitor) gets the retry timer only.
 */
export type CompanionDeliverySignal = "account_changed" | "pair_changed" | "service_reachable" | "power_resume";

const listeners = new Set<(reason: CompanionDeliverySignal) => void>();
export function onCompanionDeliverySignal(listener: (reason: CompanionDeliverySignal) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function signalCompanionDelivery(reason: CompanionDeliverySignal): void {
  for (const listener of [...listeners]) { try { listener(reason); } catch { /* a listener never decides */ } }
}

let reachable: boolean | null = null;
/** One observation of the server (a read that came back / did not). Only the change from "not reachable" to "reachable" is a signal. */
export function noteServiceReach(ok: boolean): void {
  const before = reachable;
  reachable = ok;
  if (ok && before === false) signalCompanionDelivery("service_reachable");
}

export interface PowerPort { on(event: "resume", listener: () => void): unknown; removeListener(event: "resume", listener: () => void): unknown }
export interface SignalSources {
  power?: PowerPort | null;
  auth?: { onAuthSessionOwnershipChanged(l: () => void): () => void; onAuthSessionRestored?(l: () => void): () => void } | null;
  home?: { onOneHomeChanged(l: () => void): () => void } | null;
}
function defaultPower(): PowerPort | null {
  if (!isElectronMainProcess()) return null;
  try { return ((require("electron") as { powerMonitor?: PowerPort }).powerMonitor) ?? null; } catch { return null; }
}
function lazy<T>(load: () => T): T | null { try { return load(); } catch { return null; } }

let installed = 0;
let removeAll: (() => void) | null = null;
/** Hooks the sources once for however many workers run in this process; the returned function releases this caller's share. */
export function installCompanionDeliverySignalSources(sources: SignalSources = {}): () => void {
  if (!installed++) {
    const offs: Array<() => void> = [];
    const power = sources.power === undefined ? defaultPower() : sources.power;
    if (power) {
      const onResume = () => signalCompanionDelivery("power_resume");
      try { power.on("resume", onResume); offs.push(() => { try { power.removeListener("resume", onResume); } catch { /* already gone */ } }); } catch { /* no power events here: the retry timer remains */ }
    }
    const auth = sources.auth === undefined ? lazy(() => require("../auth") as NonNullable<SignalSources["auth"]>) : sources.auth;
    if (auth) {
      const changed = () => signalCompanionDelivery("account_changed");
      try { offs.push(auth.onAuthSessionOwnershipChanged(changed)); } catch { /* never attached */ }
      try { if (auth.onAuthSessionRestored) offs.push(auth.onAuthSessionRestored(changed)); } catch { /* never attached */ }
    }
    const home = sources.home === undefined ? lazy(() => require("./home") as NonNullable<SignalSources["home"]>) : sources.home;
    if (home) { try { offs.push(home.onOneHomeChanged(() => signalCompanionDelivery("pair_changed"))); } catch { /* never attached */ } }
    removeAll = () => { for (const off of offs) { try { off(); } catch { /* already gone */ } } };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!--installed) { removeAll?.(); removeAll = null; reachable = null; }
  };
}
