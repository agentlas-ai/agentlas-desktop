import type { DesktopExactRuntimeBinding, LongRunRuntimeSelection } from "../../shared/long-run";
import type { RuntimeKind, RuntimeSelection } from "../../shared/types";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { getDb } from "../store/db";
import { resolveDesktopRuntimeAdapter } from "./runtime-adapters";

type RuntimeSelectionWithAcp = RuntimeSelection & { acpAgentId?: string | null };

export interface MainRuntimeSelectionRow {
  id: string;
  seq: number;
  chat_id: string | null;
  node_id: string | null;
  payload_json: string;
}

export interface ExactRuntimeBindingContext {
  invocationRunId: string;
  longRunId: string;
  attemptId: string;
  chatId: string;
}

export class ExactDesktopRuntimeBindingError extends Error {
  readonly reasonCode:
    | "exact_runtime_binding_invalid"
    | "exact_runtime_binding_missing"
    | "exact_runtime_binding_conflict";

  constructor(reasonCode: ExactDesktopRuntimeBindingError["reasonCode"]) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
}

const fail = (reasonCode: ExactDesktopRuntimeBindingError["reasonCode"]): never => {
  throw new ExactDesktopRuntimeBindingError(reasonCode);
};

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return fail("exact_runtime_binding_invalid");
  return value;
}

function scopeForSource(source: string): LongRunRuntimeSelection["source"] {
  return source === "cloud" || source === "hub" || source === "builtin" ? source : "local";
}

function exactBinding(input: {
  kind: unknown;
  backend?: unknown;
  source: unknown;
  model?: unknown;
  effort?: unknown;
  longContext?: unknown;
  acpAgentId?: unknown;
}): DesktopExactRuntimeBinding {
  if (typeof input.kind !== "string" || !input.kind.trim()
    || typeof input.source !== "string" || !input.source.trim()
    || (input.longContext !== undefined && typeof input.longContext !== "boolean")) {
    return fail("exact_runtime_binding_invalid");
  }
  const binding: DesktopExactRuntimeBinding = {
    schemaVersion: "agentlas.desktop-exact-runtime-binding.v1",
    kind: input.kind,
    backend: optionalString(input.backend),
    source: input.source,
    model: optionalString(input.model),
    effort: optionalString(input.effort),
    longContext: input.longContext === true,
    acpAgentId: optionalString(input.acpAgentId),
  };
  resolveDesktopRuntimeAdapter({ kind: binding.kind as RuntimeKind });
  return binding;
}

function validateStoredBinding(
  stored: LongRunRuntimeSelection,
  binding: DesktopExactRuntimeBinding,
): DesktopExactRuntimeBinding {
  if (binding.schemaVersion !== "agentlas.desktop-exact-runtime-binding.v1"
    || binding.kind !== stored.kind
    || binding.backend !== (stored.backend ?? null)
    || binding.model !== (stored.model ?? null)
    || binding.effort !== (stored.effort ?? null)
    || scopeForSource(binding.source) !== stored.source
    || stored.capabilityDescriptorId !== resolveDesktopRuntimeAdapter({ kind: binding.kind as RuntimeKind }).id) {
    return fail("exact_runtime_binding_invalid");
  }
  return exactBinding(binding);
}

export function captureLongRunRuntimeSelection(
  selection: RuntimeSelectionWithAcp,
  options: { requireExact?: boolean } = {},
): LongRunRuntimeSelection {
  const adapter = resolveDesktopRuntimeAdapter(selection);
  const coarse: LongRunRuntimeSelection = {
    kind: selection.kind,
    backend: selection.backend ?? null,
    model: selection.model ?? null,
    effort: selection.effort ?? null,
    source: typeof selection.source === "string" && selection.source.trim()
      ? scopeForSource(selection.source)
      : "local",
    capabilityDescriptorId: adapter.id,
  };
  if (typeof selection.source !== "string" || !selection.source.trim()) {
    if (options.requireExact) return fail("exact_runtime_binding_missing");
    return coarse;
  }
  return {
    ...coarse,
    desktopRuntimeBinding: exactBinding({
      kind: selection.kind,
      backend: selection.backend,
      source: selection.source,
      model: selection.model,
      effort: selection.effort,
      longContext: selection.longContext,
      acpAgentId: selection.acpAgentId,
    }),
  };
}

function selectionFromBinding(binding: DesktopExactRuntimeBinding): RuntimeSelectionWithAcp {
  return {
    kind: binding.kind as RuntimeKind,
    ...(binding.backend !== null ? { backend: binding.backend as RuntimeSelection["backend"] } : {}),
    source: binding.source,
    ...(binding.model !== null ? { model: binding.model } : {}),
    ...(binding.effort !== null ? { effort: binding.effort } : {}),
    longContext: binding.longContext,
    ...(binding.acpAgentId !== null ? { acpAgentId: binding.acpAgentId } : {}),
  };
}

function bindingFromMainEvent(
  row: MainRuntimeSelectionRow,
  context: ExactRuntimeBindingContext,
): DesktopExactRuntimeBinding | null {
  if (row.chat_id !== context.chatId || row.node_id !== null) return null;
  let payload: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(row.payload_json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    payload = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const evidence = decodeRuntimeEvidence(payload.runtimeEvidence);
  if (payload.eventKind !== "runtime-selected" || payload.runtimeRole !== "orchestrator"
    || evidence?.sourceEventId !== row.id || evidence.phase !== "observed"
    || evidence.correlation.invocationRunId !== context.invocationRunId
    || evidence.correlation.longRunId !== context.longRunId
    || evidence.correlation.attemptId !== context.attemptId) return null;
  try {
    return exactBinding({
      kind: payload.runtimeKind,
      backend: payload.runtimeBackend,
      source: payload.runtimeSource,
      model: payload.runtimeModel,
      effort: payload.runtimeEffort,
      longContext: payload.runtimeLongContext,
      acpAgentId: payload.runtimeAcpAgentId,
    });
  } catch {
    return null;
  }
}

/** Legacy recovery accepts only the producer invocation's Main-authored exact
 * selection event. Conflicting selections are not ordered into a guess. */
export function recoverLegacyDesktopRuntimeBinding(
  stored: LongRunRuntimeSelection,
  rows: readonly MainRuntimeSelectionRow[],
  context: ExactRuntimeBindingContext,
): DesktopExactRuntimeBinding {
  const candidates = rows.map((row) => bindingFromMainEvent(row, context)).filter((item): item is DesktopExactRuntimeBinding => Boolean(item));
  if (!candidates.length) return fail("exact_runtime_binding_missing");
  const unique = new Map(candidates.map((item) => [JSON.stringify(item), item]));
  if (unique.size !== 1) return fail("exact_runtime_binding_conflict");
  return validateStoredBinding(stored, [...unique.values()][0]);
}

export function restoreExactDesktopRuntimeSelection(input: {
  stored: LongRunRuntimeSelection;
  context: ExactRuntimeBindingContext;
}): RuntimeSelection {
  let binding = input.stored.desktopRuntimeBinding;
  if (!binding) {
    const rows = getDb().prepare(`SELECT id, seq, chat_id, node_id, payload_json FROM run_events
      WHERE run_id = ? AND kind = 'runtime_selection' ORDER BY seq`)
      .all(input.context.invocationRunId) as MainRuntimeSelectionRow[];
    binding = recoverLegacyDesktopRuntimeBinding(input.stored, rows, input.context);
  } else {
    binding = validateStoredBinding(input.stored, binding);
  }
  return selectionFromBinding(binding);
}
