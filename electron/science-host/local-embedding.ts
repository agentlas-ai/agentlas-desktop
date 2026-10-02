import { autoLocalEmbedding } from "../memory/local-embedding";

/** Pure, optional local retrieval provider shared by Main and daemon; never reads memory records. */
export const scienceLocalEmbeddingHost = {
  identity() {
    try {
      const value = autoLocalEmbedding("");
      if (value.degraded || value.dimensions !== 256 || !value.modelSha256) return null;
      return { model: value.model, adapter: value.adapter, dimensions: 256 as const, modelSha256: value.modelSha256 };
    } catch { return null; }
  },
  embed(text: string) {
    try {
      if (typeof text !== "string" || !text || Buffer.byteLength(text, "utf8") > 2400) return null;
      const value = autoLocalEmbedding(text);
      if (value.degraded || value.dimensions !== 256 || !value.modelSha256) return null;
      return { model: value.model, adapter: value.adapter, dimensions: 256 as const, modelSha256: value.modelSha256,
        contentHash: value.contentHash, vector: value.vector, degraded: false as const };
    } catch { return null; }
  },
};
