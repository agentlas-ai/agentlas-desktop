export const LOCAL_MODEL_HUB_SCHEMA_VERSION = 1 as const;

export type LocalModelPlatform = "darwin" | "win32" | "linux";
export type LocalModelArch = "arm64" | "x64";
export type LocalModelAccelerator = "metal" | "cpu" | "cuda" | "rocm" | "vulkan" | "openvino";

export interface LocalEnginePackageIdentity {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  packageId: string;
  engine: "llama.cpp";
  releaseTag: string;
  sourceCommit: string;
  platform: LocalModelPlatform;
  arch: LocalModelArch;
  accelerator: LocalModelAccelerator;
  archiveFormat: "tar.gz" | "zip";
  fileName: string;
  byteLength: number;
  sha256: string;
  downloadUrl: string;
  sourceUrl: string;
  provenance: {
    kind: "github-artifact-attestation";
    repository: "ggml-org/llama.cpp";
    signerWorkflowRepository: "ggml-org/llama.cpp";
  };
}

export interface LocalModelPackageIdentity {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  packageId: string;
  repository: string;
  revision: string;
  fileName: string;
  format: "gguf";
  architecture: string;
  quantization: string;
  byteLength: number;
  sha256: string;
  license: string;
  gated: boolean;
  creator: string;
  converter: string;
  downloadUrl: string;
  sourceUrl: string;
}

export type LocalModelFitClass =
  | "recommended"
  | "runnable"
  | "may_be_slow"
  | "not_recommended"
  | "unsupported"
  | "unknown";

export interface LocalHardwareProfile {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  profileId: string;
  observedAt: string;
  platform: string;
  arch: string;
  cpuModel: string;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  memoryKind: "unified" | "system" | "unknown";
  accelerator: LocalModelAccelerator | "unknown";
  acceleratorEvidence: "host-observed" | "not-observed";
  vramBytes: number | null;
  diskAvailableBytes: number | null;
}

export interface LocalModelFitAssessment {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  assessmentId: string;
  hardwareProfileId: string;
  modelPackageId: string;
  class: LocalModelFitClass;
  evidence: "estimated" | "verified_on_this_device";
  requiredBytes: number | null;
  availableBytes: number | null;
  reasonCodes: string[];
}

export type LocalPackageState =
  | "available"
  | "downloading"
  | "downloaded"
  | "verified"
  | "installed"
  | "loading"
  | "resident"
  | "queued"
  | "running"
  | "unloading"
  | "failed"
  | "unsupported";

export interface LocalPackageProgress {
  packageId: string;
  state: LocalPackageState;
  downloadedBytes: number;
  totalBytes: number;
  reasonCode: string | null;
  updatedAt: string;
}

export interface LocalPackageDownloadReceipt {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  receiptId: string;
  packageId: string;
  kind: "engine" | "model";
  state: "verified" | "cancelled" | "failed";
  expectedSha256: string;
  observedSha256: string | null;
  expectedBytes: number;
  observedBytes: number;
  resumedFromBytes: number;
  rangeAccepted: boolean;
  etag: string | null;
  startedAt: string;
  finishedAt: string;
  reasonCode: string | null;
}

export interface LocalEngineInstallationReceipt {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  receiptId: string;
  enginePackageId: string;
  enginePackageSha256: string;
  provenanceVerified: boolean;
  executableSha256: string;
  executableRelativePath: string;
  /** Exact files from the attested archive; required before loading Windows DLLs. */
  runtimeFiles?: Array<{ relativePath: string; sha256: string; byteLength: number }>;
  installedAt: string;
}

export interface LocalModelInstallationReceipt {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  installationId: string;
  modelPackageId: string;
  repository: string;
  revision: string;
  fileName: string;
  fileSha256: string;
  quantization: string;
  enginePackageId: string | null;
  installedAt: string;
  source: "download" | "user-import";
}

export interface LocalModelLoadReceipt {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  receiptId: string;
  processEpoch: string;
  installationId: string;
  enginePackageId: string;
  engineExecutableSha256: string;
  endpoint: string;
  contextTokens: number;
  state: "resident" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  reasonCode: string | null;
}

export interface LocalModelCapabilityReceipt {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  receiptId: string;
  installationId: string;
  enginePackageId: string;
  hardwareProfileId: string;
  testedAt: string;
  contextTokens: number;
  toolUse: "verified" | "failed" | "not_tested";
  strictJson: "verified" | "failed" | "not_tested";
  imageInput: "verified" | "failed" | "not_tested";
  cancellation: "verified" | "failed" | "not_tested";
  reasonCodes: string[];
}

export interface LocalModelRunReceipt {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  receiptId: string;
  processEpoch: string;
  installationId: string;
  requestSha256: string;
  state: "completed" | "failed" | "cancelled";
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasonCode: string | null;
}

export interface LocalModelHubSnapshot {
  schemaVersion: typeof LOCAL_MODEL_HUB_SCHEMA_VERSION;
  generatedAt: string;
  hardware: LocalHardwareProfile;
  engineCatalog: LocalEnginePackageIdentity[];
  modelCatalog: LocalModelPackageIdentity[];
  engineProgress: LocalPackageProgress[];
  modelProgress: LocalPackageProgress[];
  downloadReceipts: LocalPackageDownloadReceipt[];
  engineInstallations: LocalEngineInstallationReceipt[];
  modelInstallations: LocalModelInstallationReceipt[];
  fitAssessments: LocalModelFitAssessment[];
  loadReceipts: LocalModelLoadReceipt[];
  capabilityReceipts: LocalModelCapabilityReceipt[];
  runReceipts: LocalModelRunReceipt[];
  resident: LocalModelLoadReceipt | null;
  unavailableReason: string | null;
}

/** Repository metadata is a source claim, never device capability evidence. */
export interface HuggingFaceModelSummary {
  repository: string;
  author: string | null;
  downloads?: number;
  likes?: number;
  updatedAt?: string;
  gated: boolean | "unknown";
  license?: string;
  tags: string[];
}
export interface HuggingFaceCatalogStatus {
  syncedAt: string | null;
  source: "live" | "cache";
  stale: boolean;
  reasonCode?: string;
}
export interface HuggingFaceSearchResult extends HuggingFaceCatalogStatus {
  models: HuggingFaceModelSummary[];
  nextCursor?: string;
}
export interface HuggingFaceModelFile {
  fileName: string;
  byteLength: number | null;
  sha256: string | null;
  quantization: string | null;
  downloadable: boolean;
  reasonCodes: string[];
}
export interface HuggingFaceRepositoryInspection extends HuggingFaceCatalogStatus {
  repository: string;
  revision: string | null;
  publisher: string | null;
  creator: string | null;
  converter: string | null;
  architecture: string | null;
  license: string | null;
  gated: boolean | "unknown";
  files: HuggingFaceModelFile[];
  reasonCodes: string[];
}

/** Main-session operations belong to one trusted webContents; never infer these IDs from package progress. */
export interface LocalModelOperationView {
  operationId: string;
  kind: "downloadEngine" | "downloadModel" | "installEnginePackage" | "installModelPackage" | "loadModel" | "testCapabilities";
  packageId: string | null;
  installationId: string | null;
  state: "pending" | "cancelling" | "completed" | "cancelled" | "failed";
  phase: "download" | "install" | "load" | "check";
  startedAt: string;
  finishedAt: string | null;
  reasonCode: "local_model_operation_cancelled" | "local_model_operation_failed" | null;
}

/** Renderer-facing API. Main owns operation controllers and the import dialog. */
export interface LocalModelHubAPI {
  searchModels: (payload: { query: string; cursor?: string; refresh?: boolean }) => Promise<HuggingFaceSearchResult>;
  inspectRepository: (payload: { repository: string; refresh?: boolean }) => Promise<HuggingFaceRepositoryInspection>;
  addModel: (payload: { repository: string; revision: string; fileName: string }) => Promise<LocalModelPackageIdentity>;
  snapshot: () => Promise<LocalModelHubSnapshot>;
  operations: () => Promise<LocalModelOperationView[]>;
  installEnginePackage: (payload: { packageId: string; operationId: string }) => Promise<LocalEngineInstallationReceipt>;
  installModelPackage: (payload: { packageId: string; operationId: string }) => Promise<LocalModelInstallationReceipt>;
  downloadEngine: (payload: { packageId: string; operationId: string }) => Promise<LocalPackageDownloadReceipt>;
  downloadModel: (payload: { packageId: string; operationId: string }) => Promise<LocalPackageDownloadReceipt>;
  cancelOperation: (payload: { operationId: string }) => Promise<{ cancelled: boolean }>;
  importModel: (payload: { packageId: string }) => Promise<LocalModelInstallationReceipt | null>;
  installEngine: (payload: { packageId: string }) => Promise<LocalEngineInstallationReceipt>;
  installDownloadedModel: (payload: { packageId: string }) => Promise<LocalModelInstallationReceipt>;
  loadModel: (payload: { installationId: string; contextTokens: number; operationId: string }) => Promise<LocalModelLoadReceipt>;
  unload: (payload: { processEpoch: string; cancelActiveRuns: boolean }) => Promise<void>;
  testCapabilities: (payload: {
    installationId: string;
    strictJson: boolean;
    toolUse: boolean;
    cancellation: boolean;
    operationId: string;
  }) => Promise<LocalModelCapabilityReceipt>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9._:@/+\-]{8,512}$/;
const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,255}$/;

export function validLocalPackageId(value: unknown): value is string {
  return typeof value === "string" && PACKAGE_ID_RE.test(value);
}

export function validLocalPackageSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function assertLocalEnginePackageIdentity(value: LocalEnginePackageIdentity): void {
  if (
    value.schemaVersion !== LOCAL_MODEL_HUB_SCHEMA_VERSION
    || !validLocalPackageId(value.packageId)
    || value.engine !== "llama.cpp"
    || !/^b[0-9]{3,8}$/.test(value.releaseTag)
    || !COMMIT_RE.test(value.sourceCommit)
    || !["darwin", "win32", "linux"].includes(value.platform)
    || !["arm64", "x64"].includes(value.arch)
    || !["metal", "cpu", "cuda", "rocm", "vulkan", "openvino"].includes(value.accelerator)
    || !SAFE_FILE_RE.test(value.fileName)
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 1
    || !validLocalPackageSha256(value.sha256)
    || value.provenance.kind !== "github-artifact-attestation"
    || value.provenance.repository !== "ggml-org/llama.cpp"
    || value.provenance.signerWorkflowRepository !== "ggml-org/llama.cpp"
  ) throw new TypeError("invalid_local_engine_package_identity");
  const expectedPrefix = `https://github.com/ggml-org/llama.cpp/releases/download/${value.releaseTag}/`;
  if (value.downloadUrl !== `${expectedPrefix}${value.fileName}`) {
    throw new TypeError("invalid_local_engine_download_url");
  }
}

export function assertLocalModelPackageIdentity(value: LocalModelPackageIdentity): void {
  if (
    value.schemaVersion !== LOCAL_MODEL_HUB_SCHEMA_VERSION
    || !validLocalPackageId(value.packageId)
    || !/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/.test(value.repository)
    || !COMMIT_RE.test(value.revision)
    || !SAFE_FILE_RE.test(value.fileName)
    || value.format !== "gguf"
    || value.architecture.length < 1
    || value.architecture.length > 80
    || value.quantization.length < 1
    || value.quantization.length > 40
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 1
    || !validLocalPackageSha256(value.sha256)
    || typeof value.gated !== "boolean"
  ) throw new TypeError("invalid_local_model_package_identity");
  const expected = `https://huggingface.co/${value.repository}/resolve/${value.revision}/${value.fileName}`;
  if (value.downloadUrl !== expected) throw new TypeError("invalid_local_model_download_url");
}
