import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeSelection } from "../../shared/types";
import type { ToolchainCallReceipt, ToolchainGenerationResult } from "../../shared/toolchain-asset";
import type { BusinessOpaqueSource } from "../../shared/business/native-registry";
import type { ToolchainPreparationProducer, ToolchainPreparationPurpose } from "../toolchains/preparation";
import type { ToolchainPreparedProposal } from "../toolchains/generalizer";
import { configureNativeToolchainReportPorts } from "../toolchains/reports";
import { createDefaultOneToolchainNativeRegistration, type OneToolchainResourceOwnerPort,
  type OneToolchainBusinessFacade, type OneToolchainOriginalWork, type OneToolchainOriginalWorkToken } from "./toolchain-native-registration";

type Registration = Awaited<ReturnType<typeof createDefaultOneToolchainNativeRegistration>>;
/** Supplied by the EXISTING invocation owner. This is never a child/renderer DTO.
 * The source must preserve its original cancellation, retained work and candidate grant. */
export interface OneToolchainPreparationOwnerPort {
  signal(original: Readonly<OneToolchainOriginalWork>): AbortSignal;
  assertCurrent(original: Readonly<OneToolchainOriginalWork>, purpose: ToolchainPreparationPurpose): void;
  assertCandidate(original: Readonly<OneToolchainOriginalWork>, purpose: ToolchainPreparationPurpose, selection: Readonly<RuntimeSelection>): void;
  withLifetime<T>(original: Readonly<OneToolchainOriginalWork>, body: () => Promise<T>): Promise<T>;
  producedSources(original: Readonly<OneToolchainOriginalWork>, result: Readonly<ToolchainGenerationResult>): Promise<readonly BusinessOpaqueSource[]>;
  /** Existing owner serialized write domain; an async allow followed by local
   * SQL cannot implement this sink. Missing binding refuses prepared commit. */
  withPreparedCommit?(original: Readonly<OneToolchainOriginalWork>, proposal: Readonly<ToolchainPreparedProposal>,
    reducer: (scope: Readonly<{ current(): boolean; authorityRevision: string }>) => ToolchainGenerationResult):
    Promise<{ state: "committed" | "denied" | "unknown"; value: ToolchainGenerationResult | null }>;
}
export interface OneToolchainExecutionOwnerPort {
  signal(original: Readonly<OneToolchainOriginalWork>): AbortSignal;
  assertCurrent(original: Readonly<OneToolchainOriginalWork>, call: Readonly<ToolchainCallReceipt>): void;
  /** Original resource/effect lifetime and cancellation, never a new queue/run. */
  withLifetime<T>(original: Readonly<OneToolchainOriginalWork>, call: Readonly<ToolchainCallReceipt>, body: () => Promise<T>): Promise<T>;
}
export interface OneToolchainNativeOwnerPorts {
  owners: OneToolchainResourceOwnerPort;
  business: OneToolchainBusinessFacade;
  preparation: OneToolchainPreparationOwnerPort | null;
  execution?: OneToolchainExecutionOwnerPort | null;
}
interface NativeBinding { chatId?: string | null; supervisorReplyRunId?: string; historySource?: { runId: string }; personalSource?: { runId: string } }
interface Capability {
  binding: NativeBinding; current(): boolean; live: boolean;
  registration?: Registration; token?: OneToolchainOriginalWorkToken;
  pending?: Promise<OneToolchainOriginalWorkToken>;
}
let ownerPorts: OneToolchainNativeOwnerPorts | null = null;
let registering: Promise<Registration> | null = null;
const capabilities = new WeakMap<object, Capability>(), retained = new Set<Capability>();
const active = new AsyncLocalStorage<Capability>();
function unavailable(reason: string): never { throw Error(reason); }

/** Once-only trusted startup hookup. Construction performs no login, grant or provider call. */
export function configureOneToolchainNativeOwnerPorts(ports: OneToolchainNativeOwnerPorts): void {
  if (!ports.owners || !ports.business) unavailable("toolchain_native_shipping_owner_ports_unbound");
  if (ownerPorts && ownerPorts !== ports) unavailable("toolchain_native_owner_domain_already_bound");
  ownerPorts = ports;
}
async function registration(): Promise<Registration> {
  const ports = ownerPorts ?? unavailable("toolchain_native_shipping_owner_ports_unbound");
  if (!registering) registering = createDefaultOneToolchainNativeRegistration(ports).then(value => {
    if (ownerPorts !== ports) unavailable("toolchain_native_owner_domain_changed");
    configureNativeToolchainReportPorts(value.reportAdmissionPort); return value;
  }).catch(error => { registering = null; throw error; });
  return registering;
}
/** Called only while the native server mints its real binding. A JSON copy cannot reuse it. */
export function registerOneToolchainNativeCapability(binding: NativeBinding, current: () => boolean): void {
  if (capabilities.has(binding) || current() !== true) unavailable("toolchain_native_capability_invalid");
  const capability: Capability = { binding, current, live: true };
  capabilities.set(binding, capability); retained.add(capability);
}
function assertCapability(capability: Capability): void {
  if (!capability.live || capabilities.get(capability.binding) !== capability || capability.current() !== true)
    unavailable("toolchain_native_capability_revoked");
}
async function original(capability: Capability): Promise<OneToolchainOriginalWorkToken> {
  assertCapability(capability);
  if (capability.token) return capability.token;
  if (capability.pending) return capability.pending;
  capability.pending = (async () => {
    const registered = await registration(); assertCapability(capability);
    const chatId = capability.binding.chatId, runId = capability.binding.supervisorReplyRunId
      ?? capability.binding.historySource?.runId ?? capability.binding.personalSource?.runId;
    if (!chatId || !runId) unavailable("toolchain_native_original_command_required");
    const { getDb } = await import("../store/db"); assertCapability(capability);
    const rows = getDb().prepare("SELECT command_id FROM one_supervisor_requests WHERE run_id=? AND kind IN ('work','reply') AND state IN ('dispatching','accepted')")
      .all(runId) as Array<{ command_id: string }>;
    if (rows.length !== 1) unavailable("toolchain_native_original_command_required");
    const token = registered.bindRun({ commandId: rows[0].command_id, runId, chatId });
    capability.registration = registered; capability.token = token;
    try { assertCapability(capability); } catch (error) { registered.forget(token); throw error; }
    return token;
  })().finally(() => { capability.pending = undefined; });
  return capability.pending;
}
export async function withOneToolchainNativeInvocation<T>(binding: NativeBinding, body: () => Promise<T>): Promise<T> {
  const capability = capabilities.get(binding) ?? unavailable("toolchain_native_capability_required");
  const token = await original(capability), registered = capability.registration!;
  assertCapability(capability);
  return active.run(capability, () => registered.withOriginalWork(token, async () => {
    assertCapability(capability); const result = await body(); assertCapability(capability); return result;
  }));
}
export function currentOneToolchainNativeInvocation() {
  const capability = active.getStore() ?? unavailable("toolchain_native_original_command_required");
  const registered = capability.registration!, token = capability.token!;
  const assertCurrent = (): OneToolchainOriginalWork => { assertCapability(capability); return registered.assertToken(token); };
  const work = assertCurrent();
  return {
    original: work, assertCurrent,
    async registerCall(call: ToolchainCallReceipt) { assertCurrent(); const value = await registered.registerCall(token, call); assertCurrent(); return value; },
    assertPreparedCommitBound() {
      assertCurrent();
      if (typeof ownerPorts?.preparation?.withPreparedCommit !== "function") unavailable("toolchain_native_prepared_owner_effect_unbound");
    },
    execution() {
      const owner = ownerPorts?.execution ?? unavailable("toolchain_native_execution_owner_unbound");
      const signal = owner.signal(assertCurrent()); signal.throwIfAborted();
      return { signal, async run<T>(call: Readonly<ToolchainCallReceipt>, body: () => Promise<T>): Promise<T> {
        if (call.callerChatId !== work.chatId || call.parentRunId !== work.runId)
          unavailable("toolchain_native_actual_call_producer_required");
        const check = () => { signal.throwIfAborted(); owner.assertCurrent(assertCurrent(), call); signal.throwIfAborted(); };
        check(); let open = true, calls = 0, completed = false, value: T | undefined;
        try {
          const returned = await owner.withLifetime(work, call, async () => {
            if (!open || ++calls !== 1) unavailable("toolchain_native_execution_lifetime_invalid");
            check(); const result = await body();
            if (!open) unavailable("toolchain_native_execution_lifetime_invalid");
            check(); value = result; completed = true; return result;
          });
          check();
          if (calls !== 1 || !completed || !Object.is(returned, value)) unavailable("toolchain_native_execution_lifetime_invalid");
          return returned;
        } finally { open = false; }
      } };
    },
    async withPreparedCommit(proposal: Readonly<ToolchainPreparedProposal>, commit: () => ToolchainGenerationResult): Promise<ToolchainGenerationResult> {
      const owner = ownerPorts?.preparation ?? unavailable("toolchain_native_preparation_owner_unbound");
      if (typeof owner.withPreparedCommit !== "function") unavailable("toolchain_native_prepared_owner_effect_unbound");
      const { getDb } = await import("../store/db"); assertCurrent();
      const db = getDb(), signal = owner.signal(assertCurrent()); signal.throwIfAborted();
      let open = true, calls = 0, produced = false, value: ToolchainGenerationResult | null = null;
      let boundScope: Readonly<{ current(): boolean; authorityRevision: string }> | null = null;
      let authorityRevision: string | null = null;
      const check = (inside: boolean) => {
        signal.throwIfAborted(); assertCurrent(); owner.assertCurrent(assertCurrent(), "generalization");
        if (!boundScope || typeof authorityRevision !== "string" || !authorityRevision.trim()
          || authorityRevision.length > 500 || /[\u0000-\u001f]/.test(authorityRevision)
          || boundScope.authorityRevision !== authorityRevision || boundScope.current() !== true
          || getDb() !== db || inside && !db.inTransaction)
          unavailable("toolchain_native_prepared_same_owner_sql_required");
        signal.throwIfAborted();
      };
      try {
        const result = await owner.withPreparedCommit(work, proposal, scope => {
          if (!open || ++calls !== 1) unavailable("toolchain_native_prepared_commit_once_required");
          boundScope = scope; authorityRevision = scope.authorityRevision;
          check(true); const committed = commit();
          if (!committed || typeof committed !== "object" || typeof (committed as unknown as { then?: unknown }).then === "function")
            unavailable("toolchain_native_prepared_sync_result_required");
          check(true); value = committed; produced = true; return committed;
        });
        check(false);
        if (result.state !== "committed" || calls !== 1 || !produced || !Object.is(result.value, value))
          unavailable("toolchain_native_prepared_commit_unconfirmed");
        return result.value!;
      } finally { open = false; }
    },
    preparation(purpose: ToolchainPreparationPurpose) {
      const owner = ownerPorts?.preparation ?? unavailable("toolchain_native_preparation_owner_unbound");
      if (work.budgetId === null || work.budgetRevision === null) unavailable("toolchain_native_admitted_budget_required");
      assertCurrent(); owner.assertCurrent(assertCurrent(), purpose);
      const signal = owner.signal(work);
      const check = () => { signal.throwIfAborted(); const current = assertCurrent(); owner.assertCurrent(current, purpose); signal.throwIfAborted(); };
      check();
      const samePurpose = (requested: ToolchainPreparationPurpose) => { if (requested !== purpose) unavailable("toolchain_native_preparation_purpose_changed"); check(); };
      const producer: ToolchainPreparationProducer = { assertCurrent: requested => samePurpose(requested),
        assertCandidate: (requested, selection) => { samePurpose(requested); owner.assertCandidate(assertCurrent(), purpose, selection); check(); } };
      return { signal, producer, async run<T>(body: () => Promise<T>): Promise<T> {
        check();
        let open = true, calls = 0, completed = false, value: T | undefined;
        try {
          const returned = await owner.withLifetime(work, async () => {
            if (!open || ++calls !== 1) unavailable("toolchain_native_preparation_lifetime_invalid");
            check(); const result = await body();
            if (!open) unavailable("toolchain_native_preparation_lifetime_invalid");
            check(); value = result; completed = true; return result;
          });
          check();
          if (calls !== 1 || !completed || !Object.is(returned, value)) unavailable("toolchain_native_preparation_lifetime_invalid");
          return returned;
        } finally { open = false; }
      } };
    },
    async registerProduced(result: ToolchainGenerationResult) {
      const release = result.asset.versions.find(version => version.version === result.version)
        ?? unavailable("toolchain_native_immutable_release_changed");
      const ref = { toolchainId: result.asset.id, version: release.version, contentHash: release.contentHash };
      if (result.decision === "reuse") {
        const value = await registered.resolveRelease(token, ref); assertCurrent(); return value;
      }
      const owner = ownerPorts?.preparation ?? unavailable("toolchain_native_source_registration_unbound");
      const sources = await owner.producedSources(assertCurrent(), result); assertCurrent();
      return registered.registerProduced(token, ref, sources);
    },
  };
}
/** Terminal cleanup does not depend on successful authorization, lookup or provider state. */
export function forgetOneToolchainNativeCapability(binding: object): void {
  const capability = capabilities.get(binding); if (!capability) return;
  capability.live = false; capabilities.delete(binding); retained.delete(capability);
  if (capability.registration && capability.token && capability.registration.forget(capability.token).state === "unknown")
    unavailable("toolchain_native_admission_release_unconfirmed");
}
export function forgetAllOneToolchainNativeCapabilities(): void {
  const errors: unknown[] = [];
  for (const capability of [...retained]) {
    try { forgetOneToolchainNativeCapability(capability.binding); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
}
