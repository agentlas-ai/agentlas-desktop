// Repeated-work signals from tool-use episodes (shared/tool-use-episodes.ts): an operation the agent keeps doing by hand on
// one surface, with a structure that holds from run to run. The sentence detector (toolchain-detector.ts) finds repeated
// REQUESTS; this finds repeated OPERATION, which is what a Toolchain (a deterministic, MCP-shaped tool) replaces.
//
// Recurrence is a count of distinct runs. What separates a tool from a habit is the evidence:
//   · a failed episode shows the way not to do it and neither counts nor defines the structure, so a retry after a failure is
//     never counted twice. Identical successful runs in one conversation minutes apart are NOT retries: a reply flow done for
//     five posts in a row is five uses;
//   · one surface holds several operations (a site is read, scraped and posted to). Runs on a surface are clustered by how
//     their steps agree — IDF-weighted steps and step pairs, as in the sentence detector — and each cluster is judged alone;
//   · the stable structure of a cluster — steps most of its runs share — must contain an action whose selector, script, key or
//     flag set is identical across runs. A script the model rewrites a little each run still matches by the strings it touches
//     (shared/tool-use-episodes.ts codeTemplate); a click on a snapshot ref names nothing to reproduce;
//   · a script file or an inline script is already a tool of sorts, so those need more runs than a site or an app.

import { createHash } from "node:crypto";
import { TOOLCHAIN_DETECTOR_POLICY, clusterBySimilarity, flowCosine, flowVectors, type RepeatSignal } from "./toolchain-detector";
import { surfaceKind, type ToolUseEpisode } from "./tool-use-episodes";

export const TOOL_USE_SIGNAL_POLICY = Object.freeze({
  /** Distinct runs in one cluster. A script the model wrote is already a tool, so it must prove more. */
  minRuns: Object.freeze({ site: TOOLCHAIN_DETECTOR_POLICY.minRuns, app: TOOLCHAIN_DETECTOR_POLICY.minRuns, script: 10, inline: 8, other: 8 }),
  /** Runs on one surface whose steps agree at least this much (average linkage) form one operation. */
  clusterSimilarity: 0.2,
  /** A step is stable when this share of the cluster's runs has it. */
  coreShare: 0.5,
  /** Newest episodes compared per surface; the store bounds the total. */
  maxPerSurface: 200,
  exemplars: 3,
  exemplarSteps: 12,
});
export type ToolUseSignalPolicy = typeof TOOL_USE_SIGNAL_POLICY;

/** An episode as stored: the tokens the flow comparison uses and the readable steps the judgment shows. */
export interface StoredToolUseEpisode extends Pick<ToolUseEpisode, "runId" | "chatId" | "surface" | "tokens" | "actionSteps" | "failed"> {
  id: string;
  at: string;
  steps: Array<{ op: string; template: string | null; detail: string; count: number }>;
}

const ACTION_OPS = new Set(["click", "type", "fill", "press", "select", "upload", "drag", "code", "replay", "run", "inline"]);
const opOf = (token: string, surface: string) => token.slice(surface.length + 1).split("#")[0];
const dayOf = (at: string) => at.slice(0, 10);

/** Operations on surfaces that recur with a stable structure, most hand-work first. */
export function detectToolUseSignals(episodes: readonly StoredToolUseEpisode[], policy: ToolUseSignalPolicy = TOOL_USE_SIGNAL_POLICY): RepeatSignal[] {
  const recent = [...episodes].sort((a, b) => b.at.localeCompare(a.at));
  const bySurface = new Map<string, StoredToolUseEpisode[]>();
  for (const episode of recent) if (!episode.failed) bySurface.set(episode.surface, [...(bySurface.get(episode.surface) ?? []), episode]);
  const signals: RepeatSignal[] = [];
  for (const [surface, all] of bySurface) {
    const need = policy.minRuns[surfaceKind(surface)];
    if (new Set(all.map(episode => episode.runId)).size < need) continue;
    const pool = all.slice(0, policy.maxPerSurface);
    const flows = flowVectors(pool.map(episode => ({ trace: episode.tokens })));
    const similarity = pool.map((_, i) => pool.map((__, j) => i === j ? 1 : flowCosine(flows[i], flows[j])));
    for (const cluster of clusterBySimilarity(similarity, policy.clusterSimilarity)) {
      const group = cluster.map(index => pool[index]).sort((a, b) => a.at.localeCompare(b.at));
      const runs = new Set(group.map(episode => episode.runId)).size;
      if (runs < need) continue;
      const counts = new Map<string, number>();
      for (const episode of group) for (const token of new Set(episode.tokens)) counts.set(token, (counts.get(token) ?? 0) + 1);
      const core = [...counts.entries()].filter(([, count]) => count >= group.length * policy.coreShare).sort((a, b) => b[1] - a[1]).map(([token]) => token);
      const actionCore = core.filter(token => ACTION_OPS.has(opOf(token, surface)));
      // An action whose selector, script, key or flag set is the same in most runs: a ref-only click names nothing to reproduce.
      if (!actionCore.some(token => token.includes("#"))) continue;
      let total = 0, pairs = 0;
      for (let a = 0; a < cluster.length; a++) for (let b = a + 1; b < cluster.length; b++) { total += similarity[cluster[a]][cluster[b]]; pairs++; }
      const detailOf = new Map<string, string>();
      for (const episode of group) for (const step of episode.steps) {
        const token = `${surface}|${step.op}${step.template ? `#${step.template}` : ""}`;
        if (!detailOf.has(token)) detailOf.set(token, step.detail);
      }
      const chats = new Map<string, number>();
      for (const episode of group) if (episode.chatId) chats.set(episode.chatId, (chats.get(episode.chatId) ?? 0) + 1);
      const memberIds = group.map(episode => episode.id);
      signals.push({
        key: createHash("sha256").update(`episodes\n${surface}\n${core.slice(0, 6).sort().join("\n")}`, "utf8").digest("hex").slice(0, 24), memberIds,
        members: group.map(episode => ({ id: episode.id, task: surface, chatId: episode.chatId, at: episode.at, runId: episode.runId, trace: episode.tokens, vector: [] as number[] })),
        days: new Set(group.map(episode => dayOf(episode.at))).size, runs, collapsedRetries: 0, flowCohesion: pairs ? total / pairs : 1, flowLift: null, centroid: [],
        kind: "episodes", surface, commonSteps: core, coreSteps: core.map(token => detailOf.get(token) ?? token.slice(surface.length + 1)),
        exemplars: [...group].reverse().slice(0, policy.exemplars).reverse().map(episode => ({ runId: episode.runId, at: episode.at,
          steps: episode.steps.slice(0, policy.exemplarSteps).map(step => step.count > 1 ? `${step.detail} (x${step.count})` : step.detail) })),
        varyingDetails: [], dominantChatId: [...chats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null });
    }
  }
  // The most hand-work first: runs times the steps each run took.
  const effort = (signal: RepeatSignal) => signal.runs * Math.max(1, signal.members.reduce((sum, member) => sum + member.trace.length, 0) / signal.members.length);
  return signals.sort((a, b) => effort(b) - effort(a));
}
