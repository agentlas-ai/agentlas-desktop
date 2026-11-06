/**
 * Whether the next targeted contract-repair round is worth running. Progress is not the blocker count: a weak model can fix
 * some blockers and introduce as many new ones in the same round, and that round still moved. A round counts as progress when
 * at least one blocker from the previous list is gone and the list as a whole has not been seen before; a list that comes
 * back (fixing A breaks B, fixing B breaks A) is an oscillation and ends the loop. The caller's round cap stays the backstop.
 */
export interface ContractRepairProgress {
  previous: ReadonlySet<string> | null;
  seen: ReadonlySet<string>;
}

export type ContractRepairVerdict =
  | { next: true; state: ContractRepairProgress }
  | { next: false; reason: "clean" | "no_blockers_resolved" | "list_repeated"; state: ContractRepairProgress };

export function initialContractRepairProgress(): ContractRepairProgress {
  return { previous: null, seen: new Set() };
}

export function contractBlockerDigest(blockers: readonly string[]): string {
  return [...new Set(blockers)].sort().join("\n");
}

export function judgeContractRepairRound(state: ContractRepairProgress, blockers: readonly string[]): ContractRepairVerdict {
  if (blockers.length === 0) return { next: false, reason: "clean", state };
  const current = new Set(blockers);
  const digest = contractBlockerDigest(blockers);
  if (state.seen.has(digest)) return { next: false, reason: "list_repeated", state };
  if (state.previous && ![...state.previous].some((blocker) => !current.has(blocker))) {
    return { next: false, reason: "no_blockers_resolved", state };
  }
  return { next: true, state: { previous: current, seen: new Set([...state.seen, digest]) } };
}
