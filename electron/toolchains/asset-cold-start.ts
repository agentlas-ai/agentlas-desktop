// Main-only fresh-session discovery/selection. Not immutable execution or History's offline oracle.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolchainAsset, ToolchainAssetColdStart, ToolchainAssetVersion } from "../../shared/toolchain-asset";
import { COLD_START_POLICY, coldStartPassed } from "../../shared/toolchain";
import { sha256Value } from "../../shared/graph-execution-digest";
import { getToolchainAsset, toolchainSchemaProblems } from "./assets";
import { rankToolchainAssetCandidates } from "./search";
import { callToolchainPreparation, type ToolchainPreparationProducer } from "./preparation";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";

export const ASSET_FRESH_TEST_BUDGET_MS = 300_000;
export const ASSET_FRESH_RETEST_DELAY_MS = 600_000;
export interface AssetPublicationBinding { id: string; version: number; contentHash: string; assetRevision: number }
export interface NativeAssetPublicationLease {
  readonly registrationId: string; readonly intentId: string; readonly retest: "reuse" | "fresh"; readonly authorityRevision: string; readonly budgetRevision: string;
  readonly deadlineAt: number;
  readonly actor: Readonly<{ kind: "owner" | "one"; chatId: string | null }>;
  /** Only a genuine native owner's new registration may restore a withdrawn asset. */
  readonly mode: "register" | "owner-reregister";
  readonly catalog: readonly Readonly<AssetPublicationBinding>[];
  readonly runtime: ToolchainPreparationProducer;
  current(): boolean; release(): void;
  /** Exact visible example effects/expected output and provider cost approved by native owner. */
  assertExample(index: number, inputHash: string, expectedOutputHash: string, effectful: boolean): void;
  /** Original registration, result digest, authority/source/audience/budget and SQL domain.
   * Synchronously enter once; unknown acknowledgement never authorizes another dispatch. */
  withCurrentExclusion<T>(resultDigest: string, reducer: (scope: Readonly<{ current(): boolean }>) => T): Promise<Readonly<{
    state: "committed" | "denied" | "unknown"; value: T | null;
  }>>;
}
export interface NativeAssetPublicationAuthority {
  /** Original authority-owned registry object, never a serialized id or caller-selected key. */
  readonly identity: object;
  prepare(binding: Readonly<AssetPublicationBinding>): Promise<NativeAssetPublicationLease | null>;
}
export interface NativeAssetPublicationResolver {
  /** Original Main event/One caller object; never a serialized principal or grant. */
  resolve(input: Readonly<{ kind: "ipc" | "one"; caller: unknown; id: string; version: number }>): Promise<NativeAssetPublicationAuthority | null>;
}
let nativePublicationResolver: NativeAssetPublicationResolver | null = null;
export function configureNativeAssetPublicationResolver(resolver: NativeAssetPublicationResolver): void {
  if (nativePublicationResolver) throw Error("toolchain_publication_resolver_already_bound");
  nativePublicationResolver = resolver;
}
export async function resolveNativeAssetPublicationAuthority(input: { kind: "ipc" | "one"; caller: unknown; id: string; version: number }): Promise<NativeAssetPublicationAuthority> {
  if (!nativePublicationResolver) throw Error("UNBOUND_toolchain_publication_native_owner");
  const authority = await nativePublicationResolver.resolve(Object.freeze({ ...input }));
  if (!authority || !authority.identity || typeof authority.identity !== "object" || typeof authority.prepare !== "function") throw Error("UNBOUND_toolchain_publication_original_custody");
  return authority;
}
const copy = <T>(value: T): T => structuredClone(value);
function immutable<T>(value: T): T {
  const result = copy(value); const freeze = (v: unknown): void => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(result); return result;
}
function manifest(id: string, release: ToolchainAssetVersion) {
  return { toolchain_id: id, version: release.version, content_hash: release.contentHash, name: release.contract.name,
    purpose: release.contract.description, when_to_use: release.contract.whenToUse, when_not_to_use: release.contract.whenNotToUse,
    input_schema: release.contract.inputSchema, input_examples: release.contract.examples.map(e => e.input) };
}
const GENERATOR_PROMPT = [
  "Write routing test requests for this tool contract and the other currently permitted tools.",
  'Return ONLY JSON: {"positives":[5 strings],"negatives":[5 strings]}. Exactly five of each.',
  "Positives are different full-sentence realistic owner requests this tool handles, paraphrasing its purpose with concrete input values.",
  "Negatives are near-miss requests with a different outcome, opposite effect or another tool's job. Use the contract language. Do not execute anything.",
].join("\n");
const SELECTOR_PROMPT = [
  "You are a fresh assistant with no conversation history. Each task has only the contracts returned by actual search, possibly none.",
  "Choose a returned tool only when it clearly fits, otherwise null. Bind input exactly per its input_schema. Do not execute anything.",
  'Return ONLY JSON: {"answers":[{"task":index,"toolchain_id":string|null,"version":number|null,"content_hash":string|null,"input":object}]}. One answer for each of ten tasks; echo exact candidate identity/version/hash. For null use null version/hash and empty input.',
].join("\n");
function parse(text: string | null): Record<string, unknown> {
  try { const value = JSON.parse(text ?? ""); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* fail closed */ }
  throw Error("toolchain_cold_start_json_unreadable");
}
function probes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 5 || value.some(t => typeof t !== "string"
    || t.trim().length < 12 || t.length > 400 || !/\s/.test(t.trim()))) throw Error("toolchain_cold_start_exact_five_requests_required");
  const tasks = (value as string[]).map(t => t.trim());
  if (new Set(tasks).size !== 5) throw Error("toolchain_cold_start_distinct_requests_required");
  return tasks;
}
export interface AssetFreshSession {
  readonly lease: NativeAssetPublicationLease;
  readonly binding: Readonly<AssetPublicationBinding>;
  readonly catalogDigest: string;
  check(): void;
  test(): Promise<ToolchainAssetColdStart>;
  validateExample<T>(index: number, body: () => Promise<T>): Promise<T>;
  commit(result: unknown, reducer: () => ToolchainAsset): Promise<ToolchainAsset>;
  release(): void;
}
interface PublicationValidationCustody {
  readonly id: string; readonly version: number; readonly inputHash: string;
  readonly callerChatId: string | null; readonly permission: "read" | "write";
  readonly requestId: string; readonly ownerReregister: boolean;
  check(): void;
}
const publicationValidation = new AsyncLocalStorage<PublicationValidationCustody>();
/** Only an actual prepared publication session issues this custody. Serialized
 * call options cannot restore a withdrawn release or authorize another input. */
export function currentAssetPublicationValidation(input: {
  id: string; version: number; args: Record<string, unknown>; callerChatId: string | null;
  permission: "read" | "write"; requestId: string;
}): Readonly<{ ownerReregister: boolean; check(): void }> | null {
  const custody = publicationValidation.getStore();
  if (!custody) return null;
  custody.check();
  if (input.id !== custody.id || input.version !== custody.version
    || sha256Value(input.args) !== custody.inputHash || input.callerChatId !== custody.callerChatId
    || input.permission !== custody.permission || input.requestId !== custody.requestId)
    throw Error("toolchain_publication_validation_binding_changed");
  return Object.freeze({ ownerReregister: custody.ownerReregister, check: custody.check });
}
/** No discovery/ranking/paid call occurs before original native custody is available. */
export async function prepareAssetFreshSession(before: ToolchainAsset, release: ToolchainAssetVersion,
  authority: NativeAssetPublicationAuthority | undefined, signal?: AbortSignal): Promise<AssetFreshSession> {
  if (!authority || !authority.identity || typeof authority.identity !== "object" || typeof authority.prepare !== "function") throw Error("UNBOUND_toolchain_publication_native_owner");
  before = immutable(before); release = immutable(release);
  const binding = immutable({ id: before.id, version: release.version, contentHash: release.contentHash, assetRevision: before.revision });
  const lease = await authority.prepare(binding);
  const clean = (): void => { if (lease && typeof lease.release === "function") lease.release(); };
  try {
    if (!lease || !lease.intentId || !["reuse", "fresh"].includes(lease.retest) || lease.retest === "fresh" && lease.actor?.kind !== "owner" || !lease.registrationId || !lease.authorityRevision || !lease.budgetRevision || !lease.runtime
      || typeof lease.runtime.assertCurrent !== "function" || typeof lease.runtime.assertCandidate !== "function"
      || typeof lease.current !== "function" || typeof lease.release !== "function" || typeof lease.assertExample !== "function"
      || typeof lease.withCurrentExclusion !== "function" || !["owner", "one"].includes(lease.actor?.kind)
      || lease.actor.kind === "owner" && lease.actor.chatId !== null || lease.actor.kind === "one" && !lease.actor.chatId
      || !["register", "owner-reregister"].includes(lease.mode) || lease.mode === "owner-reregister" && lease.actor.kind !== "owner"
      || !Number.isFinite(lease.deadlineAt) || lease.deadlineAt <= Date.now() || lease.deadlineAt > Date.now() + ASSET_FRESH_TEST_BUDGET_MS + 1000
      || !Array.isArray(lease.catalog) || lease.catalog.length > COLD_START_POLICY.maxCallable)
      throw Error("UNBOUND_toolchain_publication_current_source_budget");
    if (before.status === "withdrawn" && lease.mode !== "owner-reregister") throw Error("toolchain_withdrawn_by_owner");
    const catalog = immutable(lease.catalog); const catalogDigest = sha256Value(catalog.map(({ id, version, contentHash }) => ({ id, version, contentHash })));
    if (new Set(catalog.map(c => c.id)).size !== catalog.length || !catalog.some(c => sha256Value(c) === sha256Value(binding)))
      throw Error("toolchain_cold_start_exact_catalog_required");
    const vector = () => sha256Value({ registrationId: lease.registrationId, intentId: lease.intentId,
      authorityRevision: lease.authorityRevision, budgetRevision: lease.budgetRevision, actor: lease.actor,
      deadlineAt: lease.deadlineAt, mode: lease.mode, retest: lease.retest, catalog: lease.catalog });
    const originalVector = vector();
    let closed = false;
    const checkAuthority = (): void => {
      signal?.throwIfAborted();
      if (closed || vector() !== originalVector || Date.now() >= lease.deadlineAt || lease.current() !== true) throw Error("toolchain_publication_authority_changed");
      lease.runtime.assertCurrent("fresh-session-evaluation");
    };
    const candidates = () => catalog.map(c => {
      const asset = getToolchainAsset(c.id), v = asset?.versions.find(v => v.version === c.version);
      if (!asset || !v || asset.revision !== c.assetRevision || v.contentHash !== c.contentHash
        || c.id !== binding.id && (asset.status !== "callable" || asset.stableVersion !== v.version || v.validation.state !== "passed"))
        throw Error("toolchain_cold_start_catalog_changed");
      return { id: c.id, release: v };
    });
    const check = (): void => {
      checkAuthority(); const current = getToolchainAsset(binding.id), v = current?.versions.find(v => v.version === binding.version);
      if (!current || current.revision !== binding.assetRevision || !v || v.contentHash !== binding.contentHash
        || current.status === "withdrawn" && lease.mode !== "owner-reregister") throw Error("toolchain_changed_during_test");
      candidates(); checkAuthority();
    };
    check();
    const session: AssetFreshSession = {
      lease, binding, catalogDigest, check,
      async validateExample(index, body) {
        check();
        const example = release.contract.examples[index];
        if (!Number.isSafeInteger(index) || index < 0 || !example) throw Error("toolchain_publication_validation_example_invalid");
        const permission = requiredExecutionPermission(release.implementation.snapshot.graph) === "write" ? "write" : "read";
        lease.assertExample(index, sha256Value(example.input), sha256Value(example.expectedOutput), permission === "write");
        let active = true;
        const current = () => { if (!active) throw Error("toolchain_publication_validation_custody_closed"); check(); };
        const custody: PublicationValidationCustody = Object.freeze({
          id: binding.id, version: binding.version, inputHash: sha256Value(example.input),
          callerChatId: lease.actor.chatId, permission,
          requestId: "validation:" + binding.contentHash + ":" + index,
          ownerReregister: lease.mode === "owner-reregister" && lease.actor.kind === "owner",
          check: current,
        });
        return publicationValidation.run(custody, async () => {
          try { current(); const result = await body(); current(); return result; }
          finally { active = false; }
        });
      },
      async test() {
        check();
        const old = release.coldStart;
        if (old?.toolchainId === binding.id && old.version === binding.version && old.contentHash === binding.contentHash && old.catalogDigest === catalogDigest && old.schemaVersion === "agentlas.toolchain-asset-cold-start.v1"
          && old.runtimeReceipts.length === 2 && old.cases.length === 10 && old.positives === 5 && old.negatives === 5
          && (!old.passed || old.positiveFound === 5 && coldStartPassed(old))
          && old.runtimeReceipts.every(r => r.execution === "invoked" && r.capability?.status === "verified")
          && Number.isFinite(Date.parse(old.at)) && Date.parse(old.at) <= Date.now() + 30000
          && (old.nativeIntentId === lease.intentId || lease.retest === "reuse" && (old.passed || Date.now() - Date.parse(old.at) < ASSET_FRESH_RETEST_DELAY_MS))) return copy(old);
        const pool = candidates();
        const generated = await callToolchainPreparation({ purpose: "fresh-session-evaluation", producer: lease.runtime,
          systemPrompt: GENERATOR_PROMPT, input: JSON.stringify({ contract: manifest(binding.id, release),
            other_tools: pool.filter(c => c.id !== binding.id).map(c => manifest(c.id, c.release)) }), deadlineAt: lease.deadlineAt, signal });
        check(); if (!generated.text || !generated.runtimeReceipt) throw Error("toolchain_cold_start_generation_unavailable");
        const data = parse(generated.text), positives = probes(data.positives), negatives = probes(data.negatives), tasks = [...positives, ...negatives];
        if (new Set(tasks).size !== 10) throw Error("toolchain_cold_start_distinct_requests_required");
        const searched = tasks.map(task => rankToolchainAssetCandidates(task, pool, COLD_START_POLICY.searchLimit));
        check();
        const selected = await callToolchainPreparation({ purpose: "fresh-session-evaluation", producer: lease.runtime,
          systemPrompt: SELECTOR_PROMPT, input: JSON.stringify({ tasks: tasks.map((task, index) => ({ index, task,
            candidates: searched[index].map(c => manifest(c.id, c.release)) })) }), deadlineAt: lease.deadlineAt, signal });
        check(); if (!selected.text || !selected.runtimeReceipt) throw Error("toolchain_cold_start_selection_unavailable");
        const answerData = parse(selected.text);
        if (!Array.isArray(answerData.answers) || answerData.answers.length !== 10) throw Error("toolchain_cold_start_exact_answers_required");
        const answers = new Map<number, Record<string, unknown>>();
        for (const a of answerData.answers) {
          if (!a || typeof a !== "object" || Array.isArray(a) || !Number.isInteger(a.task) || a.task < 0 || a.task > 9 || answers.has(a.task)
            || !a.input || typeof a.input !== "object" || Array.isArray(a.input) || Buffer.byteLength(JSON.stringify(a.input)) > 64 * 1024)
            throw Error("toolchain_cold_start_answer_binding_invalid");
          if (a.toolchain_id === null) {
            if (a.version !== null || a.content_hash !== null || Object.keys(a.input).length) throw Error("toolchain_cold_start_null_binding_invalid");
          } else if (!searched[a.task].some(c => c.id === a.toolchain_id && c.release.version === a.version && c.release.contentHash === a.content_hash))
            throw Error("toolchain_cold_start_choice_not_returned");
          answers.set(a.task, a);
        }
        const cases = tasks.map((task, index) => {
          const a = answers.get(index)!, chosen = searched[index].find(c => c.id === a.toolchain_id);
          const selectedThis = a.toolchain_id === binding.id;
          return { kind: index < 5 ? "positive" as const : "negative" as const, task,
            found: searched[index].some(c => c.id === binding.id), selected: selectedThis,
            bound: selectedThis && toolchainSchemaProblems(release.contract.inputSchema, a.input).length === 0,
            candidates: searched[index].map(c => ({ id: c.id, version: c.release.version, contentHash: c.release.contentHash })),
            chosen: chosen ? { id: chosen.id, version: chosen.release.version, contentHash: chosen.release.contentHash } : null,
            input: copy(a.input) as Record<string, unknown> };
        });
        const r = selected.runtimeReceipt;
        const result: ToolchainAssetColdStart = { schemaVersion: "agentlas.toolchain-asset-cold-start.v1", toolchainId: binding.id,
          version: binding.version, contentHash: binding.contentHash, nativeIntentId: lease.intentId, catalogDigest, at: new Date().toISOString(),
          positives: 5, positiveFound: cases.slice(0, 5).filter(c => c.found).length,
          positiveSelected: cases.slice(0, 5).filter(c => c.selected).length, positiveBound: cases.slice(0, 5).filter(c => c.bound).length,
          negatives: 5, negativeSelected: cases.slice(5).filter(c => c.selected).length, passed: false,
          model: `${[r.selection.kind, r.selection.model].filter(Boolean).join(":")} via ${r.route}`,
          cases, runtimeReceipts: copy([generated.runtimeReceipt, selected.runtimeReceipt]) };
        result.passed = result.positiveFound === 5 && coldStartPassed(result);
        check(); return result;
      },
      async commit(result, reducer) {
        check(); let entered = false, open = true, value: ToolchainAsset | null = null;
        const answer = await lease.withCurrentExclusion(sha256Value({ binding, catalogDigest, result,
          actor: lease.actor, authorityRevision: lease.authorityRevision }), scope => {
          if (!open || entered || !scope || typeof scope.current !== "function" || scope.current() !== true) throw Error("toolchain_publication_owner_exclusion_required");
          entered = true; check();
          value = reducer();
          if (value && typeof value === "object" && "then" in value) throw Error("toolchain_publication_sync_commit_required");
          checkAuthority(); if (scope.current() !== true) throw Error("toolchain_publication_owner_exclusion_changed");
          return value;
        }).finally(() => { open = false; });
        if (!answer || answer.state !== "committed" || !entered || !value || answer.value !== value) throw Error("toolchain_publication_effect_unconfirmed");
        const saved = getToolchainAsset(binding.id);
        if (!saved || sha256Value(saved) !== sha256Value(value)) throw Error("toolchain_publication_readback_unconfirmed");
        return value;
      },
      release() { closed = true; clean(); },
    };
    return session;
  } catch (error) { clean(); throw error; }
}
