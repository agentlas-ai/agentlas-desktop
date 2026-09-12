import type {
  LocalEnginePackageIdentity,
  LocalModelPackageIdentity,
} from "../../shared/local-model-hub";
import {
  LOCAL_MODEL_HUB_SCHEMA_VERSION,
  assertLocalEnginePackageIdentity,
  assertLocalModelPackageIdentity,
} from "../../shared/local-model-hub";

/**
 * Every row is an immutable producer identity copied from the publisher's
 * release API. A new release is a new row; package ids are never retargeted.
 */
const ENGINE_CATALOG: readonly LocalEnginePackageIdentity[] = [
  {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    packageId: "llama.cpp:b10903:darwin-arm64-metal",
    engine: "llama.cpp",
    releaseTag: "b10903",
    sourceCommit: "481c65f091f74c5e7089dd0a3a1cc6b50cced31e",
    platform: "darwin",
    arch: "arm64",
    accelerator: "metal",
    archiveFormat: "tar.gz",
    fileName: "llama-b10903-bin-macos-arm64.tar.gz",
    byteLength: 11_139_921,
    sha256: "a1893edd4e63645fb04ac9ef89fa932d3cc7ac5c513e8002b6031dbe7d104c2d",
    downloadUrl: "https://github.com/ggml-org/llama.cpp/releases/download/b10903/llama-b10903-bin-macos-arm64.tar.gz",
    sourceUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10903",
    provenance: {
      kind: "github-artifact-attestation",
      repository: "ggml-org/llama.cpp",
      signerWorkflowRepository: "ggml-org/llama.cpp",
    },
  },
  {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    packageId: "llama.cpp:b10903:darwin-x64-cpu",
    engine: "llama.cpp",
    releaseTag: "b10903",
    sourceCommit: "481c65f091f74c5e7089dd0a3a1cc6b50cced31e",
    platform: "darwin",
    arch: "x64",
    accelerator: "cpu",
    archiveFormat: "tar.gz",
    fileName: "llama-b10903-bin-macos-x64.tar.gz",
    byteLength: 11_193_197,
    sha256: "58d5f475960ce6d6c28541da0ccdbdff88bfd31b64a9db8babc0dd3add3a45f8",
    downloadUrl: "https://github.com/ggml-org/llama.cpp/releases/download/b10903/llama-b10903-bin-macos-x64.tar.gz",
    sourceUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10903",
    provenance: {
      kind: "github-artifact-attestation",
      repository: "ggml-org/llama.cpp",
      signerWorkflowRepository: "ggml-org/llama.cpp",
    },
  },
] as const;

const MODEL_CATALOG: readonly LocalModelPackageIdentity[] = [
  {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    packageId: "hf:Qwen/Qwen3-0.6B-GGUF@23749fefcc72300e3a2ad315e1317431b06b590a:Q8_0",
    repository: "Qwen/Qwen3-0.6B-GGUF",
    revision: "23749fefcc72300e3a2ad315e1317431b06b590a",
    fileName: "Qwen3-0.6B-Q8_0.gguf",
    format: "gguf",
    architecture: "qwen3",
    quantization: "Q8_0",
    byteLength: 639_446_688,
    sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031",
    license: "apache-2.0",
    gated: false,
    creator: "Qwen",
    converter: "Qwen",
    downloadUrl: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/tree/23749fefcc72300e3a2ad315e1317431b06b590a",
  },
  {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    packageId: "hf:Qwen/Qwen3-1.7B-GGUF@90862c4b9d2787eaed51d12237eafdfe7c5f6077:Q8_0",
    repository: "Qwen/Qwen3-1.7B-GGUF",
    revision: "90862c4b9d2787eaed51d12237eafdfe7c5f6077",
    fileName: "Qwen3-1.7B-Q8_0.gguf",
    format: "gguf",
    architecture: "qwen3",
    quantization: "Q8_0",
    byteLength: 1_834_426_016,
    sha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a",
    license: "apache-2.0",
    gated: false,
    creator: "Qwen",
    converter: "Qwen",
    downloadUrl: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/tree/90862c4b9d2787eaed51d12237eafdfe7c5f6077",
  },
  {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    packageId: "hf:Qwen/Qwen3-4B-GGUF@bc640142c66e1fdd12af0bd68f40445458f3869b:Q4_K_M",
    repository: "Qwen/Qwen3-4B-GGUF",
    revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
    fileName: "Qwen3-4B-Q4_K_M.gguf",
    format: "gguf",
    architecture: "qwen3",
    quantization: "Q4_K_M",
    byteLength: 2_497_280_256,
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
    license: "apache-2.0",
    gated: false,
    creator: "Qwen",
    converter: "Qwen",
    downloadUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/bc640142c66e1fdd12af0bd68f40445458f3869b",
  },
  {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    packageId: "hf:ggml-org/gemma-3-1b-it-GGUF@f9c28bcd85737ffc5aef028638d3341d49869c27:Q4_K_M",
    repository: "ggml-org/gemma-3-1b-it-GGUF",
    revision: "f9c28bcd85737ffc5aef028638d3341d49869c27",
    fileName: "gemma-3-1b-it-Q4_K_M.gguf",
    format: "gguf",
    architecture: "gemma3",
    quantization: "Q4_K_M",
    byteLength: 806_058_240,
    sha256: "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135",
    license: "gemma",
    gated: false,
    creator: "Google DeepMind",
    converter: "ggml-org",
    downloadUrl: "https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/resolve/f9c28bcd85737ffc5aef028638d3341d49869c27/gemma-3-1b-it-Q4_K_M.gguf",
    sourceUrl: "https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/tree/f9c28bcd85737ffc5aef028638d3341d49869c27",
  },
] as const;

for (const item of ENGINE_CATALOG) assertLocalEnginePackageIdentity(item);
for (const item of MODEL_CATALOG) assertLocalModelPackageIdentity(item);

export function localEngineCatalog(): LocalEnginePackageIdentity[] {
  return ENGINE_CATALOG.map((item) => ({ ...item, provenance: { ...item.provenance } }));
}

export function localModelCatalog(): LocalModelPackageIdentity[] {
  return MODEL_CATALOG.map((item) => ({ ...item }));
}

export function localEnginePackage(packageId: string): LocalEnginePackageIdentity | null {
  const item = ENGINE_CATALOG.find((candidate) => candidate.packageId === packageId);
  return item ? { ...item, provenance: { ...item.provenance } } : null;
}

export function localModelPackage(packageId: string): LocalModelPackageIdentity | null {
  const item = MODEL_CATALOG.find((candidate) => candidate.packageId === packageId);
  return item ? { ...item } : null;
}

export function compatibleEnginePackage(platform = process.platform, arch = process.arch): {
  item: LocalEnginePackageIdentity | null;
  reasonCode: string | null;
} {
  if (!(["darwin", "win32", "linux"] as const).includes(platform as "darwin" | "win32" | "linux")) {
    return { item: null, reasonCode: "engine_os_unsupported" };
  }
  if (arch !== "arm64" && arch !== "x64") {
    return { item: null, reasonCode: "engine_arch_unsupported" };
  }
  const item = ENGINE_CATALOG.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  return item
    ? { item: { ...item, provenance: { ...item.provenance } }, reasonCode: null }
    : { item: null, reasonCode: "engine_package_unavailable" };
}
