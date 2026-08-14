import { getDb } from "./db";
import type {
  AgentRuntimeOverride,
  AgentRuntimeOverrideScope,
  AgentRuntimeOverrideSetInput,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
} from "../../shared/types";

interface RuntimeOverrideRow {
  scope: AgentRuntimeOverrideScope;
  target_id: string;
  label: string | null;
  // Keep legacy rows readable; canonicalize removed Google CLI rows below.
  kind: string;
  backend: RuntimeBackend | null;
  source: string | null;
  model: string | null;
  effort: string | null;
  long_context: number;
  updated_at: string;
}

export interface RuntimeOverrideTarget {
  scope: AgentRuntimeOverrideScope;
  targetId: string | null | undefined;
}

const VALID_SCOPES = new Set<AgentRuntimeOverrideScope>(["agent", "firm", "division"]);
const VALID_KINDS = new Set<RuntimeKind>(["claude-code", "codex", "antigravity", "kimi", "byok", "ollama"]);

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalStoredKind(kind: string): RuntimeKind {
  const canonical = kind === "gemini" ? "antigravity" : kind;
  if (!VALID_KINDS.has(canonical as RuntimeKind)) throw new Error(`Unknown stored runtime kind: ${kind}`);
  return canonical as RuntimeKind;
}

function assertScope(scope: AgentRuntimeOverrideScope): void {
  if (!VALID_SCOPES.has(scope)) throw new Error(`Unknown runtime override scope: ${scope}`);
}

function normalizeSelection(selection: RuntimeSelection): RuntimeSelection {
  if (!VALID_KINDS.has(selection.kind)) {
    throw new Error(`Unknown runtime kind: ${selection.kind}`);
  }
  return {
    kind: selection.kind,
    backend: selection.backend,
    source: cleanText(selection.source) ?? undefined,
    model: cleanText(selection.model) ?? undefined,
    longContext: Boolean(selection.longContext),
    effort: cleanText(selection.effort) ?? undefined,
  };
}

function toOverride(row: RuntimeOverrideRow): AgentRuntimeOverride {
  const selection: RuntimeSelection = {
    kind: canonicalStoredKind(row.kind),
    backend: row.backend ?? undefined,
    source: row.kind === "gemini" ? undefined : row.source ?? undefined,
    model: row.kind === "gemini" ? undefined : row.model ?? undefined,
    longContext: Boolean(row.long_context),
    effort: row.effort ?? undefined,
  };
  return {
    scope: row.scope,
    targetId: row.target_id,
    label: row.label,
    selection,
    updatedAt: row.updated_at,
  };
}

export function listAgentRuntimeOverrides(): AgentRuntimeOverride[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_runtime_overrides ORDER BY updated_at DESC")
    .all() as RuntimeOverrideRow[];
  return rows.map(toOverride);
}

export function getAgentRuntimeOverride(
  scope: AgentRuntimeOverrideScope,
  targetId: string,
): AgentRuntimeOverride | null {
  assertScope(scope);
  const id = cleanText(targetId);
  if (!id) return null;
  const row = getDb()
    .prepare("SELECT * FROM agent_runtime_overrides WHERE scope = ? AND target_id = ?")
    .get(scope, id) as RuntimeOverrideRow | undefined;
  return row ? toOverride(row) : null;
}

export function findAgentRuntimeOverride(
  targets: RuntimeOverrideTarget[],
): AgentRuntimeOverride | null {
  for (const target of targets) {
    if (!target.targetId) continue;
    const found = getAgentRuntimeOverride(target.scope, target.targetId);
    if (found) return found;
  }
  return null;
}

export function setAgentRuntimeOverride(
  input: AgentRuntimeOverrideSetInput,
): AgentRuntimeOverride {
  assertScope(input.scope);
  const targetId = cleanText(input.targetId);
  if (!targetId) throw new Error("Runtime override targetId is required.");
  const selection = normalizeSelection(input.selection);
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_runtime_overrides
       (scope, target_id, label, kind, backend, source, model, effort, long_context, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, target_id) DO UPDATE SET
         label = excluded.label,
         kind = excluded.kind,
         backend = excluded.backend,
         source = excluded.source,
         model = excluded.model,
         effort = excluded.effort,
         long_context = excluded.long_context,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.scope,
      targetId,
      cleanText(input.label),
      selection.kind,
      selection.backend ?? null,
      selection.source ?? null,
      selection.model ?? null,
      selection.effort ?? null,
      selection.longContext ? 1 : 0,
      updatedAt,
    );
  return getAgentRuntimeOverride(input.scope, targetId) as AgentRuntimeOverride;
}

export function removeAgentRuntimeOverride(
  scope: AgentRuntimeOverrideScope,
  targetId: string,
): void {
  assertScope(scope);
  const id = cleanText(targetId);
  if (!id) return;
  getDb()
    .prepare("DELETE FROM agent_runtime_overrides WHERE scope = ? AND target_id = ?")
    .run(scope, id);
}
