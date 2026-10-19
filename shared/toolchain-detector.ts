// Repeated-work detection for Toolchains — the pure host half.
//
// The detector finds work One keeps doing again and hands one well-evidenced signal to a model, which decides whether it
// is a reusable capability (a Toolchain works like a plugin or connector: one stable behavior, typed inputs). This file
// only decides which signals deserve that model call. Sentence similarity, shared tool steps, and recurrence on
// separate days jointly distinguish reusable behavior from unrelated work and retries.
// The thresholds are policy inputs; they do not independently prove that a reusable capability exists.

import { createHash } from "node:crypto";
import type { ToolchainAsset, ToolchainCallReceipt } from "./toolchain-asset";

export const TOOLCHAIN_DETECTOR_POLICY = Object.freeze({
  /** Average-linkage cosine distance; members of one cluster average ≥ 0.6 similarity. */
  clusterDistance: 0.4,
  minMembers: 3,
  /** Recurrence: a burst inside one day (one Goal retrying one item) is not a recurring behavior. */
  minDays: 3,
  minRuns: 3,
  /** Mean pairwise Jaccard of runtime-independent tool steps after each sentence. */
  minTraceSimilarity: 0.45,
  windowDays: 21,
  maxObservations: 400,
  maxRepresentatives: 8,
  traceLength: 15,
  /** A judged signal is not re-asked while its verdict is fresh. */
  cooldownDays: 14,
  /** Centroid similarity at which a new signal is the same signal as a judged one. */
  sameSignalSimilarity: 0.75,
});
export type ToolchainDetectorPolicy = typeof TOOLCHAIN_DETECTOR_POLICY;

export interface DetectorObservation {
  id: string;
  task: string;
  chatId: string | null;
  /** ISO time of the empty search. */
  at: string;
  runId: string | null;
  /** Runtime-independent tool steps that followed the search in the same run. */
  trace: readonly string[];
  vector: readonly number[];
}

export interface RepeatSignal {
  key: string;
  memberIds: string[];
  members: DetectorObservation[];
  days: number;
  runs: number;
  traceSimilarity: number;
  centroid: number[];
  /** Tool steps present in at least half of the members. */
  commonSteps: string[];
  /** Digit-bearing details that vary between members (dates, episode/version ids): inputs, never identity. */
  varyingDetails: string[];
  dominantChatId: string | null;
}

export interface DetectorVerdictRef {
  at: string;
  decision: string;
  centroid: readonly number[];
  memberIds: readonly string[];
}

function norm(vector: readonly number[]): number[] {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map(value => value / length) : vector.map(() => 0);
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i++) { dot += left[i] * right[i]; a += left[i] ** 2; b += right[i] ** 2; }
  return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : 0;
}

/** Average-linkage agglomerative clustering on cosine similarity (Lance-Williams update). Returns member index lists. */
export function clusterByAverageLinkage(vectors: readonly (readonly number[])[], distance: number): number[][] {
  const n = vectors.length;
  const unit = vectors.map(norm);
  const sim: number[][] = unit.map(left => unit.map(right => cosine(left, right)));
  const clusters: Array<number[] | null> = unit.map((_, index) => [index]);
  const floor = 1 - distance;
  for (;;) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) {
      if (!clusters[i]) continue;
      for (let j = i + 1; j < n; j++) if (clusters[j] && sim[i][j] > best) { best = sim[i][j]; bi = i; bj = j; }
    }
    if (bi < 0 || best < floor) break;
    const ni = clusters[bi]!.length, nj = clusters[bj]!.length;
    for (let k = 0; k < n; k++) {
      if (!clusters[k] || k === bi || k === bj) continue;
      const merged = (ni * sim[bi][k] + nj * sim[bj][k]) / (ni + nj);
      sim[bi][k] = merged; sim[k][bi] = merged;
    }
    clusters[bi] = [...clusters[bi]!, ...clusters[bj]!];
    clusters[bj] = null;
  }
  return clusters.filter((cluster): cluster is number[] => Boolean(cluster));
}

export function traceJaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left), b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let shared = 0;
  for (const step of a) if (b.has(step)) shared++;
  return shared / union.size;
}

function meanPairwise(members: readonly DetectorObservation[]): number {
  let total = 0, pairs = 0;
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    total += traceJaccard(members[i].trace, members[j].trace); pairs++;
  }
  return pairs ? total / pairs : 0;
}

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_.:/-]*/gu;
function tokens(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase().match(TOKEN) ?? []).map(token => token.replace(/[.:/-]+$/u, "")));
}

/** Digit-bearing tokens (dates, S03, v008, R01, t18) that appear in fewer than half of the members. */
export function varyingInstanceDetails(tasks: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const task of tasks) for (const token of tokens(task)) if (/\p{N}/u.test(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count < tasks.length / 2).map(([token]) => token).sort();
}

/** Instance details that leaked into a capability's identity text. Matching is on whole tokens. */
export function leakedInstanceDetails(text: string, details: readonly string[]): string[] {
  const present = tokens(text);
  return details.filter(detail => present.has(detail));
}

function dayOf(at: string): string { return at.slice(0, 10); }

function signalKey(memberIds: readonly string[]): string {
  return createHash("sha256").update([...memberIds].sort().join("\n"), "utf8").digest("hex").slice(0, 24);
}

/** Clusters that pass all three keys, strongest first. Vectors from a non-semantic (hash) embedder must not reach here. */
export function detectRepeatSignals(observations: readonly DetectorObservation[], policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY): RepeatSignal[] {
  const recent = [...observations].sort((a, b) => b.at.localeCompare(a.at)).slice(0, policy.maxObservations);
  const groups = clusterByAverageLinkage(recent.map(item => item.vector), policy.clusterDistance);
  const signals: RepeatSignal[] = [];
  for (const group of groups) {
    if (group.length < policy.minMembers) continue;
    const members = group.map(index => recent[index]).sort((a, b) => a.at.localeCompare(b.at));
    const days = new Set(members.map(member => dayOf(member.at))).size;
    const runs = new Set(members.map(member => member.runId ?? member.id)).size;
    if (days < policy.minDays || runs < policy.minRuns) continue;
    const traceSimilarity = meanPairwise(members);
    if (traceSimilarity < policy.minTraceSimilarity) continue;
    const dimensions = members[0].vector.length;
    const centroid = norm(Array.from({ length: dimensions }, (_, d) => members.reduce((sum, member) => sum + (member.vector[d] ?? 0), 0) / members.length));
    const stepCounts = new Map<string, number>();
    for (const member of members) for (const step of new Set(member.trace)) stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1);
    const chats = new Map<string, number>();
    for (const member of members) if (member.chatId) chats.set(member.chatId, (chats.get(member.chatId) ?? 0) + 1);
    const memberIds = members.map(member => member.id);
    signals.push({ key: signalKey(memberIds), memberIds, members, days, runs, traceSimilarity, centroid,
      commonSteps: [...stepCounts.entries()].filter(([, count]) => count >= members.length / 2).sort((a, b) => b[1] - a[1]).map(([step]) => step),
      varyingDetails: varyingInstanceDetails(members.map(member => member.task)),
      dominantChatId: [...chats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null });
  }
  return signals.sort((a, b) => b.days - a.days || b.members.length - a.members.length || b.traceSimilarity - a.traceSimilarity);
}

/** A signal already judged stays judged until its cooldown passes; a created capability stays answered. */
export function signalAlreadyJudged(signal: RepeatSignal, verdicts: readonly DetectorVerdictRef[], now: number,
  policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY): DetectorVerdictRef | null {
  const fresh = (verdict: DetectorVerdictRef) => verdict.decision === "capability" || verdict.decision === "covered"
    || now - Date.parse(verdict.at) < policy.cooldownDays * 86_400_000;
  return verdicts.find(verdict => fresh(verdict) && (cosine(signal.centroid, verdict.centroid) >= policy.sameSignalSimilarity
    || signal.memberIds.every(id => verdict.memberIds.includes(id)))) ?? null;
}

/** Most recent distinct sentences, newest last, bounded for the model. */
export function representativeTasks(signal: RepeatSignal, policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY): Array<{ day: string; task: string }> {
  const seen = new Set<string>();
  const picked: Array<{ day: string; task: string }> = [];
  for (const member of [...signal.members].reverse()) {
    if (seen.has(member.task)) continue;
    seen.add(member.task);
    picked.push({ day: dayOf(member.at), task: member.task.slice(0, 500) });
    if (picked.length >= policy.maxRepresentatives) break;
  }
  return picked.reverse();
}

/** The scout's answer as the host admits it (electron/system-agents/toolchain-scout). */
export interface ScoutJudgmentLike {
  decision: "capability" | "not_common" | "covered";
  rationale: string;
  coveredToolchainId: string | null;
  capabilityName: string | null;
  capabilityRequest: string | null;
}

/** Host admission of the model's judgment: a refusal code the model can correct, or null. Meaning stays the model's. */
export function scoutAdmissionRefusal(decision: ScoutJudgmentLike, varyingDetails: readonly string[], catalogIds: readonly string[]): string | null {
  if (decision.rationale.length > 2000) return "rationale_too_long";
  if (decision.decision === "covered")
    return decision.coveredToolchainId && catalogIds.includes(decision.coveredToolchainId) ? null : "covered_id_not_in_catalog";
  if (decision.decision === "not_common") return null;
  const name = decision.capabilityName?.trim() ?? "", request = decision.capabilityRequest?.trim() ?? "";
  if (!name || !request) return "capability_name_and_request_required";
  if (name.length > 160 || request.length > 6000) return "capability_text_too_long";
  const leaked = leakedInstanceDetails(name, varyingDetails);
  return leaked.length ? `capability_name_contains_instance_details:${leaked.join(",")}` : null;
}

// ── Trial use (electron/toolchains/trial.ts): pure rules ────────────────────────────────────────────────────────────
export const TRIAL_PROMOTE_SUCCESSES = 2;
export const TRIAL_RETIRE_FAILURES = 2;
/** One trial chance per conversation per day, so a draft that does not fit never keeps coming back. */
export const TRIAL_GRANT_WINDOW_MS = 24 * 3_600_000;

export interface TrialOutcome { callId: string; chatId: string | null; parentRunId: string | null; status: ToolchainCallReceipt["status"]; error: string | null; at: string }
export interface TrialLedger {
  schema: "agentlas.toolchain-trial.v1";
  toolchainId: string;
  version: number;
  contentHash: string;
  state: "trial" | "promoted" | "retired";
  grants: Array<{ chatId: string; at: string }>;
  outcomes: TrialOutcome[];
  /** Set once the detector sent this retired version back to the generalizer. */
  repairRequestedAt?: string;
  /** Whole-run token medians at promotion: hand-done runs of the signal vs runs that used the Toolchain. */
  tokens?: { baselineRuns: number; baselineMedianTokens: number | null; toolchainRuns: number; toolchainMedianTokens: number | null };
  updatedAt: string;
}

/** The draft version a trial runs: the latest, never validated, of a draft asset. */
export function trialVersion(asset: ToolchainAsset) {
  if (asset.status !== "draft") return null;
  const release = asset.versions.at(-1);
  return release && release.validation.state === "untested" ? release : null;
}

/** Eligible for this conversation now: a trial draft, its ledger (if any) still trialling this exact content, no grant today. */
export function trialEligible(asset: ToolchainAsset, ledger: TrialLedger | null, chatId: string, now: number): boolean {
  const release = trialVersion(asset);
  if (!release || ledger && (ledger.state !== "trial" || ledger.contentHash !== release.contentHash)) return false;
  return !ledger?.grants.some(grant => grant.chatId === chatId && now - Date.parse(grant.at) < TRIAL_GRANT_WINDOW_MS);
}

/** Successes count once per conversation-day; uncertain (an effect not confirmed) counts as a failure. */
export function trialVerdict(outcomes: readonly TrialOutcome[]): "promote" | "retire" | "continue" {
  const failures = outcomes.filter(outcome => outcome.status === "failed" || outcome.status === "uncertain").length;
  if (failures >= TRIAL_RETIRE_FAILURES) return "retire";
  const successes = new Set(outcomes.filter(outcome => outcome.status === "succeeded").map(outcome => `${outcome.chatId}\0${outcome.at.slice(0, 10)}`));
  return successes.size >= TRIAL_PROMOTE_SUCCESSES && failures === 0 ? "promote" : "continue";
}
