import type { Actuator } from "./actuator";
import { probeDialog, synthesizeDialogCapability } from "./dialog-probe";
import { withForeground } from "./foreground";
import { enumerateMenus, menuLeaves, type MenuNode, type MenuTarget } from "./menu-probe";
import type { Capability, CapabilityParameter } from "./types";

// Self-repair. An explored capability breaks when the app's interface moves under it: a menu item is renamed or relocated by an update, a
// dialog gains or loses a control. Repair first asks "is the menu path still there?" by reading the menu bar (read-only). If the item
// moved, it looks for the same item under a new name or parent; then it re-probes the dialog and rewrites the capability from what is
// there now. If it cannot be found, or the re-probe fails, the capability is marked degraded and never silently kept as "verified".

export function normalizeLabel(label: string): string {
  return label.normalize("NFKC").toLowerCase().replace(/[…]|\.{3}/g, "").replace(/&/g, "").replace(/\s+/g, " ").trim();
}

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  if (x === y) return 1;
  if (!x || !y) return 0;
  const tx = trigrams(x);
  const ty = trigrams(y);
  let shared = 0;
  for (const gram of tx) if (ty.has(gram)) shared += 1;
  return (2 * shared) / (tx.size + ty.size);
}

const SAME_ITEM_AT = 0.72;
const MAYBE_ITEM_AT = 0.5;

export interface MovedCandidate { path: string[]; how: "same" | "moved" | "renamed"; score: number; needsShapeCheck: boolean }

// Where could this menu path have gone? Best guess first. Exact path and "the same words elsewhere" are accepted on their own; a label that is
// only somewhat alike ("Print…" -> "Print Document…") is only a candidate: it is accepted if the dialog it opens looks like the old one.
export function candidatePaths(oldPath: readonly string[], leaves: readonly MenuNode[]): MovedCandidate[] {
  const joined = oldPath.join("\u0000");
  const exact = leaves.find((leaf) => leaf.path.join("\u0000") === joined);
  if (exact) return [{ path: exact.path, how: "same", score: 1, needsShapeCheck: false }];
  const label = oldPath[oldPath.length - 1];
  const parent = oldPath.slice(0, -1).join("\u0000");
  const sameWords = leaves.filter((leaf) => normalizeLabel(leaf.label) === normalizeLabel(label));
  if (sameWords.length === 1) {
    const inSameMenu = sameWords[0].path.slice(0, -1).join("\u0000") === parent;
    return [{ path: sameWords[0].path, how: inSameMenu ? "renamed" : "moved", score: 1, needsShapeCheck: false }];
  }
  const out: MovedCandidate[] = [];
  for (const leaf of leaves.filter((item) => item.path.slice(0, -1).join("\u0000") === parent)) {
    const score = similarity(leaf.label, label);
    if (score >= MAYBE_ITEM_AT) out.push({ path: leaf.path, how: "renamed", score, needsShapeCheck: score < SAME_ITEM_AT });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// Kept for callers that only want the single clear answer.
export function findMovedPath(oldPath: readonly string[], leaves: readonly MenuNode[]): { path: string[]; how: "same" | "moved" | "renamed" } | null {
  const first = candidatePaths(oldPath, leaves).find((candidate) => !candidate.needsShapeCheck);
  return first ? { path: first.path, how: first.how } : null;
}

// How alike are two dialogs, by the kinds and captions of what they ask for (the action button list is left out: it is the dialog's verb).
export function shapeSimilarity(a: readonly CapabilityParameter[], b: readonly CapabilityParameter[]): number {
  const signature = (parameters: readonly CapabilityParameter[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const parameter of parameters) {
      if (parameter.name === "action") continue;
      const key = `${parameter.type.split(":")[0].split("<")[0]}|${parameter.description ?? ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const x = signature(a);
  const y = signature(b);
  let shared = 0;
  let total = 0;
  for (const key of new Set([...x.keys(), ...y.keys()])) {
    shared += Math.min(x.get(key) ?? 0, y.get(key) ?? 0);
    total += Math.max(x.get(key) ?? 0, y.get(key) ?? 0);
  }
  return total === 0 ? 1 : shared / total;
}

export interface RepairPorts {
  actuator: Actuator;
  target: MenuTarget;
  appKey: string;
  fingerprint: string;
  day: string;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export type RepairOutcome =
  | { status: "repaired"; capability: Capability; how: "same" | "moved" | "renamed" }
  | { status: "degraded"; reason: "menu_gone" | "probe_failed" | "not_a_dialog" | "not_repairable"; code?: string };

// The capability must be an explored dialog capability (steps starting with invoke_menu). Anything else is not repairable here.
export async function repairDialogCapability(ports: RepairPorts, capability: Capability): Promise<RepairOutcome> {
  const first = capability.body?.kind === "steps" ? capability.body.steps[0] : undefined;
  const oldPath = first?.tool === "invoke_menu" && Array.isArray(first.args.path) ? (first.args.path as string[]) : null;
  if (!oldPath) return { status: "degraded", reason: "not_repairable" };
  const holder: { accepted: { found: MovedCandidate; fresh: Capability } | null; gone: boolean; failure: { reason: "probe_failed" | "not_a_dialog"; code?: string } } = { accepted: null, gone: false, failure: { reason: "probe_failed" } };
  // The menus are read with the app in front: a background app's menus are stale (items switched off, state-dependent ones missing).
  const front = await withForeground(ports.actuator, ports.target, async () => {
    const scan = await enumerateMenus(ports.actuator, ports.target, { signal: ports.signal, ...(ports.sleep ? { sleep: ports.sleep } : {}) });
    if (scan.stuck) { holder.failure = { reason: "probe_failed", code: "menu_stuck" }; return; } // a menu that will not close: nothing else is pressed
    const candidates = candidatePaths(oldPath, menuLeaves(scan.nodes));
    if (candidates.length === 0) { holder.gone = true; return; }
    for (const found of candidates) {
      const probe = await probeDialog({ actuator: ports.actuator, target: ports.target, signal: ports.signal, ...(ports.sleep ? { sleep: ports.sleep } : {}) }, found.path);
      if (probe.status !== "ok" || !probe.shape) { holder.failure = { reason: probe.status === "no-dialog" ? "not_a_dialog" : "probe_failed", code: probe.code ?? probe.status }; continue; }
      const fresh = synthesizeDialogCapability(ports.appKey, found.path, probe.shape, ports.fingerprint, ports.day, ports.actuator.platform);
      if (found.needsShapeCheck && shapeSimilarity(capability.parameters, fresh.parameters) < 0.6) { holder.failure = { reason: "probe_failed", code: "different_dialog" }; continue; }
      holder.accepted = { found, fresh };
      break;
    }
  }, ports.signal, ports.sleep);
  if (!front.ok) return { status: "degraded", reason: "probe_failed", code: front.code };
  if (holder.gone) return { status: "degraded", reason: "menu_gone" };
  if (!holder.accepted) return { status: "degraded", ...holder.failure };
  const { found, fresh } = holder.accepted;
  // The id stays (callers hold it); everything the probe observed replaces what was there.
  const repaired: Capability = {
    ...capability,
    name: fresh.name,
    suite: fresh.suite,
    source: fresh.source,
    parameters: fresh.parameters,
    body: fresh.body,
    postconditions: fresh.postconditions,
    status: "verified",
    // what was proven by a real call no longer applies to a shape that changed; the re-probe proves the entry point again
    verification: "structural",
    boundFingerprint: ports.fingerprint,
    revision: (capability.revision ?? 0) + 1,
    evidence: capability.evidence
      ? { observations: capability.evidence.observations, firstSeenDay: capability.evidence.firstSeenDay, lastSeenDay: ports.day }
      : fresh.evidence,
  };
  return { status: "repaired", capability: repaired, how: found.how };
}
