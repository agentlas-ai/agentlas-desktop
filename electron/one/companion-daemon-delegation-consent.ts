import {dialog} from "electron";
import {companionDaemonDelegationBytes,type CompanionDaemonDelegation} from "../../shared/companion-daemon-delegation";
import {issueCompanionDaemonDelegationConsentPermit} from "./companion-daemon-delegation-permit";

const label=(x:unknown):x is string=>typeof x==="string"&&x.trim().length>0&&x.length<=80&&!/[\p{Cs}\p{Cf}\u0000-\u001f\u007f]/u.test(x);
/** Main attestation proves the target, not consent. The exact target must be
 * re-attested after the person agrees and again at one-use signing. */
export async function requestCompanionDaemonDelegationConsent(options:{binding:unknown;guiKeyFingerprint:string;assertCurrent():void;
  deviceLabel():string;agentName():string;locale:"ko"|"en";attest(binding:CompanionDaemonDelegation):Promise<string|null>;verifyAttestation(token:string,binding:CompanionDaemonDelegation):boolean}):Promise<object|null>{
  try{
    companionDaemonDelegationBytes("gui",options.binding);const binding=structuredClone(options.binding) as CompanionDaemonDelegation;
    Object.freeze(binding.scope);Object.freeze(binding);
    if(!/^[a-f0-9]{64}$/.test(options.guiKeyFingerprint))return null;
    const device=options.deviceLabel(),agent=options.agentName();if(!label(device)||!label(agent))return null;
    const current=()=>{const value=options.assertCurrent() as unknown;if(value!==undefined){if(value&&typeof(value as {then?:unknown}).then==="function")void Promise.resolve(value).catch(()=>{});throw Error("daemon_consent_owner_invalid");}
      if(options.deviceLabel()!==device||options.agentName()!==agent)throw Error("daemon_consent_target_changed");};
    const evidence=async()=>{current();const token=await options.attest(binding);current();return typeof token==="string"&&options.verifyAttestation(token,binding)===true?token:null;};
    if(!await evidence())return null;
    const scopes=binding.scope.map(s=>options.locale==="ko"?(s==="front"?"개인 대화":"Work 작업"):(s==="front"?"personal conversations":"Work tasks")).join(options.locale==="ko"?", ":" and ");
    const answer=await dialog.showMessageBox({type:"question",buttons:options.locale==="ko"?["취소","허용"]:["Cancel","Allow"],defaultId:0,cancelId:0,noLink:true,
      title:options.locale==="ko"?"백그라운드 연결 허용":"Allow background connection",
      message:options.locale==="ko"?`${device}의 ${agent}가 요청하면 앱 창이 닫혀도 이 컴퓨터에서 ${scopes}을 처리하도록 허용할까요?`:`Allow ${agent} on ${device} to handle ${scopes} on this computer while the app window is closed?`,
      detail:options.locale==="ko"?"연결된 기기와 계정에만 적용됩니다.":"This applies only to the connected device and account."});
    current();if(answer.response!==1)return null;const token=await evidence();if(!token)return null;current();
    return issueCompanionDaemonDelegationConsentPermit({binding,guiKeyFingerprint:options.guiKeyFingerprint,assertCurrent(){current();if(options.verifyAttestation(token,binding)!==true)throw Error("daemon_consent_attestation_expired");}});
  }catch{return null;}
}
