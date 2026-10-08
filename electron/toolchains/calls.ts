import { randomUUID } from "node:crypto";
import { sha256Value, graphExecutionDigest } from "../../shared/graph-execution-digest";
import { requiredExecutionPermission } from "../../shared/graph-node-protocol";
import type { ToolchainCallReceipt } from "../../shared/toolchain-asset";
import { getDb } from "../store/db";
import { getAutomation } from "../store/automations";
import type { RunGraphOptions } from "../workflow/run-graph";
import { getToolchainAsset, toolchainSchemaProblems } from "./assets";

const PREFIX = "toolchain.call.v1:";
export interface ToolchainCallInput { toolchainId: string; version: number; args: Record<string, unknown> }
export interface ToolchainCallOptions {
  requestId: string;
  permission: "read" | "write";
  callerChatId?: string | null;
  parentRunId?: string | null;
  signal?: AbortSignal;
  depth?: number;
  callChain?: string[];
  dryRun?: boolean;
  sink?: RunGraphOptions["sink"];
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
  // A resumed parent changes physical runId; requestId carries its stable occurrence.
  // parentRunId is provenance, never part of side-effect deduplication identity.
  const key = `${PREFIX}${sha256Value({ callerChatId: options.callerChatId ?? null, requestId: options.requestId }).slice(7)}`;
  const inputHash = sha256Value({ toolchainId: input.toolchainId, version: input.version, args: input.args, permission: options.permission,
    dryRun: Boolean(options.dryRun), validation });
  // Claim the occurrence before any asynchronous work. A persisted running row after a
  // restart is returned as unresolved; it is never permission to replay external effects.
  const claim = getDb().transaction(() => {
    const prior = getDb().prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    if (prior) {
      const receipt = JSON.parse(prior.value) as ToolchainCallReceipt;
      if (receipt.inputHash !== inputHash) throw new Error("toolchain_request_identity_conflict");
      return { prior: receipt };
    }
    const asset = getToolchainAsset(input.toolchainId);
    const release = asset?.versions.find(item => item.version === input.version);
    if (!asset || !release) throw new Error("toolchain_version_not_found");
    if (asset.status === "withdrawn") throw new Error("toolchain_withdrawn");
    if (!validation && (asset.status !== "callable" || release.validation.state !== "passed")) throw new Error("toolchain_version_not_callable");
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
  const work = (async (): Promise<ToolchainCallReceipt> => {
    let completed: ToolchainCallReceipt;
    let unconfirmedEffect = false;
    const effectful = requiredExecutionPermission(release.implementation.snapshot.graph) === "write";
    try {
      if (options.signal?.aborted) throw new Error("toolchain_call_aborted");
      const { runGraph } = await import("../workflow/run-graph");
      const result = await runGraph(release.implementation.snapshot, release.implementation.snapshot.graph!, {
        runId: receipt.runId, occurrenceId: `toolchain:${receipt.id}`, initialVars: input.args,
        signal: options.signal, sink: options.sink, depth: (options.depth ?? 0) + 1,
        callChain: [...(options.callChain ?? []), marker], dryRun: options.dryRun,
        permissionCeiling: options.permission, immutableImplementation: true, strategyCycle: "defer",
      });
      unconfirmedEffect = Object.values(result.nodeFailures ?? {}).some(failure => failure.code === "MUTATION_UNVERIFIED");
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
    return completed;
  })();
  inFlight.set(key, work);
  try { return await work; } finally { if (inFlight.get(key) === work) inFlight.delete(key); }
}
