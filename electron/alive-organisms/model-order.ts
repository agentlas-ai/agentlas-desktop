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
import { rolePriorityRuntimes, runtimeForOwnerSelection } from "../runtime/selection";
import { getResolvedModelRole, listModelRoleMembers } from "../store/model-roles";
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
  /** The live runtime (with the resolved model) the light wake runner is picked from; null when not usable. */
  status: RuntimeStatus | null;
}

const sameSeat = (a: Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "acpAgentId">,
  b: Pick<RuntimeSelection, "kind" | "backend" | "source" | "model" | "acpAgentId">): boolean =>
  a.kind === b.kind && (a.backend ?? null) === (b.backend ?? null) && (a.source ?? null) === (b.source ?? null)
  && (a.model ?? null) === (b.model ?? null) && (a.acpAgentId ?? null) === (b.acpAgentId ?? null);

/**
 * A member saved as "engine default" has no model id; an Alive wake still needs an exact one. Use the model the
 * CLI itself reports as its default (config file, then the last observed run) — recorded on the receipt, never
 * invented. With neither, the member is not selectable (pool.member-model-unknown).
 */
function statusSelection(runtime: RuntimeStatus): RuntimeSelection {
  return { kind: runtime.kind, backend: runtime.backend, source: runtime.source, acpAgentId: runtime.acpAgentId,
    label: runtime.label, model: runtime.model ?? runtime.cliDefaultModel ?? runtime.observedDefaultModel ?? undefined,
    effort: runtime.effort ?? undefined,
    longContext: runtime.longContextEnabled };
}

/** Pure: pool members + live usable candidates → ordered entries. Exposed for contracts. */
export function buildAliveModelOrder(input: {
  members: Record<"orchestrator" | "worker", Array<{ selection: RuntimeSelection }>>;
  usable: Record<"orchestrator" | "worker", RuntimeStatus[]>;
  exact?: (selection: RuntimeSelection) => boolean;
  /** Learned light-wake facts (light-wake.ts): a member that cannot run a decision-only wake is skipped. */
  facts?: (status: RuntimeStatus) => readonly string[];
}): AliveModelOrderEntry[] {
  const out: AliveModelOrderEntry[] = [];
  for (const role of ["orchestrator", "worker"] as const) {
    input.members[role].forEach((member, position) => {
      const wanted = member.selection;
      const live = input.usable[role].find((candidate) => candidate.kind === wanted.kind
        && (!wanted.backend || candidate.backend === wanted.backend)
        && (!wanted.source || candidate.source === wanted.source)
        && (wanted.kind !== "acp" || candidate.acpAgentId === wanted.acpAgentId)
        && (!wanted.model || candidate.model === wanted.model || statusSelection(candidate).model === wanted.model));
      const selection = live ? statusSelection(live) : null;
      const model = (selection?.model ?? wanted.model ?? "").trim();
      // A seat already listed (the same member saved in both roles) is one seat in the order.
      if (out.some((entry) => entry.selection && selection && sameSeat(entry.selection, selection))) return;
      let skipCode: string | null = null;
      if (!selection) skipCode = "pool.member-unavailable";
      else if (!selection.model || !selection.source) skipCode = "pool.member-model-unknown";
      else if (input.exact && !input.exact(selection)) skipCode = "pool.member-binding-inexact";
      else if (live && input.facts?.(live).includes("cannot-judge")) skipCode = "pool.member-no-tools-unsupported";
      else if (live && input.facts?.(live).includes("usage-unmeasured")) skipCode = "pool.member-usage-unmeasured";
      out.push({ role, position, runtimeId: wanted.kind === "acp" && wanted.acpAgentId ? `acp:${wanted.acpAgentId}` : wanted.kind,
        model, label: (wanted.label ?? selection?.label ?? wanted.kind).toString().slice(0, 120),
        exhausted: skipCode !== null, skipCode, selection: skipCode ? null : selection,
        status: skipCode || !live || !selection ? null : { ...live, model: selection.model } });
    });
  }
  return out;
}

/**
 * An unconfigured store has no pool rows. Execution then runs the owner's active orchestrator — the dashboard's
 * resolved orchestrator selection, which may be an Agentlas serving tier (R5 2026-09-25: a serving-only owner saw
 * Claude Code as Alive's only model, because the fallback read detection's `active` flag, which marks CLI runtimes
 * only). Use that resolved selection, gated the same way as a pool member (runtimeForOwnerSelection: credential,
 * cooldown, model, quota); with no resolved selection keep the legacy active runtime.
 */
export function legacyMembers(members: Record<"orchestrator" | "worker", Array<{ selection: RuntimeSelection }>>,
  usable: Record<"orchestrator" | "worker", RuntimeStatus[]>,
  resolved?: { selection: RuntimeSelection; live: RuntimeStatus | null } | null): {
    members: Record<"orchestrator" | "worker", Array<{ selection: RuntimeSelection }>>;
    usable: Record<"orchestrator" | "worker", RuntimeStatus[]>;
  } {
  if (members.orchestrator.length > 0) return { members, usable };
  if (resolved) {
    return { members: { ...members, orchestrator: [{ selection: resolved.selection }] },
      usable: { ...usable, orchestrator: resolved.live ? [resolved.live] : [] } };
  }
  return { members: { ...members, orchestrator: usable.orchestrator.map((runtime) => ({ selection: statusSelection(runtime) })) }, usable };
}

let cached: { atMs: number; entries: AliveModelOrderEntry[] } | null = null;

function exactOk(selection: RuntimeSelection): boolean {
  try { captureLongRunRuntimeSelection(selection, { requireExact: true }); return true; } catch { return false; }
}

/** Refresh from live detection (cached by detect.ts). Called before each organism beat. */
export async function refreshAliveModelOrder(nowMs = Date.now(),
  facts?: (status: RuntimeStatus) => readonly string[]): Promise<AliveModelOrderEntry[]> {
  const detected = await detectRuntimes();
  const members = {
    orchestrator: listModelRoleMembers("orchestrator" as RuntimeRole),
    worker: listModelRoleMembers("worker" as RuntimeRole),
  };
  const usable = {
    orchestrator: rolePriorityRuntimes(detected, "orchestrator"),
    worker: members.worker.length ? rolePriorityRuntimes(detected, "worker") : [],
  };
  let resolved: { selection: RuntimeSelection; live: RuntimeStatus | null } | null = null;
  if (members.orchestrator.length === 0) {
    const role = getResolvedModelRole("orchestrator" as RuntimeRole);
    if (role?.selection) resolved = { selection: role.selection, live: runtimeForOwnerSelection(detected, role.selection) };
  }
  const plan = legacyMembers(members, usable, resolved);
  const entries = buildAliveModelOrder({ members: plan.members, usable: plan.usable, exact: exactOk, ...(facts ? { facts } : {}) });
  cached = { atMs: nowMs, entries };
  return entries;
}

export function cachedAliveModelOrder(): AliveModelOrderEntry[] { return cached?.entries ?? []; }

/** NEW resolver (pool → exact selection). The first usable entry in owner order, or null. */
export function aliveSelectionFromPool(entries: AliveModelOrderEntry[] = cachedAliveModelOrder()):
  { selection: RuntimeSelection; status: RuntimeStatus; record: AliveWakeRuntimeRecord } | null {
  for (const entry of entries) {
    if (entry.exhausted || !entry.selection || !entry.status) continue;
    const selection = entry.selection;
    // buildAliveModelOrder already admitted this selection through the exact binding check.
    if (!selection.model || !selection.source) continue;
    return { selection, status: entry.status, record: { role: entry.role, position: entry.position, kind: selection.kind,
      backend: selection.backend ?? null, model: selection.model, label: entry.label } };
  }
  return null;
}

export function __setAliveModelOrderForTest(entries: AliveModelOrderEntry[]): void { cached = { atMs: Date.now(), entries }; }
