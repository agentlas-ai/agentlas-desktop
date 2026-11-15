/**
 * The one Alive type still shared: the exact held attempt an owner's reviewed action may release (Science's Alive core,
 * electron/alive-core/owner-resume.ts). The One/Work Alive switch, its IPC contract and its token grant are gone.
 */
export interface AliveResumeBarrier {
  agentId:string; agentVersion:number; controlEpoch:number; wakeId:string;
  settledSequence:number; latestSequence:number; receiptDigest:string; errorCode:string;
  goalBinding?: {goalId:string;runId:string;runVersion:number};
}
