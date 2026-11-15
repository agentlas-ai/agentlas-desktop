import { getDb } from "./db";
import { RuntimeSelectionContractError, runtimeSupportsAgentOverride } from "../../shared/runtime-selection";
import { RUNTIME_KINDS } from "../../shared/runtime-kinds";
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
// Every kind the picker can offer may be pinned per agent (was a stale six-kind list).
const VALID_KINDS = new Set<RuntimeKind>(RUNTIME_KINDS);

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
  /*
   * ★2026-09-23 — 이 표에는 ACP 좌석 신원(acpAgentId)을 담을 열이 없다. 예전엔 kind "acp" 를
   *   그대로 저장했고, 실행 때 좌석 대조(selection.ts runtimeMatchesOverride)가 영원히 안 맞아
   *   조용히 역할 풀로 실행됐다(사용자는 고정했다고 믿는다). 공유 스키마 사다리를 올리지 않고
   *   가장 안전한 쪽을 고른다: 저장 때 코드로 거절한다. 화면은 ACP 를 에이전트별 고정 목록에서
   *   "지원 안 함"으로 비활성화해 이 거절에 닿지 않는다. 열이 생기면 여기만 풀면 된다.
   */
  if (!runtimeSupportsAgentOverride(selection)) {
    throw new RuntimeSelectionContractError(
      "agent_runtime_override_acp_unsupported",
      "ACP engines cannot be pinned per agent yet. Choose the ACP engine in the chat instead.",
    );
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
  // The fallback and follow rows of an agent's model order (below) are one setting, shown by the primary row only.
  return rows.filter((row) => !(row.scope === "agent" && row.target_id.includes(ORDER_MARK))).map(toOverride);
}

/*
 * ── An agent's own model order ──────────────────────────────
 * Each agent follows the global Worker order (default), the global Orchestrator order, or has its own ordered list of
 * [model, effort] lines (the first is the primary, the rest are fallbacks). Stored in THIS table, no new table or column:
 *   · `own`            scope=agent, target_id=<agentId> is line 1 (exactly the row an older build wrote and read), lines 2.. are
 *                      target_id=<agentId>#2, #3 ...
 *   · `orchestrator` / `worker` (an explicit choice)   one row target_id=<agentId>#follow, label = the role (kind is a placeholder).
 *   · no row           the default: nothing was chosen, so the selection is exactly what it was before this feature.
 * Who reads it: selection.ts selectRuntimeForTargets (every turn) and the order IPC. Who removes it: removeAgentRuntimeOverride
 * (agent deleted: settings-agent-ops releaseAgentReferences, org.ts), a new write (replaces all rows of the agent in one
 * transaction), agent-dedupe (re-keys on a merge). The order is a setting of THIS computer: it is in no package, sync or upload.
 */
const ORDER_MARK = "#";
const FOLLOW_ROW = "#follow";
const MAX_OWN_LINES = 12;
export type AgentModelFollow = "worker" | "orchestrator" | "own";
export interface AgentModelOrder {
  agentId: string;
  /** What the agent follows now; "worker" with explicit=false is the default (nothing stored). */
  follow: AgentModelFollow;
  /** true when the owner chose (a row exists); false = the default, which keeps the turn's own role pool exactly as before. */
  explicit: boolean;
  /** The agent's own lines in order (only when follow is "own"). */
  own: RuntimeSelection[];
  updatedAt: string | null;
}
export class AgentModelOrderError extends Error {
  constructor(readonly code: "agent_id_invalid" | "own_order_empty" | "own_order_too_long" | "own_order_line_invalid" | "follow_invalid", message: string) { super(message); }
}
const orderTarget = (agentId: string, position: number): string => position === 1 ? agentId : `${agentId}${ORDER_MARK}${position}`;
function validAgentId(agentId: unknown): string {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id || id.length > 200 || id.includes(ORDER_MARK)) throw new AgentModelOrderError("agent_id_invalid", "agent id is invalid");
  return id;
}
function likeEscape(value: string): string { return value.replace(/[\\%_]/g, (ch) => `\\${ch}`); }
function orderRowsOf(agentId: string): RuntimeOverrideRow[] {
  return getDb()
    .prepare("SELECT * FROM agent_runtime_overrides WHERE scope = 'agent' AND (target_id = ? OR target_id LIKE ? ESCAPE '\\')")
    .all(agentId, `${likeEscape(agentId)}${ORDER_MARK}%`) as RuntimeOverrideRow[];
}
function storedSelection(row: RuntimeOverrideRow): RuntimeSelection | null {
  try { return toOverride(row).selection; } catch { return null; }
}
/** The agent's stored order, read fresh from the table (turn time: a change of the global order or of this setting applies from the next turn). */
export function readAgentModelOrder(agentId: string): AgentModelOrder {
  // Reading never throws: an id that cannot carry an order (empty, too long, with the row mark) is simply an agent that has none, so a turn
  // of an agent with an odd id still runs. Only a write validates the id.
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id || id.length > 200 || id.includes(ORDER_MARK)) return { agentId: id, follow: "worker", explicit: false, own: [], updatedAt: null };
  const rows = orderRowsOf(id);
  const marker = rows.find((row) => row.target_id === `${id}${FOLLOW_ROW}`);
  const lines = rows
    .filter((row) => row.target_id !== `${id}${FOLLOW_ROW}`)
    .map((row) => ({ position: row.target_id === id ? 1 : Number(row.target_id.slice(id.length + 1)), row }))
    .filter((item) => Number.isInteger(item.position) && item.position >= 1)
    .sort((a, b) => a.position - b.position);
  const own = lines.flatMap((item) => { const selection = storedSelection(item.row); return selection ? [selection] : []; });
  const primary = lines.find((item) => item.position === 1);
  const markerRole = marker?.label === "orchestrator" || marker?.label === "worker" ? marker.label : null;
  // A marker and a primary row together can only come from an older build writing after a newer one: the later write wins.
  const markerWins = markerRole !== null && (!primary || marker!.updated_at >= primary.row.updated_at);
  if (markerWins) return { agentId: id, follow: markerRole!, explicit: true, own: [], updatedAt: marker!.updated_at };
  if (primary && own.length > 0) return { agentId: id, follow: "own", explicit: true, own, updatedAt: primary.row.updated_at };
  return { agentId: id, follow: "worker", explicit: false, own: [], updatedAt: null };
}
function ownLineOverride(agentId: string, order: AgentModelOrder, index: number): AgentRuntimeOverride {
  return { scope: "agent", targetId: agentId, label: null, selection: order.own[index], updatedAt: order.updatedAt ?? "" };
}
/** The agent's own lines as overrides (line 1 first); empty when the agent does not have its own order. */
export function agentOwnOrderOverrides(agentId: string): AgentRuntimeOverride[] {
  const order = readAgentModelOrder(agentId);
  return order.follow === "own" ? order.own.map((_, index) => ownLineOverride(order.agentId, order, index)) : [];
}
/** The global role an agent explicitly follows, or null (default or its own order). */
export function agentFollowedRole(agentId: string | null | undefined): "worker" | "orchestrator" | null {
  if (!agentId) return null;
  try { const order = readAgentModelOrder(agentId); return order.explicit && order.follow !== "own" ? order.follow : null; } catch { return null; }
}
function replaceOrderRows(agentId: string, rows: Array<{ target: string; label: string | null; selection: RuntimeSelection }>): void {
  const db = getDb();
  const updatedAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM agent_runtime_overrides WHERE scope = 'agent' AND (target_id = ? OR target_id LIKE ? ESCAPE '\\')")
      .run(agentId, `${likeEscape(agentId)}${ORDER_MARK}%`);
    const insert = db.prepare(
      `INSERT INTO agent_runtime_overrides (scope, target_id, label, kind, backend, source, model, effort, long_context, updated_at)
       VALUES ('agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run(row.target, row.label, row.selection.kind, row.selection.backend ?? null, row.selection.source ?? null,
      row.selection.model ?? null, row.selection.effort ?? null, row.selection.longContext ? 1 : 0, updatedAt);
  })();
}
/** The agent follows a global order ("worker" or "orchestrator"), chosen by the owner. Replaces every stored line of the agent. */
export function writeAgentModelFollow(agentId: string, follow: "worker" | "orchestrator"): AgentModelOrder {
  const id = validAgentId(agentId);
  if (follow !== "worker" && follow !== "orchestrator") throw new AgentModelOrderError("follow_invalid", "follow must be worker, orchestrator or own");
  replaceOrderRows(id, [{ target: `${id}${FOLLOW_ROW}`, label: follow, selection: { kind: "claude-code" } as RuntimeSelection }]);
  return readAgentModelOrder(id);
}
/** The agent's own ordered lines (1..12; the first is the primary, the rest fallbacks). Replaces every stored line of the agent. */
export function writeAgentOwnOrder(agentId: string, selections: RuntimeSelection[], label?: string | null): AgentModelOrder {
  const id = validAgentId(agentId);
  if (!Array.isArray(selections) || selections.length === 0) throw new AgentModelOrderError("own_order_empty", "an own order needs at least one line");
  if (selections.length > MAX_OWN_LINES) throw new AgentModelOrderError("own_order_too_long", `an own order has at most ${MAX_OWN_LINES} lines`);
  const lines = selections.map((selection) => {
    try { return normalizeSelection(selection); }
    catch (error) { throw new AgentModelOrderError("own_order_line_invalid", error instanceof Error ? error.message : "line invalid"); }
  });
  replaceOrderRows(id, lines.map((selection, index) => ({ target: orderTarget(id, index + 1), label: index === 0 ? cleanText(label) : null, selection })));
  return readAgentModelOrder(id);
}
/** Back to the default (nothing stored). */
export function clearAgentModelOrder(agentId: string): void {
  const id = validAgentId(agentId);
  getDb().prepare("DELETE FROM agent_runtime_overrides WHERE scope = 'agent' AND (target_id = ? OR target_id LIKE ? ESCAPE '\\')")
    .run(id, `${likeEscape(id)}${ORDER_MARK}%`);
}

export function getAgentRuntimeOverride(
  scope: AgentRuntimeOverrideScope,
  targetId: string,
): AgentRuntimeOverride | null {
  assertScope(scope);
  const id = cleanText(targetId);
  if (!id) return null;
  // An agent's assignment is its own order's first line; an explicit follow of a global order is no assignment (null).
  if (scope === "agent" && !id.includes(ORDER_MARK)) {
    const first = agentOwnOrderOverrides(id)[0];
    if (first) {
      const row = getDb().prepare("SELECT label FROM agent_runtime_overrides WHERE scope = 'agent' AND target_id = ?").get(id) as { label: string | null } | undefined;
      return { ...first, label: row?.label ?? null };
    }
    return null;
  }
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
    // The owner told this agent to follow a global order: that is its own answer, so a team's pin below it does not apply.
    if (target.scope === "agent" && agentFollowedRole(target.targetId)) return null;
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
  if (input.scope === "agent" && !targetId.includes(ORDER_MARK)) {
    // The older single-model write keeps the agent's later lines (fallbacks) when it already had its own order.
    const existing = readAgentModelOrder(targetId);
    writeAgentOwnOrder(targetId, [selection, ...(existing.follow === "own" ? existing.own.slice(1) : [])], input.label);
    return getAgentRuntimeOverride("agent", targetId) as AgentRuntimeOverride;
  }
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
  if (scope === "agent" && !id.includes(ORDER_MARK)) { clearAgentModelOrder(id); return; }
  getDb()
    .prepare("DELETE FROM agent_runtime_overrides WHERE scope = ? AND target_id = ?")
    .run(scope, id);
}
