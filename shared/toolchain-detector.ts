// Repeated-work detection for Toolchains — the pure host half.
//
// The detector finds work One keeps doing again and hands one well-evidenced signal to a model, which decides whether it
// is a reusable capability (a Toolchain works like a plugin or connector: one stable behavior, typed inputs). This file
// only decides which signals deserve that model call. Recurrence is a COUNT of distinct executions, not a span of days:
// work done twelve times in one day is as repeated as work done once a week. What keeps retries and look-alike sentences
// out is the evidence, not the calendar:
//   · retries of one item are collapsed (near-identical sentence, same conversation, minutes apart) before counting;
//   · sentences must cluster by meaning, and the tool flow after each search must agree (see flowCohesion);
//   · the occurrences must be distinct runs with distinct sentences.
// The thresholds are policy inputs; they do not independently prove that a reusable capability exists.

import { createHash } from "node:crypto";
import type { ToolchainAsset, ToolchainCallReceipt } from "./toolchain-asset";

export const TOOLCHAIN_DETECTOR_POLICY = Object.freeze({
  /** Average-linkage cosine distance; members of one cluster average ≥ 0.6 similarity. */
  clusterDistance: 0.4,
  /** Occurrences after retries are collapsed. */
  minMembers: 5,
  /** Distinct executions (run ids). */
  minRuns: 5,
  /** Distinct sentences: five copies of one sentence are one item repeated, not a behavior with varying inputs. */
  minDistinctTasks: 3,
  /**
   * Tool-flow agreement, see flowCohesion. The floor is absolute; the lift is relative to how alike two UNRELATED observations
   * of this owner look (an owner whose every run is shell-heavy has a high baseline). Measured on 512 production searches:
   * unrelated pairs 0.12, coherent clusters 0.25-0.59, clusters that were only wording 0.09-0.17.
   */
  minFlowCohesion: 0.2,
  minFlowLift: 2.2,
  /** Sentence cosine at or below which two observations count as unrelated, and how many such pairs the baseline needs. */
  unrelatedSimilarity: 0.4,
  minUnrelatedPairs: 20,
  /** A search that repeats an earlier one in the same conversation this closely and this soon is a retry, not a recurrence. */
  retrySimilarity: 0.92,
  retryWindowMinutes: 30,
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
  /** Calendar days the occurrences fall on. Information for the judgment; never a gate. */
  days: number;
  runs: number;
  /** Retries folded away across the whole corpus this signal came from (context for the judgment, not part of this cluster). */
  collapsedRetries: number;
  /** Mean pairwise tool-flow agreement of the members, and how many times the baseline of unrelated pairs it is. */
  flowCohesion: number;
  /** Null when there were too few unrelated pairs to measure a baseline. */
  flowLift: number | null;
  centroid: number[];
  /** Where the signal came from: sentences of empty searches, or tool-use episodes on one surface (shared/tool-use-signals.ts). */
  kind?: "sentences" | "episodes";
  /** Episode signals: the site, app command line or script the repeated work happens on. */
  surface?: string;
  /** Episode signals: the stable steps in readable form, and a few real runs of them (values masked, secrets dropped). */
  coreSteps?: string[];
  exemplars?: Array<{ runId: string; at: string; steps: string[] }>;
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
  /** Set on verdicts of episode signals: the surface and the stable steps that made the question. */
  surface?: string;
  coreTokens?: readonly string[];
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
  const unit = vectors.map(norm);
  return clusterBySimilarity(unit.map(left => unit.map(right => cosine(left, right))), 1 - distance);
}

/** The same clustering on a precomputed symmetric similarity matrix; clusters merge while their average similarity is at least `floor`. */
export function clusterBySimilarity(similarity: readonly (readonly number[])[], floor: number): number[][] {
  const n = similarity.length;
  const sim: number[][] = similarity.map(row => [...row]);
  const clusters: Array<number[] | null> = Array.from({ length: n }, (_, index) => [index]);
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

/** Consecutive repeats of one step (ten shell calls in a row) are one step of the flow. */
function compressSteps(trace: readonly string[]): string[] {
  const out: string[] = [];
  for (const step of trace) if (out[out.length - 1] !== step) out.push(step);
  return out;
}

export type FlowVector = Map<string, number>;

/**
 * Tool flow as an IDF-weighted bag of steps and consecutive step pairs, unit length.
 *
 * Set overlap of tool classes cannot tell two runs apart when nearly every run uses shell and file reads: unrelated pairs
 * scored 0.25 and coherent clusters 0.23-0.70, so the two overlapped. Weighting a step by how rare it is among all
 * observed runs lets the distinctive steps (browser reads, graph runs, goal waits) carry the comparison, and step pairs
 * keep some order (read-then-write is not write-then-read). Weights come from the observations given, so they follow this
 * owner's own tool mix.
 */
export function flowVectors(observations: readonly Pick<DetectorObservation, "trace">[]): FlowVector[] {
  const features = observations.map(observation => {
    const steps = compressSteps(observation.trace);
    const counts = new Map<string, number>();
    for (const step of steps) counts.set(step, (counts.get(step) ?? 0) + 1);
    for (let i = 0; i + 1 < steps.length; i++) { const pair = `${steps[i]}>${steps[i + 1]}`; counts.set(pair, (counts.get(pair) ?? 0) + 1); }
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of features) for (const key of counts.keys()) documentFrequency.set(key, (documentFrequency.get(key) ?? 0) + 1);
  const total = observations.length;
  return features.map(counts => {
    const vector: FlowVector = new Map();
    let length = 0;
    for (const [key, count] of counts) {
      const weight = (1 + Math.log(count)) * Math.log(1 + total / (documentFrequency.get(key) ?? 1));
      vector.set(key, weight); length += weight * weight;
    }
    length = Math.sqrt(length);
    if (length > 0) for (const [key, weight] of vector) vector.set(key, weight / length);
    return vector;
  });
}

export function flowCosine(left: FlowVector, right: FlowVector): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let dot = 0;
  for (const [key, weight] of small) dot += weight * (large.get(key) ?? 0);
  return dot;
}

/**
 * How alike two UNRELATED observations look in tool flow: the mean agreement of pairs whose sentences share little meaning.
 * Null when there are too few such pairs to say (an owner whose searches are all one behavior has no unrelated pairs; the
 * absolute floor then stands alone).
 */
function unrelatedFlowBaseline(vectors: readonly (readonly number[])[], flows: readonly FlowVector[], policy: ToolchainDetectorPolicy): number | null {
  let total = 0, pairs = 0;
  for (let i = 0; i < flows.length; i++) for (let j = i + 1; j < flows.length; j++) {
    if (cosine(vectors[i], vectors[j]) > policy.unrelatedSimilarity) continue;
    total += flowCosine(flows[i], flows[j]); pairs++;
  }
  return pairs >= policy.minUnrelatedPairs ? total / pairs : null;
}

/** Mean flow agreement between all pairs of the given vectors (0 when fewer than two). */
function meanFlowAgreement(vectors: readonly FlowVector[]): number {
  let total = 0, pairs = 0;
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) { total += flowCosine(vectors[i], vectors[j]); pairs++; }
  return pairs ? total / pairs : 0;
}

/**
 * Drops searches that repeat an earlier one in the same conversation closely and soon after (retries of one item). The
 * earlier one stays; the count of dropped ones is returned so the judgment can see them.
 */
export function collapseRetries(observations: readonly DetectorObservation[], policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY):
  { kept: DetectorObservation[]; collapsed: number } {
  const ordered = [...observations].sort((a, b) => a.at.localeCompare(b.at));
  const window = policy.retryWindowMinutes * 60_000;
  const kept: DetectorObservation[] = [];
  let collapsed = 0;
  for (const item of ordered) {
    const duplicate = item.chatId !== null && kept.some(earlier => earlier.chatId === item.chatId
      && Date.parse(item.at) - Date.parse(earlier.at) <= window && cosine(earlier.vector, item.vector) >= policy.retrySimilarity);
    if (duplicate) collapsed++; else kept.push(item);
  }
  return { kept, collapsed };
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

function normalizedTask(task: string): string { return task.toLocaleLowerCase().replace(/\s+/gu, " ").trim(); }

/**
 * Clusters that recur often enough, as distinct executions with distinct sentences, and whose tool flow agrees, strongest
 * first. Vectors from a non-semantic (hash) embedder must not reach here.
 */
export function detectRepeatSignals(observations: readonly DetectorObservation[], policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY): RepeatSignal[] {
  const recent = [...observations].sort((a, b) => b.at.localeCompare(a.at)).slice(0, policy.maxObservations);
  const { kept, collapsed: collapsedTotal } = collapseRetries(recent, policy);
  if (kept.length < policy.minMembers) return [];
  const flows = flowVectors(kept);
  const baseline = unrelatedFlowBaseline(kept.map(item => item.vector), flows, policy);
  const groups = clusterByAverageLinkage(kept.map(item => item.vector), policy.clusterDistance);
  const signals: RepeatSignal[] = [];
  for (const group of groups) {
    if (group.length < policy.minMembers) continue;
    const members = group.map(index => kept[index]).sort((a, b) => a.at.localeCompare(b.at));
    const runs = new Set(members.map(member => member.runId ?? member.id)).size;
    if (runs < policy.minRuns) continue;
    if (new Set(members.map(member => normalizedTask(member.task))).size < policy.minDistinctTasks) continue;
    const flowCohesion = meanFlowAgreement(group.map(index => flows[index]));
    const flowLift = baseline !== null && baseline > 0 ? flowCohesion / baseline : null;
    if (flowCohesion < policy.minFlowCohesion || (flowLift !== null && flowLift < policy.minFlowLift)) continue;
    const days = new Set(members.map(member => dayOf(member.at))).size;
    const dimensions = members[0].vector.length;
    const centroid = norm(Array.from({ length: dimensions }, (_, d) => members.reduce((sum, member) => sum + (member.vector[d] ?? 0), 0) / members.length));
    const stepCounts = new Map<string, number>();
    for (const member of members) for (const step of new Set(member.trace)) stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1);
    const chats = new Map<string, number>();
    for (const member of members) if (member.chatId) chats.set(member.chatId, (chats.get(member.chatId) ?? 0) + 1);
    const memberIds = members.map(member => member.id);
    signals.push({ key: signalKey(memberIds), memberIds, members, days, runs, collapsedRetries: collapsedTotal, flowCohesion, flowLift, centroid,
      commonSteps: [...stepCounts.entries()].filter(([, count]) => count >= members.length / 2).sort((a, b) => b[1] - a[1]).map(([step]) => step),
      varyingDetails: varyingInstanceDetails(members.map(member => member.task)),
      dominantChatId: [...chats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null });
  }
  return signals.sort((a, b) => b.runs - a.runs || b.flowCohesion - a.flowCohesion);
}

/** A signal already judged stays judged until its cooldown passes; a created capability stays answered. */
export function signalAlreadyJudged(signal: RepeatSignal, verdicts: readonly DetectorVerdictRef[], now: number,
  policy: ToolchainDetectorPolicy = TOOLCHAIN_DETECTOR_POLICY): DetectorVerdictRef | null {
  const fresh = (verdict: DetectorVerdictRef) => verdict.decision === "capability" || verdict.decision === "covered"
    || now - Date.parse(verdict.at) < policy.cooldownDays * 86_400_000;
  // An episode signal asks "should this operation on this surface have a tool". The same operation is the same stable steps on the
  // same surface, or the same runs; one site can hold several operations, each its own question.
  if (signal.surface) {
    const core = new Set(signal.commonSteps);
    return verdicts.find(verdict => verdict.surface === signal.surface && fresh(verdict) && (signal.memberIds.every(id => verdict.memberIds.includes(id))
      || (verdict.coreTokens ?? []).filter(token => core.has(token)).length / Math.max(1, new Set([...core, ...(verdict.coreTokens ?? [])]).size) >= 0.5)) ?? null;
  }
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

/**
 * The version a trial runs: the latest, never validated, of a draft asset; or, for a callable asset that was pulled back for
 * failing, a repaired version newer than the stable one.
 */
export function trialVersion(asset: ToolchainAsset, pulledBack = false) {
  if (asset.status !== "draft" && !(pulledBack && asset.status === "callable")) return null;
  const release = asset.versions.at(-1);
  if (pulledBack && release && release.version <= (asset.stableVersion ?? 0)) return null;
  return release && release.validation.state === "untested" ? release : null;
}

/** Eligible for this conversation now: a trial draft, its ledger (if any) still trialling this exact content, no grant today. */
export function trialEligible(asset: ToolchainAsset, ledger: TrialLedger | null, chatId: string, now: number, pulledBack = false): boolean {
  const release = trialVersion(asset, pulledBack);
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
