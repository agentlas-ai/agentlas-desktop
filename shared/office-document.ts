export const OFFICE_DOCUMENT_SESSION_VERSION = "agentlas.office-document-session.v1" as const;
export const OFFICE_TASK_SELECTION_VERSION = "agentlas.office-task-selection.v1" as const;
export const OFFICE_EDIT_INTENT_VERSION = "agentlas.office-edit-intent.v1" as const;

export type OfficeFormat = "pdf" | "docx" | "xlsx" | "pptx" | "hwp" | "hwpx";
export type OfficeCapabilityName = "read" | "structure" | "render" | "edit" | "calculate" | "export" | "nativeApp";
export type OfficeCapabilityStatus = "verified" | "available" | "unverified" | "unsupported";

export interface OfficeCapabilityVerdict {
  status: OfficeCapabilityStatus;
  reason:
    | "viewer-ready"
    | "viewer-loading"
    | "viewer-failed"
    | "structured-renderer"
    | "read-only-viewer"
    | "stored-formula-values-only"
    | "not-applicable"
    | "original-bytes-only"
    | "native-open-available"
    | "native-open-unavailable"
    | "format-unresolved";
}

export type OfficeCapabilities = Record<OfficeCapabilityName, OfficeCapabilityVerdict>;

export interface MainArtifactRevision {
  sha256: string;
  binding: string;
  tabId: string;
  authority: "main-content-sha256";
}

export type OfficeSelectionAnchor =
  | { kind: "cell"; sheetName: string; address: string; displayValue: string; formula?: string; formulaState: "loading" | "ready" | "unavailable" }
  | { kind: "page"; pageNumber: number }
  | { kind: "slide"; slideNumber: number; title?: string }
  | { kind: "text"; text: string; pageNumber?: number; slideNumber?: number };

export interface OfficeTaskSelection {
  contractVersion: typeof OFFICE_TASK_SELECTION_VERSION;
  format: OfficeFormat;
  artifactRevision: MainArtifactRevision | null;
  anchor: OfficeSelectionAnchor;
  /** Local UI ordering only. This is never an artifact revision. */
  selectionSequence: number;
}

export interface OfficeEditIntent {
  contractVersion: typeof OFFICE_EDIT_INTENT_VERSION;
  operationId: string;
  artifactRevision: MainArtifactRevision;
  selection: OfficeTaskSelection & { artifactRevision: MainArtifactRevision };
  originalValue: string;
  replacementValue: string;
  /** Local draft ordering only. Main must still compare artifactRevision.sha256. */
  draftSequence: number;
}
