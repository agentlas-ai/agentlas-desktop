// Repeat signals from saved graphs, grouped by structure (shared/graph-structure.ts), for the repeated-work detector.
//
// Search sentences cluster by meaning (detectRepeatSignals). Graph purposes do not: graphs that repeat one structure
// each name their episode, counts and sources, so their purpose sentences sit far apart by meaning, and sentence
// clustering joins them into mixed clusters whose tool flow is too common to pass. What repeats there is the structure, so the structure groups them; the sentences
// only go to the judgment, which decides whether one reusable behavior is behind them (not_common otherwise).

import { createHash } from "node:crypto";
import { TOOLCHAIN_DETECTOR_POLICY, collapseRetries, varyingInstanceDetails,
  type DetectorObservation, type RepeatSignal, type ToolchainDetectorPolicy } from "./toolchain-detector";

export interface GraphStructureMember extends DetectorObservation { fingerprint: string }

function unit(vector: readonly number[]): number[] {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map(value => value / length) : vector.map(() => 0);
}

/**
 * One signal per structure saved for enough distinct pieces of work: after retries are folded (same conversation,
 * near-identical purpose, minutes apart), at least minMembers graphs with minDistinctTasks different purposes.
 * The signal key is the structure's, so a judgment on it holds while new graphs of that structure keep arriving.
 */
export function detectGraphStructureSignals(observations: readonly GraphStructureMember[],
  policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY): RepeatSignal[] {
  const recent = [...observations].sort((a, b) => b.at.localeCompare(a.at)).slice(0, policy.maxObservations);
  const groups = new Map<string, GraphStructureMember[]>();
  for (const item of recent) groups.set(item.fingerprint, [...(groups.get(item.fingerprint) ?? []), item]);
  const signals: RepeatSignal[] = [];
  for (const [fingerprint, group] of groups) {
    const { kept, collapsed } = collapseRetries(group, policy);
    if (kept.length < policy.minMembers) continue;
    const members = [...kept].sort((a, b) => a.at.localeCompare(b.at));
    const runs = new Set(members.map(member => member.runId ?? member.id)).size;
    if (runs < policy.minRuns) continue;
    if (new Set(members.map(member => member.task.toLocaleLowerCase().replace(/\s+/gu, " ").trim())).size < policy.minDistinctTasks) continue;
    const dimensions = members[0].vector.length;
    const centroid = unit(Array.from({ length: dimensions }, (_, d) => members.reduce((sum, member) => sum + (member.vector[d] ?? 0), 0) / members.length));
    const chats = new Map<string, number>();
    for (const member of members) if (member.chatId) chats.set(member.chatId, (chats.get(member.chatId) ?? 0) + 1);
    // Members of one structure share every step, in order, by construction.
    const steps = [...members[0].trace];
    signals.push({ key: createHash("sha256").update(`graph-structure:${fingerprint}`, "utf8").digest("hex").slice(0, 24),
      memberIds: members.map(member => member.id), members, days: new Set(members.map(member => member.at.slice(0, 10))).size, runs,
      collapsedRetries: collapsed, flowCohesion: 1, flowLift: null, centroid, commonSteps: steps,
      varyingDetails: varyingInstanceDetails(members.map(member => member.task)),
      dominantChatId: [...chats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null });
  }
  return signals.sort((a, b) => b.runs - a.runs || b.days - a.days);
}

