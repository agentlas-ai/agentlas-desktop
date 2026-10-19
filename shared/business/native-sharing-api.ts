import type {EmployeeAgentTransferAPI} from './employee-agent-transfer';
import type {BusinessNativeIdentity,BusinessNativeCustodyReceipt} from './native-sharing-wire';
/** Selectors and bounded reviewed text only. Main retains authentication, keys,
 * original receipts, approval capabilities and all effect authority. */
export interface BusinessNativeSharingAPI extends EmployeeAgentTransferAPI {
 identity():Promise<BusinessNativeIdentity>;
 completedWork():Promise<readonly {commandId:string;taskId:string;runId:string;title:string|null}[]>;
 approveAssociation(input:{challengeId:string}):Promise<{state:'associated';associationId:string;associationRevision:number}|{state:'unknown';approvalReceiptId:string}>;
 reconcileAssociation(input:{approvalReceiptId:string}):Promise<{state:'associated';associationId:string}>;
 shareCompletedResult(input:{commandId:string;agentResourceId:string;sourceResourceId:string;summary:string;expectedRevision:number|null}):Promise<{state:'accepted';acceptanceId:string;delivery:'pending'}>;
 receipt(input:{acceptanceId:string}):Promise<{state:'custody-confirmed';receipt:BusinessNativeCustodyReceipt;publication:'published'|'awaiting-enrollment'|'unknown';registrationSelector?:{readonly packetId:string;readonly packetRevision:string}}|{state:'unknown'}|{state:'accepted';delivery:'not-dispatched'}>;
 continuePublication(input:{acceptanceId:string}):Promise<{publication:'published'|'awaiting-enrollment'|'unknown'}>;
 revoke():Promise<{state:'revoked';receipt:unknown}|{state:'unknown'}>;
}
