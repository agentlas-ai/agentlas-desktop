/**
 * Which model runs an Alive One/Work wake — the owner's dashboard role pool, never the composer chip.
 *
 * Order: orchestrator members in their saved order (Settings/Dashboard RuntimeControl, runtime.setRoleMembers),
 * then worker members. An empty worker pool inherits the orchestrator pool, so it adds nothing here.
 * A member is "exhausted" when the existing execution fallback would skip it right now
 * (rolePriorityRuntimes: quota/auth cooldown noted by the runner, exhausted usage snapshot, unreadable
 * credential, missing runtime/model) — the same detection automation and team fallback use, not a new one.
 *
 * The chosen member must also pass the exact long-run binding (source + model) that desktopAliveRuntime's
 * exactSelection demands; this module adds a NEW pool → exact-selection resolver and leaves exactSelection
 * untouched. The life's stored binding is the POLICY ({kind:"pool"}); the resolved model is written only on
 * the wake receipt, so the lifetime heartbeat does not read every wake as a binding change.
 */
import type { RuntimeRole, RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { detectRuntimes } from "../runtime/detect";
import { rolePriorityRuntimes } from "../runtime/selection";
import { listModelRoleMembers } from "../store/model-roles";
import { captureLongRunRuntimeSelection } from "../long-run/exact-runtime-binding";
import type { AliveWakeRuntimeRecord } from "../alive-core/contracts";

/** Stored as alive_agents.runtime_binding_json: a policy, stable across wakes. */
export const ALIVE_POOL_RUNTIME_POLICY = Object.freeze({ kind: "pool", order: "orchestrator>worker", v: 1 });

export interface AliveModelOrderEntry {
  role: "orchestrator" | "worker";
  position: number;
  runtimeId: string;
  model: string;
  label: string;
  exhausted: boolean;
  /** Why it is skipped now (content-free code); null when usable. */
  skipCode: string | null;
  /** Exact selection when usable; null otherwise. */
  selection: RuntimeSelection | null;
}

const sameSeat = (a: Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "acpAgentId">,
  b: Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "acpAgentId">): boolean =>
  a.kind === b.kind && (a.backend ?? null) === (b.backend ?? null) && (a.source ?? null) === (b.source ?? null)
  && (a.model ?? null) === (b.model ?? null) && (a.acpAgentId ?? null) === (b.acpAgentId ?? null);

function statusSelection(runtime: RuntimeStatus): RuntimeSelection {
  return { kind: runtime.kind, backend: runtime.backend, source: runtime.source, acpAgentId: runtime.acpAgentId,
    label: runtime.label, model: runtime.model ?? undefined, effort: runtime.effort ?? undefined,
    longContext: runtime.longContextEnabled };
}

/** Pure: pool members + live usable candidates → ordered entries. Exposed for contracts. */
export function buildAliveModelOrder(input: {
  members: Record<"orchestrator" | "worker", Array<{ selection: RuntimeSelection }>>;
  usable: Record<"orchestrator" | "worker", RuntimeStatus[]>;
  exact?: (selection: RuntimeSelection) => boolean;
}): AliveModelOrderEntry[] {
  const out: AliveModelOrderEntry[] = [];
  for (const role of ["orchestrator", "worker"] as const) {
    input.members[role].forEach((member, position) => {
      const wanted = member.selection;
      const live = input.usable[role].find((candidate) => candidate.kind === wanted.kind
        && (!wanted.backend || candidate.backend === wanted.backend)
        && (!wanted.source || candidate.source === wanted.source)
        && (wanted.kind !== "acp" || candidate.acpAgentId === wanted.acpAgentId)
        && (!wanted.model || candidate.model === wanted.model));
      const selection = live ? statusSelection(live) : null;
      const model = (selection?.model ?? wanted.model ?? "").trim();
      // A seat already listed (the same member saved in both roles) is one seat in the order.
      if (out.some((entry) => entry.selection && selection && sameSeat(entry.selection, selection))) return;
      let skipCode: string | null = null;
      if (!selection) skipCode = "pool.member-unavailable";
      else if (!selection.model || !selection.source) skipCode = "pool.member-model-unknown";
      else if (input.exact && !input.exact(selection)) skipCode = "pool.member-binding-inexact";
      out.push({ role, position, runtimeId: wanted.kind === "acp" && wanted.acpAgentId ? `acp:${wanted.acpAgentId}` : wanted.kind,
        model, label: (wanted.label ?? selection?.label ?? wanted.kind).toString().slice(0, 120),
        exhausted: skipCode !== null, skipCode, selection: skipCode ? null : selection });
    });
  }
  return out;
}

let cached: { atMs: number; entries: AliveModelOrderEntry[] } | null = null;

function exactOk(selection: RuntimeSelection): boolean {
  try { captureLongRunRuntimeSelection(selection, { requireExact: true }); return true; } catch { return false; }
}

/** Refresh from live detection (cached by detect.ts). Called before each organism beat. */
export async function refreshAliveModelOrder(nowMs = Date.now()): Promise<AliveModelOrderEntry[]> {
  const detected = await detectRuntimes();
  const members = {
    orchestrator: listModelRoleMembers("orchestrator" as RuntimeRole),
    worker: listModelRoleMembers("worker" as RuntimeRole),
  };
  const usable = {
    orchestrator: rolePriorityRuntimes(detected, "orchestrator"),
    worker: members.worker.length ? rolePriorityRuntimes(detected, "worker") : [],
  };
  const entries = buildAliveModelOrder({ members, usable, exact: exactOk });
  cached = { atMs: nowMs, entries };
  return entries;
}

export function cachedAliveModelOrder(): AliveModelOrderEntry[] { return cached?.entries ?? []; }

/** NEW resolver (pool → exact selection). The first usable entry in owner order, or null. */
export function aliveSelectionFromPool(entries: AliveModelOrderEntry[] = cachedAliveModelOrder()):
  { selection: RuntimeSelection; record: AliveWakeRuntimeRecord } | null {
  for (const entry of entries) {
    if (entry.exhausted || !entry.selection) continue;
    const selection = entry.selection;
    // buildAliveModelOrder already admitted this selection through the exact binding check.
    if (!selection.model || !selection.source) continue;
    return { selection, record: { role: entry.role, position: entry.position, kind: selection.kind,
      backend: selection.backend ?? null, model: selection.model, label: entry.label } };
  }
  return null;
}

export function __setAliveModelOrderForTest(entries: AliveModelOrderEntry[]): void { cached = { atMs: Date.now(), entries }; }
