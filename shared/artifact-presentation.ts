/** Presentation data cannot contain actions or grant capabilities. */
export interface ArtifactPresentationState {
  schemaVersion: 1;
  fields: Array<{
    key: string;
    tag: "INPUT" | "TEXTAREA" | "SELECT";
    type: string;
    value: string;
    checked?: boolean;
    selectionStart: number | null;
    selectionEnd: number | null;
  }>;
  focus: string | null;
  scroll: { x: number; y: number };
}

export interface ArtifactPresentationReceipt {
  schemaVersion: "agentlas.artifact-presentation.v1";
  appId: string;
  sourceIdentityDigest: string;
  originBundleDigest: string;
  revision: number;
  stateDigest: string;
  requestId: string;
  state: ArtifactPresentationState;
  updatedAt: string;
}

export type ArtifactPresentationWriteResult =
  | { status: "saved"; receipt: ArtifactPresentationReceipt }
  | { status: "conflict"; current: ArtifactPresentationReceipt | null };
