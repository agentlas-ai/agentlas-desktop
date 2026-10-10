import {OneVaultError,type OneVaultRequest,type OneVaultEnvelope,type OneVaultStatusQuery,type OneVaultReceipt} from '../../shared/one-vault';
import {validateOneVaultStatus,verifyOneVaultStatusReceipt} from './one-vault-crypto';
/** Reference ciphertext-only consumer. Mobile's native consumer must apply equivalent pending
 * query checks after its own independent admission. This does not supply native Mobile trust. */
export class OneMobileFreshStatusConsumer {
 private pending:OneVaultStatusQuery|null=null;
 private readonly used=new Set<string>();
 private readonly request:OneVaultRequest;
 private readonly envelope:OneVaultEnvelope;
 constructor(request:OneVaultRequest,envelope:OneVaultEnvelope,private readonly hostPublicKey:string,private readonly senderPublicKey:string,private readonly stillCurrent:()=>boolean,private readonly now:()=>number=Date.now){this.request=structuredClone(request);this.envelope=structuredClone(envelope);}
 expect(query:OneVaultStatusQuery):void{
  if(!this.stillCurrent()||this.used.has(query.nonce)||this.used.size>=256)throw new OneVaultError('secure_route_unavailable');
  validateOneVaultStatus(query,this.request,this.senderPublicKey,this.now());
  if(query.operationId!==this.envelope.operationId)throw new OneVaultError('replay_conflict');
  this.used.add(query.nonce);this.pending=structuredClone(query);
 }
 accept(receipt:OneVaultReceipt):boolean{
  const q=this.pending;if(!q||!this.stillCurrent())return false;
  if(!verifyOneVaultStatusReceipt(receipt,this.request,this.envelope,this.hostPublicKey,q,this.senderPublicKey,this.now()))return false;
  this.pending=null;return true;
 }
 close():void{this.pending=null;}
}
