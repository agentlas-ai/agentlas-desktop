// Renderer-side access to the resident judgment service via the narrow
// kind-allowlisted preload bridge. These are prefill/routing decisions: an
// explicit user choice always wins upstream (closed-form), the judged verdict
// decides when a model answers, and the keyword tables remain only the labeled
// deterministic fallback when the bridge or model is unavailable. Callers must
// never block a render pass on these — judge before the flow starts, or judge
// async and update.

import { ipc } from "./ipc";

export interface RendererJudged<V extends string> {
  verdict: V;
  source: "llm" | "fallback";
  reason: string;
}

export async function judgeLabelViaBridge<V extends string>(spec: {
  kind: string;
  labels: readonly V[];
  input: string;
  fallback: V;
  hints?: Array<{ label: V; words: string[] }>;
  timeoutMs?: number;
}): Promise<RendererJudged<V>> {
  const api = ipc();
  if (!api?.judgment?.judge) {
    return { verdict: spec.fallback, source: "fallback", reason: "judgment bridge unavailable" };
  }
  try {
    const result = await api.judgment.judge({
      kind: spec.kind,
      labels: [...spec.labels],
      input: spec.input,
      fallback: spec.fallback,
      hints: spec.hints?.map((hint) => ({ label: hint.label, words: hint.words })),
      timeoutMs: spec.timeoutMs,
    });
    if (result.source === "llm" && (spec.labels as readonly string[]).includes(result.verdict)) {
      return { verdict: result.verdict as V, source: "llm", reason: result.reason };
    }
    return { verdict: spec.fallback, source: "fallback", reason: result.reason };
  } catch {
    return { verdict: spec.fallback, source: "fallback", reason: "judgment bridge call failed" };
  }
}

export interface RendererSubsetJudged<V extends string> {
  selected: V[];
  source: "llm" | "fallback";
  reason: string;
}

export async function judgeSubsetViaBridge<V extends string>(spec: {
  kind: string;
  labels: readonly V[];
  input: string;
  hints?: Array<{ label: V; words: string[] }>;
  timeoutMs?: number;
}): Promise<RendererSubsetJudged<V>> {
  const api = ipc();
  if (!api?.judgment?.judgeSubset) {
    return { selected: [], source: "fallback", reason: "judgment bridge unavailable" };
  }
  try {
    const result = await api.judgment.judgeSubset({
      kind: spec.kind,
      labels: [...spec.labels],
      input: spec.input,
      hints: spec.hints?.map((hint) => ({ label: hint.label, words: hint.words })),
      timeoutMs: spec.timeoutMs,
    });
    if (result.source !== "llm") return { selected: [], source: "fallback", reason: result.reason };
    const allowed = new Set<string>(spec.labels as readonly string[]);
    return {
      selected: result.selected.filter((label): label is V => allowed.has(label)),
      source: "llm",
      reason: result.reason,
    };
  } catch {
    return { selected: [], source: "fallback", reason: "judgment bridge call failed" };
  }
}
