import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { SupervisorTask } from "../../shared/one-supervisor";
import { MOBILE_BRIDGE_PROTOCOL_VERSION } from "../../shared/mobile-bridge";
import { COMPANION_WORK_FULL_MAX_BYTES } from "../../shared/companion-handoff-proof";
import { getAuthenticatedSessionBinding, webBaseUrl } from "../auth";
import { userDataDir } from "../runtime-paths";
import { MobileBridgePairingManager, mobileBridgeHostIdentityPath } from "../mobile-bridge/pairing";
import { MobileBridgeAccountPairingClient } from "../mobile-bridge/account-pairing";
import { captureNativeAuthBinding, loadNativeGuiCredential, signNativeCompanionDirectPoll, signNativeCompanionDirectClaim, signNativeCompanionDirectLifecycle } from "../daemon/native-auth-credentials";
import { createCompanionWorkReceiptOwner, readCompanionRetirementReceipt } from "./companion-work-receipt";
import { createCompanionDirectIntakeClient } from "./companion-direct-intake-client";
import { createCompanionWorkDelivery } from "./companion-work-delivery";
import { installCompanionDeliverySignalSources, onCompanionDeliverySignal } from "./companion-delivery-signals";
import { onHomeCauseEnded } from "./home-signal";
import { onExternalWrite } from "../store/external-writer-presence";
import { createCompanionWorkDeliveryClient } from "./companion-work-delivery-client";

/** Installed by whichever local host currently owns the Supervisor domain.
 * All account/device data is read again before signing and before delivery. */
export function createCompanionWorkDeliveryRuntime(options: { db: Database.Database; tasks(): SupervisorTask[]; oneId(): string; assertOwner(): void;
  assertRetirementOwner(): void; retirementScope():{userId:string;workspaceId:string;oneId:string}|null;
  noStartProof(runId: string): boolean; nativeReceipt(runId: string): unknown; retireUnstarted(commandId: string): void | Promise<void>;
  carrierRunId?(runId:string,chatId:string):string|null; executionEvidence?:boolean }) {
  const dir = userDataDir(), pairing = new MobileBridgePairingManager(dir);
  function hostId(): string | null {
    try {
      const row: unknown = JSON.parse(readFileSync(mobileBridgeHostIdentityPath(dir), "utf8"));
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const value = row as { hostId?: unknown; version?: unknown; createdAt?: unknown };
      return Object.keys(row).sort().join(",") === "createdAt,hostId,version" && value.version === MOBILE_BRIDGE_PROTOCOL_VERSION &&
        typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) && typeof value.hostId === "string" &&
        /^host_[a-f0-9]{32}$/.test(value.hostId) ? value.hostId : null;
    } catch { return null; }
  }
  function current(binding: Record<string, unknown>) {
    options.assertOwner();
    if (typeof binding.deviceId !== "string") throw new Error("companion_delivery_scope_invalid");
    const session = getAuthenticatedSessionBinding(), paired = pairing.deviceAccountBinding(binding.deviceId), host = hostId(), oneId = options.oneId();
    if (!session || !paired || !host || binding.userId !== session.userId || binding.workspaceId !== session.workspaceId ||
        paired.ownerUserId !== session.userId || paired.workspaceId !== session.workspaceId || paired.accountSubject !== binding.accountSubject ||
        binding.hostId !== host || binding.oneId !== oneId || !Number.isSafeInteger(binding.authEpoch) || Number(binding.authEpoch) < 0)
      throw new Error("companion_delivery_scope_changed");
    return { session, paired, host, oneId, deviceId: binding.deviceId, authEpoch: Number(binding.authEpoch) };
  }
  const owners = new Map<string, ReturnType<typeof createCompanionWorkReceiptOwner>>();
  async function ownerFor(commandId: string) {
    const row = options.db.prepare("SELECT binding_json FROM one_companion_handoffs WHERE command_id=?").get(commandId) as { binding_json: string } | undefined;
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as Record<string, unknown>, captured = current(binding);
    const guard = () => {
      const next = current(binding);
      if (next.session.sessionId !== captured.session.sessionId || next.paired.issuedAt !== captured.paired.issuedAt ||
          next.paired.accountAuthorityOrigin !== captured.paired.accountAuthorityOrigin) throw new Error("companion_delivery_scope_changed");
    };
    const account = new MobileBridgeAccountPairingClient();
    if (account.origin !== captured.paired.accountAuthorityOrigin || await account.accountAuthorityStatus({ accountSubject: captured.paired.accountSubject }) !== "active") return null;
    guard();
    const credential = await loadNativeGuiCredential(captureNativeAuthBinding());
    guard();
    const identity = { userId: captured.session.userId, workspaceId: captured.session.workspaceId, authEpoch: captured.authEpoch,
      accountSubject: captured.paired.accountSubject, deviceId: captured.deviceId, hostId: captured.host, oneId: captured.oneId };
    const owner = createCompanionWorkReceiptOwner({ db: options.db, credential, identity: () => { guard(); return identity; }, tasks: options.tasks, assertCurrent: guard, carrierRunId:options.carrierRunId,
      ...(options.executionEvidence ? {executionReceipt:options.nativeReceipt} : {}) });
    owners.delete(commandId); owners.set(commandId, owner);
    while (owners.size > 20) owners.delete(owners.keys().next().value!);
    return owner;
  }
  let client: ReturnType<typeof createCompanionWorkDeliveryClient> | null = null, clientOrigin = "";
  const deliveryClient = () => {
    const origin = webBaseUrl();
    if (!client || origin !== clientOrigin) { client = createCompanionWorkDeliveryClient({ baseUrl: origin }); clientOrigin = origin; }
    return client;
  };
  const startGateStillOwnsIt = (binding: Record<string, unknown>): boolean => { try { current(binding); return true; } catch { return false; } };
  const retirementReceipts = new WeakSet<object>();
  async function retirement(commandId: string) {
    try {
      options.assertRetirementOwner();
      const row = options.db.prepare(`SELECT h.binding_json,r.run_id FROM one_companion_handoffs h JOIN one_supervisor_requests r ON r.command_id=h.command_id WHERE h.command_id=?`)
        .get(commandId) as {binding_json:string;run_id:string} | undefined;
      if (!row || !row.run_id) return null;
      const binding = JSON.parse(row.binding_json) as Record<string, unknown>, host = hostId();
      const scope=options.retirementScope();
      if (!scope || !host || binding.hostId !== host || binding.commandId !== commandId ||
          binding.userId !== scope.userId || binding.workspaceId !== scope.workspaceId || binding.oneId !== scope.oneId) return null;
      // direct-work-capacity R11: this lane is for a task the ordinary path can no longer start or close - the signed-in account, the pairing or the host
      // authority it was taken under is gone. While all three still hold, the executor's own start gate (`start`: authorized | existing | cancel) is the one
      // that asks the server before anything is dispatched, so a row waiting for it is not asked about here: a service that answers `cancel` for a row
      // that has no run yet (before R10) must not close a task the phone has just handed over. A value, not an age.
      if (startGateStillOwnsIt(binding)) return null;
      const guard = () => { options.assertRetirementOwner(); if (hostId() !== host) throw new Error("companion_retirement_scope_changed"); };
      const credential = await loadNativeGuiCredential(captureNativeAuthBinding()); guard();
      const client = createCompanionDirectIntakeClient({webOrigin:webBaseUrl(),cookie:()=>null,assertCurrent:guard,
        signPoll:value=>signNativeCompanionDirectPoll(credential,value),
        signClaim:(value,challenge)=>signNativeCompanionDirectClaim(credential,value,challenge),
        signLifecycle:(kind,value,challenge,runId)=>signNativeCompanionDirectLifecycle(credential,kind,value,challenge,runId)});
      if (!await client.retirement(binding,row.run_id)) return null;
      guard();
      await options.retireUnstarted(commandId); guard();
      const value = readCompanionRetirementReceipt({db:options.db,credential,commandId,assertOwner:guard,
        noStartProof:options.noStartProof,nativeReceipt:options.nativeReceipt,carrierRunId:options.carrierRunId});
      if (value) retirementReceipts.add(value);
      return value;
    } catch { return null; }
  }
  const worker = createCompanionWorkDelivery({ db: options.db, candidates: "terminal", read: async (commandId) => {
    try { const normal = (await ownerFor(commandId))?.read(commandId); if (normal) return normal; } catch { /* The session may already be gone. */ }
    return null;
  }, assertCurrent: options.assertOwner,
    send: async (value) => {
      // The signed receipt itself is never used as current-account evidence.
      current(value.receipt as unknown as Record<string, unknown>);
      const sent = await deliveryClient().send(value);
      current(value.receipt as unknown as Record<string, unknown>);
      return sent;
    },
    readFullChunk: async (commandId, index) => {
      const row = options.db.prepare("SELECT length(CAST(result_text AS BLOB)) AS bytes FROM one_companion_work_full_results WHERE command_id=?").get(commandId) as { bytes: number } | undefined;
      if (!row || row.bytes > COMPANION_WORK_FULL_MAX_BYTES) return null;
      const prior = owners.get(commandId), chunk = prior?.readFullChunk(commandId, index);
      if (chunk) return chunk;
      owners.delete(commandId);
      return (await ownerFor(commandId))?.readFullChunk(commandId, index) ?? null;
    },
    sendFullChunk: async (value) => {
      current(value.chunk);
      const result = await deliveryClient().sendFullChunk(value);
      current(value.chunk);
      return result;
    } });
  // The original One owner can attest a stopped run for a short period after
  // sign-out, even though the ordinary account-bound delivery is now fenced.
  // This lane can send only the opaque, empty interrupted proof made above.
  const retiredWorker = createCompanionWorkDelivery({db:options.db,assertCurrent:options.assertRetirementOwner,candidates:"retirement",unreadableIsIdle:true,
    read:retirement,send:async value=>{
      const r=value.receipt;
      if(!retirementReceipts.has(value) || value.truncated || r.state!=="interrupted" || r.result!=="" ||
          r.resultVerified!==false || r.fullResultPending!==false) return {kind:"skip"};
      options.assertRetirementOwner();const sent=await deliveryClient().send(value);options.assertRetirementOwner();return sent;
    }});
  // direct-work-capacity R8: no period. A receipt is sent when a signal says there may be one to send - a task ended (the host calls `sweep`; a
  // settled run or a row that ended in a restart), the app started, the account or pairing changed, the server answered again, the computer woke -
  // and again by the workers' single retry timer only while the server has not taken one.
  let offSignals: Array<() => void> = [], pokeTimer: ReturnType<typeof setTimeout> | null = null;
  // In order: the retirement lane only asks about what the ordinary lane could not deliver (it costs the server a status question per row).
  const sweepBoth = async () => { await worker.sweep().catch(() => undefined); await retiredWorker.sweep().catch(() => undefined); };
  // R11: a store write is not a reason to ask the server about an unstarted claim, so a poke reaches the ordinary lane only. The retirement lane is
  // asked by `sweepBoth` (app start, account / pairing change, the server answering again, wake from sleep, a task's end) and, even then, only
  // about a row the start gate can no longer reach (`startGateStillOwnsIt`).
  const pokeOrdinary = async () => { await worker.poke().catch(() => undefined); };
  // A task's end is announced by the supervisor store after its commit (home-signal.ts "personal_agent": also a request a restart settled) and, when another
  // process (the background service) ran the task, by Main's data_version watch (onExternalWrite). Both are only "look for receipts nobody tried yet": a local read
  // behind one short debounce (a streaming chat writes often); a waiting retry keeps its interval.
  const schedulePoke = () => { if (pokeTimer) return; pokeTimer = setTimeout(() => { pokeTimer = null; void pokeOrdinary(); }, 500); pokeTimer.unref?.(); };
  return Object.freeze({
    start() {
      if (offSignals.length) return;
      offSignals = [installCompanionDeliverySignalSources(), onCompanionDeliverySignal(() => { void sweepBoth(); }),
        onHomeCauseEnded(cause => { if (cause === "personal_agent") schedulePoke(); }), onExternalWrite(schedulePoke)];
      worker.start(); retiredWorker.start();
    },
    async stop() { for (const off of offSignals.splice(0)) off(); if (pokeTimer) { clearTimeout(pokeTimer); pokeTimer = null; } await Promise.all([worker.stop(),retiredWorker.stop()]); },
    sweep: sweepBoth,
    poke: pokeOrdinary,
  });
}
