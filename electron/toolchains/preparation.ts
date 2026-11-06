import type { RuntimeSelection } from "../../shared/types";
import { selectionForRuntime, sameRuntimeIdentity } from "../../shared/runtime-selection";
import { detectRuntimes } from "../runtime/detect";
import { runtimeCooldown } from "../runtime/runtime-cooldown";
import { runtimeFailureBlocksReplay } from "../runtime/selection";
import { runNativePreparation } from "../runtime/native-preparation-lifetime";
import { inspectJudgmentCapability } from "../system-agents/judgment-capability";
import { callConnectedModelDetailed, configuredOrchestratorJudgmentPolicy, judgmentPoolAvailability,
  type JudgmentRuntimeAttempt } from "../system-agents/judgment";

export type ToolchainPreparationPurpose = "generalization" | "fresh-session-evaluation";
/** Main-only callbacks bound to the original One producer and current resource,
 * source/audience, runtime, effect and budget authority. Never serialized.
 * Discovery/capability are observations, not grants. Missing callbacks deny. */
export interface ToolchainPreparationProducer {
  assertCurrent(purpose: ToolchainPreparationPurpose): void;
  assertCandidate(purpose: ToolchainPreparationPurpose, selection: Readonly<RuntimeSelection>): void;
}
type Call = typeof callConnectedModelDetailed;
type Result = Awaited<ReturnType<Call>>;
export interface ToolchainPreparationInput {
  purpose: ToolchainPreparationPurpose;
  systemPrompt: string;
  input: string;
  deadlineAt: number;
  signal?: AbortSignal;
  producer?: ToolchainPreparationProducer;
  accept?: Parameters<Call>[0]["accept"];
  outputSchema?: Parameters<Call>[0]["outputSchema"];
}
/** Injection is for closed source tests/Main composition, never an IPC argument. */
export interface ToolchainPreparationRuntimePorts {
  discover: typeof detectRuntimes;
  cooldown: typeof runtimeCooldown;
  inspect: typeof inspectJudgmentCapability;
  pool: typeof judgmentPoolAvailability;
  policy: typeof configuredOrchestratorJudgmentPolicy;
  call: Call;
  now(): number;
}
function denied(code: string): never { throw Object.assign(new Error(code), { code }); }
const live: ToolchainPreparationRuntimePorts = {
  discover: detectRuntimes, cooldown: runtimeCooldown, inspect: inspectJudgmentCapability,
  pool: judgmentPoolAvailability, policy: configuredOrchestratorJudgmentPolicy,
  call: callConnectedModelDetailed, now: Date.now,
};
function checkpoint(input: ToolchainPreparationInput, ports: ToolchainPreparationRuntimePorts): void {
  input.signal?.throwIfAborted();
  if (!Number.isFinite(input.deadlineAt) || ports.now() >= input.deadlineAt) denied("toolchain_preparation_budget_exhausted");
  input.producer?.assertCurrent(input.purpose);
}
function verifiedResult(result: Result, ports: ToolchainPreparationRuntimePorts, selection?: RuntimeSelection): void {
  if (!result.text) return;
  const receipt = result.runtimeReceipt;
  if (result.failure || !receipt || receipt.execution !== "invoked" || !receipt.selection.model
    || receipt.capability?.status !== "verified" || ports.inspect(receipt.selection).status !== "verified")
    denied("toolchain_preparation_receipt_invalid");
  if (selection && (receipt.route !== "explicit_pin" || !sameRuntimeIdentity(receipt.selection, selection)
    || selection.model !== undefined && receipt.selection.model !== selection.model)) denied("toolchain_preparation_receipt_mismatch");
}
function safeNext(result: Result): boolean {
  const failure = result.failure;
  if (!failure || failure.source !== "marker" || runtimeFailureBlocksReplay(failure)) return false;
  // Timeout, unknown exits, isolation refusal and ambiguous evidence never grant
  // another dispatch. The existing runner validates these machine markers.
  return ["quota", "auth", "unavailable"].includes(failure.kind)
    && !(result.attempts ?? []).some(attempt => ["timeout", "cancelled", "refused"].includes(attempt.outcome));
}
export function callToolchainPreparation(input: ToolchainPreparationInput,
  ports: ToolchainPreparationRuntimePorts = live): Promise<Result> {
  // Keep original native preparation custody/Stop barrier; do not mint a run,
  // queue, effect approval or runtime factory. The actual judgment path owns all
  // accounting, workspace, History fences, no-tools and provider dispatch.
  if (input.producer && (typeof input.producer.assertCurrent !== "function"
    || typeof input.producer.assertCandidate !== "function")) denied("toolchain_preparation_producer_required");
  const producer = input.producer ? Object.freeze({
    assertCurrent: input.producer.assertCurrent.bind(input.producer),
    assertCandidate: input.producer.assertCandidate.bind(input.producer),
  }) : undefined;
  const bound = Object.freeze({ ...input, producer });
  return runNativePreparation(() => prepare(bound, ports));
}
async function prepare(input: ToolchainPreparationInput, ports: ToolchainPreparationRuntimePorts): Promise<Result> {
  if (!["generalization", "fresh-session-evaluation"].includes(input.purpose)) denied("toolchain_preparation_purpose_invalid");
  checkpoint(input, ports);
  const snapshot = ports.pool();
  if (snapshot.state === "unavailable") denied("toolchain_preparation_pool_unavailable");
  const policy = ports.policy();
  if (snapshot.state === "configured") {
    if (!policy || policy.poolFingerprint !== snapshot.fingerprint) denied("toolchain_preparation_pool_changed");
    const result = await ports.call({ systemPrompt: input.systemPrompt, input: input.input,
      selectionPolicy: policy, requireNoTools: true, signal: input.signal,
      timeoutMs: input.deadlineAt - ports.now(), accept: input.accept, outputSchema: input.outputSchema });
    checkpoint(input, ports);
    const current = ports.pool();
    if (current.state !== "configured" || current.fingerprint !== snapshot.fingerprint) denied("toolchain_preparation_pool_changed");
    verifiedResult(result, ports);
    if (result.text && (result.runtimeReceipt?.route !== "orchestrator_pool"
      || result.runtimeReceipt.fingerprint !== policy.poolFingerprint)) denied("toolchain_preparation_receipt_mismatch");
    return result; // A configured pool never escapes into discovered providers.
  }
  if (policy) denied("toolchain_preparation_pool_changed");
  if (!input.producer || typeof input.producer.assertCurrent !== "function"
    || typeof input.producer.assertCandidate !== "function") denied("toolchain_preparation_producer_required");
  const assertFallback = () => {
    checkpoint(input, ports);
    const current = ports.pool();
    if (current.state !== "unconfigured" || current.fingerprint !== snapshot.fingerprint) denied("toolchain_preparation_pool_changed");
  };
  assertFallback();
  const discovered = await ports.discover();
  assertFallback();
  const seen = new Set<string>();
  const candidates = discovered.filter(runtime => !runtime.signInRequired && ports.inspect(runtime).status === "verified")
    .sort((a, b) => Number(Boolean(ports.cooldown(a))) - Number(Boolean(ports.cooldown(b))) || Number(b.active) - Number(a.active))
    .filter(runtime => {
      const identity = JSON.stringify([runtime.kind, runtime.backend, runtime.source, runtime.model ?? null, runtime.acpAgentId ?? null]);
      if (seen.has(identity)) return false; seen.add(identity); return true;
    });
  if (!candidates.length) denied("toolchain_preparation_no_verified_runtime");
  const attempts: JudgmentRuntimeAttempt[] = [];
  let last: Result | undefined;
  for (const runtime of candidates) {
    assertFallback();
    const selection = selectionForRuntime(runtime);
    if (ports.inspect(selection).status !== "verified") denied("toolchain_preparation_capability_changed");
    // The original native producer must check exact model/provider, resource and
    // payer/budget authority now. A denied candidate is not skipped silently.
    input.producer.assertCandidate(input.purpose, Object.freeze({ ...selection }));
    assertFallback();
    const result = await ports.call({ systemPrompt: input.systemPrompt, input: input.input,
      runtimeSelection: selection, requireNoTools: true, signal: input.signal,
      timeoutMs: input.deadlineAt - ports.now(), accept: input.accept, outputSchema: input.outputSchema });
    assertFallback();
    input.producer.assertCandidate(input.purpose, Object.freeze({ ...selection }));
    assertFallback();
    attempts.push(...result.attempts ?? []);
    verifiedResult(result, ports, selection);
    last = { ...result, attempts: [...attempts] };
    if (result.text || !safeNext(result)) return last;
  }
  return last!; // Actual last failure/receipt, never a fabricated success.
}
