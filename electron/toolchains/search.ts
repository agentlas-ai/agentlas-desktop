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
import { autoLocalEmbedding, rankHybridLocal } from "../memory/local-embedding";

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
