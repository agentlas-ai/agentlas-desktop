


















import { getDb } from "../store/db";
import { isEffectStatusOnlyTool } from "../invocation/effect-boundary";
import { callLeftNoOutsideEffect } from "../invocation/no-effect-failure";

const TERMINAL_KINDS = new Set(["invoke_completed", "invoke_failed", "invoke_threw", "invoke_cancelled", "invoke_interrupted"]);

export interface AttemptEffectCandidate { toolId: string; toolName: string; args: string }

export interface AttemptEffectReceipt {
  invocationRunId: string;
  /** The host's ledger for this invocation is closed and complete (no call can be missing or still running). */
  closed: boolean;
  /** Machine reason the ledger is not closed (null when closed). */
  openReason: string | null;
  /** Recorded calls proven observation-only. */
  readOnlyCalls: number;
  /** Recorded calls whose name/arguments do not prove observation-only: the only things a look must judge. */
  candidates: AttemptEffectCandidate[];






  hostConfirmed: AttemptEffectCandidate[];
}

const HOST_REGISTRATION_TOOLS = new Set(["automation.create", "automation.update", "automation.pause", "automation.resume"]);

interface Row { id: string; seq: number; kind: string; payload_json: string }

function parse(row: Row): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(row.payload_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function readAttemptEffectReceipt(invocationRunId: string): AttemptEffectReceipt {
  const open = (openReason: string, candidates: AttemptEffectCandidate[] = [], readOnlyCalls = 0): AttemptEffectReceipt =>
    ({ invocationRunId, closed: false, openReason, readOnlyCalls, candidates, hostConfirmed: [] });
  const rows = getDb().prepare("SELECT id, seq, kind, payload_json FROM run_events WHERE run_id = ? ORDER BY seq ASC")
    .all(invocationRunId) as Row[];
  const terminal = [...rows].reverse().find((row) => TERMINAL_KINDS.has(row.kind));
  if (!terminal) return open("terminal_missing");
  const effectRow = [...rows].reverse().find((row) => row.kind === "runtime_effect_boundary");
  const boundary = effectRow ? parse(effectRow) : null;
  if (!effectRow || !boundary || effectRow.seq < terminal.seq) return open("effect_receipt_missing");
  if (boundary.schemaVersion !== "agentlas.runtime-effect-boundary.v1" || boundary.terminalEventId !== terminal.id
    || boundary.terminalSeq !== terminal.seq || boundary.coverage !== "complete" || boundary.ledgerComplete !== true) {
    return open("effect_receipt_incomplete");
  }
  const scopes = Array.isArray(boundary.adapterScopes) ? boundary.adapterScopes as Array<{ report?: { complete?: unknown } | null }> : [];
  if (scopes.some((scope) => scope?.report?.complete !== true)) return open("adapter_report_incomplete");
  const operations = Array.isArray(boundary.operations)
    ? boundary.operations as Array<{ toolId?: unknown; resultObserved?: unknown }> : null;
  if (!operations) return open("operation_snapshot_missing");
  if (operations.some((operation) => typeof operation?.toolId !== "string" || operation.resultObserved !== true)) return open("operation_open");

  // Every recorded call, grouped by id; each distinct (name, arguments) pair under an id is judged (ids are reused).
  const calls = new Map<string, Array<{ toolName: string; toolArgs: unknown; completed: boolean }>>();
  let toolEvents = 0;
  for (const row of rows) {
    if (row.kind !== "mcp_tool-use") continue;
    const data = parse(row);
    if (!data || typeof data.toolName !== "string") continue;
    if (isEffectStatusOnlyTool({ name: data.toolName, id: data.toolId, args: data.toolArgs, isError: data.toolIsError })) continue;
    toolEvents += 1;
    if (row.seq > effectRow.seq) return open("call_after_receipt");
    if (typeof data.toolId !== "string" || !data.toolId) return open("call_without_id");
    const list = calls.get(data.toolId) ?? [];
    list.push({ toolName: data.toolName, toolArgs: data.toolArgs,
      completed: data.toolIsError === false && typeof data.toolResultPreview === "string" && data.toolResultPreview.trim() !== "" });
    calls.set(data.toolId, list);
  }
  if (boundary.observedToolEventCount !== toolEvents) return open("call_count_mismatch");
  const operationIds = new Set(operations.map((operation) => operation.toolId as string));
  if (operationIds.size !== calls.size || [...calls.keys()].some((id) => !operationIds.has(id))) return open("operation_set_mismatch");

  const candidates: AttemptEffectCandidate[] = [];
  const hostConfirmed: AttemptEffectCandidate[] = [];
  let readOnlyCalls = 0;
  for (const [toolId, list] of calls) {
    if (list.every((call) => HOST_REGISTRATION_TOOLS.has(call.toolName)) && list.some((call) => call.completed)) {
      const named = list.find((call) => call.toolArgs !== undefined && call.toolArgs !== null && call.toolArgs !== "") ?? list[0]!;
      const args = typeof named.toolArgs === "string" ? named.toolArgs : named.toolArgs == null ? "" : JSON.stringify(named.toolArgs);
      hostConfirmed.push({ toolId, toolName: named.toolName.slice(0, 120), args: args.replace(/\s+/g, " ").trim().slice(0, 240) });
      continue;
    }
    // Judge the arguments a row actually carried; a name recorded only without arguments is judged by name alone.
    const withArgs = list.filter((call) => call.toolArgs !== undefined && call.toolArgs !== null && call.toolArgs !== "");
    const judged = [...withArgs, ...list.filter((call) => !withArgs.some((other) => other.toolName === call.toolName))
      .map((call) => ({ toolName: call.toolName, toolArgs: undefined }))];
    const unproven = judged.find((call) => !callLeftNoOutsideEffect(call));
    if (!unproven) { readOnlyCalls += 1; continue; }
    const args = typeof unproven.toolArgs === "string" ? unproven.toolArgs : unproven.toolArgs === undefined ? "" : JSON.stringify(unproven.toolArgs);
    candidates.push({ toolId, toolName: unproven.toolName.slice(0, 120), args: args.replace(/\s+/g, " ").trim().slice(0, 240) });
  }
  return { invocationRunId, closed: true, openReason: null, readOnlyCalls, candidates, hostConfirmed };
}

const provenNoEffect = new Set<string>();
const unprovenAtSeq = new Map<string, number>();

/**
 * One attempt's own closed receipt proves no outward call (only reads, or the turn never reached the model).
 * Such an attempt is never unsettled: it needs no look and no person, and it must not hold a set of real
 * uncertainties hostage (owner DB 2026-10-04: 17 never-dispatched turns in a set of 21 made every look answer
 * unknown, then the set outgrew the look limit). A proof is final once written, so it is cached; a missing proof
 * is re-read only when the invocation's ledger has grown.
 */
export function attemptReceiptProvesNoEffect(invocationRunId: string | null): boolean {
  if (!invocationRunId) return false;
  if (provenNoEffect.has(invocationRunId)) return true;
  let lastSeq: number;
  try {
    lastSeq = (getDb().prepare("SELECT COALESCE(MAX(seq), -1) AS seq FROM run_events WHERE run_id = ?").get(invocationRunId) as { seq: number }).seq;
  } catch { return false; }
  if (unprovenAtSeq.get(invocationRunId) === lastSeq) return false;
  let receipt: AttemptEffectReceipt;
  try { receipt = readAttemptEffectReceipt(invocationRunId); } catch { return false; }
  const proven = receipt.closed && !receipt.candidates.length && !receipt.hostConfirmed.length;
  if (proven) { provenNoEffect.add(invocationRunId); unprovenAtSeq.delete(invocationRunId); }
  else unprovenAtSeq.set(invocationRunId, lastSeq);
  return proven;
}

/**
 * The host's own answer for a set of uncertain attempts, or null when a look is still needed. Only when every
 * attempt has a closed receipt with no candidate call: then nothing outside changed and the answer is not_done.
 */
export function receiptSettlesAttempts(attempts: ReadonlyArray<{ id: string; invocationRunId: string | null }>):
  { evidence: string; readOnlyCalls: number } | null {
  if (!attempts.length) return null;
  let readOnlyCalls = 0;
  for (const attempt of attempts) {
    if (!attempt.invocationRunId) return null;
    let receipt: AttemptEffectReceipt;
    try { receipt = readAttemptEffectReceipt(attempt.invocationRunId); } catch { return null; }
    // A host-confirmed registration took effect: never settle that attempt as "not_done".
    if (!receipt.closed || receipt.candidates.length || receipt.hostConfirmed.length) return null;
    readOnlyCalls += receipt.readOnlyCalls;
  }
  return { readOnlyCalls,
    evidence: `host receipt: ${attempts.length} attempt(s), closed ledger, ${readOnlyCalls} recorded call(s) all observation-only (search, read, page load); no outward call` };
}
