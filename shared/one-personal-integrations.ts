import type {PersonalDataTarget,PersonalDataProposal} from './one-personal-data';
import type {HistoryEvolutionCandidate,HistoryEvolutionSnapshot} from './one-history-evolution';
export interface GmailNativeSelection {serverId:string;expectedAccountRef:string;target:PersonalDataTarget;budgetId:string;query:string;labelIds:string[];allowMessageBody:boolean;allowHistory:boolean;purpose:string}
export interface GmailConsentState {consentId:string;revision:number;status:'proposal'|'approved'|'paused'|'revoked';sourceId:string|null;target:PersonalDataTarget;intake:{revision:number;enabled:boolean}|null}
export interface GmailNativeCatalogEntry {serverId:string;label:string;enabled:boolean;availability:'review-required'|'permission-required';consents:GmailConsentState[];/** Only Main-current permitted selection, never user-authored resource grants. Missing means unavailable. */selections:GmailNativeSelection[]}
export interface GmailNativeReceipt {consentId:string;revision:number;status:GmailConsentState['status'];sourceId:string|null;sourceStatus:string|null}
type ConsentInput={consentId:string;expectedRevision:number};
type CandidateInput={target:PersonalDataTarget;candidateId:string;expectedRevision:number};
export interface OnePersonalIntegrationsNativeAPI {
 gmailCatalog():Promise<GmailNativeCatalogEntry[]>;
 gmailPropose(input:GmailNativeSelection&{commandId?:string}):Promise<GmailNativeReceipt>;
 gmailApprove(input:ConsentInput):Promise<GmailNativeReceipt>;
 gmailRegister(input:ConsentInput):Promise<GmailNativeReceipt>;
 gmailPause(input:ConsentInput):Promise<GmailNativeReceipt>;
 gmailRevoke(input:ConsentInput):Promise<GmailNativeReceipt>;
 gmailResume(input:ConsentInput):Promise<GmailNativeReceipt>;
 gmailIntake(input:ConsentInput&{subscriptionRevision:number;enabled:boolean}):Promise<{subscriptionId:string;revision:number;enabled:boolean}>;
 historySnapshot(input:{target:PersonalDataTarget}):Promise<HistoryEvolutionSnapshot>;
 historyObserve(input:{target:PersonalDataTarget;predecessorId?:string}):Promise<HistoryEvolutionCandidate>;
 historyDraft(input:CandidateInput&{commandId:string}):Promise<HistoryEvolutionCandidate>;
 historyCollectDraft(input:CandidateInput):Promise<HistoryEvolutionCandidate>;
 historyEvaluate(input:CandidateInput):Promise<HistoryEvolutionCandidate>;
 historyAccept(input:CandidateInput):Promise<HistoryEvolutionCandidate>;
 historyRun(input:CandidateInput&{commandId:string}):Promise<HistoryEvolutionCandidate>;
 historyProposeFeedback(input:CandidateInput):Promise<PersonalDataProposal>;
 historyAcceptFeedback(input:CandidateInput&{proposalId:string;expectedPageRevision:number;commandId:string}):Promise<HistoryEvolutionCandidate>;
 historyReconcileFeedback(input:CandidateInput):Promise<HistoryEvolutionCandidate>;
 historyControl(input:CandidateInput&{action:'pause'|'resume'|'revoke'|'delete';commandId?:string;expectedControlVersion?:string}):Promise<HistoryEvolutionCandidate>;
 historyRestore(input:CandidateInput&{versionId:string}):Promise<HistoryEvolutionCandidate>;
}
