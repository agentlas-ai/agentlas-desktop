import { dialog } from "electron";
import type { KeyObject } from "node:crypto";
import { companionFrontTransferBytes, type CompanionFrontTransferBinding } from "../../shared/companion-front-transfer-proof";
import { issueFrontTransferConsentPermit } from "./companion-front-transfer-permit";
import { createFrontTransferAttestationVerifier, takeFrontTransferAttestation, type FrontTransferTarget } from "./companion-front-transfer-attestation";

const label=(s:unknown):s is string=>typeof s==="string" && s.trim().length>0 && s.length<=80 && !/[\p{Cs}\p{Cf}\u0000-\u001f\u007f]/u.test(s);
/** The owner explicitly grants the selected transfer scope. This does not
 * merge or edit existing profiles or memories. A fresh attestation is required
 * after the confirmation before a single-use signing permit is created. */
export async function requestCompanionFrontTransferConsent(options:{binding:unknown;publicKey:KeyObject;target():FrontTransferTarget|null;
  assertCurrent():void;deviceLabel():string;agentName():string;locale:"ko"|"en";attest(binding:CompanionFrontTransferBinding):Promise<string|null>}):Promise<object|null> {
  try {
    companionFrontTransferBytes("desktop-consent",options.binding);
    const binding=structuredClone(options.binding) as CompanionFrontTransferBinding;
    Object.freeze(binding.scope);Object.freeze(binding);
    const device=options.deviceLabel(),agent=options.agentName();if(!label(device) || !label(agent))return null;
    const current=()=>{const result=options.assertCurrent() as unknown;if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});throw new Error("front_transfer_owner_not_synchronous");}if(options.deviceLabel()!==device || options.agentName()!==agent)throw new Error("front_transfer_consent_target_changed");};
    const verify=createFrontTransferAttestationVerifier({publicKey:options.publicKey,target:options.target,assertCurrent:current});
    const evidence=async()=>{current();const token=await options.attest(binding);current();const capability=verify(token),verified=takeFrontTransferAttestation(capability);
      if(!verified || verified.deviceGeneration!==binding.deviceGeneration ||
        (["userId","workspaceId","authEpoch","accountSubject","familyId","deviceId","hostId","oneId","approvalId","challenge"] as const)
          .some(field=>verified.target[field]!==binding[field]) || JSON.stringify(verified.target.scope)!==JSON.stringify(binding.scope))return null;
      return verified;};
    if(!await evidence())return null;
    const scopes=binding.scope.map(value=>options.locale==="ko" ? (value==="conversation"?"대화":value==="memory"?"개인 기억":"프로필") : (value==="conversation"?"conversation":value==="memory"?"personal memory":"profile")).join(options.locale==="ko"?", ":" and ");
    const answer=await dialog.showMessageBox({type:"question",buttons:options.locale==="ko"?["취소","허용"]:["Cancel","Allow"],defaultId:0,cancelId:0,noLink:true,
      title:options.locale==="ko"?"컴퓨터로 대화 이어가기":"Continue conversations on this computer",
      message:options.locale==="ko"?`${device}의 ${agent}가 요청할 때 ${scopes}를 이 컴퓨터에 전달하도록 허용할까요?`:`Allow ${agent} on ${device} to send ${scopes} to this computer when needed?`,
      detail:options.locale==="ko"?"사진과 파일은 전달하지 않습니다. 기존 프로필이나 기억을 덮어쓰지 않습니다.":"Photos and files are not transferred. Existing profiles and memories are not overwritten."});
    current();if(answer.response!==1)return null;
    const verified=await evidence();if(!verified)return null;verified.assertCurrent();current();
    return issueFrontTransferConsentPermit({binding,deviceKeyFingerprint:verified.target.deviceKeyFingerprint,
      assertCurrent:()=>{current();verified.assertCurrent();}});
  }catch{return null;}
}
