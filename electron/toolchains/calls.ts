import { withGraphOccurrenceCustody } from "../../shared/graph-occurrence-custody";
import { randomUUID } from "node:crypto";
import { sha256Value, graphExecutionDigest } from "../../shared/graph-execution-digest";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import type { ToolchainCallReceipt } from "../../shared/toolchain-asset";
import { getDb } from "../store/db";
import { getAutomation } from "../store/automations";
import type { RunGraphOptions } from "../workflow/run-graph";
import { getToolchainAsset, toolchainSchemaProblems } from "./assets";
import { currentAssetPublicationValidation } from "./asset-cold-start";
import { recordToolchainTrialOutcome } from "./trial";
import { recordToolchainHealthOutcome } from "./health";
import { isToolchainPulledBack } from "./trial-ledger";

const PREFIX = "toolchain.call.v1:";
export interface ToolchainCallInput { toolchainId: string; version: number; args: Record<string, unknown> }
export interface ToolchainCallOptions {
  requestId: string;
  permission: "read" | "write";
  callerChatId?: string | null;
  parentRunId?: string | null;
  signal?: AbortSignal;
  /** Host-only owner/session fence; never accepted from an IPC/MCP DTO. */
  assertCurrent?: () => void;
  depth?: number;
  callChain?: string[];
  dryRun?: boolean;
  /** Host-only: this conversation holds a live trial grant for this exact draft version (toolchains/trial.ts). */
  trial?: boolean;
  sink?: RunGraphOptions["sink"];
  /** Main-only producer hooks. Neither is accepted from an IPC/MCP DTO. The
   * exact persisted running/terminal receipt is supplied by this executor. */
  beforeExecution?: (receipt: Readonly<ToolchainCallReceipt>) => void | Promise<void>;
  afterSettlement?: (receipt: Readonly<ToolchainCallReceipt>) => void | Promise<void>;
  withExecution?: (receipt: Readonly<ToolchainCallReceipt>, body: () => Promise<ToolchainCallReceipt>) => Promise<ToolchainCallReceipt>;
}
function write(key: string, receipt: ToolchainCallReceipt): void {
  getDb().prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(receipt));
}
export function listToolchainCalls(toolchainId: string): ToolchainCallReceipt[] {
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(PREFIX, `${PREFIX}\uffff`) as Array<{ value: string }>;
  return rows.map(row => JSON.parse(row.value) as ToolchainCallReceipt).filter(row => row.toolchainId === toolchainId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function getToolchainCall(id: string): ToolchainCallReceipt | null {
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ?").all(PREFIX, `${PREFIX}\uffff`) as Array<{ value: string }>;
  return rows.map(row => JSON.parse(row.value) as ToolchainCallReceipt).find(row => row.id === id) ?? null;
}
const inFlight = new Map<string, Promise<ToolchainCallReceipt>>();
export function callToolchain(input: ToolchainCallInput, options: ToolchainCallOptions): Promise<ToolchainCallReceipt> {
  return invoke(input, options, false);
}
/** Host-only publication gate; never exposed as a callable tool or an IPC argument. */
export function runToolchainValidation(input: ToolchainCallInput, options: ToolchainCallOptions): Promise<ToolchainCallReceipt> {
  return invoke(input, options, true);
}
async function invoke(input: ToolchainCallInput, options: ToolchainCallOptions, validation: boolean): Promise<ToolchainCallReceipt> {
  if (!options.requestId?.trim() || options.requestId.length > 500 || !["read", "write"].includes(options.permission)) throw new Error("toolchain_request_invalid");
  options.assertCurrent?.();
  const publication = validation ? currentAssetPublicationValidation({ id: input.toolchainId, version: input.version,
    args: input.args, callerChatId: options.callerChatId ?? null, permission: options.permission, requestId: options.requestId }) : null;
  // A resumed parent changes physical runId; requestId carries its stable occurrence.
  // parentRunId is provenance, never part of side-effect deduplication identity.
  const key = `${PREFIX}${sha256Value({ callerChatId: options.callerChatId ?? null, requestId: options.requestId }).slice(7)}`;
  const inputHash = sha256Value({ toolchainId: input.toolchainId, version: input.version, args: input.args, permission: options.permission,
    dryRun: Boolean(options.dryRun), validation });
  // Claim the occurrence before any asynchronous work. A persisted running row after a
  // restart is returned as unresolved; it is never permission to replay external effects.
  const claim = getDb().transaction(() => {
    options.assertCurrent?.();
    publication?.check();
    const prior = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    if (prior) {
      const receipt = JSON.parse(prior.value) as ToolchainCallReceipt;
      if (receipt.inputHash !== inputHash) throw new Error("toolchain_request_identity_conflict");
      return { prior: receipt };
    }
    const asset = getToolchainAsset(input.toolchainId);
    const release = asset?.versions.find(item => item.version === input.version);
    if (!asset || !release) throw new Error("toolchain_version_not_found");
    if (asset.status === "withdrawn" && !publication?.ownerReregister) throw new Error("toolchain_withdrawn");
    if (!validation && !options.trial && (asset.status !== "callable" || release.validation.state !== "passed")) throw new Error("toolchain_version_not_callable");
    // A stable version that failed in real use was pulled back (health.ts); a repaired version takes its place through trial.
    if (!validation && !options.trial && isToolchainPulledBack(asset)) throw new Error("toolchain_pulled_back_for_repair");
    const problems = toolchainSchemaProblems(release.contract.inputSchema, input.args);
    if (problems.length) throw new Error(`toolchain_input_invalid:${problems.join(",")}`);
    if (Buffer.byteLength(JSON.stringify(input.args)) > 256 * 1024) throw new Error("toolchain_input_too_large");
    const graph = release.implementation.snapshot.graph!;
    if (options.permission === "read" && requiredExecutionPermission(graph) === "write") throw new Error("toolchain_permission_denied");
    const marker = `toolchain:${asset.id}@${release.version}`;
    if ((options.callChain ?? []).includes(marker) || (options.depth ?? 0) >= 8) throw new Error("toolchain_call_cycle_or_depth");
    const carrier = getAutomation(release.implementation.automationId);
    if (!carrier?.graph || graphExecutionDigest(carrier, carrier.graph) !== graphExecutionDigest(release.implementation.snapshot, graph)) throw new Error("toolchain_implementation_changed");
    const id = `tcr_${randomUUID()}`;
    const receipt: ToolchainCallReceipt = { schemaVersion: "agentlas.toolchain-call.v1", id, toolchainId: asset.id, version: release.version,
      requestId: options.requestId, callerChatId: options.callerChatId ?? null, parentRunId: options.parentRunId ?? null,
      contentHash: release.contentHash, inputHash, status: "running", ok: false, runId: `run-${id}`,
      startedAt: new Date().toISOString(), completedAt: null, dryRun: Boolean(options.dryRun) };
    write(key, receipt);
    return { receipt, release, marker };
  }).immediate();
  if (claim.prior) return inFlight.get(key) ?? { ...claim.prior,
    ...(claim.prior.status === "running" ? { error: "toolchain_call_in_progress_or_interrupted" } : {}) };
  const { receipt, release, marker } = claim;
  const execute = async (): Promise<ToolchainCallReceipt> => {
    let completed: ToolchainCallReceipt;
    let unconfirmedEffect = false;
    const effectful = requiredExecutionPermission(release.implementation.snapshot.graph) === "write";
    try {
      options.assertCurrent?.();
      if (options.signal?.aborted) throw new Error("toolchain_call_aborted");
      publication?.check();
      await options.beforeExecution?.(Object.freeze(structuredClone(receipt)));
      options.assertCurrent?.();
      options.signal?.throwIfAborted();
      const { runGraph } = await import("../workflow/run-graph");
      options.assertCurrent?.();
      publication?.check();
      const occurrenceId = `toolchain:${receipt.id}`;
      const graphDigest = graphExecutionDigest(release.implementation.snapshot, release.implementation.snapshot.graph!);
      const assertOccurrenceCurrent = () => {
        options.assertCurrent?.();
        options.signal?.throwIfAborted();
        publication?.check();
        const row = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
        const current = row && JSON.parse(row.value) as ToolchainCallReceipt | undefined;
        const asset = getToolchainAsset(receipt.toolchainId);
        const version = asset?.versions.find(item => item.version === receipt.version);
        const carrier = getAutomation(release.implementation.automationId);
        if (!current || current.id !== receipt.id || current.runId !== receipt.runId || current.inputHash !== inputHash
          || current.status !== "running" || !version || version.contentHash !== receipt.contentHash
          || (asset?.status === "withdrawn" && !publication?.ownerReregister)
          || (!validation && !options.trial && (asset?.status !== "callable" || version.validation.state !== "passed"))
          || !carrier?.graph || graphExecutionDigest(carrier, carrier.graph) !== graphDigest) throw new Error("graph_occurrence_custody_changed");
      };
      const result = await withGraphOccurrenceCustody({ automationId: release.implementation.snapshot.id, occurrenceId, graphDigest },
        assertOccurrenceCurrent, occurrenceCustody => runGraph(release.implementation.snapshot, release.implementation.snapshot.graph!, {
        runId: receipt.runId, occurrenceId, occurrenceCustody, initialVars: input.args,
        signal: options.signal, sink: options.sink, depth: (options.depth ?? 0) + 1,
        callChain: [...(options.callChain ?? []), marker], dryRun: options.dryRun,
        permissionCeiling: options.permission, immutableImplementation: true, strategyCycle: "defer",
        ...(options.callerChatId ? { actingChatId: options.callerChatId } : {}),
      }));
      unconfirmedEffect = Object.values(result.nodeFailures ?? {}).some(failure => failure.code === "MUTATION_UNVERIFIED");
      publication?.check();
      if (!result.ok || result.needsInput || result.pendingNodeIds?.length) throw new Error(result.error ?? "toolchain_execution_unsettled");
      const binding = release.implementation.outputBinding;
      const raw = result.outputs[binding.nodeId];
      if (typeof raw !== "string") throw new Error("toolchain_output_missing");
      let output: unknown = raw;
      if (binding.format === "json") {
        try { output = JSON.parse(raw); } catch { throw new Error("toolchain_output_not_json"); }
      }
      const problems = toolchainSchemaProblems(release.contract.outputSchema, output);
      if (problems.length) throw new Error(`toolchain_output_invalid:${problems.join(",")}`);
      if (options.dryRun && result.dryRunBlocks?.length) throw new Error("toolchain_dry_run_effects_blocked");
      completed = { ...receipt, status: "succeeded", ok: true, result: output, completedAt: new Date().toISOString() };
    } catch (error) {
      completed = { ...receipt, status: (effectful || unconfirmedEffect) && !options.dryRun ? "uncertain" : "failed", ok: false,
        error: error instanceof Error ? error.message : "toolchain_execution_failed", completedAt: new Date().toISOString() };
    }
    write(key, completed);
    if (options.trial) recordToolchainTrialOutcome(completed);
    else if (!validation) recordToolchainHealthOutcome(completed);
    // A lost native response/registration never rewrites the genuine execution
    // result or authorizes replay. The persisted terminal receipt is reconciled.
    await options.afterSettlement?.(Object.freeze(structuredClone(completed)));
    return completed;
  };
  const work = options.withExecution ? options.withExecution(Object.freeze(structuredClone(receipt)), execute) : execute();
  inFlight.set(key, work);
  try { return await work; } finally { if (inFlight.get(key) === work) inFlight.delete(key); }
}
