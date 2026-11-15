import {companionDaemonDelegationBytes,type CompanionDaemonDelegation} from "../../shared/companion-daemon-delegation";

type Permit={binding:CompanionDaemonDelegation;assertCurrent():void};
const permits=new WeakMap<object,Permit>();
const sync=(fn:()=>void)=>{const v=fn() as unknown;if(v!==undefined){if(v&&typeof(v as {then?:unknown}).then==="function")void Promise.resolve(v).catch(()=>{});throw Error("daemon_possession_owner_invalid");}};
/** This proves only daemon-key possession. It does not approve delegation;
 * the native caller must bind the exact authenticated GUI channel, account,
 * registered device and One in assertCurrent before issuing this permit. */
export function createCompanionDaemonPossessionPermit(binding:unknown,assertCurrent:(binding:CompanionDaemonDelegation)=>void):object|null{
  try{companionDaemonDelegationBytes("possession",binding);if(typeof assertCurrent!=="function")return null;
    const fixed=structuredClone(binding) as CompanionDaemonDelegation;Object.freeze(fixed.scope);Object.freeze(fixed);
    const guard=()=>sync(()=>assertCurrent(fixed));guard();const value=Object.freeze({});permits.set(value,{binding:fixed,assertCurrent:guard});return value;
  }catch{return null;}
}
export function takeCompanionDaemonPossessionPermit(value:unknown):Permit|null{
  if(!value||typeof value!=="object")return null;const permit=permits.get(value);permits.delete(value);if(!permit)return null;
  try{permit.assertCurrent();return permit}catch{return null;}
}
