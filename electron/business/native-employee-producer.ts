import type {BusinessEmployeeAgentApprovedNativeOriginal} from './employee-agent-report-producer';
import type {BusinessEmployeeAgentReport,BusinessEmployeeAgentReportRequest} from '../../shared/business/employee-agent-report';
import type {BusinessNativeAssociation,BusinessNativeCustodyReceipt} from '../../shared/business/native-sharing-wire';
import {businessEmployeeAgentNativeDigest as digest} from './employee-agent-report-adapter';
export const BUSINESS_NATIVE_CUSTODY_PACKET='agentlas.business.native-custody.v2' as const;
export interface NativeEmployeeCustodyPacket {
 readonly schema:typeof BUSINESS_NATIVE_CUSTODY_PACKET;
 readonly acceptanceKind:'explicit-sharing-acceptance';readonly expectationId:string;
 readonly approved:{readonly schema:'agentlas.business.employee-agent-approved-packet.v1';readonly selector:{packetId:string;packetRevision:string};
  readonly original:Omit<BusinessEmployeeAgentApprovedNativeOriginal,'work'>&{readonly work:Omit<BusinessEmployeeAgentApprovedNativeOriginal['work'],'canonicalControlRevision'>};readonly report:BusinessEmployeeAgentReport};
 readonly associationId:string;readonly associationRevision:number;readonly sourceRevision:number;readonly consentRevision:number;readonly idempotencyKey:string;
}
export interface NativeEmployeeDelivery {
 readonly packet:NativeEmployeeCustodyPacket;readonly reportRequest:BusinessEmployeeAgentReportRequest;
 readonly state:'ready'|'attempted'|'unknown'|'settled';readonly receipt:BusinessNativeCustodyReceipt|null;
}
export interface NativeEmployeeCustodyOwners {
 readonly protocol:'agentlas.business.native-custody-producer.v2';
 subscribeAccepted(listener:(capability:object)=>void):()=>void;
 current(capability:object):Promise<boolean>;
 inspect(capability:object):Promise<NativeEmployeeDelivery|null>;
 beginAttempt(capability:object,packetDigest:string):Promise<boolean>;
 holdUnknown(capability:object):Promise<void>;
 settle(capability:object,result:Readonly<BusinessNativeCustodyReceipt>):Promise<boolean>;
 submit(capability:object,packet:Readonly<NativeEmployeeCustodyPacket>):Promise<BusinessNativeCustodyReceipt>;
 lookup(capability:object,packet:Readonly<NativeEmployeeCustodyPacket>):Promise<BusinessNativeCustodyReceipt>;
 currentResult(capability:object,result:Readonly<BusinessNativeCustodyReceipt>):Promise<boolean>;
 publish(capability:object):Promise<'published'|'awaiting-enrollment'|'unknown'>;
}
/** Native v2 performs no organization policy projection. Its opaque capability
 * comes from the genuine native acceptance transaction; Root independently
 * verifies current association/source/ACL inside final publication admission. */
export function createNativeEmployeeCustodyProducer(owners:NativeEmployeeCustodyOwners,lifetime:{signal:AbortSignal;current():boolean}){
 const names=['subscribeAccepted','current','inspect','beginAttempt','holdUnknown','settle','submit','lookup','currentResult','publish'] as const;
 const refs=names.map(name=>owners?.[name]);let closed=false,attached=false,unknown=false,release:(()=>void)|null=null;
 const active=new WeakMap<object,Promise<'published'|'awaiting-enrollment'|'unknown'|'denied'>>();
 function blocker(){return closed||unknown||owners?.protocol!=='agentlas.business.native-custody-producer.v2'||names.some((name,i)=>typeof owners[name]!=='function'||owners[name]!==refs[i])||lifetime.signal.aborted?'business_native_custody_producer_unavailable':null}
 async function check(capability:object){return !blocker()&&lifetime.current()&&await owners.current(capability)&&!blocker()&&lifetime.current()}
 async function receiveOriginal(capability:object):Promise<'published'|'awaiting-enrollment'|'unknown'|'denied'>{
  if(!await check(capability))return 'denied';const delivery=await owners.inspect(capability);if(!delivery||!await check(capability))return 'denied';
  const packet=structuredClone(delivery.packet);if(packet.schema!==BUSINESS_NATIVE_CUSTODY_PACKET||packet.acceptanceKind!=='explicit-sharing-acceptance')return 'denied';
  try{
   let result:BusinessNativeCustodyReceipt;
   if(delivery.state==='ready'){
    if(!await owners.beginAttempt(capability,digest(packet))||!await check(capability)){await owners.holdUnknown(capability);return 'unknown'}
    result=await owners.submit(capability,packet);
   }else result=await owners.lookup(capability,packet);
   if(!await check(capability)||result.schema!=='agentlas.business.native-sharing.v1'||result.kind!=='packet'||result.associationId!==packet.associationId||result.idempotencyKey!==packet.idempotencyKey||result.nativePacketDigest!==digest(packet.approved)||!await owners.currentResult(capability,result)||!await owners.settle(capability,result)){
    await owners.holdUnknown(capability);return 'unknown';
   }
   if(!await check(capability)||!await owners.currentResult(capability,result)||!await check(capability))return 'unknown';
   const publication=await owners.publish(capability);return await check(capability)?publication:'unknown';
  }catch{try{await owners.holdUnknown(capability)}catch{}return 'unknown'}
 }
 function receive(capability:object){if(!capability||typeof capability!=='object')return Promise.resolve('denied' as const);const prior=active.get(capability);if(prior)return prior;const pending=receiveOriginal(capability).catch(()=> 'unknown' as const).finally(()=>active.delete(capability));active.set(capability,pending);return pending;}
 function close(){closed=true;if(release){const stop=release;release=null;try{stop()}catch{unknown=true}}}
 return Object.freeze({blocker,receive,attach(){if(attached)return !blocker();if(blocker())return false;try{release=owners.subscribeAccepted(cap=>{void receive(cap)});if(typeof release!=='function'){unknown=true;return false}attached=true;lifetime.signal.addEventListener('abort',close,{once:true});return true}catch{unknown=true;return false}},close,
  cleanlyClosed:()=>closed&&!unknown&&release===null});
}
export function sameNativeEmployeeAssociation(a:BusinessNativeAssociation,packet:NativeEmployeeCustodyPacket){return a.associationId===packet.associationId&&a.associationRevision===packet.associationRevision&&a.sourceRevision===packet.sourceRevision&&a.consentRevision===packet.consentRevision&&a.state==='active';}
