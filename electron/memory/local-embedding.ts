import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export const MODEL2VEC_HYBRID_DIMENSIONS = 352;
export const MODEL2VEC_HYBRID_NAME = "model2vec_potion_base_8m_int8_hybrid";
export const MODEL2VEC_ASSET_FORMAT = "agentlas-model2vec-int8-v1";
export const PINNED_MODEL2VEC_CONTENT_SHA256 = "fe492f69607b750142aa48d47d579b53252b3288547c27d4d0e473d6af485e1e";
export const PINNED_MODEL2VEC_MODEL_ID = "minishlab/potion-base-8M";
export const PINNED_MODEL2VEC_REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23";
const PINNED_MODEL2VEC_SOURCE_FILES: Record<string, AssetFileRecord> = {
  "config.json": { sha256: "2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553", size: 202 },
  "tokenizer.json": { sha256: "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50", size: 683666 },
  "model.safetensors": { sha256: "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2", size: 30236760 },
  "README.md": { sha256: "de8ec91bf63c5f4c0e20751c227b2d049953e1cab5f8d5d44211c59a44795bdd", size: 5203 },
};
const MODEL_DISCOVERY_MISS_TTL_MS = 5_000;
const HASH_MIN_VECTOR_SCORE = 0.08;
const MODEL2VEC_MIN_VECTOR_SCORE = 0.45;
const MODEL2VEC_CJK_MIN_VECTOR_SCORE = 0.5;
const VECTOR_RELATIVE_FLOOR = 0.72;
const CJK_QUERY_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]+/;
const HANGUL_PATTERN = /[가-힣]/;

type ModelDescriptor = {
  modelPath: string;
  modelSha256: string;
  adapter: string;
  // True when the vocabulary has whole Hangul syllables. potion-base-8M is
  // distilled from an English BERT and has none — only Hangul Jamo — so its
  // WordPiece shatters Korean into individual letters. Measured on this model:
  // "배포 실패" tokenizes to ᄇ ᅢ ᄑ ᅩ ᄉ ᅵ ᆯ ᄑ ᅢ. Comparing those vectors measures
  // letter frequency, not meaning, which is why unrelated Korean sentences
  // scored HIGHER (0.86) than related ones (0.68). The semantic axis has to be
  // withheld for Korean until the asset can actually read it.
  supportsHangul: boolean;
  dimensions: number;
  vocabSize: number;
  vocab: Map<string, number>;
  unknownTokenId: number;
  embeddings: Buffer;
  scales: Buffer;
};

let cachedModelDescriptor: ModelDescriptor | null | undefined;
let cachedModelDescriptorAt = 0;

const LATIN_TOKEN_PATTERN = /[a-z0-9][a-z0-9_-]{1,}/g;
const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]+/g;
// A version is one identifier, but the general Latin pattern cannot see it: the
// dot ends a token and a token must be two characters, so "0.9.0" produced no
// tokens whatsoever — a prompt naming only a version fell back to dumping the
// most recent entries instead of searching — and "v0.8.46" fractured into "v0"
// and "46". The leading "v" is dropped so a memory written as "v0.8.46" is
// still found by a prompt that says "0.8.46".
const VERSION_TOKEN_PATTERN = /v?\d+(?:\.\d+)+(?:-[a-z0-9.]+)?/g;

export function localEmbeddingTokens(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  const withoutVersions = lowered.replace(VERSION_TOKEN_PATTERN, (version) => {
    tokens.push(version.replace(/^v/, ""));
    return " ";
  });
  tokens.push(...(withoutVersions.match(LATIN_TOKEN_PATTERN) ?? []));
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
  const assetSuffix = path.join("model2vec", "potion-base-8M-int8");
  return [
    process.env.AGENTLAS_MODEL2VEC_PATH ?? "",
    process.env.AGENTLAS_LOCAL_EMBEDDING_MODEL_PATH ?? "",
    process.env.AGENTLAS_RUNTIME_HOME
      ? path.join(process.env.AGENTLAS_RUNTIME_HOME, "models", assetSuffix)
      : "",
    resources ? path.join(resources, "models", assetSuffix) : "",
    resources ? path.join(resources, "Hephaestus", "models", assetSuffix) : "",
    resources ? path.join(resources, "Hephaestus", "assets", assetSuffix) : "",
    process.env.HEPHAESTUS_RUNTIME_ROOT
      ? path.join(process.env.HEPHAESTUS_RUNTIME_ROOT, "models", assetSuffix)
      : "",
    process.env.HEPHAESTUS_RUNTIME_ROOT
      ? path.join(process.env.HEPHAESTUS_RUNTIME_ROOT, "assets", assetSuffix)
      : "",
    path.join(process.cwd(), "Hephaestus", "models", assetSuffix),
    path.join(process.cwd(), "Hephaestus", "assets", assetSuffix),
    path.join(__dirname, "..", "..", "..", "Hephaestus", "assets", assetSuffix),
    path.join(os.homedir(), ".agentlas", "runtime", "current", "models", assetSuffix),
  ].filter(Boolean);
}

type AssetFileRecord = { sha256: string; size: number };

function exactFileRecords(value: unknown, expected: Record<string, AssetFileRecord>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const expectedNames = Object.keys(expected).sort();
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(expectedNames)) return false;
  return expectedNames.every((name) => {
    const record = actual[name] as Partial<AssetFileRecord> | null;
    return record?.sha256 === expected[name].sha256 && record?.size === expected[name].size;
  });
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifiedFile(root: string, name: string, record: AssetFileRecord): string {
  const candidate = path.join(root, name);
  const candidateStat = fs.lstatSync(candidate);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error(`invalid model asset file: ${name}`);
  }
  const target = fs.realpathSync.native(candidate);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("model asset file escaped root");
  if (candidateStat.size !== record.size) {
    throw new Error(`invalid model asset file: ${name}`);
  }
  if (!/^[0-9a-f]{64}$/.test(record.sha256) || sha256File(target) !== record.sha256) {
    throw new Error(`model asset checksum mismatch: ${name}`);
  }
  return target;
}

function contentIdentity(files: Record<string, AssetFileRecord>, names: string[]): string {
  const digest = createHash("sha256");
  for (const name of [...names].sort()) {
    digest.update(name).update("\0").update(files[name].sha256).update("\0")
      .update(String(files[name].size)).update("\n");
  }
  return digest.digest("hex");
}

function verifyModelDirectory(directory: string): ModelDescriptor | null {
  try {
    const inputStat = fs.lstatSync(directory);
    if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) return null;
    const root = fs.realpathSync.native(directory);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as any;
    if (manifest.format !== MODEL2VEC_ASSET_FORMAT || manifest.license?.spdx !== "MIT") return null;
    if (manifest.runtime?.networkRequired !== false ||
      !Array.isArray(manifest.runtime?.externalPackages) ||
      manifest.runtime.externalPackages.length !== 0) return null;
    if (manifest.quantization?.scheme !== "symmetric_per_row_int8" ||
      manifest.quantization?.scaleDtype !== "float32le") return null;
    const dimensions = Number(manifest.dimensions);
    const vocabSize = Number(manifest.vocabSize);
    if (!Number.isInteger(dimensions) || dimensions !== 256 || !Number.isInteger(vocabSize) || vocabSize <= 0) return null;
    const required = ["embeddings.i8", "scales.f32le", "tokenizer.json", "LICENSE.model.txt"];
    const files = manifest.files as Record<string, AssetFileRecord>;
    if (!files || required.some((name) => !files[name])) return null;
    const resolved = Object.fromEntries(required.map((name) => [name, verifiedFile(root, name, files[name])]));
    if (files["embeddings.i8"].size !== vocabSize * dimensions ||
      files["scales.f32le"].size !== vocabSize * 4) return null;
    const modelSha256 = contentIdentity(files, required);
    if (manifest.contentSha256 !== modelSha256 || modelSha256 !== PINNED_MODEL2VEC_CONTENT_SHA256) return null;
    const tokenizer = JSON.parse(fs.readFileSync(resolved["tokenizer.json"], "utf8")) as any;
    const vocabObject = tokenizer?.model?.vocab as Record<string, unknown> | undefined;
    if (tokenizer?.model?.type !== "WordPiece" || !vocabObject || Object.keys(vocabObject).length !== vocabSize) return null;
    const vocab = new Map<string, number>();
    const ids: number[] = [];
    for (const [token, rawId] of Object.entries(vocabObject)) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id < 0 || id >= vocabSize) return null;
      vocab.set(token, id);
      ids.push(id);
    }
    ids.sort((left, right) => left - right);
    if (ids.some((id, index) => id !== index)) return null;
    const unknownTokenId = vocab.get("[UNK]");
    if (unknownTokenId === undefined) return null;
    const source = manifest.source as { modelId?: unknown; revision?: unknown; files?: unknown };
    if (source?.modelId !== PINNED_MODEL2VEC_MODEL_ID || source?.revision !== PINNED_MODEL2VEC_REVISION) return null;
    if (!exactFileRecords(source.files, PINNED_MODEL2VEC_SOURCE_FILES)) return null;
    const assetIdentity = `model2vec:${PINNED_MODEL2VEC_MODEL_ID}:${PINNED_MODEL2VEC_REVISION}:${modelSha256}:${manifest.format}`;
    let supportsHangul = false;
    for (const token of vocab.keys()) {
      if (HANGUL_PATTERN.test(token)) {
        supportsHangul = true;
        break;
      }
    }
    return {
      modelPath: root,
      modelSha256,
      adapter: `${assetIdentity}:hybrid-hash96-v1:${MODEL2VEC_HYBRID_DIMENSIONS}`,
      supportsHangul,
      dimensions,
      vocabSize,
      vocab,
      unknownTokenId,
      embeddings: fs.readFileSync(resolved["embeddings.i8"]),
      scales: fs.readFileSync(resolved["scales.f32le"]),
    };
  } catch {
    return null;
  }
}

export function verifyLocalModel2VecAsset(directory: string): {
  adapter: string;
  dimensions: number;
  modelSha256: string;
} | null {
  const descriptor = verifyModelDirectory(directory);
  return descriptor ? {
    adapter: descriptor.adapter,
    dimensions: MODEL2VEC_HYBRID_DIMENSIONS,
    modelSha256: descriptor.modelSha256,
  } : null;
}

/** Runtime installers may place the asset after Desktop has already started. */
export function invalidateLocalEmbeddingModelCache(): void {
  cachedModelDescriptor = undefined;
  cachedModelDescriptorAt = 0;
}

function verifiedModelDescriptor(): ModelDescriptor | null {
  if (cachedModelDescriptor !== undefined && (
    cachedModelDescriptor !== null || Date.now() - cachedModelDescriptorAt < MODEL_DISCOVERY_MISS_TTL_MS
  )) return cachedModelDescriptor;
  for (const candidate of modelCandidates()) {
    const descriptor = verifyModelDirectory(candidate);
    if (descriptor) {
      cachedModelDescriptorAt = Date.now();
      return (cachedModelDescriptor = descriptor);
    }
  }
  cachedModelDescriptorAt = Date.now();
  cachedModelDescriptor = null;
  return null;
}

function isWhitespace(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return character === " " || character === "\t" || character === "\n" || character === "\r" ||
    codePoint === 0x85 || codePoint === 0xa0 || /\p{Zs}/u.test(character);
}

function isControl(character: string): boolean {
  if (character === "\t" || character === "\n" || character === "\r") return false;
  return /[\p{Cc}\p{Cf}]/u.test(character);
}

function isChineseCharacter(codePoint: number): boolean {
  return (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f);
}

function isPunctuation(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (codePoint >= 33 && codePoint <= 47) ||
    (codePoint >= 58 && codePoint <= 64) ||
    (codePoint >= 91 && codePoint <= 96) ||
    (codePoint >= 123 && codePoint <= 126) || /\p{P}/u.test(character);
}

function bertPretokens(text: string): string[] {
  const cleaned: string[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || codePoint === 0xfffd || isControl(character)) continue;
    if (isWhitespace(character)) cleaned.push(" ");
    else if (isChineseCharacter(codePoint)) cleaned.push(" ", character, " ");
    else cleaned.push(character);
  }
  const normalized = cleaned.join("").toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
  const tokens: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const character of normalized) {
    if (isWhitespace(character)) flush();
    else if (isPunctuation(character)) {
      flush();
      tokens.push(character);
    } else current += character;
  }
  flush();
  return tokens;
}

export function model2VecTokenIds(text: string, descriptor = verifiedModelDescriptor()): number[] {
  if (!descriptor) return [];
  const ids: number[] = [];
  for (const token of bertPretokens(text)) {
    const characters = Array.from(token);
    if (characters.length > 100) continue;
    let start = 0;
    const pieces: number[] = [];
    let failed = false;
    while (start < characters.length) {
      let end = characters.length;
      let found: number | undefined;
      while (start < end) {
        const piece = `${start > 0 ? "##" : ""}${characters.slice(start, end).join("")}`;
        found = descriptor.vocab.get(piece);
        if (found !== undefined) break;
        end -= 1;
      }
      if (found === undefined) {
        failed = true;
        break;
      }
      pieces.push(found);
      start = end;
    }
    if (!failed) {
      for (const id of pieces) {
        if (id !== descriptor.unknownTokenId) ids.push(id);
        if (ids.length >= 512) return ids;
      }
    }
  }
  return ids;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function model2VecHybridEmbedding(text: string, descriptor: ModelDescriptor): LocalMemoryEmbedding {
  const semantic = Array<number>(descriptor.dimensions).fill(0);
  for (const tokenId of model2VecTokenIds(text, descriptor)) {
    const scale = descriptor.scales.readFloatLE(tokenId * 4);
    const offset = tokenId * descriptor.dimensions;
    for (let dimension = 0; dimension < descriptor.dimensions; dimension += 1) {
      semantic[dimension] += descriptor.embeddings.readInt8(offset + dimension) * scale;
    }
  }
  const semanticNormalized = normalizeVector(semantic);
  const hashing = localHashingEmbedding(text).vector;
  const factor = 1 / Math.sqrt(2);
  const hybrid = normalizeVector([
    ...semanticNormalized.map((value) => value * factor),
    ...hashing.map((value) => value * factor),
  ]).map((value) => Number(value.toFixed(6)));
  return {
    model: MODEL2VEC_HYBRID_NAME,
    adapter: descriptor.adapter,
    dimensions: MODEL2VEC_HYBRID_DIMENSIONS,
    vector: hybrid,
    modelSha256: descriptor.modelSha256,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    degraded: false,
    degradedReason: null,
  };
}

/** Auto-select verified local Model2Vec, with explicit hash-96 degraded fallback. */
export function autoLocalEmbedding(text: string): LocalMemoryEmbedding {
  const descriptor = verifiedModelDescriptor();
  return descriptor ? model2VecHybridEmbedding(text, descriptor) : localHashingEmbedding(text);
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
  const expectedModel = descriptor ? MODEL2VEC_HYBRID_NAME : LOCAL_HASHING_MODEL;
  const expectedDimensions = descriptor ? MODEL2VEC_HYBRID_DIMENSIONS : LOCAL_HASHING_DIMENSIONS;
  const storedModel = String(model ?? "");
  const adapter = String(metadata.adapter ?? (
    model === LOCAL_HASHING_MODEL ? LOCAL_HASHING_IDENTITY : ""
  ));
  if (adapter !== expectedAdapter || Number(dimensions) !== expectedDimensions) return null;
  // Core's cache projection stores adapter identity only; Desktop-owned rows
  // additionally carry the model and checksum and must match both when present.
  if (storedModel && storedModel !== expectedModel) return null;
  if (storedModel && descriptor && metadata.modelSha256 !== descriptor.modelSha256) return null;
  if (storedModel && !descriptor && metadata.modelSha256) return null;
  if (typeof metadata.text === "string" && metadata.contentHash !== contentHash) return null;
  try {
    const vector = JSON.parse(String(vectorJson ?? "[]")) as unknown;
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.length !== Number(dimensions) ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) return null;
    return {
      model: storedModel || expectedModel,
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
  semanticEligible: boolean;
}

let reportedHangulGap = false;

/**
 * True when the text is Korean but the loaded model has no Hangul lexical
 * units, so its vector carries no meaning for that text.
 */
function hangulBeyondModel(text: string): boolean {
  if (!HANGUL_PATTERN.test(text)) return false;
  const descriptor = verifiedModelDescriptor();
  if (!descriptor || descriptor.supportsHangul) return false;
  if (!reportedHangulGap) {
    reportedHangulGap = true;
    console.warn(
      "[memory] the local embedding model has no Hangul vocabulary — Korean text is ranked lexically only. " +
        "Semantic recall for Korean needs a multilingual asset.",
    );
  }
  return true;
}

/** Reciprocal-rank fusion: lexical and local-vector ranks remain independently auditable. */
export function rankHybridLocal<T extends HybridRankable>(
  query: string,
  items: readonly T[],
  rrfK = 60,
): HybridRanked<T>[] {
  const queryEmbedding = autoLocalEmbedding(query);
  const queryVector = queryEmbedding.vector;
  const measured = items.map((item) => ({
    item,
    lexicalScore: lexicalOverlap(query, item.text),
    vectorScore: cosineSimilarity(queryVector, item.embedding),
  }));
  const bestVectorScore = Math.max(0, ...measured.map((entry) => entry.vectorScore));
  const minimumVectorScore = queryEmbedding.model === MODEL2VEC_HYBRID_NAME
    ? (CJK_QUERY_PATTERN.test(query) ? MODEL2VEC_CJK_MIN_VECTOR_SCORE : MODEL2VEC_MIN_VECTOR_SCORE)
    : HASH_MIN_VECTOR_SCORE;
  // A score the model cannot form an opinion about is not a weak signal, it is
  // noise: with no Hangul in the vocabulary the semantic half compares letter
  // frequency, and unrelated Korean then outranks related Korean. Withhold the
  // semantic axis for any comparison that touches Korean, and let lexical rank
  // stand alone, rather than let a threshold decide which noise gets through.
  const semanticBlind = hangulBeyondModel(query);
  const measuredWithGate = measured.map((entry) => ({
    ...entry,
    semanticEligible: !semanticBlind
      && !hangulBeyondModel(entry.item.text)
      && entry.vectorScore >= minimumVectorScore
      && entry.vectorScore >= bestVectorScore * VECTOR_RELATIVE_FLOOR,
  }));
  const lexical = [...measuredWithGate].filter((entry) => entry.lexicalScore > 0).sort((left, right) =>
    right.lexicalScore - left.lexicalScore || left.item.id.localeCompare(right.item.id));
  const vector = [...measuredWithGate].filter((entry) => entry.semanticEligible).sort((left, right) =>
    right.vectorScore - left.vectorScore || left.item.id.localeCompare(right.item.id));
  const lexicalRank = new Map(lexical.map((entry, index) => [entry.item.id, index + 1]));
  const vectorRank = new Map(vector.map((entry, index) => [entry.item.id, index + 1]));
  return measuredWithGate.map((entry) => {
    const lexicalContribution = entry.lexicalScore > 0
      ? 1 / (rrfK + (lexicalRank.get(entry.item.id) ?? items.length + 1))
      : 0;
    const vectorContribution = entry.semanticEligible
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
