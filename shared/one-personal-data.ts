/** Personal data is bound to an exact editable local Page, never a browser tab. */
export const ONE_PERSONAL_DATA_SCHEMA = "agentlas.one-personal-data.v1" as const;
export interface PersonalDataTarget {
  deploymentId: string; oneId: string; scope: "personal" | "project" | "organization";
  organizationId: string | null; projectId: string | null;
  spaceId: string; pageId: string; audience: "owner" | "organization";
}
export interface PersonalDataSourceBinding {
  sourceId: string; connectorId: string; accountRef: string; permissionRevision: string;
  credentialGeneration: string; purpose: string; coverage: "history" | "bounded-search";
}
export interface PersonalDataSourceItem {
  id: string; revision: string; sourceRef: string; text: string; deleted: boolean;
}
export interface PersonalDataSourceBatch {
  sourceRevision: string; cursor: string | null; nextCursor: string | null;
  permissionRevision: string; credentialGeneration: string; observedAt: string;
  complete: boolean; items: PersonalDataSourceItem[];
}
export type PersonalDataSourceStatus = "unread" | "ready" | "partial" | "invalid_cursor" | "permission_changed" | "disconnected" | "paused" | "blocked";
export interface PersonalDataSourceState {
  target: PersonalDataTarget; binding: PersonalDataSourceBinding; cursor: string | null;
  sourceRevision: string | null; observedAt: string | null; status: PersonalDataSourceStatus;
  revision: number; reason: string | null;
}
export interface PersonalDataProvenance { occurrenceId: string; sourceRevision: string; observedAt: string; binding: PersonalDataSourceBinding }
export interface PersonalDataBlock { id: string; kind: "manual" | "inference"; text: string; sourceRefs: string[]; provenance?: PersonalDataProvenance }
export interface PersonalDataTaskAnchor {
  commandId: string; taskId: string; runId: string; controlVersion: string;
  chatId?: string;
  artifactId: string; artifactRevision: string; artifactDigest: string;
}
export interface PersonalDataPageRevision {
  target: PersonalDataTarget; revision: number; title: string; blocks: PersonalDataBlock[];
  digest: string; updatedAt: string; origin: "create" | "manual" | "proposal";
  acceptedAnchor: PersonalDataTaskAnchor | null;
}
export interface PersonalDataSpaceLink { kind: "page" | "conversation" | "file"; ref: string; label: string }
export interface PersonalDataSpace { spaceId: string; revision: number; links: PersonalDataSpaceLink[] }
export interface PersonalDataProposal {
  proposalId: string; target: PersonalDataTarget; baseRevision: number; blocks: PersonalDataBlock[];
  anchor: PersonalDataTaskAnchor; sourceBindings: PersonalDataSourceBinding[];
  status: "pending" | "accepted" | "cancelled"; createdAt: string; acceptedRevision: number | null;
}
export interface PersonalDataWriteReceipt {
  commandId: string; target: PersonalDataTarget; revision: number; digest: string;
  readBackVerified: true; page: PersonalDataPageRevision;
}
export interface PersonalDataCollectionReceipt {
  occurrenceId: string | null; source: PersonalDataSourceState;
  supervisor: import("./one-supervisor").SupervisorCommandReceipt | null;
}
export interface PersonalDataSnapshot {
  schema: typeof ONE_PERSONAL_DATA_SCHEMA; target: PersonalDataTarget;
  page: PersonalDataPageRevision | null; space: PersonalDataSpace | null;
  sources: PersonalDataSourceState[]; proposals: PersonalDataProposal[];
}
export interface PersonalDataCreateInput { commandId: string; target: PersonalDataTarget; title: string; text: string }
export interface PersonalDataEditInput { commandId: string; target: PersonalDataTarget; expectedRevision: number; title: string; text: string }
export interface PersonalDataCollectInput { target: PersonalDataTarget; sourceId: string; budgetId: string }
export interface PersonalDataAcceptInput { commandId: string; target: PersonalDataTarget; proposalId: string; expectedRevision: number }
export interface PersonalDataFollowUpInput { commandId: string; target: PersonalDataTarget; expectedRevision: number; anchor: PersonalDataTaskAnchor; text: string }
export interface OnePersonalDataAPI {
  snapshot(input: { target: PersonalDataTarget }): Promise<PersonalDataSnapshot>;
  create(input: PersonalDataCreateInput): Promise<PersonalDataWriteReceipt>;
  edit(input: PersonalDataEditInput): Promise<PersonalDataWriteReceipt>;
  collect(input: PersonalDataCollectInput): Promise<PersonalDataCollectionReceipt>;
  sourceControl(input: { target: PersonalDataTarget; sourceId: string; action: "pause" | "resume" | "disconnect" | "reset-cursor"; expectedRevision: number }): Promise<PersonalDataSourceState>;
  accept(input: PersonalDataAcceptInput): Promise<PersonalDataWriteReceipt>;
  cancelProposal(input: { target: PersonalDataTarget; proposalId: string }): Promise<PersonalDataProposal>;
  rebaseProposal(input: { target: PersonalDataTarget; proposalId: string; expectedRevision: number }): Promise<PersonalDataProposal>;
  cancelInference(input: { commandId: string; target: PersonalDataTarget; occurrenceId: string; runId: string; expectedControlVersion: string }): Promise<import("./one-supervisor").SupervisorCommandReceipt>;
  followUp(input: PersonalDataFollowUpInput): Promise<import("./one-supervisor").SupervisorCommandReceipt>;
}
