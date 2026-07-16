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

// The model's own dimensionality. This was 352 while a 96-dim hashing bag of
// words rode alongside the 256 semantic dims; that concatenation existed only
// because the English-only model was blind to Korean, and it diluted the
// semantic axis once a multilingual model could read it.
/** Kept as an exported compatibility name; the multilingual adapter is pure 256-d semantic output. */
export const MODEL2VEC_HYBRID_DIMENSIONS = 256;
export const MODEL2VEC_HYBRID_NAME = "model2vec_potion_multilingual_128m_int8";
export const MODEL2VEC_ASSET_FORMAT = "agentlas-model2vec-int8-v1";
export const PINNED_MODEL2VEC_CONTENT_SHA256 = "aa806dbd4c6025f47b0242f8b92eb789109a0c612524980eb905fda3b5b73bde";
// potion-base-8M is distilled from an English BERT and has no whole Hangul
// syllables in its vocabulary — only Jamo — so it shatters Korean into single
// letters and ranks it by letter frequency. On a fixed ranking set it placed the
// right memory first 0 times out of 4 while scoring 0.46-0.63, i.e. confidently
// wrong; the multilingual asset placed it first 3 times out of 4, and
// Korean-to-English similarity went from -0.03 (worse than random) to 0.494.
export const PINNED_MODEL2VEC_MODEL_ID = "minishlab/potion-multilingual-128M";
export const PINNED_MODEL2VEC_REVISION = "73908c3438cf03b6a01bcb9611d62b23d0726f08";
const PINNED_MODEL2VEC_EMBEDDING_PARTS = [
  {
    name: "embeddings.i8.part-000",
    sha256: "e41c2cd2bf7f77925d5f6162242f22d31e731c4daec44adc4d71fbe27d51ac36",
    size: 67_108_864,
  },
  {
    name: "embeddings.i8.part-001",
    sha256: "2720f905f4959b0067e875b38cbb70b72ab2107ec5026899294c700146439f3f",
    size: 60_981_504,
  },
] as const;
const PINNED_MODEL2VEC_ORDERED_PARTS_SHA256 = "4d0382e963f7fd099b4f7be64c004c5772c4962662ce9af2cf76b7a19a114e91";
const PINNED_MODEL2VEC_SOURCE_FILES: Record<string, AssetFileRecord> = {
  "config.json": { sha256: "595e4cab2093732efd5dbe084fd5c1826b5eea693b73b4c1fd971672867d2e54", size: 271 },
  "tokenizer.json": { sha256: "19f1909063da3cfe3bd83a782381f040dccea475f4816de11116444a73e1b6a1", size: 18616131 },
  "model.safetensors": { sha256: "14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397", size: 512361560 },
  "README.md": { sha256: "9505454b6a3efbb25257124de875cb73e02bd663a822528525a3c29b1c4d91ac", size: 5575 },
};
const MODEL_DISCOVERY_MISS_TTL_MS = 5_000;
const HASH_MIN_VECTOR_SCORE = 0.08;
// A noise floor, not a precision gate — precision comes from the reciprocal-rank
// fusion below. Calibrated against the multilingual asset, where a genuine match
// scores 0.15-0.50 (English runs higher, 0.25-1.00) and unrelated text scores
// -0.02 upward. The old 0.45/0.50 pair was calibrated against potion-base-8M,
// whose Jamo-shattered Korean scored 0.4-0.9 for everything; carrying those
// numbers over would discard almost every real Korean match.
const MODEL2VEC_MIN_VECTOR_SCORE = 0.15;
const MODEL2VEC_CJK_MIN_VECTOR_SCORE = 0.12;
const VECTOR_RELATIVE_FLOOR = 0.72;
// Semantic magnitude is deliberately a small correction to lexical evidence.
// Equal-rank fusion can let weak semantic evidence overrule exact text; this
// residual preserves lexical authority while retaining cross-language recall.
const SEMANTIC_RESIDUAL_WEIGHT = 0.05;
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
  // WordPiece (potion-base-8M) or Unigram (potion-multilingual-128M). The two
  // segment text completely differently, so the asset declares which one it is
  // rather than the reader assuming.
  tokenizer: "WordPiece" | "Unigram";
  /** Unigram only: log-probability per token, indexed by token id. */
  unigramScores: Float64Array | null;
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
  const assetSuffix = path.join("model2vec", "potion-multilingual-128M-int8");
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

function orderedPartsIdentity(files: Record<string, AssetFileRecord>, names: string[]): string {
  const digest = createHash("sha256");
  for (const [index, name] of names.entries()) {
    const record = files[name];
    if (!record) return "";
    digest.update(String(index)).update("\0").update(name).update("\0")
      .update(record.sha256).update("\0").update(String(record.size)).update("\n");
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
    const rawEmbeddingParts: unknown[] = Array.isArray(manifest.embeddingParts)
      ? manifest.embeddingParts
      : [];
    const embeddingParts: string[] = rawEmbeddingParts.filter((name: unknown): name is string => (
      typeof name === "string" && /^embeddings\.i8\.part-\d{3}$/.test(name)
    ));
    if (
      embeddingParts.length === 0 ||
      embeddingParts.length !== rawEmbeddingParts.length ||
      new Set(embeddingParts).size !== embeddingParts.length ||
      JSON.stringify(embeddingParts) !== JSON.stringify(PINNED_MODEL2VEC_EMBEDDING_PARTS.map((part) => part.name))
    ) return null;
    const required = [...embeddingParts, "scales.f32le", "tokenizer.json", "LICENSE.model.txt"];
    const files = manifest.files as Record<string, AssetFileRecord>;
    if (!files || required.some((name) => !files[name])) return null;
    if (!PINNED_MODEL2VEC_EMBEDDING_PARTS.every((part) => (
      files[part.name]?.sha256 === part.sha256 && files[part.name]?.size === part.size
    ))) return null;
    const orderedPartsSha256 = orderedPartsIdentity(files, embeddingParts);
    if (orderedPartsSha256 !== PINNED_MODEL2VEC_ORDERED_PARTS_SHA256) return null;
    const resolved = Object.fromEntries(required.map((name) => [name, verifiedFile(root, name, files[name])]));
    if (embeddingParts.reduce((sum, name) => sum + files[name].size, 0) !== vocabSize * dimensions ||
      files["scales.f32le"].size !== vocabSize * 4) return null;
    const modelSha256 = contentIdentity(files, required);
    if (manifest.contentSha256 !== modelSha256 || modelSha256 !== PINNED_MODEL2VEC_CONTENT_SHA256) return null;
    const tokenizer = JSON.parse(fs.readFileSync(resolved["tokenizer.json"], "utf8")) as any;
    const tokenizerType = tokenizer?.model?.type;
    if (tokenizerType !== "WordPiece" && tokenizerType !== "Unigram") return null;
    const vocab = new Map<string, number>();
    let unigramScores: Float64Array | null = null;
    if (tokenizerType === "WordPiece") {
      const vocabObject = tokenizer?.model?.vocab as Record<string, unknown> | undefined;
      if (!vocabObject || Object.keys(vocabObject).length !== vocabSize) return null;
      const ids: number[] = [];
      for (const [token, rawId] of Object.entries(vocabObject)) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || id < 0 || id >= vocabSize) return null;
        vocab.set(token, id);
        ids.push(id);
      }
      ids.sort((left, right) => left - right);
      if (ids.some((id, index) => id !== index)) return null;
    } else {
      // Unigram stores an ordered [token, logProbability] list; the array index
      // is the token id, and the score drives the Viterbi segmentation.
      const entries = tokenizer?.model?.vocab as unknown[] | undefined;
      if (!Array.isArray(entries) || entries.length !== vocabSize) return null;
      unigramScores = new Float64Array(vocabSize);
      for (let id = 0; id < entries.length; id += 1) {
        const entry = entries[id];
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [token, score] = entry as [unknown, unknown];
        if (typeof token !== "string" || typeof score !== "number" || !Number.isFinite(score)) return null;
        // A duplicate token would make the id ambiguous; the first wins, as in
        // the reference tokenizer.
        if (!vocab.has(token)) vocab.set(token, id);
        unigramScores[id] = score;
      }
    }
    const unknownTokenId = vocab.get("[UNK]") ?? vocab.get("<unk>");
    if (unknownTokenId === undefined) return null;
    const source = manifest.source as { modelId?: unknown; revision?: unknown; files?: unknown };
    if (source?.modelId !== PINNED_MODEL2VEC_MODEL_ID || source?.revision !== PINNED_MODEL2VEC_REVISION) return null;
    if (!exactFileRecords(source.files, PINNED_MODEL2VEC_SOURCE_FILES)) return null;
    const assetIdentity = `model2vec:${PINNED_MODEL2VEC_MODEL_ID}:${PINNED_MODEL2VEC_REVISION}:${modelSha256}:${orderedPartsSha256}:${manifest.format}`;
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
      adapter: `${assetIdentity}:semantic-v1:${MODEL2VEC_HYBRID_DIMENSIONS}`,
      supportsHangul,
      tokenizer: tokenizerType,
      unigramScores,
      dimensions,
      vocabSize,
      vocab,
      unknownTokenId,
      embeddings: Buffer.concat(embeddingParts.map((name) => fs.readFileSync(resolved[name]))),
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

// Unigram segmentation. bge-m3's normalizer is a 316KB precompiled SentencePiece
// charsmap; NFKC plus whitespace collapsing reproduces it for the text this runs
// on, so the charsmap does not have to be reimplemented. Metaspace then marks
// word starts with U+2581 and Viterbi picks the segmentation with the highest
// total log-probability — the piece boundaries are what let Korean stay whole
// ("배포 실패" → ▁ / 배포 / ▁실패) instead of collapsing into Jamo.
const METASPACE = "\u2581";
const UNIGRAM_MAX_PIECE_CHARS = 24;

function unigramNormalize(text: string): string {
  const normalized = text.normalize("NFKC").split(/\s+/).filter(Boolean).join(" ");
  if (!normalized) return "";
  return METASPACE + normalized.split(" ").join(METASPACE);
}

function unigramTokenIds(text: string, descriptor: ModelDescriptor): number[] {
  const scores = descriptor.unigramScores;
  if (!scores) return [];
  const characters = Array.from(unigramNormalize(text));
  const length = characters.length;
  if (length === 0) return [];
  const bestScore = new Float64Array(length + 1).fill(-Infinity);
  const bestStart = new Int32Array(length + 1).fill(-1);
  const bestId = new Int32Array(length + 1).fill(-1);
  bestScore[0] = 0;
  for (let start = 0; start < length; start += 1) {
    if (bestScore[start] === -Infinity) continue;
    const limit = Math.min(length, start + UNIGRAM_MAX_PIECE_CHARS);
    for (let end = start + 1; end <= limit; end += 1) {
      const id = descriptor.vocab.get(characters.slice(start, end).join(""));
      if (id === undefined) continue;
      const candidate = bestScore[start] + scores[id];
      if (candidate > bestScore[end]) {
        bestScore[end] = candidate;
        bestStart[end] = start;
        bestId[end] = id;
      }
    }
  }
  // A character no piece covers leaves the path broken. Rather than emit an
  // arbitrary partial segmentation, report nothing and let the caller fall back
  // to lexical evidence.
  if (bestScore[length] === -Infinity) return [];
  const ids: number[] = [];
  for (let at = length; at > 0; at = bestStart[at]) {
    if (bestStart[at] < 0) return [];
    if (bestId[at] !== descriptor.unknownTokenId) ids.push(bestId[at]);
  }
  return ids.reverse();
}

export function model2VecTokenIds(text: string, descriptor = verifiedModelDescriptor()): number[] {
  if (!descriptor) return [];
  if (descriptor.tokenizer === "Unigram") return unigramTokenIds(text, descriptor);
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
  // The multilingual model reads Korean directly. Keep lexical overlap as an
  // independently auditable retrieval rank instead of contaminating the
  // semantic vector with the obsolete English-model hash96 compensation axis.
  const vector = normalizeVector(semantic).map((value) => Number(value.toFixed(6)));
  return {
    model: MODEL2VEC_HYBRID_NAME,
    adapter: descriptor.adapter,
    dimensions: MODEL2VEC_HYBRID_DIMENSIONS,
    vector,
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

/** Calibrated late fusion: lexical and local-vector evidence remain independently auditable. */
export function rankHybridLocal<T extends HybridRankable>(
  query: string,
  items: readonly T[],
  _rrfK = 60,
): HybridRanked<T>[] {
  const queryEmbedding = autoLocalEmbedding(query);
  const queryVector = queryEmbedding.vector;
  const measured = items.map((item) => ({
    item,
    lexicalScore: lexicalOverlap(query, item.text),
    vectorScore: cosineSimilarity(queryVector, item.embedding),
  }));
  const bestVectorScore = Math.max(0, ...measured.map((entry) => entry.vectorScore));
  // CJK no longer gets its own floor: that existed because the English-only
  // asset could not read it, and a model that reads Korean should not be second-
  // guessed for being asked in Korean.
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
  return measuredWithGate.map((entry) => {
    const lexicalContribution = entry.lexicalScore;
    const vectorContribution = entry.semanticEligible
      ? Math.max(0, entry.vectorScore - minimumVectorScore) * SEMANTIC_RESIDUAL_WEIGHT
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
