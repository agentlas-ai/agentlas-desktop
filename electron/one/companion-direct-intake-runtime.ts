import { readFileSync } from "node:fs";
import { getAuthenticatedSessionBinding, getSessionCookieHeader, webBaseUrl } from "../auth";
import { MOBILE_BRIDGE_PROTOCOL_VERSION } from "../../shared/mobile-bridge";
import { userDataDir } from "../runtime-paths";
import { MobileBridgePairingManager, mobileBridgeHostIdentityPath } from "../mobile-bridge/pairing";
import { MobileBridgeAccountPairingClient } from "../mobile-bridge/account-pairing";
import { captureNativeAuthBinding, loadNativeGuiCredential, signNativeCompanionDirectPoll, signNativeCompanionDirectClaim, signNativeCompanionDirectLifecycle } from "../daemon/native-auth-credentials";
import { createDaemonCompanionWorkAuthority } from "../daemon/companion-work-authority";
import { loadCompanionWorkKey } from "./companion-work-key";
import { CompanionIntakeRetryAfter, createCompanionDirectIntakeClient } from "./companion-direct-intake-client";
import type { SupervisorCommandReceipt } from "../../shared/one-supervisor";
import { computerMayServe, computerStandingForSweep, directPollPaused, noteComputerGate, noteDirectPollRefused, noteTakeError, startWaitEnded, type ComputerVerdict } from "./companion-computer-gate";
import { getDb } from "../store/db";
import { localHoldsCommand, readDirectHolding } from "./companion-poll-holding";

/** One worker in the current Supervisor owner. The phone need not be running;
 * each iteration re-reads the current local account and paired-device binding. */
export function createCompanionDirectIntakeRuntime(options: {
  oneId(): string; assertOwner(): void; receive(capability: object): SupervisorCommandReceipt; intervalMs?: number;
}) {
  // TR-desktop 3: the background service (daemon, ELECTRON_RUN_AS_NODE) never takes direct work. A computer whose app is closed answers as a computer that is off:
  // the server's personal agent answers for it. The server sees a computer as "on" only by the signed poll made here (`directSeenAt`, web companion-direct-work-auth.mjs:114-120,
  // online = seen within 90 s :95-96), so a daemon that does not poll never makes this computer look on. Same guard the GUI coordinator and the front runtime already have.
  if (process.env.ELECTRON_RUN_AS_NODE === "1") throw new Error("companion_intake_gui_only");
  const dir = userDataDir(), pairing = new MobileBridgePairingManager(dir), account = new MobileBridgeAccountPairingClient();
  const interval = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 120_000) throw new Error("companion_intake_interval_invalid");
  let stopped = false, timer: ReturnType<typeof setInterval> | null = null, running: Promise<void> | null = null;
  let keyCache: { sessionId: string; until: number; credential: Awaited<ReturnType<typeof loadNativeGuiCredential>> } | null = null;
  let retryAt = 0;
  async function lifecycle(purpose: "start" | "status", binding: Record<string, unknown>, runId: string): Promise<string | null> {
    try {
      if (Date.now() < retryAt) return null;
      options.assertOwner();
      const session = getAuthenticatedSessionBinding(), host = hostId(), one = options.oneId();
      // TR-desktop (trust-root.md E1): a Work that was already taken is started only while this computer is still the confirmed home and the phone's pairing may still vouch.
      // Not a "cancel": a flicker of the home (a pointer being read again) must not lose a brief; the server answers `cancel` itself when the home really moved, and
      // the same word is waited out by the executor's existing "start unavailable" retry. Nothing reaches a model and no request is made while it waits.
      if (purpose === "start") {
        const may = computerMayServe(binding.deviceId, host); noteComputerGate("start", may);
        if (!may.ok) {
          // The wait has an end (companion-computer-gate.ts startWaitEnded): a day after it was stored, a computer that is not the home / a pairing that may not vouch closes it.
          let stored: string | null = null;
          try { stored = (getDb().prepare("SELECT created_at FROM one_supervisor_requests WHERE command_id=?").get(binding.commandId) as { created_at?: string } | undefined)?.created_at ?? null; } catch { /* no row readable: keep waiting */ }
          return startWaitEnded(may, stored) ? "cancel" : null;
        }
      }
      if (stopped || !session || !host || !one || typeof binding.deviceId !== "string" || binding.userId !== session.userId ||
          binding.workspaceId !== session.workspaceId || binding.hostId !== host || binding.oneId !== one) return null;
      const paired = pairing.deviceAccountBinding(binding.deviceId);
      if (!paired || paired.ownerUserId !== session.userId || paired.workspaceId !== session.workspaceId ||
          paired.accountSubject !== binding.accountSubject || paired.accountAuthorityOrigin !== account.origin) return null;
      const guard = () => {
        options.assertOwner();
        const current = getAuthenticatedSessionBinding(), device = pairing.deviceAccountBinding(binding.deviceId as string);
        if (stopped || !current || !device || current.sessionId !== session.sessionId || current.userId !== session.userId ||
            current.workspaceId !== session.workspaceId || device.issuedAt !== paired.issuedAt || device.ownerUserId !== session.userId ||
            device.workspaceId !== session.workspaceId || device.accountSubject !== paired.accountSubject ||
            device.accountAuthorityOrigin !== paired.accountAuthorityOrigin || hostId() !== host || options.oneId() !== one) throw new Error("companion_intake_scope_changed");
      };
      const credential = await loadNativeGuiCredential(captureNativeAuthBinding());
      guard();
      const client = createCompanionDirectIntakeClient({ webOrigin: webBaseUrl(), cookie: getSessionCookieHeader, assertCurrent: guard,
        signPoll: value => signNativeCompanionDirectPoll(credential, value),
        signClaim: (value, challenge) => signNativeCompanionDirectClaim(credential, value, challenge),
        signLifecycle: (kind, value, challenge, id) => signNativeCompanionDirectLifecycle(credential, kind, value, challenge, id) });
      return await client.lifecycle(purpose, binding, runId);
    } catch (error) {
      if (error instanceof CompanionIntakeRetryAfter) retryAt = Math.max(retryAt, Date.now() + error.retryAfterMs);
      return null;
    }
  }
  function hostId(): string | null {
    try {
      const row: unknown = JSON.parse(readFileSync(mobileBridgeHostIdentityPath(dir), "utf8"));
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const v = row as { hostId?: unknown; version?: unknown; createdAt?: unknown };
      return Object.keys(row).sort().join(",") === "createdAt,hostId,version" && v.version === MOBILE_BRIDGE_PROTOCOL_VERSION &&
        typeof v.createdAt === "string" && Number.isFinite(Date.parse(v.createdAt)) && typeof v.hostId === "string" && /^host_[a-f0-9]{32}$/.test(v.hostId) ? v.hostId : null;
    } catch { return null; }
  }
  async function sweep(): Promise<void> {
    if (stopped || Date.now() < retryAt) return;
    if (running) return running;
    running = (async () => {
      options.assertOwner();
      const session = getAuthenticatedSessionBinding(), host = hostId(), one = options.oneId();
      if (!session || !host || !one || !getSessionCookieHeader()) { keyCache = null; return; }
      // TR-desktop (trust-root.md E1 1-2): not the confirmed home = no key loaded and no request at all (the sweep is the existing 5 s one: nothing new polls).
      const standing = computerStandingForSweep(host);
      if (!standing.ok) { noteComputerGate("take", standing); return; }
      const devices = pairing.listDevices().filter(d => d.revokedAt === null);
      let served = false, unregistered = false, refusal: ComputerVerdict | null = null;
      for (const item of devices) {
        if (stopped) return;
        const paired = pairing.deviceAccountBinding(item.deviceId);
        if (!paired || paired.ownerUserId !== session.userId || paired.workspaceId !== session.workspaceId || paired.accountAuthorityOrigin !== account.origin) continue;
        // ... and a phone whose pairing record may not vouch (not made by this screen's QR, not pressed by the owner) is skipped before any request.
        const may = computerMayServe(item.deviceId, host);
        if (!may.ok) { refusal ??= may; continue; }
        // T1-3: a phone the service refused (403: this computer is not registered for it) is not asked again until a signal or one window (companion-computer-gate.ts directPollPaused).
        const pollKey = `${item.deviceId}|${paired.issuedAt}|${session.sessionId}|${host}|${one}`;
        if (directPollPaused(pollKey)) { refusal ??= { ok: false, why: "not_registered" }; continue; }
        served = true;
        const guard = () => {
          options.assertOwner();
          const current = getAuthenticatedSessionBinding(), device = pairing.deviceAccountBinding(item.deviceId);
          if (stopped || !current || !device || current.sessionId !== session.sessionId || current.userId !== session.userId ||
              current.workspaceId !== session.workspaceId || device.issuedAt !== paired.issuedAt || device.ownerUserId !== session.userId ||
              device.workspaceId !== session.workspaceId || device.accountSubject !== paired.accountSubject ||
              device.accountAuthorityOrigin !== paired.accountAuthorityOrigin || hostId() !== host || options.oneId() !== one) throw new Error("companion_intake_scope_changed");
        };
        try {
          guard();
          let credential = keyCache && keyCache.sessionId === session.sessionId && keyCache.until > Date.now() ? keyCache.credential : null;
          if (!credential) {
            credential = await loadNativeGuiCredential(captureNativeAuthBinding());
            guard();
            keyCache = { sessionId: session.sessionId, until: Date.now() + 60_000, credential };
          }
          guard();
          const client = createCompanionDirectIntakeClient({ webOrigin: webBaseUrl(), cookie: getSessionCookieHeader, assertCurrent: guard,
            signPoll: value => signNativeCompanionDirectPoll(credential, value),
            signClaim: (binding, challenge) => signNativeCompanionDirectClaim(credential, binding, challenge),
            holding: target => readDirectHolding(getDb, target), held: id => localHoldsCommand(getDb, "direct", id),   // R5/R8: read from the durable store on every poll
            mayTake: id => id === item.deviceId, onPollRefused: () => { unregistered = true; noteDirectPollRefused(pollKey); } });   // asked just above (may.ok): the same answer, not read again
          const payload = await client.receive({ userId: session.userId, deviceId: item.deviceId, hostId: host, oneId: one },
            b => b.userId === session.userId && b.workspaceId === session.workspaceId && b.accountSubject === paired.accountSubject &&
              b.deviceId === item.deviceId && b.hostId === host && b.oneId === one && Number.isSafeInteger(b.authEpoch) && Number(b.authEpoch) >= 0);
          guard();
          if (!payload) continue;
          const admission = createDaemonCompanionWorkAuthority({ actor: () => getAuthenticatedSessionBinding(),
            device: id => pairing.deviceAccountBinding(id), hostId, oneId: options.oneId, assertOwner: guard,
            accountActive: async device => device.accountAuthorityOrigin === account.origin && await account.accountAuthorityStatus({ accountSubject: device.accountSubject }) === "active",
            loadKey: loadCompanionWorkKey, receive: options.receive });
          await admission.admit(payload);
          guard();
        } catch (error) {
          // All paired devices share this process's outbound IP; stop polling
          // them together until the service's rate-limit window has passed.
          if (error instanceof CompanionIntakeRetryAfter) { retryAt = Math.max(retryAt, Date.now() + error.retryAfterMs); return; }
          noteTakeError("take", error);   // a web address the clients refuse is named (once), not swallowed
          /* Other failures keep the same command available for reconciliation. */
        }
      }
      noteComputerGate("take", unregistered ? { ok: false, why: "not_registered" } : served || !refusal ? { ok: true } : refusal);
    })().finally(() => { running = null; });
    return running;
  }
  function start() { if (timer || stopped) return; timer = setInterval(() => { void sweep().catch(() => undefined); }, interval); timer.unref?.(); void sweep().catch(() => undefined); }
  async function stop() { stopped = true; keyCache = null; if (timer) clearInterval(timer); timer = null; await running?.catch(() => undefined); }
  return Object.freeze({ start, stop, sweep, lifecycle });
}
