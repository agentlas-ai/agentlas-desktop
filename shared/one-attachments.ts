import type { FsPathGrant, ImageAttachment } from "./types";

export const ONE_ATTACHMENT_CONTRACT_VERSION = "1.0.0" as const;

/**
 * The largest single value SQLite stores (SQLITE_MAX_LENGTH of the better-sqlite3 build: 1,000,000,000 bytes). A chat
 * file is one row value, so this is the one real per-file bound; it is not a policy choice ("사진이나
 * 영상 올리는 제한 없애고").
 */
export const CHAT_FILE_STORE_MAX_BYTES = 1_000_000_000;

/**
 * The bounds every Desktop had before this release. They are no longer limits on what may be attached. They remain only
 * where an old peer needs them: an old phone's inline `images` envelope, and the legacy inline copy of a file group's
 * pictures that old phones and old transcripts display (chatFileDisplayImages).
 */
export const ONE_ATTACHMENT_LEGACY_LIMITS = Object.freeze({
  maxCount: 8,
  maxImageBytes: 5 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
});

/**
 * No count, image-size or total-size limit. What reaches a model is fitted to each runtime's own
 * provider limits in one place (electron/runtime/model-image-budget.ts); the original bytes stay intact. A folder's
 * entry count and relative path length stay bounded: they guard path safety and old phones' folder cards.
 */
export const ONE_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: Number.MAX_SAFE_INTEGER,
  maxImageBytes: CHAT_FILE_STORE_MAX_BYTES,
  maxFileBytes: CHAT_FILE_STORE_MAX_BYTES,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  maxDirectoryEntries: 512,
  maxRelativePathBytes: 768,
  capabilityTtlMs: 30 * 60 * 1_000,
});

export type OneAttachmentKind = "image" | "file" | "directory";

/**
 * Picker/drop metadata is only a UX consistency claim. Main resolves the
 * exact grant and derives the authoritative name, type, size, and digest.
 */
export interface OneAttachmentPrepareItem {
  grant: FsPathGrant;
  displayName: string;
  claimedMediaType: string;
  claimedSize: number;
}

export interface PrepareOneAttachmentsInput {
  chatId: string;
  userPrompt: string;
  attachments: OneAttachmentPrepareItem[];
}

/** Opaque, process-local and single-use authority. It never contains a path. */
export interface OneAttachmentRef {
  contractVersion: typeof ONE_ATTACHMENT_CONTRACT_VERSION;
  attachmentSetId: string;
  capabilityToken: string;
}

export interface OneAttachmentSafeItem {
  attachmentId: string;
  name: string;
  mediaType: string;
  size: number;
  kind: OneAttachmentKind;
  digest: `sha256:${string}`;
}

export interface PreparedOneAttachments {
  contractVersion: typeof ONE_ATTACHMENT_CONTRACT_VERSION;
  ref: OneAttachmentRef;
  attachments: OneAttachmentSafeItem[];
  totalBytes: number;
  expiresAt: string;
  limits: typeof ONE_ATTACHMENT_LIMITS;
}

export interface DiscardOneAttachmentsInput {
  ref: OneAttachmentRef;
}

export interface BindOneAttachmentsToTeamInput {
  ref: OneAttachmentRef;
  proposalId: string;
  chatId: string;
}

/** Main-only output. Do not expose this shape over preload/renderer IPC. */
export interface ClaimedOneAttachments {
  ref: OneAttachmentRef;
  receipt: {
    contractVersion: typeof ONE_ATTACHMENT_CONTRACT_VERSION;
    attachments: OneAttachmentSafeItem[];
    totalBytes: number;
  };
  images: ImageAttachment[];
  runtimeContext: string;
  redactions: Array<{ path: string; replacement: string }>;
}
