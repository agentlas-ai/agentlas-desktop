import type {PersonalDataTarget} from './one-personal-data';
/** Native selectors and readback metadata only. None of these values is authority. */
export interface HistoryWorkSelection {target:PersonalDataTarget}
export interface HistoryWorkCandidateSelection extends HistoryWorkSelection {candidateId:string;expectedRevision:number}
export interface HistoryWorkStatus {
 schema:'agentlas.personal.history-work-status.v1';target:PersonalDataTarget;
 state:'unregistered'|'registered'|'oracle-required'|'revoked'|'unknown';
 sources:Array<{agentId:string;label:string}>;registrationId:string|null;
 oracleReady:boolean;candidateIds:string[];operations:Array<{operationId:string;candidateId:string;state:'started'|'applying'|'applied'|'unknown'|'cancelled';newRevisionId:string|null}>;
}
export const HISTORY_WORK_DRAFT_TOOL='history_work_draft';
export const HISTORY_WORK_APPLY_TOOL='history_work_apply';
export const HISTORY_WORK_LINEAGE='explicit-personal-history-file-acceptance';
