/**
 * Optional request keys of the media-carousel work. Each belongs to a host capability a phone reads before it
 * sends the key; an older Desktop refuses the key through its exact-key checks, so a phone never sends one blind.
 *
 *   chat-attachments-v2          chat.attachments.begin  scope: "chat" | "build"
 *                                chat.attachment.imagePreview  maxEdge: 64..2048
 *   remote-build-attachments-v1  build.start / build.answer  fileGroupId: uuid (a finished `build` upload of the same phone)
 *   remote-build-options-v1      build.start  mode: "single" | "team" | "package"
 *
 * The keys are validated here and taken off the request, so every existing exact-key validator and handler keeps reading
 * the request it always read. No electron import: the bridge server, the authority and the gates load this.
 */
export const MOBILE_CHAT_ATTACHMENTS_V2_CAPABILITY = "chat-attachments-v2";
export const MOBILE_REMOTE_BUILD_ATTACHMENTS_CAPABILITY = "remote-build-attachments-v1";
export const MOBILE_REMOTE_BUILD_OPTIONS_CAPABILITY = "remote-build-options-v1";
export const MOBILE_BUILD_MODES = ["single", "team", "package"] as const;
export type MobileBuildMode = (typeof MOBILE_BUILD_MODES)[number];
export const MOBILE_IMAGE_PREVIEW_EDGE = Object.freeze({ min: 64, max: 2048 });

export interface MobileMediaParams {
  scope?: "chat" | "build";
  maxEdge?: number;
  fileGroupId?: string;
  mode?: MobileBuildMode;
}

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const KEYS_BY_METHOD: Readonly<Record<string, readonly (keyof MobileMediaParams)[]>> = Object.freeze({
  "chat.attachments.begin": ["scope"],
  "chat.attachment.imagePreview": ["maxEdge"],
  "build.start": ["fileGroupId", "mode"],
  "build.answer": ["fileGroupId"],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The method's media keys, validated, and the params without them. `null` when the method has none of them present
 * (then nothing changes). An invalid value is an error string, never silently dropped.
 */
export function splitMobileMediaParams(method: string, params: unknown): { error: string | null; media: MobileMediaParams; rest: Record<string, unknown> } | null {
  const keys = KEYS_BY_METHOD[method];
  if (!keys || !isRecord(params) || !keys.some((key) => Object.prototype.hasOwnProperty.call(params, key))) return null;
  const rest: Record<string, unknown> = { ...params };
  const media: MobileMediaParams = {};
  let error: string | null = null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    const value = params[key];
    delete rest[key];
    if (key === "scope") {
      if (value === "chat" || value === "build") media.scope = value;
      else error ??= "scope must be chat or build";
    } else if (key === "maxEdge") {
      if (Number.isSafeInteger(value) && Number(value) >= MOBILE_IMAGE_PREVIEW_EDGE.min && Number(value) <= MOBILE_IMAGE_PREVIEW_EDGE.max) media.maxEdge = Number(value);
      else error ??= `maxEdge must be an integer from ${MOBILE_IMAGE_PREVIEW_EDGE.min} to ${MOBILE_IMAGE_PREVIEW_EDGE.max}`;
    } else if (key === "fileGroupId") {
      if (typeof value === "string" && UUID_RE.test(value)) media.fileGroupId = value.toLowerCase();
      else error ??= "fileGroupId must be an upload group id";
    } else if (key === "mode") {
      if (typeof value === "string" && (MOBILE_BUILD_MODES as readonly string[]).includes(value)) media.mode = value as MobileBuildMode;
      else error ??= "mode must be single, team or package";
    }
  }
  if (media.scope === "build" && rest.chatId !== undefined && rest.chatId !== null) error ??= "a build upload belongs to no conversation";
  return { error, media, rest };
}
