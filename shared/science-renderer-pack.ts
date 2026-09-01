import { createHash } from "node:crypto";
import {
  compareProductExtensionVersions,
  isProductExtensionId,
  isSafeProductExtensionPath,
  type ProductExtensionFile,
  type ProductExtensionManifest,
} from "./product-extension";

export const SCIENCE_RENDERER_PACK_SCHEMA = "agentlas.science-renderer-pack/v1" as const;
export const SCIENCE_RENDERER_ADAPTER_API_VERSION = "1.0.0" as const;
export const SCIENCE_RENDERER_PACK_DESCRIPTOR = "renderer-pack.json" as const;

export const SCIENCE_RENDER_SURFACES = ["canvas", "svg", "dom", "webgl2", "webgpu"] as const;
export type ScienceRenderSurface = typeof SCIENCE_RENDER_SURFACES[number];

export const SCIENCE_CAPTURE_TARGETS = ["canvas", "svg", "wrapper"] as const;
export type ScienceCaptureTarget = typeof SCIENCE_CAPTURE_TARGETS[number];

export interface ScienceRendererPackEngine {
  name: string;
  version: string;
  licenseSpdx: string;
  sourceUrl: string;
}

export interface ScienceRendererPackRenderer {
  id: string;
  artifactKinds: string[];
  surfaces: ScienceRenderSurface[];
  captureTargets: ScienceCaptureTarget[];
  inputSchemaSha256: string;
  semanticSchemaSha256: string;
  entrySha256: string;
  maxPayloadBytes: number;
}

export interface ScienceRendererPackExecutorEngineRef {
  name: string;
  version: string;
}

export interface ScienceRendererPackExecutorAsset {
  role: "runtime" | "wasm";
  path: string;
  sha256: string;
}

export interface ScienceRendererPackExecutor {
  id: string;
  version: string;
  artifactKinds: string[];
  entry: string;
  entrySha256: string;
  runtime: "node";
  network: "deny-all";
  sandboxPolicy: "science-child-v1";
  engines: ScienceRendererPackExecutorEngineRef[];
  assets: ScienceRendererPackExecutorAsset[];
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface ScienceRendererPackLicense {
  spdx: string;
  noticePath: string;
  sourceUrl: string;
}

export interface ScienceRendererPackManifest {
  schema: typeof SCIENCE_RENDERER_PACK_SCHEMA;
  id: string;
  version: string;
  displayName: string;
  minimumDesktopVersion: string;
  adapterApiVersion: string;
  entry: string;
  engines: ScienceRendererPackEngine[];
  renderers: ScienceRendererPackRenderer[];
  /** Legacy renderer-only packs omit this. Executable packs must declare it. */
  executors?: ScienceRendererPackExecutor[];
  assets: {
    merkleRoot: string;
    packageBytes: number;
    sbomPath: string;
    sbomSha256: string;
  };
  capabilities: {
    worker: boolean;
    wasm: boolean;
    vectorExport: boolean;
    offline: true;
    network: false;
    multiCapture: boolean;
    deterministicExport: boolean;
  };
  networkPolicy: {
    mode: "deny-all";
  };
  licenses: ScienceRendererPackLicense[];
}

export type ScienceRendererPackState = "ready" | "verified-unprobed" | "disabled" | "repair-required" | "conflict";

export interface ScienceRendererPackStatus {
  id: string;
  displayName: string;
  version: string | null;
  source: "core" | "extension";
  state: ScienceRendererPackState;
  rendererIds: string[];
  artifactKinds: string[];
  engineNames: string[];
  surfaces: ScienceRenderSurface[];
  packageBytes: number;
  licenseSpdx: string[];
  errorCode: string | null;
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RENDERER_ID_RE = /^[a-z][a-z0-9-]{1,31}(?:\.[a-z][a-z0-9-]{1,63})+$/;
const ARTIFACT_KIND_RE = /^[a-z][a-z0-9-]{1,31}(?:\.[a-z][a-z0-9-]{1,63})*$/;
const SPDX_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isHttpsSource(value: unknown): value is string {
  if (!isBoundedText(value, 2_048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function uniqueStrings(values: unknown, pattern: RegExp, maxItems: number): values is string[] {
  return Array.isArray(values)
    && values.length > 0
    && values.length <= maxItems
    && values.every((value) => typeof value === "string" && pattern.test(value))
    && new Set(values).size === values.length;
}

function isEngine(value: unknown): value is ScienceRendererPackEngine {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "version", "licenseSpdx", "sourceUrl"])) return false;
  return isBoundedText(value.name, 120)
    && isBoundedText(value.version, 80)
    && typeof value.licenseSpdx === "string" && SPDX_RE.test(value.licenseSpdx)
    && isHttpsSource(value.sourceUrl);
}

function isRenderer(value: unknown): value is ScienceRendererPackRenderer {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "artifactKinds", "surfaces", "captureTargets", "inputSchemaSha256",
    "semanticSchemaSha256", "entrySha256", "maxPayloadBytes",
  ])) return false;
  if (typeof value.id !== "string" || !RENDERER_ID_RE.test(value.id)) return false;
  if (!uniqueStrings(value.artifactKinds, ARTIFACT_KIND_RE, 64)) return false;
  if (!Array.isArray(value.surfaces) || value.surfaces.length < 1 || value.surfaces.length > SCIENCE_RENDER_SURFACES.length) return false;
  if (value.surfaces.some((surface) => !SCIENCE_RENDER_SURFACES.includes(surface as ScienceRenderSurface)) || new Set(value.surfaces).size !== value.surfaces.length) return false;
  if (!Array.isArray(value.captureTargets) || value.captureTargets.length < 1 || value.captureTargets.length > SCIENCE_CAPTURE_TARGETS.length) return false;
  if (value.captureTargets.some((target) => !SCIENCE_CAPTURE_TARGETS.includes(target as ScienceCaptureTarget)) || new Set(value.captureTargets).size !== value.captureTargets.length) return false;
  if (typeof value.inputSchemaSha256 !== "string" || !SHA256_RE.test(value.inputSchemaSha256)) return false;
  if (typeof value.semanticSchemaSha256 !== "string" || !SHA256_RE.test(value.semanticSchemaSha256)) return false;
  if (typeof value.entrySha256 !== "string" || !SHA256_RE.test(value.entrySha256)) return false;
  return Number.isSafeInteger(value.maxPayloadBytes) && (value.maxPayloadBytes as number) >= 1_024 && (value.maxPayloadBytes as number) <= 256 * 1024 * 1024;
}

function isExecutorEngineRef(value: unknown): value is ScienceRendererPackExecutorEngineRef {
  return isRecord(value) && hasExactKeys(value, ["name", "version"])
    && isBoundedText(value.name, 120) && isBoundedText(value.version, 80);
}

function isExecutorAsset(value: unknown): value is ScienceRendererPackExecutorAsset {
  return isRecord(value) && hasExactKeys(value, ["role", "path", "sha256"])
    && (value.role === "runtime" || value.role === "wasm")
    && typeof value.path === "string" && isSafeProductExtensionPath(value.path)
    && typeof value.sha256 === "string" && SHA256_RE.test(value.sha256);
}

function isExecutor(value: unknown): value is ScienceRendererPackExecutor {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "version", "artifactKinds", "entry", "entrySha256", "runtime", "network", "sandboxPolicy",
    "engines", "assets", "maxInputBytes", "maxOutputBytes", "timeoutMs",
  ])) return false;
  return typeof value.id === "string" && RENDERER_ID_RE.test(value.id)
    && typeof value.version === "string" && VERSION_RE.test(value.version)
    && uniqueStrings(value.artifactKinds, ARTIFACT_KIND_RE, 64)
    && typeof value.entry === "string" && isSafeProductExtensionPath(value.entry)
    && typeof value.entrySha256 === "string" && SHA256_RE.test(value.entrySha256)
    && value.runtime === "node" && value.network === "deny-all" && value.sandboxPolicy === "science-child-v1"
    && Array.isArray(value.engines) && value.engines.length > 0 && value.engines.length <= 16 && value.engines.every(isExecutorEngineRef)
    && Array.isArray(value.assets) && value.assets.length > 0 && value.assets.length <= 32 && value.assets.every(isExecutorAsset)
    && new Set(value.assets.map((asset) => asset.path)).size === value.assets.length
    && Number.isSafeInteger(value.maxInputBytes) && Number(value.maxInputBytes) >= 1_024 && Number(value.maxInputBytes) <= 256 * 1024 * 1024
    && Number.isSafeInteger(value.maxOutputBytes) && Number(value.maxOutputBytes) >= 1_024 && Number(value.maxOutputBytes) <= 256 * 1024 * 1024
    && Number.isSafeInteger(value.timeoutMs) && Number(value.timeoutMs) >= 1_000 && Number(value.timeoutMs) <= 120_000;
}

function isLicense(value: unknown): value is ScienceRendererPackLicense {
  if (!isRecord(value) || !hasExactKeys(value, ["spdx", "noticePath", "sourceUrl"])) return false;
  return typeof value.spdx === "string" && SPDX_RE.test(value.spdx)
    && typeof value.noticePath === "string" && isSafeProductExtensionPath(value.noticePath)
    && isHttpsSource(value.sourceUrl);
}

export function isScienceRendererPackManifest(value: unknown): value is ScienceRendererPackManifest {
  if (!isRecord(value)) return false;
  const legacyKeys = [
    "schema", "id", "version", "displayName", "minimumDesktopVersion", "adapterApiVersion",
    "entry", "engines", "renderers", "assets", "capabilities", "networkPolicy", "licenses",
  ];
  if (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, [...legacyKeys, "executors"])) return false;
  if (value.schema !== SCIENCE_RENDERER_PACK_SCHEMA) return false;
  if (typeof value.id !== "string" || !isProductExtensionId(value.id) || !value.id.startsWith("agentlas-science-renderer-")) return false;
  if (typeof value.version !== "string" || !VERSION_RE.test(value.version)) return false;
  if (!isBoundedText(value.displayName, 120)) return false;
  if (typeof value.minimumDesktopVersion !== "string" || !VERSION_RE.test(value.minimumDesktopVersion)) return false;
  if (typeof value.adapterApiVersion !== "string" || !VERSION_RE.test(value.adapterApiVersion)) return false;
  if (compareProductExtensionVersions(SCIENCE_RENDERER_ADAPTER_API_VERSION, value.adapterApiVersion) !== 0) return false;
  if (typeof value.entry !== "string" || !isSafeProductExtensionPath(value.entry)) return false;
  if (!Array.isArray(value.engines) || value.engines.length < 1 || value.engines.length > 16 || !value.engines.every(isEngine)) return false;
  if (!Array.isArray(value.renderers) || value.renderers.length < 1 || value.renderers.length > 32 || !value.renderers.every(isRenderer)) return false;
  if (new Set(value.renderers.map((renderer) => renderer.id)).size !== value.renderers.length) return false;
  if (value.executors !== undefined && (!Array.isArray(value.executors) || value.executors.length > 32 || !value.executors.every(isExecutor))) return false;
  if (Array.isArray(value.executors) && new Set(value.executors.map((executor) => executor.id)).size !== value.executors.length) return false;
  if (!isRecord(value.assets) || !hasExactKeys(value.assets, ["merkleRoot", "packageBytes", "sbomPath", "sbomSha256"])) return false;
  if (typeof value.assets.merkleRoot !== "string" || !SHA256_RE.test(value.assets.merkleRoot)) return false;
  if (!Number.isSafeInteger(value.assets.packageBytes) || (value.assets.packageBytes as number) < 1 || (value.assets.packageBytes as number) > 8 * 1024 * 1024 * 1024) return false;
  if (typeof value.assets.sbomPath !== "string" || !isSafeProductExtensionPath(value.assets.sbomPath)) return false;
  if (typeof value.assets.sbomSha256 !== "string" || !SHA256_RE.test(value.assets.sbomSha256)) return false;
  if (!isRecord(value.capabilities) || !hasExactKeys(value.capabilities, [
    "worker", "wasm", "vectorExport", "offline", "network", "multiCapture", "deterministicExport",
  ])) return false;
  if (typeof value.capabilities.worker !== "boolean" || typeof value.capabilities.wasm !== "boolean" || typeof value.capabilities.vectorExport !== "boolean") return false;
  if (value.capabilities.offline !== true || value.capabilities.network !== false) return false;
  if (typeof value.capabilities.multiCapture !== "boolean" || typeof value.capabilities.deterministicExport !== "boolean") return false;
  if (!isRecord(value.networkPolicy) || !hasExactKeys(value.networkPolicy, ["mode"]) || value.networkPolicy.mode !== "deny-all") return false;
  if (!Array.isArray(value.licenses) || value.licenses.length < 1 || value.licenses.length > 64 || !value.licenses.every(isLicense)) return false;
  if (new Set(value.licenses.map((license) => license.noticePath)).size !== value.licenses.length) return false;
  return true;
}

export function scienceRendererPackAssetRoot(files: readonly ProductExtensionFile[]): string {
  const rows = files
    .filter((file) => file.path !== SCIENCE_RENDERER_PACK_DESCRIPTOR)
    .map((file) => `${file.path}\0${file.sha256}\0${file.size}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(rows, "utf8").digest("hex");
}

export function validateScienceRendererPackRelease(
  pack: ScienceRendererPackManifest,
  extension: ProductExtensionManifest,
  desktopVersion: string,
): void {
  if (pack.id !== extension.id || pack.version !== extension.version || pack.minimumDesktopVersion !== extension.minimumDesktopVersion) throw new Error("science-renderer-pack-extension-identity-mismatch");
  if (extension.entry !== pack.entry) throw new Error("science-renderer-pack-entry-mismatch");
  if (extension.permissions.length !== 0) throw new Error("science-renderer-pack-permissions-forbidden");
  if (compareProductExtensionVersions(desktopVersion, pack.minimumDesktopVersion) < 0) throw new Error("science-renderer-pack-desktop-incompatible");
  const files = new Map(extension.files.map((file) => [file.path, file]));
  const descriptor = files.get(SCIENCE_RENDERER_PACK_DESCRIPTOR);
  const entry = files.get(pack.entry);
  const sbom = files.get(pack.assets.sbomPath);
  if (!descriptor || !entry || !sbom) throw new Error("science-renderer-pack-required-file-missing");
  if (entry.sha256 !== pack.renderers[0].entrySha256 || pack.renderers.some((renderer) => renderer.entrySha256 !== entry.sha256)) throw new Error("science-renderer-pack-entry-digest-mismatch");
  if (sbom.sha256 !== pack.assets.sbomSha256) throw new Error("science-renderer-pack-sbom-digest-mismatch");
  const engines = new Set(pack.engines.map((engine) => `${engine.name}\0${engine.version}`));
  for (const executor of pack.executors ?? []) {
    const executorEntry = files.get(executor.entry);
    if (!executorEntry || executorEntry.sha256 !== executor.entrySha256) throw new Error("science-renderer-pack-executor-entry-invalid");
    if (executor.engines.some((engine) => !engines.has(`${engine.name}\0${engine.version}`))) throw new Error("science-renderer-pack-executor-engine-invalid");
    for (const asset of executor.assets) {
      const file = files.get(asset.path);
      if (!file || file.sha256 !== asset.sha256) throw new Error("science-renderer-pack-executor-asset-invalid");
    }
  }
  for (const license of pack.licenses) if (!files.has(license.noticePath)) throw new Error("science-renderer-pack-license-notice-missing");
  const packageBytes = extension.files.filter((file) => file.path !== SCIENCE_RENDERER_PACK_DESCRIPTOR).reduce((sum, file) => sum + file.size, 0);
  if (packageBytes !== pack.assets.packageBytes) throw new Error("science-renderer-pack-byte-count-mismatch");
  if (scienceRendererPackAssetRoot(extension.files) !== pack.assets.merkleRoot) throw new Error("science-renderer-pack-merkle-root-mismatch");
}
