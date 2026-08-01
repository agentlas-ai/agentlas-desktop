// Renderer-side access to the resident judgment service via the narrow
// kind-allowlisted preload bridge. These are prefill/routing decisions: an
// explicit user choice always wins upstream (closed-form), and only a valid
// model verdict may decide semantic meaning. Unavailability stays unresolved;
// callers may not replace it with keywords, regexes, dictionaries, or defaults.

import { ipc } from "./ipc";

export interface RendererJudged<V extends string> {
  verdict: V;
  source: "llm";
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
    throw new Error("semantic_judgment_unavailable");
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
    throw new Error("semantic_judgment_unresolved");
  } catch {
    throw new Error("semantic_judgment_unresolved");
  }
}

export interface RendererSubsetJudged<V extends string> {
  selected: V[];
  source: "llm";
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
    throw new Error("semantic_judgment_unavailable");
  }
  try {
    const result = await api.judgment.judgeSubset({
      kind: spec.kind,
      labels: [...spec.labels],
      input: spec.input,
      hints: spec.hints?.map((hint) => ({ label: hint.label, words: hint.words })),
      timeoutMs: spec.timeoutMs,
    });
    if (result.source !== "llm") throw new Error("semantic_judgment_unresolved");
    const allowed = new Set<string>(spec.labels as readonly string[]);
    return {
      selected: result.selected.filter((label): label is V => allowed.has(label)),
      source: "llm",
      reason: result.reason,
    };
  } catch {
    throw new Error("semantic_judgment_unresolved");
  }
}
