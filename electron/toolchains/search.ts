// Toolchain search — the product's one hybrid ranker, applied to callable contracts.
//
// The first version matched words only. The first real cold-start test caught it:
// a model paraphrased "Hacker News 한글 요약 저장" five ways and the search found the
// contract 0 times out of 5. Paraphrase is the normal case, so ranking uses the same
// multilingual model2vec + lexical ranker as memory recall (thresholds calibrated
// there for Korean), and acceptance is the pure rule in shared/toolchain.ts.

import { createHash } from "node:crypto";

import { acceptToolchainHits } from "../../shared/toolchain";
import { autoLocalEmbedding, LOCAL_HASHING_DIMENSIONS, rankHybridLocal } from "../memory/local-embedding";
import type { ToolchainAsset, ToolchainAssetVersion } from "../../shared/toolchain-asset";
import { isToolchainPulledBack } from "./trial-ledger";

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
  const hits = acceptToolchainHits(ranked.map(entry => ({ id: entry.item.id, score: entry.score,
    // Hash bucket collisions carry no semantic evidence for choosing a callable.
    // Keep the shared lexical floor and the verified model's semantic path.
    lexicalScore: entry.lexicalScore, semanticEligible: entry.semanticEligible
      && entry.item.embedding.length !== LOCAL_HASHING_DIMENSIONS })), limit);
  return hits.flatMap(hit => { const candidate = candidates.find(c => c.id === hit.id); return candidate ? [candidate] : []; });
}

/**
 * The releases a caller may use now: the stable version of a callable asset whose validation passed. A Toolchain pulled back for
 * failing in real use stays out until its repaired version is the stable one. Search and the per-Toolchain MCP tools share this.
 */
export function callableToolchainReleases(assets: readonly ToolchainAsset[]): Array<{ asset: ToolchainAsset; release: ToolchainAssetVersion }> {
  return assets.flatMap(asset => {
    const release = asset.versions.find(item => item.version === asset.stableVersion);
    return asset.status === "callable" && release?.validation.state === "passed" && !isToolchainPulledBack(asset) ? [{ asset, release }] : [];
  });
}

/** Normal eligibility is unchanged; the explicit draft ranker confers no callability. */
export function searchToolchainAssets(task: string, assets: ToolchainAsset[], limit = 5): ToolchainAsset[] {
  const candidates = callableToolchainReleases(assets).map(({ asset, release }) => ({ id: asset.id, release }));
  return rankToolchainAssetCandidates(task, candidates, limit).flatMap(hit => {
    const asset = assets.find(item => item.id === hit.id); return asset ? [asset] : [];
  });
}
