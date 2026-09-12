import { OFFICE_DOCUMENT_SESSION_VERSION, OFFICE_TASK_SELECTION_VERSION, OFFICE_EDIT_INTENT_VERSION } from "@shared/office-document";
import type { OfficeFormat, OfficeCapabilityVerdict, OfficeCapabilities, MainArtifactRevision, OfficeSelectionAnchor, OfficeTaskSelection, OfficeEditIntent } from "@shared/office-document";
export * from "@shared/office-document";

export interface PendingOfficeEdit {
  selection: OfficeTaskSelection;
  originalValue: string;
  replacementValue: string;
  draftSequence: number;
  delivery: "draft" | "sending" | "acknowledged" | "failed";
}

export interface OfficeRevisionConflict {
  base: MainArtifactRevision;
  incoming: MainArtifactRevision;
}

export interface OfficeDocumentSession {
  contractVersion: typeof OFFICE_DOCUMENT_SESSION_VERSION;
  format: OfficeFormat | null;
  activeRevision: MainArtifactRevision | null;
  incomingRevision: MainArtifactRevision | null;
  selection: OfficeTaskSelection | null;
  pendingEdit: PendingOfficeEdit | null;
  conflict: OfficeRevisionConflict | null;
  selectionSequence: number;
  draftSequence: number;
}

export type OfficeDocumentSessionAction =
  | { type: "observe-document"; format: OfficeFormat | null; revision: MainArtifactRevision | null }
  | { type: "select"; anchor: OfficeSelectionAnchor }
  | { type: "change-draft"; replacementValue: string }
  | { type: "set-delivery"; draftSequence: number; delivery: PendingOfficeEdit["delivery"] }
  | { type: "discard-draft-and-load" }
  | { type: "clear-draft" };

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function mainArtifactRevision(input: { sha256: string; binding: string; tabId: string } | undefined): MainArtifactRevision | null {
  const sha256 = input?.sha256.trim().toLowerCase() ?? "";
  if (!SHA256_PATTERN.test(sha256) || !input?.binding.trim() || !input.tabId.trim()) return null;
  return { sha256, binding: input.binding, tabId: input.tabId, authority: "main-content-sha256" };
}

function sameRevision(left: MainArtifactRevision | null, right: MainArtifactRevision | null): boolean {
  if (!left || !right) return left === right;
  return left.sha256 === right.sha256 && left.binding === right.binding && left.tabId === right.tabId;
}

export function officeSelectionValue(selection: OfficeTaskSelection | null): string | null {
  const anchor = selection?.anchor;
  if (!anchor) return null;
  if (anchor.kind === "cell") return anchor.displayValue;
  if (anchor.kind === "slide") return anchor.title ?? "";
  if (anchor.kind === "text") return anchor.text;
  return null;
}

export function createOfficeDocumentSession(format: OfficeFormat | null, revision: MainArtifactRevision | null): OfficeDocumentSession {
  return {
    contractVersion: OFFICE_DOCUMENT_SESSION_VERSION,
    format,
    activeRevision: revision,
    incomingRevision: null,
    selection: null,
    pendingEdit: null,
    conflict: null,
    selectionSequence: 0,
    draftSequence: 0,
  };
}

export function reduceOfficeDocumentSession(state: OfficeDocumentSession, action: OfficeDocumentSessionAction): OfficeDocumentSession {
  if (action.type === "observe-document") {
    if (sameRevision(state.activeRevision, action.revision)) return { ...state, format: action.format };
    if (state.pendingEdit) {
      if (state.activeRevision && action.revision) {
        return {
          ...state,
          incomingRevision: action.revision,
          conflict: { base: state.activeRevision, incoming: action.revision },
        };
      }
      return state;
    }
    return {
      ...state,
      format: action.format,
      activeRevision: action.revision,
      incomingRevision: null,
      selection: null,
      pendingEdit: null,
      conflict: null,
    };
  }
  if (action.type === "select") {
    if (!state.format) return state;
    const selectionSequence = state.selectionSequence + 1;
    return {
      ...state,
      selectionSequence,
      selection: {
        contractVersion: OFFICE_TASK_SELECTION_VERSION,
        format: state.format,
        artifactRevision: state.activeRevision,
        anchor: action.anchor,
        selectionSequence,
      },
    };
  }
  if (action.type === "change-draft") {
    const selection = state.pendingEdit?.selection ?? state.selection;
    const originalValue = state.pendingEdit?.originalValue ?? officeSelectionValue(selection);
    if (!selection || originalValue === null || !state.activeRevision || state.conflict) return state;
    const replacementValue = action.replacementValue;
    if (replacementValue === originalValue) return { ...state, pendingEdit: null };
    const draftSequence = state.draftSequence + 1;
    return {
      ...state,
      draftSequence,
      pendingEdit: { selection, originalValue, replacementValue, draftSequence, delivery: "draft" },
    };
  }
  if (action.type === "set-delivery") {
    if (!state.pendingEdit || state.pendingEdit.draftSequence !== action.draftSequence) return state;
    return { ...state, pendingEdit: { ...state.pendingEdit, delivery: action.delivery } };
  }
  if (action.type === "discard-draft-and-load") {
    if (!state.incomingRevision) return { ...state, pendingEdit: null, conflict: null };
    return {
      ...state,
      activeRevision: state.incomingRevision,
      incomingRevision: null,
      selection: null,
      pendingEdit: null,
      conflict: null,
    };
  }
  if (action.type === "clear-draft") return { ...state, pendingEdit: null, conflict: null, incomingRevision: null };
  return state;
}

export function createOfficeEditIntent(state: OfficeDocumentSession, operationId: string): OfficeEditIntent | null {
  const edit = state.pendingEdit;
  const revision = state.activeRevision;
  if (!edit || !revision || state.conflict || edit.delivery === "sending") return null;
  if (!edit.selection.artifactRevision || !sameRevision(edit.selection.artifactRevision, revision)) return null;
  const cleanOperationId = operationId.trim();
  if (!cleanOperationId) return null;
  return {
    contractVersion: OFFICE_EDIT_INTENT_VERSION,
    operationId: cleanOperationId,
    artifactRevision: revision,
    selection: edit.selection as OfficeTaskSelection & { artifactRevision: MainArtifactRevision },
    originalValue: edit.originalValue,
    replacementValue: edit.replacementValue,
    draftSequence: edit.draftSequence,
  };
}

export function officeCapabilities(input: {
  format: OfficeFormat | null;
  viewerState: "loading" | "ready" | "failed";
  nativeOpenAvailable: boolean;
}): OfficeCapabilities {
  const render: OfficeCapabilityVerdict = input.format === null
    ? { status: "unsupported", reason: "format-unresolved" }
    : input.viewerState === "ready"
      ? { status: "verified", reason: "viewer-ready" }
      : input.viewerState === "failed"
        ? { status: "unsupported", reason: "viewer-failed" }
        : { status: "unverified", reason: "viewer-loading" };
  return {
    read: render.status === "verified" ? { status: "verified", reason: "viewer-ready" } : render,
    structure: input.format === null
      ? { status: "unsupported", reason: "format-unresolved" }
      : { status: "available", reason: "structured-renderer" },
    render,
    edit: { status: "unsupported", reason: "read-only-viewer" },
    calculate: input.format === "xlsx"
      ? { status: "unverified", reason: "stored-formula-values-only" }
      : { status: "unsupported", reason: "not-applicable" },
    export: input.format === null
      ? { status: "unsupported", reason: "format-unresolved" }
      : { status: "available", reason: "original-bytes-only" },
    nativeApp: input.nativeOpenAvailable
      ? { status: "available", reason: "native-open-available" }
      : { status: "unsupported", reason: "native-open-unavailable" },
  };
}

const FORMAT_BY_EXTENSION: Record<string, OfficeFormat> = {
  pdf: "pdf", docx: "docx", xlsx: "xlsx", pptx: "pptx", hwp: "hwp", hwpx: "hwpx",
};

const FORMAT_BY_MIME: Record<string, OfficeFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/x-hwpx": "hwpx",
};

export interface OfficeFormatResolution {
  format: OfficeFormat | null;
  evidence: "extension" | "mime" | "signature" | "unresolved";
  reason: "resolved" | "signature-conflict" | "ambiguous-hwp-container" | "unsupported-format";
  needsSignature: boolean;
}

function signatureKind(signature: Uint8Array | undefined): "pdf" | "ole" | "zip" | null {
  if (!signature || signature.byteLength < 4) return null;
  if (signature[0] === 0x25 && signature[1] === 0x50 && signature[2] === 0x44 && signature[3] === 0x46) return "pdf";
  if (signature.byteLength >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => signature[index] === byte)) return "ole";
  if (signature[0] === 0x50 && signature[1] === 0x4b && [0x03, 0x05, 0x07].includes(signature[2]) && [0x04, 0x06, 0x08].includes(signature[3])) return "zip";
  return null;
}

export function resolveOfficeFormat(name: string, mimeType?: string, signature?: Uint8Array): OfficeFormatResolution {
  const extension = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? "";
  const byExtension = FORMAT_BY_EXTENSION[extension];
  const mime = mimeType?.trim().toLowerCase() ?? "";
  const signatureType = signatureKind(signature);
  if (byExtension) {
    const conflict = (byExtension === "hwp" && signatureType === "zip")
      || (byExtension === "hwpx" && signatureType === "ole")
      || (byExtension === "pdf" && signatureType && signatureType !== "pdf")
      || (["docx", "xlsx", "pptx", "hwpx"].includes(byExtension) && signatureType && signatureType !== "zip");
    return conflict
      ? { format: null, evidence: "unresolved", reason: "signature-conflict", needsSignature: false }
      : { format: byExtension, evidence: "extension", reason: "resolved", needsSignature: false };
  }
  if (mime === "application/x-hwp") {
    if (signatureType === "ole") return { format: "hwp", evidence: "signature", reason: "resolved", needsSignature: false };
    if (signatureType === "zip") return { format: null, evidence: "unresolved", reason: "ambiguous-hwp-container", needsSignature: false };
    return { format: null, evidence: "unresolved", reason: "ambiguous-hwp-container", needsSignature: !signature };
  }
  const byMime = FORMAT_BY_MIME[mime];
  if (byMime) return { format: byMime, evidence: "mime", reason: "resolved", needsSignature: false };
  if (signatureType === "pdf") return { format: "pdf", evidence: "signature", reason: "resolved", needsSignature: false };
  return { format: null, evidence: "unresolved", reason: "unsupported-format", needsSignature: false };
}
