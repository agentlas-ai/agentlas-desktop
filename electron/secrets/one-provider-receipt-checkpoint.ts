import {OneProviderError,type OneProviderReceipt} from '../../shared/one-provider';
import type {MediaOperationRecord} from '../../shared/media-operation';
import type {patchMediaOperation} from '../store/media-operations';
import type {OneVaultSqlite} from './one-vault-journal';
import {oneVaultDigest} from './one-vault-crypto';
export type OneProviderReadMedia=Pick<MediaOperationRecord,'id'|'version'|'inputDigest'|'lifecycle'|'cancellation'|'providerCheckpoint'|'result'>;
export const oneProviderUnsettled=(row:OneProviderReadMedia|null):boolean=>!!row&&['submitting','provider_accepted','running','verifying','outcome_unknown'].includes(row.lifecycle);
/** SAME store/DB checkpoint, no transition, dispatch, receipt re-signing, timer or retry.
 * A prepared command or unclaimed submit_intent does not establish an uncertain dispatch. */
export function checkpointOneProviderUnknownReceipt(db:OneVaultSqlite,store:{getMediaOperation(id:string):OneProviderReadMedia|null;patchMediaOperation?:typeof patchMediaOperation},expected:Readonly<OneProviderReadMedia>,receipt:Readonly<OneProviderReceipt>,current:()=>boolean):OneProviderReadMedia {
 if(!store.patchMediaOperation||!oneProviderUnsettled(expected)||receipt.state!=='outcome_unknown'||receipt.audio!==null||receipt.operationId!==expected.id||receipt.actionDigest!==expected.inputDigest)throw new OneProviderError('authority_unavailable');
 const patch=store.patchMediaOperation,expectedDigest=oneVaultDigest(expected),receiptDigest=oneVaultDigest(receipt);
 try{return db.transaction(()=>{
  if(!current())throw new OneProviderError('authority_denied');
  const row=store.getMediaOperation(expected.id);
  if(!row||oneVaultDigest(row)!==expectedDigest||!oneProviderUnsettled(row))throw new OneProviderError('operation_conflict');
  const prior=row.providerCheckpoint;
  if(row.result||prior!==null&&(typeof prior!=='object'||Array.isArray(prior)||Object.getPrototypeOf(prior)!==Object.prototype)||(prior as {oneProviderReceipt?:unknown}|null)?.oneProviderReceipt)throw new OneProviderError('operation_conflict');
  patch({id:row.id,expectedVersion:row.version,patch:{providerCheckpoint:{...(prior as Record<string,unknown>|null),oneProviderReceipt:structuredClone(receipt)}},reasonCode:'one_provider_unsettled_receipt'});
  const stored=store.getMediaOperation(row.id),actual=(stored?.providerCheckpoint as {oneProviderReceipt?:unknown}|null)?.oneProviderReceipt;
  if(!stored||stored.version!==row.version+1||stored.lifecycle!==row.lifecycle||stored.cancellation!==row.cancellation||stored.inputDigest!==row.inputDigest||oneVaultDigest(actual)!==receiptDigest)throw new OneProviderError('operation_conflict');
  if(!current())throw new OneProviderError('authority_denied');
  return stored;
 }).immediate();}catch(e){throw e instanceof OneProviderError?e:new OneProviderError('provider_uncertain');}
}
