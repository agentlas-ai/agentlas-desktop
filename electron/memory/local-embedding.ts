import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Keep this adapter byte-for-byte compatible with
 * Hephaestus/ontology/embeddings.py::LocalHashingVectorAdapter.
 * It is deterministic, dependency-free, local-only, and never sends memory to
 * a provider.
 */
export const LOCAL_HASHING_MODEL = "local_hashing";
export const LOCAL_HASHING_DIMENSIONS = 96;
export const LOCAL_HASHING_IDENTITY = `local_hashing:sha256-bow:v1:${LOCAL_HASHING_DIMENSIONS}`;

export interface LocalMemoryEmbedding {
  model: string;
  adapter: string;
  dimensions: number;
  vector: number[];
  modelSha256: string | null;
  contentHash: string;
  degraded: boolean;
  degradedReason: string | null;
}

type ModelDescriptor = {
  modelPath: string;
  modelSha256: string;
  adapter: string;
};

let cachedModelDescriptor: ModelDescriptor | null | undefined;
let modelBackendUnavailableReason: string | null = null;

const LATIN_TOKEN_PATTERN = /[a-z0-9][a-z0-9_-]{1,}/g;
const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]+/g;

export function localEmbeddingTokens(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = lowered.match(LATIN_TOKEN_PATTERN) ?? [];
  for (const run of lowered.match(CJK_RUN_PATTERN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens;
}

export function localHashingEmbedding(text: string): LocalMemoryEmbedding {
  const vector = Array<number>(LOCAL_HASHING_DIMENSIONS).fill(0);
  for (const token of localEmbeddingTokens(text)) {
    const digest = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
    const bucket = Number.parseInt(digest.slice(0, 8), 16) % LOCAL_HASHING_DIMENSIONS;
    const sign = Number.parseInt(digest.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vector[bucket] += sign * (1 + Math.min(token.length, 16) / 16);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return {
    model: LOCAL_HASHING_MODEL,
    adapter: LOCAL_HASHING_IDENTITY,
    dimensions: LOCAL_HASHING_DIMENSIONS,
    vector: norm === 0 ? vector : vector.map((value) => Number((value / norm).toFixed(6))),
    modelSha256: null,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    degraded: true,
    degradedReason: "verified-local-model2vec-unavailable",
  };
}

function modelCandidates(): string[] {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    process.env.AGENTLAS_MODEL2VEC_PATH ?? "",
    process.env.AGENTLAS_LOCAL_EMBEDDING_MODEL_PATH ?? "",
    path.join(os.homedir(), ".agentlas", "models", "potion-base-8M"),
    resources ? path.join(resources, "models", "potion-base-8M") : "",
    resources ? path.join(resources, "Hephaestus", "models", "potion-base-8M") : "",
    process.env.HEPHAESTUS_RUNTIME_ROOT
      ? path.join(process.env.HEPHAESTUS_RUNTIME_ROOT, "models", "potion-base-8M")
      : "",
    path.join(process.cwd(), "Hephaestus", "models", "potion-base-8M"),
  ].filter(Boolean);
}

function digestVerifiedModelDirectory(directory: string): ModelDescriptor | null {
  try {
    const root = fs.realpathSync.native(directory);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !/potion-base-8m/i.test(path.basename(root))) return null;
    const files: string[] = [];
    const visit = (current: string): void => {
      for (const name of fs.readdirSync(current).sort()) {
        const absolute = path.join(current, name);
        const item = fs.lstatSync(absolute);
        if (item.isSymbolicLink()) throw new Error("model asset cannot contain symlinks");
        if (item.isDirectory()) visit(absolute);
        else if (item.isFile() && name !== ".agentlas-model.json") files.push(absolute);
      }
    };
    visit(root);
    const relative = files.map((file) => path.relative(root, file));
    if (!relative.some((file) => /(?:^|\/)config\.json$/i.test(file))) return null;
    if (!relative.some((file) => /(?:model\.(?:safetensors|npy)|embeddings?\.(?:safetensors|npy))$/i.test(file))) return null;
    const digest = createHash("sha256");
    let total = 0;
    for (let index = 0; index < files.length; index += 1) {
      const bytes = fs.readFileSync(files[index]);
      total += bytes.length;
      if (total > 128 * 1024 * 1024) throw new Error("model asset exceeds local verification limit");
      digest.update(relative[index]).update("\0").update(bytes).update("\0");
    }
    const modelSha256 = digest.digest("hex");
    const manifestPath = path.join(root, ".agentlas-model.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (String(manifest.modelId ?? "").toLowerCase() !== "potion-base-8m") return null;
      const expected = String(manifest.sha256 ?? "").toLowerCase();
      if (expected && expected !== modelSha256) return null;
    }
    return {
      modelPath: root,
      modelSha256,
      adapter: `model2vec:potion-base-8M:sha256:${modelSha256}`,
    };
  } catch {
    return null;
  }
}

function verifiedModelDescriptor(): ModelDescriptor | null {
  if (modelBackendUnavailableReason) return null;
  if (cachedModelDescriptor !== undefined) return cachedModelDescriptor;
  for (const candidate of modelCandidates()) {
    const descriptor = digestVerifiedModelDirectory(candidate);
    if (descriptor) return (cachedModelDescriptor = descriptor);
  }
  cachedModelDescriptor = null;
  return null;
}

function coreCandidates(): string[] {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return [
    process.env.HEPHAESTUS_RUNTIME_ROOT ?? "",
    resources ? path.join(resources, "Hephaestus") : "",
    path.join(process.cwd(), "Hephaestus"),
    path.join(__dirname, "..", "..", "..", "Hephaestus"),
  ].filter(Boolean);
}

function pythonCandidates(coreRoot: string): string[] {
  return [
    process.env.AGENTLAS_PYTHON ?? "",
    path.join(coreRoot, "bin", process.platform === "win32" ? "python.exe" : "python3"),
    process.platform === "win32" ? "python" : "/opt/homebrew/bin/python3",
    process.platform === "win32" ? "py" : "/usr/local/bin/python3",
    "python3",
    "python",
  ].filter(Boolean);
}

function model2VecEmbedding(text: string, descriptor: ModelDescriptor): LocalMemoryEmbedding | null {
  const coreRoot = coreCandidates().find((candidate) => {
    try { return fs.statSync(path.join(candidate, "ontology", "embeddings.py")).isFile(); } catch { return false; }
  });
  if (!coreRoot) {
    modelBackendUnavailableReason = "public-core-embedding-runtime-unavailable";
    return null;
  }
  const script = [
    "import json,os,sys",
    "sys.path.insert(0, os.environ['HEPHAESTUS_RUNTIME_ROOT'])",
    "from ontology.embeddings import Model2VecLocalAdapter",
    "adapter=Model2VecLocalAdapter(os.environ['AGENTLAS_MODEL2VEC_PATH'])",
    "vector=adapter.embed(sys.stdin.read())",
    "print(json.dumps({'vector':vector,'dimensions':len(vector)}))",
  ].join(";");
  for (const python of pythonCandidates(coreRoot)) {
    const result = spawnSync(python, ["-c", script], {
      input: text,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        HEPHAESTUS_RUNTIME_ROOT: coreRoot,
        AGENTLAS_MODEL2VEC_PATH: descriptor.modelPath,
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        NO_PROXY: "*",
      },
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (result.status !== 0) continue;
    try {
      const parsed = JSON.parse(result.stdout) as { vector?: unknown; dimensions?: unknown };
      if (!Array.isArray(parsed.vector) || parsed.vector.length === 0 ||
        parsed.vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        Number(parsed.dimensions) !== parsed.vector.length) continue;
      return {
        model: "model2vec:potion-base-8M",
        adapter: descriptor.adapter,
        dimensions: parsed.vector.length,
        vector: parsed.vector,
        modelSha256: descriptor.modelSha256,
        contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
        degraded: false,
        degradedReason: null,
      };
    } catch {
      // Try the next local Python candidate; never fall through to a network runtime.
    }
  }
  modelBackendUnavailableReason = "model2vec-python-runtime-unavailable";
  return null;
}

/** Auto-select verified local Model2Vec, with explicit hash-96 degraded fallback. */
export function autoLocalEmbedding(text: string): LocalMemoryEmbedding {
  const descriptor = verifiedModelDescriptor();
  if (descriptor) {
    const embedded = model2VecEmbedding(text, descriptor);
    if (embedded) return embedded;
  }
  const fallback = localHashingEmbedding(text);
  fallback.degradedReason = modelBackendUnavailableReason ?? fallback.degradedReason;
  return fallback;
}

export function parseLocalEmbedding(
  model: unknown,
  dimensions: unknown,
  vectorJson: unknown,
  metadata: {
    adapter?: unknown;
    modelSha256?: unknown;
    contentHash?: unknown;
    text?: string;
  } = {},
): LocalMemoryEmbedding | null {
  const contentHash = typeof metadata.text === "string"
    ? createHash("sha256").update(metadata.text, "utf8").digest("hex")
    : String(metadata.contentHash ?? "");
  if (metadata.contentHash && String(metadata.contentHash) !== contentHash) return null;
  const descriptor = verifiedModelDescriptor();
  const expectedAdapter = descriptor?.adapter ?? LOCAL_HASHING_IDENTITY;
  const adapter = String(metadata.adapter ?? (
    model === LOCAL_HASHING_MODEL ? LOCAL_HASHING_IDENTITY : ""
  ));
  if (adapter !== expectedAdapter) return null;
  try {
    const vector = JSON.parse(String(vectorJson ?? "[]")) as unknown;
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.length !== Number(dimensions) ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) return null;
    return {
      model: String(model ?? ""),
      adapter,
      dimensions: vector.length,
      vector,
      modelSha256: descriptor?.modelSha256 ?? (metadata.modelSha256 ? String(metadata.modelSha256) : null),
      contentHash,
      degraded: !descriptor,
      degradedReason: descriptor ? null : "verified-local-model2vec-unavailable",
    };
  } catch {
    return null;
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function lexicalOverlap(query: string, document: string): number {
  const queryTokens = new Set(localEmbeddingTokens(query));
  const documentTokens = new Set(localEmbeddingTokens(document));
  if (queryTokens.size === 0 || documentTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (documentTokens.has(token)) overlap += 1;
  return overlap / Math.sqrt(queryTokens.size * documentTokens.size);
}

export interface HybridRankable {
  id: string;
  text: string;
  embedding: readonly number[];
  prior?: number;
}

export interface HybridRanked<T extends HybridRankable> {
  item: T;
  score: number;
  lexicalScore: number;
  vectorScore: number;
}

/** Reciprocal-rank fusion: lexical and local-vector ranks remain independently auditable. */
export function rankHybridLocal<T extends HybridRankable>(
  query: string,
  items: readonly T[],
  rrfK = 60,
): HybridRanked<T>[] {
  const queryVector = autoLocalEmbedding(query).vector;
  const measured = items.map((item) => ({
    item,
    lexicalScore: lexicalOverlap(query, item.text),
    vectorScore: cosineSimilarity(queryVector, item.embedding),
  }));
  const lexical = [...measured].sort((left, right) =>
    right.lexicalScore - left.lexicalScore || left.item.id.localeCompare(right.item.id));
  const vector = [...measured].sort((left, right) =>
    right.vectorScore - left.vectorScore || left.item.id.localeCompare(right.item.id));
  const lexicalRank = new Map(lexical.map((entry, index) => [entry.item.id, index + 1]));
  const vectorRank = new Map(vector.map((entry, index) => [entry.item.id, index + 1]));
  return measured.map((entry) => {
    const lexicalContribution = entry.lexicalScore > 0
      ? 1 / (rrfK + (lexicalRank.get(entry.item.id) ?? items.length + 1))
      : 0;
    const vectorContribution = entry.vectorScore > 0
      ? 1 / (rrfK + (vectorRank.get(entry.item.id) ?? items.length + 1))
      : 0;
    return {
      ...entry,
      score: lexicalContribution + vectorContribution + Math.max(0, itemPrior(entry.item)) * 0.002,
    };
  }).sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id));
}

function itemPrior(item: HybridRankable): number {
  return Number.isFinite(item.prior) ? Number(item.prior) : 0;
}
