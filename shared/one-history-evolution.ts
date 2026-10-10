import type { PersonalDataTarget, PersonalDataTaskAnchor, PersonalDataWriteReceipt } from "./one-personal-data";
export const ONE_HISTORY_EVOLUTION_SCHEMA="agentlas.one-history-evolution.v1" as const;
export interface HistoryEvolutionObservation {
  id:string; revision:string; sourceId:string; sourceRef:string; observedAt:string; permissionRevision:string;
  consentRevision:string; environmentRevision:string; interface:"work-session"|"application"|"erp-api"|"erp-ui";
  summary:string; sensitiveFieldsRemoved:true;
}
export interface ProcessBinding {
  schema:"agentlas.process-binding.v1"; environmentRevision:string; interface:HistoryEvolutionObservation["interface"];
  preconditions:string[]; inputs:string[]; outputs:string[]; manualJudgments:string[];
  checks:string[]; toolRefs:string[]; resourceRefs:string[]; sourceRevisions:Array<{sourceRef:string;revision:string}>;
}
export interface EvolutionEnvelope {
  policyRevision:string; sourceIds:string[]; toolRefs:string[]; resourceRefs:string[]; budgetId:string;
  maxObservations:number; retentionMs:number; allowedKinds:Array<"skill"|"toolchain"|"agent">;
  automaticPromotion:false;
}
export interface HistoryEvolutionDraft {
  kind:"skill"|"toolchain"|"agent"; assetId:string; versionId:string; digest:string;
  producer:"plugin-builder"|"agent-workspace"|"toolchain-learner";
  proposalRef?:string;
  process:ProcessBinding; toolRefs:string[]; resourceRefs:string[];
  /** Safe file/version references only; secrets and global approval directives are not stored here. */
  changeRefs:string[];
}
export interface HistoryEvolutionEvaluation {
  draftDigest:string; envelopeDigest:string; oracleId:string; oracleRevision:string; fixtureDigest:string;
  resultDigest:string; passed:boolean; isolated:true; networkAccess:false; providerCalls:0;
}
export interface HistoryEvolutionCandidate {
  schema:typeof ONE_HISTORY_EVOLUTION_SCHEMA; candidateId:string; target:PersonalDataTarget; revision:number;
  status:"observed"|"drafting"|"draft"|"evaluated"|"accepted"|"running"|"feedback"|"paused"|"revoked"|"deleted"|"unknown";
  observations:HistoryEvolutionObservation[]; envelope:EvolutionEnvelope;
  draft:HistoryEvolutionDraft|null; evaluation:HistoryEvolutionEvaluation|null;
  generationCommandId:string|null; runCommandId:string|null; anchor:PersonalDataTaskAnchor|null;
  feedback:PersonalDataWriteReceipt|null; predecessorId:string|null; createdAt:string; reason:string|null;
}
export interface HistoryEvolutionSnapshot { schema:typeof ONE_HISTORY_EVOLUTION_SCHEMA; target:PersonalDataTarget; candidates:HistoryEvolutionCandidate[] }
export interface OneHistoryEvolutionAPI {
  snapshot(input:{target:PersonalDataTarget}):Promise<HistoryEvolutionSnapshot>;
  draft(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;commandId:string}):Promise<HistoryEvolutionCandidate>;
  evaluate(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number}):Promise<HistoryEvolutionCandidate>;
  accept(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;reviewedHash:string;approvalId:string}):Promise<HistoryEvolutionCandidate>;
  run(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;commandId:string}):Promise<HistoryEvolutionCandidate>;
  control(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;action:"pause"|"resume"|"revoke"|"delete";commandId?:string;expectedControlVersion?:string}):Promise<HistoryEvolutionCandidate>;
  restore(input:{target:PersonalDataTarget;candidateId:string;expectedRevision:number;versionId:string}):Promise<HistoryEvolutionCandidate>;
}
