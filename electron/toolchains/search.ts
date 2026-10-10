// Toolchain search — the product's one hybrid ranker, applied to callable contracts.
//
// The first version matched words only. The first real cold-start test caught it:
// a model paraphrased "Hacker News 한글 요약 저장" five ways and the search found the
// contract 0 times out of 5. Paraphrase is the normal case, so ranking uses the same
// multilingual model2vec + lexical ranker as memory recall (thresholds calibrated
// there for Korean), and acceptance is the pure rule in shared/toolchain.ts.

import { createHash } from "node:crypto";

import {
  acceptToolchainHits,
  contractSearchText,
  type ToolchainInterface,
  type ToolchainSearchHit,
} from "../../shared/toolchain";
import { autoLocalEmbedding, LOCAL_HASHING_DIMENSIONS, rankHybridLocal } from "../memory/local-embedding";
import type { ToolchainAsset, ToolchainAssetVersion } from "../../shared/toolchain-asset";

const MAX_CACHED = 256;
const embeddings = new Map<string, readonly number[]>();

function embeddingOf(text: string): readonly number[] {
  const key = createHash("sha256").update(text, "utf8").digest("hex");
  const cached = embeddings.get(key);
  if (cached) return cached;
  const vector = autoLocalEmbedding(text).vector;
  if (embeddings.size >= MAX_CACHED) embeddings.delete(embeddings.keys().next().value as string);
  embeddings.set(key, vector);
  return vector;
}

/** Contracts must already be filtered to the ones the caller may see (callable, current, enabled). */
export function searchToolchains(task: string, contracts: ToolchainInterface[], limit?: number): ToolchainSearchHit[] {
  const query = String(task || "").trim();
  if (!query || contracts.length === 0) return [];
  const purpose = rankHybridLocal(query, contracts.map((contract) => {
    const text = contractSearchText(contract);
    return { id: contract.automationId, text, embedding: embeddingOf(text) };
  }));
  return acceptToolchainHits(purpose.map((entry) => ({
    automationId: entry.item.id,
    score: entry.score,
    lexicalScore: entry.lexicalScore,
    semanticEligible: entry.semanticEligible,
  })), limit);
}

/** Ranker only: callers must supply native-permitted exact immutable candidates.
 * Accepting a draft here never changes validation, publication or grants. */
export function rankToolchainAssetCandidates(task: string, candidates: Array<{ id: string; release: ToolchainAssetVersion }>, limit = 5): Array<{ id: string; release: ToolchainAssetVersion }> {
  const query = task.trim();
  if (!query || !candidates.length) return [];
  const ranked = rankHybridLocal(query, candidates.map(candidate => {
    const c = candidate.release.contract;
    const text = [c.name, c.description, ...c.whenToUse,
      Object.keys((c.inputSchema.properties ?? {}) as Record<string, unknown>).join(" ")].join("\n");
    return { id: candidate.id, text, embedding: embeddingOf(text) };
  }));
  const hits = acceptToolchainHits(ranked.map(entry => ({ automationId: entry.item.id, score: entry.score,
    // Hash bucket collisions carry no semantic evidence for choosing a callable.
    // Keep the shared lexical floor and the verified model's semantic path.
    lexicalScore: entry.lexicalScore, semanticEligible: entry.semanticEligible
      && entry.item.embedding.length !== LOCAL_HASHING_DIMENSIONS })), limit);
  return hits.flatMap(hit => { const candidate = candidates.find(c => c.id === hit.automationId); return candidate ? [candidate] : []; });
}

/** Normal eligibility is unchanged; the explicit draft ranker confers no callability. */
export function searchToolchainAssets(task: string, assets: ToolchainAsset[], limit = 5): ToolchainAsset[] {
  const candidates = assets.flatMap(asset => {
    const version = asset.versions.find(item => item.version === asset.stableVersion);
    if (asset.status !== "callable" || version?.validation.state !== "passed") return [];
    return [{ id: asset.id, release: version }];
  });
  return rankToolchainAssetCandidates(task, candidates, limit).flatMap(hit => {
    const asset = assets.find(item => item.id === hit.id); return asset ? [asset] : [];
  });
}
