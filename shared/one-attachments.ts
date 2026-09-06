import type { FsPathGrant, ImageAttachment } from "./types";

export const ONE_ATTACHMENT_CONTRACT_VERSION = "1.0.0" as const;

export const ONE_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 8,
  maxImageBytes: 5 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
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
