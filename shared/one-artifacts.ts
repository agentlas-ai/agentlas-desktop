/** Renderer-safe request for one exact Main-owned artifact binding. */
export interface OneArtifactBindingRequestV1 {
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  manifestId: string;
  artifactRef: string;
}

/** Ephemeral Desktop-only preview capability. It is never persisted or projected to Mobile. */
export interface OneArtifactPreviewCapabilityV1 {
  capabilityUrl: string;
  mimeType: string;
  kind: "image" | "video" | "audio" | "document" | "spreadsheet" | "archive" | "data";
  sizeBytes: number;
  expiresAt: string;
  /** Main reopens and hashes the exact source before issuing this capability. */
  sha256?: string;
}

export interface OneArtifactPreviewRevokeV1 extends OneArtifactBindingRequestV1 {
  capabilityUrl: string;
}

/**
 * Why Main would not preview an exact artifact binding. Each code names the one check that refused: issuing a
 * capability (the binding, its Task, its path, the file's identity) or serving one (the capability itself).
 * Codes are machine values; the card maps them to words and shows the code beside them.
 */
export const ONE_ARTIFACT_PREVIEW_REFUSAL_CODES = [
  "request_invalid",
  "task_missing",
  "task_chat_mismatch",
  "task_archived",
  "task_version_ahead",
  "task_version_mismatch",
  "manifest_missing",
  "binding_missing",
  "binding_version_mismatch",
  "lifecycle_unverified",
  "path_archived",
  "type_mismatch",
  "file_missing",
  "path_out_of_scope",
  "path_changed",
  "file_unreadable",
  "file_not_bounded",
  "identity_changed",
  "content_changed",
  "capability_malformed",
  "capability_unknown",
  "capability_expired",
  "capability_evicted",
  "range_invalid",
] as const;
export type OneArtifactPreviewRefusalCode = (typeof ONE_ARTIFACT_PREVIEW_REFUSAL_CODES)[number];

export interface OneArtifactPreviewRefusalV1 {
  refused: true;
  code: OneArtifactPreviewRefusalCode;
}

/** Response header that carries the refusal code when Main will not serve a capability URL. */
export const ONE_ARTIFACT_PREVIEW_REFUSAL_HEADER = "X-Agentlas-Preview-Refusal";

export function isOneArtifactPreviewRefusalCode(value: unknown): value is OneArtifactPreviewRefusalCode {
  return typeof value === "string" && (ONE_ARTIFACT_PREVIEW_REFUSAL_CODES as readonly string[]).includes(value);
}

export function isOneArtifactPreviewRefusalV1(value: unknown): value is OneArtifactPreviewRefusalV1 {
  return isRecord(value) && onlyKeys(value, ["refused", "code"]) && value.refused === true
    && isOneArtifactPreviewRefusalCode(value.code);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CAPABILITY_URL_RE = /^agentlas:\/\/one-artifact\/[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isOneArtifactBindingRequestV1(value: unknown): value is OneArtifactBindingRequestV1 {
  if (!isRecord(value) || !onlyKeys(value, [
    "taskId", "taskVersion", "chatId", "runId", "manifestId", "artifactRef",
  ])) return false;
  return ID_RE.test(String(value.taskId ?? ""))
    && Number.isSafeInteger(value.taskVersion)
    && Number(value.taskVersion) > 0
    && ID_RE.test(String(value.chatId ?? ""))
    && ID_RE.test(String(value.runId ?? ""))
    && ID_RE.test(String(value.manifestId ?? ""))
    && ID_RE.test(String(value.artifactRef ?? ""));
}

export function isOneArtifactPreviewRevokeV1(value: unknown): value is OneArtifactPreviewRevokeV1 {
  if (!isRecord(value) || !onlyKeys(value, [
    "taskId", "taskVersion", "chatId", "runId", "manifestId", "artifactRef", "capabilityUrl",
  ])) return false;
  const request = { ...value };
  delete request.capabilityUrl;
  return isOneArtifactBindingRequestV1(request)
    && typeof value.capabilityUrl === "string"
    && CAPABILITY_URL_RE.test(value.capabilityUrl);
}

export function isOneArtifactPreviewCapabilityV1(value: unknown): value is OneArtifactPreviewCapabilityV1 {
  if (!isRecord(value) || !onlyKeys(value, ["capabilityUrl", "mimeType", "kind", "sizeBytes", "expiresAt", "sha256"])) return false;
  return typeof value.capabilityUrl === "string"
    && CAPABILITY_URL_RE.test(value.capabilityUrl)
    && typeof value.mimeType === "string"
    && value.mimeType.length <= 80
    && ["image", "video", "audio", "document", "spreadsheet", "archive", "data"].includes(String(value.kind))
    && Number.isSafeInteger(value.sizeBytes)
    && Number(value.sizeBytes) > 0
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt))
    && (value.sha256 === undefined || (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)));
}
