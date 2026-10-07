import { createHash } from "node:crypto";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { AdapterEffectAdmission, AdapterEffectReport } from "../invocation/adapter-effect-context";
import type { RunnerFailure } from "../runtime/runner";
import { selectionForRuntime } from "../../shared/runtime-selection";
import { getDb } from "../store/db";
import { listModelRoleMembers } from "../store/model-roles";
import { runtimeCooldown } from "../runtime/runtime-cooldown";
import { isRuntimeCredentialUnavailable } from "../runtime/credential-access";
import { pinnedRuntimeCredentialOrModelUnavailable, rolePriorityRuntimes,
  runtimeFailureBlocksReplay, selectExactRuntime } from "../runtime/selection";

export function graphWorkerIdentity(selection: RuntimeSelection): string {
  return JSON.stringify([selection.kind, selection.backend ?? null, selection.source ?? null,
    selection.acpAgentId ?? null, selection.model ?? null]);
}
export interface GraphWorkerPool { fingerprint: string; selections: RuntimeSelection[]; inherited: boolean }
/** A value snapshot, not a claim of historical role-edit ABA detection. */
export function readGraphWorkerPool(): GraphWorkerPool | null {
  try {
    const db = getDb();
    const count = (role: string) => (db.prepare("SELECT COUNT(*) AS n FROM model_role_members WHERE role = ?").get(role) as { n: number }).n;
    const inherited = count("worker") === 0;
    const role = inherited ? "orchestrator" : "worker", n = count(role);
    const members = listModelRoleMembers(role);
    if (!n || members.length !== n) return null;
    const selections = members.map(member => ({ ...member.selection, role: "worker" as const, inherit: inherited }));
    return { selections, inherited, fingerprint: createHash("sha256").update(JSON.stringify(selections)).digest("hex") };
  } catch { return null; }
}
export interface GraphPinPreflight { reason: "runtime_unavailable" | "host_local_backoff"; failure?: RunnerFailure }
export function graphPinUnavailable(runtimes: RuntimeStatus[], pin: RuntimeSelection, firstDispatch = false): GraphPinPreflight | null {
  const exact = selectExactRuntime(runtimes, pin);
  if (exact && isRuntimeCredentialUnavailable(exact.active)) return null;
  if (!exact || !exact.picked || pinnedRuntimeCredentialOrModelUnavailable(exact.active)) {
    return { reason: "runtime_unavailable", failure: { kind: "unavailable", source: "marker", runtime: pin.kind, providerCode: "graph_pin_not_available", message: "The exact Graph runtime is unavailable before dispatch." } };
  }
  // A local backoff is a scheduling fact, not a provider cause or replay grant.
  // Only the first dispatch may use it; returned failures require a sealed receipt.
  return firstDispatch && runtimeCooldown(exact.active) ? { reason: "host_local_backoff" } : null;
}
export function chooseGraphWorker(pool: GraphWorkerPool, runtimes: RuntimeStatus[], attempted: ReadonlySet<string>,
  failed?: RuntimeSelection, failure?: RunnerFailure): RuntimeSelection | null {
  if (readGraphWorkerPool()?.fingerprint !== pool.fingerprint) return null;
  const failedRuntime = failed ? selectExactRuntime(runtimes, failed)?.active : undefined;
  const allowed = new Set(pool.selections.flatMap(pin => {
    const exact = selectExactRuntime(runtimes, pin);
    return exact ? [graphWorkerIdentity(selectionForRuntime(exact.active))] : [];
  }));
  for (const candidate of rolePriorityRuntimes(runtimes, "worker", { failedRuntime, failure, allowCreditFallback: false })) {
    const selection = selectionForRuntime(candidate, { role: "worker", inherit: pool.inherited });
    if (allowed.has(graphWorkerIdentity(selection)) && !attempted.has(graphWorkerIdentity(selection))) return selection;
  }
  return null;
}
export interface GraphWorkerAttempt {
  readonly attemptId: string; readonly runId: string; readonly automationId: string;
  readonly occurrenceId: string; readonly nodeId: string; readonly chatId: string;
  readonly selection: RuntimeSelection;
}
interface AttemptState {
  assertCurrent: () => void; failed: boolean; tool: boolean; prepared: boolean; activity: boolean;
  failure: RunnerFailure | null; selected?: RuntimeSelection; closed: boolean;
  coverage: Map<string, { adapter: string; preparation: boolean; child: boolean; complete: boolean }>; coverageUnknown: boolean; nativeDispatches: number;
}
const attempts = new WeakMap<GraphWorkerAttempt, AttemptState>();
export interface GraphWorkerFailureReceipt {
  readonly status: "retryable" | "blocked";
  readonly failure: Readonly<RunnerFailure> | null;
  readonly selected?: Readonly<RuntimeSelection>;
  readonly runtimeQuiesced: boolean;
}
const receipts = new WeakMap<GraphWorkerFailureReceipt, GraphWorkerAttempt>();
export function createGraphWorkerAttempt(identity: GraphWorkerAttempt, assertCurrent: () => void): GraphWorkerAttempt {
  assertCurrent();
  const attempt = Object.freeze({ ...identity, selection: Object.freeze({ ...identity.selection }) });
  attempts.set(attempt, { assertCurrent, failed: false, tool: false, prepared: false, activity: false, failure: null, closed: false, coverage: new Map(), coverageUnknown: false, nativeDispatches: 0 });
  return attempt;
}
export function assertGraphWorkerAttempt(attempt?: GraphWorkerAttempt): void {
  if (!attempt) return;
  const state = attempts.get(attempt);
  if (!state || state.closed) throw new Error("graph_worker_attempt_stale");
  state.assertCurrent();
}
export function noteGraphWorkerTool(attempt?: GraphWorkerAttempt): void { const s = attempt && attempts.get(attempt); if (s) s.tool = true; }
export function noteGraphWorkerActivity(attempt?: GraphWorkerAttempt): void { const s = attempt && attempts.get(attempt); if (s) s.activity = true; }
export function noteGraphWorkerPrepare(attempt?: GraphWorkerAttempt): void { const s = attempt && attempts.get(attempt); if (s) s.prepared = true; }
export function noteGraphWorkerAdapterStart(attempt: GraphWorkerAttempt, admission: AdapterEffectAdmission): void {
  const s = attempts.get(attempt); if (!s) return;
  if (s.closed || s.coverage.size >= 128 || s.coverage.has(admission.scopeId)
    || !admission.scopeId.startsWith(`${attempt.runId}:`) || admission.chatId !== attempt.chatId) {
    s.coverageUnknown = true; return;
  }
  s.coverage.set(admission.scopeId, { adapter: admission.adapterKind, preparation: admission.purpose === "preparation", child: admission.parentScopeId !== undefined || admission.dispatchId !== undefined, complete: false });
}
export function noteGraphWorkerAdapterFinish(attempt: GraphWorkerAttempt, scopeId: string, report: AdapterEffectReport): void {
  const s = attempts.get(attempt); if (!s) return;
  const scope = s.coverage.get(scopeId);
  if (s.closed || !scope || scope.complete || report.schemaVersion !== "agentlas.adapter-effect-coverage.v1"
    || report.complete !== true || report.quiesced !== true || !report.terminal
    || report.operationIds.length !== 0 || report.reasons.length !== 0) { s.coverageUnknown = true; return; }
  scope.complete = true;
}
export function noteGraphWorkerCoverageUnknown(attempt: GraphWorkerAttempt): void {
  const s = attempts.get(attempt); if (s) s.coverageUnknown = true;
}
function closedEffectCoverage(s: AttemptState): boolean {
  if (s.coverageUnknown || [...s.coverage.values()].some(scope => !scope.complete)) return false;
  // Only numeric API rejection is admitted without a native adapter witness.
  // This is request rejection, not an OS descendant or global effect-zero proof.
  const apiRejected = s.selected?.kind === "byok" && s.failure?.runtime === "byok"
    && ((s.failure.kind === "auth" && s.failure.providerCode === "http_401")
      || (s.failure.kind === "quota" && s.failure.providerCode === "http_429"));
  return (apiRejected && s.nativeDispatches === 0) || (s.nativeDispatches === 1 && [...s.coverage.values()].some(scope => !scope.preparation && !scope.child
    && (scope.adapter === s.selected?.kind || (scope.adapter === "claude" && s.selected?.kind === "claude-code"))));
}
export function noteGraphWorkerSelection(attempt: GraphWorkerAttempt | undefined, selection: RuntimeSelection): void {
  const s = attempt && attempts.get(attempt); if (s) s.selected = { ...selection };
}
export function noteGraphWorkerDispatch(attempt: GraphWorkerAttempt | undefined, selection: RuntimeSelection): void {
  const s = attempt && attempts.get(attempt); if (s && selection.kind !== "byok") s.nativeDispatches += 1;
}
export function noteGraphWorkerFailure(attempt?: GraphWorkerAttempt): void {
  const s = attempt && attempts.get(attempt); if (s) s.failed = true;
}
/** Called only for the exact direct runner's returned result, never a nested thrown error. */
export function noteGraphWorkerReturnedFailure(attempt: GraphWorkerAttempt | undefined, selection: RuntimeSelection, failure: RunnerFailure): void {
  const s = attempt && attempts.get(attempt); if (!s || !attempt) return;
  s.failed = true;
  if (graphWorkerIdentity(selection) !== graphWorkerIdentity(attempt.selection)) { s.coverageUnknown = true; return; }
  s.selected = { ...selection }; s.failure = { ...failure };
}
/** Only this invocation's actual drain can seal a grant. It is never serialized as authority. */
export async function settleGraphWorkerAttempt(attempt: GraphWorkerAttempt | undefined, drain: () => Promise<boolean>): Promise<GraphWorkerFailureReceipt | undefined> {
  if (!attempt) return undefined;
  const s = attempts.get(attempt);
  if (!s || s.closed) return undefined;
  if (!s.failed) { s.closed = true; return undefined; }
  let quiesced = false;
  const f = s.failure;
  const eligible = f?.source === "marker" && ["auth", "quota", "unavailable"].includes(f.kind)
    && !runtimeFailureBlocksReplay(f) && !["keychain_unavailable", "credential_read_failed"].includes(f.providerCode ?? "")
    && s.selected && (s.selected.kind === f.runtime || (s.selected.kind === "claude-code" && f.runtime === "claude"))
    && graphWorkerIdentity(s.selected) === graphWorkerIdentity(attempt.selection)
    && (attempt.selection.effort === undefined || s.selected.effort === attempt.selection.effort)
    && (attempt.selection.longContext === undefined || s.selected.longContext === attempt.selection.longContext)
    && !s.tool && !s.prepared && !s.activity && closedEffectCoverage(s);
  try {
    s.assertCurrent();
    if (eligible) quiesced = await drain();
    s.assertCurrent();
  } catch { quiesced = false; }
  s.closed = true;
  const receipt: GraphWorkerFailureReceipt = Object.freeze({ status: eligible && quiesced && !s.tool && !s.prepared && !s.activity && closedEffectCoverage(s) ? "retryable" : "blocked",
    failure: f ? Object.freeze({ ...f }) : null, selected: s.selected ? Object.freeze({ ...s.selected }) : undefined, runtimeQuiesced: quiesced });
  receipts.set(receipt, attempt);
  return receipt;
}
export function readGraphWorkerFailure(receipt: GraphWorkerFailureReceipt | undefined, attempt: GraphWorkerAttempt | undefined): GraphWorkerFailureReceipt | null {
  if (!receipt || !attempt || receipts.get(receipt) !== attempt) return null;
  const s = attempts.get(attempt);
  if (!s) return null;
  s.assertCurrent();
  if (receipt.status === "retryable" && (s.tool || s.prepared || s.activity || !closedEffectCoverage(s))) throw new Error("graph_worker_late_effect_observed");
  return receipt;
}
