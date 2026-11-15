import { dialog } from "electron";
import type { KeyObject } from "node:crypto";
import { companionContinuityBytes, type CompanionContinuityBinding } from "../../shared/companion-continuity-proof";
import { issueContinuityConsentPermit } from "./companion-continuity-permit";
import { createContinuityAttestationVerifier, takeContinuityAttestation, type ContinuityTarget } from "./companion-continuity-attestation";

const label=(s:unknown):s is string=>typeof s==="string" && s.trim().length>0 && s.length<=80 && !/[\p{Cs}\p{Cf}\u0000-\u001f\u007f]/u.test(s);
/** This only authorizes checking continuity. It never merges, edits or deletes
 * a profile or memory. Both attestations are separately verified; the second
 * must still be valid after the real desktop confirmation. */
export async function requestCompanionContinuityConsent(options:{binding:unknown;publicKey:KeyObject;target():ContinuityTarget|null;
  assertCurrent():void;deviceLabel():string;agentName():string;locale:"ko"|"en";attest(binding:CompanionContinuityBinding):Promise<string|null>}):Promise<object|null> {
  try {
    companionContinuityBytes("desktop-consent",options.binding);
    const binding=structuredClone(options.binding) as CompanionContinuityBinding;
    Object.freeze(binding.scope);Object.freeze(binding);
    const device=options.deviceLabel(),agent=options.agentName();if(!label(device) || !label(agent))return null;
    const current=()=>{options.assertCurrent();if(options.deviceLabel()!==device || options.agentName()!==agent)throw new Error("continuity_consent_target_changed");};
    const verify=createContinuityAttestationVerifier({publicKey:options.publicKey,target:options.target,assertCurrent:current});
    const evidence=async()=>{current();const token=await options.attest(binding);current();const capability=verify(token),verified=takeContinuityAttestation(capability);
      if(!verified || verified.deviceGeneration!==binding.deviceGeneration ||
        (["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","hostId","oneId","approvalId","challenge"] as const)
          .some(field=>verified.target[field]!==binding[field]) || JSON.stringify(verified.target.scope)!==JSON.stringify(binding.scope))return null;
      return verified;};
    if(!await evidence())return null;
    const scopes=binding.scope.map(value=>options.locale==="ko" ? (value==="memory"?"개인 기억":"프로필") : (value==="memory"?"personal memory":"profile")).join(options.locale==="ko"?", ":" and ");
    const answer=await dialog.showMessageBox({type:"question",buttons:options.locale==="ko"?["취소","허용"]:["Cancel","Allow"],defaultId:0,cancelId:0,noLink:true,
      title:options.locale==="ko"?"휴대폰 연결 확인":"Connect your phone",
      message:options.locale==="ko"?`${device}에서 ${agent}의 ${scopes} 연결을 확인할까요?`:`Allow ${device} to check ${agent}'s ${scopes} connection?`,
      detail:options.locale==="ko"?"이 단계에서는 기존 정보를 복사하거나 변경하지 않습니다.":"This step does not copy or change your existing information."});
    current();if(answer.response!==1)return null;
    const verified=await evidence();if(!verified)return null;verified.assertCurrent();current();
    return issueContinuityConsentPermit({binding,deviceKeyFingerprint:verified.target.deviceKeyFingerprint,
      assertCurrent:()=>{current();verified.assertCurrent();}});
  }catch{return null;}
}
