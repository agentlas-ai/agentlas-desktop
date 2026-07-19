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
  kind: "image" | "video" | "audio";
  sizeBytes: number;
  expiresAt: string;
}

export interface OneArtifactPreviewRevokeV1 extends OneArtifactBindingRequestV1 {
  capabilityUrl: string;
}

export interface OneArtifactOpenResultV1 {
  opened: boolean;
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
  if (!isRecord(value) || !onlyKeys(value, ["capabilityUrl", "mimeType", "kind", "sizeBytes", "expiresAt"])) return false;
  return typeof value.capabilityUrl === "string"
    && CAPABILITY_URL_RE.test(value.capabilityUrl)
    && typeof value.mimeType === "string"
    && value.mimeType.length <= 80
    && ["image", "video", "audio"].includes(String(value.kind))
    && Number.isSafeInteger(value.sizeBytes)
    && Number(value.sizeBytes) > 0
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt));
}
