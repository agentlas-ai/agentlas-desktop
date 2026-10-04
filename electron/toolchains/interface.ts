// Callable Graph interface (Phase 2) — let a fresh One call a saved automation
// from its contract alone, and prove that before calling it "callable".
//
// The contract lives in the toolchain document, not in the graph, so writing or
// testing it never changes the graph's execution digest (no paused run is
// invalidated). It records the definition digest it was tested against; any
// later edit makes it stale and it disappears from search until re-tested.

import { ensureToolchainLogo } from "./logo";
import {
  coldStartPassed,
  COLD_START_POLICY,
  toolchainInputProblems,
  type ToolchainInterface,
} from "../../shared/toolchain";
import { nodeDeclaresOutwardEffect } from "../../shared/graph-node-protocol";
import { graphInputRequirement } from "../../shared/graph-trigger-input";
import { sha256Value } from "../../shared/graph-execution-digest";
import type { Automation } from "../../shared/types";
import { automationDefinitionDigest } from "../automation-lifecycle";
import { getAutomation, listAutomations } from "../store/automations";
import { getDb } from "../store/db";
import { callConnectedModelDetailed, configuredOrchestratorJudgmentPolicy } from "../system-agents/judgment";
import { isVerifiedJudgmentCapability } from "../system-agents/judgment-capability";
import { detectRuntimes } from "../runtime/detect";
import { runtimeCooldown } from "../runtime/runtime-cooldown";
import { selectionForRuntime } from "../../shared/runtime-selection";
import { listToolchainStates, mutateToolchainState, readToolchainState, ToolchainStateConflict } from "./store";
import { searchToolchains } from "./search";

const MAX_TEXT = 600;

/**
 * What a contract promises: the steps (graph), its purpose and name, who does the
 * work (target) and with which authority and tools. Rewording the purpose makes it
 * stale (the definition digest alone ignores the goal — caught by
 * test-toolchain-surfaces).
 *
 * Deliberately NOT included: the runtime pin, schedule, trigger timing, limits and
 * monitor. The host pins a runtime on the first run (automation_runtime_pinned), and
 * when that sat in this digest every callable graph went stale after one use —
 * measured in the isolated app: run ok, then "one_graph_target_not_in_context".
 * Execution freshness is still exact: one_graph_run checks expected_revision.
 */
export function contractSourceDigest(automation: Automation): string {
  return sha256Value({
    graph: automation.graph ?? null,
    goal: automation.goal ?? null,
    name: automation.name,
    prompt: automation.promptTemplate ?? "",
    target: [automation.targetType, automation.targetId, automation.targetVersion ?? null],
    permission: automation.executionPermission ?? "write",
    toolMode: automation.toolMode ?? "auto",
    hubMode: automation.hubMode ?? "hub-allowed",
  });
}

function clip(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function pastInputs(automationId: string, varName: string): Array<Record<string, string>> {
  const rows = getDb().prepare(
    "SELECT payload_json FROM automation_run_inputs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 20",
  ).all(automationId) as Array<{ payload_json: string }>;
  const seen = new Set<string>();
  const examples: Array<Record<string, string>> = [];
  for (const row of rows) {
    try {
      const value = (JSON.parse(row.payload_json) as Record<string, unknown>)[varName];
      const text = clip(value, 200);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      examples.push({ [varName]: text });
      if (examples.length >= 3) break;
    } catch { /* skip unreadable input */ }
  }
  return examples;
}

/** Deterministic first draft from what the graph already declares. Effects are pessimistic. */
export function draftInterface(automation: Automation, now = new Date().toISOString()): ToolchainInterface {
  const graph = automation.graph;
  const requirement = graphInputRequirement(graph, "en");
  // Pessimistic by default (MCP: readOnlyHint=false, destructiveHint=true). An agent
  // node can call any attached tool, so "declared no effect" is not evidence of
  // read-only — measured: the Threads and X posting automations declare none.
  const DETERMINISTIC = new Set(["trigger", "condition", "transform", "eval", "code"]);
  const readOnly = (graph?.nodes ?? []).length > 0 && (graph?.nodes ?? []).every((node) =>
    DETERMINISTIC.has(node.type) && !nodeDeclaresOutwardEffect({ type: node.type, config: node.config }));
  const purpose = clip(automation.goal) || clip(automation.name);
  // The model binding the input reads only this description. A generic "Input for
  // this graph" tells it nothing, so prefer the graph's own question (promptLabel),
  // then the trigger node's label, then the variable name.
  const trigger = graph?.nodes.find((node) => node.type === "trigger");
  const promptLabel = typeof trigger?.config?.promptLabel === "string" ? trigger.config.promptLabel.trim() : "";
  const inputDescription = clip(promptLabel || trigger?.label?.trim() || requirement?.varName || "", 200);
  const properties = requirement
    ? { [requirement.varName]: { type: "string" as const, description: inputDescription || requirement.varName, maxLength: 4000 } }
    : {};
  return {
    schemaVersion: "agentlas.toolchain-interface.v1",
    automationId: automation.id,
    name: clip(automation.name, 160),
    description: purpose,
    whenToUse: [purpose].filter(Boolean),
    whenNotToUse: readOnly
      ? ["The task needs a different outcome than this automation's stated purpose."]
      : ["The task only needs information; this automation changes things outside (posts, sends or writes)."],
    inputSchema: { type: "object", properties, required: requirement ? [requirement.varName] : [], additionalProperties: false },
    inputExamples: requirement ? pastInputs(automation.id, requirement.varName) : [],
    effects: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
    state: "draft",
    definitionDigest: contractSourceDigest(automation),
    coldStart: null,
    usage: { returned: 0, runs: 0 },
    updatedAt: now,
  };
}

export function interfaceIsStale(contract: ToolchainInterface, automation: Automation): boolean {
  try { return contract.definitionDigest !== contractSourceDigest(automation); } catch { return true; }
}

/** Callable contracts that are current and whose automation can run now. */
export function currentCallableContracts(): Array<{ contract: ToolchainInterface; automation: Automation }> {
  const byId = new Map(listAutomations().map((automation) => [automation.id, automation]));
  const out: Array<{ contract: ToolchainInterface; automation: Automation }> = [];
  for (const state of listToolchainStates()) {
    const contract = state.interface;
    const automation = byId.get(state.automationId);
    if (!contract || contract.state !== "callable" || !automation?.enabled) continue;
    if (interfaceIsStale(contract, automation)) continue;
    out.push({ contract, automation });
  }
  return out.slice(0, COLD_START_POLICY.maxCallable);
}

export function callableContractFor(automationId: string): ToolchainInterface | null {
  const automation = getAutomation(automationId);
  const contract = readToolchainState(automationId).interface;
  if (!automation?.enabled || !contract || contract.state !== "callable" || interfaceIsStale(contract, automation)) return null;
  return contract;
}

function bumpUsage(automationId: string, field: "returned" | "runs"): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mutateToolchainState(automationId, (current) => {
        if (!current.interface) return null;
        const usage = current.interface.usage ?? { returned: 0, runs: 0 };
        return { ...current, interface: { ...current.interface, usage: { ...usage, [field]: usage[field] + 1 } } };
      });
      return;
    } catch (error) {
      if (!(error instanceof ToolchainStateConflict)) return;
    }
  }
}

export function recordToolchainReturned(automationIds: string[]): void {
  for (const id of automationIds) bumpUsage(id, "returned");
}

export function recordToolchainRun(automationId: string): void {
  if (readToolchainState(automationId).interface) bumpUsage(automationId, "runs");
}

/** The manifest a model sees after search: contract only, no instructions, no history. */
export function contractManifest(contract: ToolchainInterface, automation: Automation, revision: string) {
  return {
    graph_id: automation.id,
    expected_revision: revision,
    name: contract.name,
    purpose: contract.description,
    when_to_use: contract.whenToUse,
    when_not_to_use: contract.whenNotToUse,
    input_schema: contract.inputSchema,
    input_examples: contract.inputExamples,
    effects: contract.effects,
  };
}

// ── Cold-start test ──────────────────────────────────────────────────────────

const GENERATOR_PROMPT = [
  "You write test requests for a tool-routing evaluation. You receive one tool contract and a list of other automations.",
  "Return ONLY JSON: {\"positives\":[5 strings],\"negatives\":[5 strings]}.",
  "positives: realistic owner requests this tool should handle, phrased differently from its name and purpose (paraphrase, do not copy wording). Each is a full sentence a person would type, never just an input value. If the tool takes an input, each positive must still make a concrete value for it obvious. Use the language the tool's purpose is written in.",
  "negatives: near-miss requests it must NOT handle — same topic but a different outcome, or the opposite effect (e.g. reading vs posting), or another automation's job.",
].join("\n");

const SELECTOR_PROMPT = [
  "You are a fresh assistant with no prior conversation. For each task you get the candidate tools a search returned (possibly none).",
  "Pick the one tool that clearly does the task, or null when none fits. Use only each candidate's contract (purpose, when_to_use, when_not_to_use, input_schema).",
  "If you pick one, fill its input exactly per input_schema (string values, only listed fields).",
  "Return ONLY JSON: {\"answers\":[{\"task\":<index>,\"graph_id\":string|null,\"input\":object}]} with one answer per task.",
].join("\n");

/**
 * A tool-free model call. The test feeds the model near-miss tasks such as "post
 * this on X", so a runtime that might still expose its own tools must not run it.
 * The owner's judgment pool goes first; when it cannot prove a tool-free call
 * (codex today: codex_native_no_tools_not_release_verified) a detected runtime
 * whose isolation is verified (Claude safe mode, BYOK/local, Agentlas serving)
 * takes over. The rule is never relaxed — with no such runtime the test refuses.
 */
async function callIsolatedModel(systemPrompt: string, input: string, signal?: AbortSignal): Promise<{ text: string | null; model: string | null; reason: string | null }> {
  const base = { systemPrompt, input, requireNoTools: true as const, timeoutMs: 120_000, ...(signal ? { signal } : {}) };
  const policy = configuredOrchestratorJudgmentPolicy();
  if (policy) {
    const pooled = await callConnectedModelDetailed({ ...base, selectionPolicy: policy });
    const receipt = pooled.runtimeReceipt;
    if (pooled.text) return { text: pooled.text, reason: null,
      model: receipt?.selection ? `${[receipt.selection.kind, receipt.selection.model].filter(Boolean).join(":")} via ${receipt.route}` : "judgment-pool" };
  }
  // Every verified tool-free runtime is a candidate, not just the first one. A runtime known to be in
  // a quota/auth cooldown goes last (it is still tried — the cooldown may have just ended), and one
  // that fails hands over to the next. Independent review 2026-10-04: the fallback used to pick one
  // runtime and stop, so an exhausted first choice failed the test while another model was free.
  const isolated = (await detectRuntimes()).filter((runtime) => !runtime.signInRequired && isVerifiedJudgmentCapability(runtime))
    .sort((left, right) => Number(Boolean(runtimeCooldown(left))) - Number(Boolean(runtimeCooldown(right)))
      || Number(right.active) - Number(left.active));
  if (!isolated.length) return { text: null, model: null, reason: "no_isolated_runtime" };
  let last: { model: string; reason: string } | null = null;
  for (const runtime of isolated) {
    if (signal?.aborted) break;
    const selection = selectionForRuntime(runtime);
    const model = [selection.kind, selection.model].filter(Boolean).join(":");
    const direct = await callConnectedModelDetailed({ ...base, runtimeSelection: selection });
    if (direct.text) return { text: direct.text, model, reason: null };
    last = { model, reason: String(direct.failure?.message || direct.failure?.kind || "isolated_runtime_failed").slice(0, 80) };
  }
  return { text: null, model: last?.model ?? null, reason: last?.reason ?? "isolated_runtime_failed" };
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => clip(item, 400)).slice(0, max) : [];
}

export type ColdStartRun = NonNullable<ToolchainInterface["coldStart"]>;

/**
 * Generate positive and near-miss tasks, run the real search for each, then ask
 * a model with no history to choose and bind from the returned contracts only.
 * Two no-tools model calls; nothing executes.
 */
export async function runColdStartTest(automationId: string, draft: ToolchainInterface, signal?: AbortSignal): Promise<ColdStartRun> {
  const automation = getAutomation(automationId);
  if (!automation) throw new Error("toolchain_automation_missing");
  const others = listAutomations().filter((item) => item.id !== automationId && item.graph)
    .slice(0, 12).map((item) => `- ${clip(item.name, 120)}: ${clip(item.goal, 200)}`).join("\n");
  const generatedCall = await callIsolatedModel(GENERATOR_PROMPT,
    JSON.stringify({ contract: contractManifest(draft, automation, "test"), other_automations: others || "(none)" }), signal);
  if (!generatedCall.text) throw new Error(`toolchain_cold_start_unavailable:${generatedCall.reason}`);
  const generated = parseJsonObject(generatedCall.text);
  // A probe must be a request, not a bare value ("go" came back once as a "task").
  const isRequest = (task: string) => task.length >= 12 && /\s/.test(task.trim());
  const positives = stringList(generated?.positives, 5).filter(isRequest);
  const negatives = stringList(generated?.negatives, 5).filter(isRequest);
  if (positives.length === 0 || negatives.length === 0) throw new Error("toolchain_cold_start_generation_unreadable");

  // Search exactly as One would, with this draft treated as callable.
  const pool = [
    ...currentCallableContracts().filter((entry) => entry.automation.id !== automationId),
    { contract: { ...draft, state: "callable" as const }, automation },
  ];
  const tasks = [...positives, ...negatives];
  const searched = tasks.map((task) => searchToolchains(task, pool.map((entry) => entry.contract))
    .map((hit) => pool.find((entry) => entry.automation.id === hit.automationId)!)
    .map((entry) => contractManifest(entry.contract, entry.automation, "test")));
  const selectedCall = await callIsolatedModel(SELECTOR_PROMPT,
    JSON.stringify({ tasks: tasks.map((task, index) => ({ index, task, candidates: searched[index] })) }), signal);
  if (!selectedCall.text) throw new Error(`toolchain_cold_start_unavailable:${selectedCall.reason}`);
  const selected = parseJsonObject(selectedCall.text);
  if (!Array.isArray(selected?.answers)) throw new Error("toolchain_cold_start_selection_unreadable");
  const answers = Array.isArray(selected?.answers) ? selected!.answers as Array<Record<string, unknown>> : [];
  const answerFor = (index: number) => answers.find((answer) => Number(answer.task) === index);
  let positiveSelected = 0;
  let positiveBound = 0;
  const positiveFound = positives.filter((_, index) => searched[index].some((manifest) => manifest.graph_id === automationId)).length;
  positives.forEach((_, index) => {
    const answer = answerFor(index);
    if (answer?.graph_id !== automationId) return;
    positiveSelected += 1;
    if (toolchainInputProblems(draft, answer.input ?? {}).length === 0) positiveBound += 1;
  });
  let negativeSelected = 0;
  negatives.forEach((_, offset) => {
    if (answerFor(positives.length + offset)?.graph_id === automationId) negativeSelected += 1;
  });
  const cases = tasks.map((task, index) => {
    const answer = answerFor(index);
    const selectedThis = answer?.graph_id === automationId;
    return {
      kind: index < positives.length ? "positive" as const : "negative" as const,
      task,
      found: searched[index].some((manifest) => manifest.graph_id === automationId),
      selected: selectedThis,
      bound: selectedThis && toolchainInputProblems(draft, answer?.input ?? {}).length === 0,
    };
  });
  const result: ColdStartRun = {
    at: new Date().toISOString(),
    positives: positives.length,
    positiveFound,
    positiveSelected,
    positiveBound,
    negatives: negatives.length,
    negativeSelected,
    passed: false,
    model: selectedCall.model,
    cases,
  };
  result.passed = coldStartPassed(result);
  return result;
}

/**
 * Hard ceiling for one fresh-session test (two tool-free model calls, each with its own pooled and
 * fallback attempt), so a stuck model cannot hold the slot or write a result much later.
 */
export const TOOLCHAIN_TEST_BUDGET_MS = 300_000;

/** One test per automation at a time; a second caller (owner or One) shares the running one. */
const testsInFlight = new Map<string, Promise<ToolchainInterface>>();

export function toolchainTestInProgress(automationId: string): boolean {
  return testsInFlight.has(automationId);
}

/**
 * Draft (or refresh) the contract and test it; callable only if the test passes.
 *
 * Independent review 2026-10-04: the test can outlive every caller's wait, so it is host-owned —
 * single-flight per automation, bounded by TOOLCHAIN_TEST_BUDGET_MS — and it never overwrites a
 * decision taken while it ran (an owner withdrawal used to be silently reverted to callable).
 */
export function exposeAutomation(
  automationId: string,
  signal?: AbortSignal,
  actor: { kind: "owner" | "one"; chatId?: string | null } = { kind: "owner" },
): Promise<ToolchainInterface> {
  const running = testsInFlight.get(automationId);
  if (running) return running;
  const test = runExposure(automationId, signal, actor)
    .finally(() => { if (testsInFlight.get(automationId) === test) testsInFlight.delete(automationId); });
  testsInFlight.set(automationId, test);
  return test;
}

/** What identifies the contract a test started from; usage counters may change, nothing else may. */
function contractMarker(contract: ToolchainInterface | null): string {
  return contract ? `${contract.state}|${contract.updatedAt}|${contract.exposedBy?.at ?? ""}|${contract.withdrawnBy?.at ?? ""}` : "none";
}

async function runExposure(
  automationId: string,
  signal: AbortSignal | undefined,
  actor: { kind: "owner" | "one"; chatId?: string | null },
): Promise<ToolchainInterface> {
  const automation = getAutomation(automationId);
  if (!automation?.graph) throw new Error("toolchain_automation_missing");
  const startedFrom = contractMarker(readToolchainState(automationId).interface);
  const draft = draftInterface(automation);
  const budget = AbortSignal.timeout(TOOLCHAIN_TEST_BUDGET_MS);
  const coldStart = await runColdStartTest(automationId, draft, signal ? AbortSignal.any([signal, budget]) : budget);
  const contract: ToolchainInterface = { ...draft, coldStart, state: coldStart.passed ? "callable" : "draft",
    exposedBy: { kind: actor.kind, chatId: actor.chatId ?? null, at: new Date().toISOString() } };
  mutateToolchainState(automationId, (current) => {
    // The owner withdrew it (or another write replaced it) while the test ran: that decision stands.
    if (contractMarker(current.interface) !== startedFrom) throw new Error("toolchain_changed_during_test");
    return { ...current, interface: { ...contract, usage: current.interface?.usage ?? contract.usage } };
  });
  // Now it is a Toolchain: it gets its app icon (only when the app enabled drawing).
  ensureToolchainLogo({ automationId, name: contract.name || automation.name, description: contract.description });
  return contract;
}

export function withdrawAutomation(automationId: string): void {
  const at = new Date().toISOString();
  mutateToolchainState(automationId, (current) => current.interface
    ? { ...current, interface: { ...current.interface, state: "deprecated", withdrawnBy: { kind: "owner", at }, updatedAt: at } }
    : null);
}
