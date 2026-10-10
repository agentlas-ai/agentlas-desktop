"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { OneVaultRequest, OneVaultEnvelope, OneVaultReceipt, OneVaultStatusQuery, OneVaultErrorCode, OneVaultRecoveryDescriptor } from "@shared/one-vault";
import { OneBottomSheet } from "./OneBottomSheet";
import styles from "./OneVaultRequestForm.module.css";

/** Local crypto adapter. seal receives the ephemeral field locally; only envelope reaches IPC. */
export interface OneVaultSecureChannel {
  authenticate(request: OneVaultRequest): Promise<boolean>;
  authenticateRecovery?(request:OneVaultRequest,recovery:OneVaultRecoveryDescriptor):Promise<boolean>;
  statusQueryRecovery?(request:OneVaultRequest,recovery:OneVaultRecoveryDescriptor):Promise<OneVaultStatusQuery>;
  verifyRecoveryReceipt?(request:OneVaultRequest,recovery:OneVaultRecoveryDescriptor,receipt:OneVaultReceipt,query:OneVaultStatusQuery):Promise<boolean>;
  seal(request: OneVaultRequest, operationId: string, action: "store" | "delete", value: string | null): Promise<OneVaultEnvelope>;
  submit(requestId: string, envelope: OneVaultEnvelope): Promise<OneVaultReceipt>;
  statusQuery(request: OneVaultRequest, envelope: OneVaultEnvelope): Promise<OneVaultStatusQuery>;
  reconcile(requestId: string, query: OneVaultStatusQuery): Promise<OneVaultReceipt>;
  verifyReceipt(request: OneVaultRequest, envelope: OneVaultEnvelope, receipt: OneVaultReceipt, expectedResponseNonce?: string | null): Promise<boolean>;
}
const errors: Record<OneVaultErrorCode, string> = {
  secure_route_unavailable:"안전한 저장 경로를 확인할 수 없습니다.", invalid_request:"요청 정보를 확인할 수 없습니다.",
  invalid_envelope:"암호화된 요청을 확인할 수 없습니다.", sender_untrusted:"이 기기의 신뢰 확인이 필요합니다.",
  host_mismatch:"대상 Desktop이 일치하지 않습니다.", request_expired:"요청 시간이 만료되었습니다.",
  authority_denied:"현재 계정에 필요한 권한이 없습니다.", authority_unavailable:"현재 권한을 확인할 수 없습니다.",
  revision_changed:"요청 또는 권한이 바뀌었습니다. 새 요청을 확인해 주세요.", replay_conflict:"중복 요청의 내용이 일치하지 않습니다.",
  generation_conflict:"저장된 키가 바뀌었습니다. 새 교체 요청이 필요합니다.", store_failed:"키 저장에 실패했습니다.",
  store_unknown:"저장 결과가 확인되지 않았습니다. 같은 작업의 상태를 확인해 주세요.",
  request_consumed:"이미 처리된 요청입니다. 상태를 확인해 주세요.", not_found:"해당 요청을 찾을 수 없습니다.",
};
function errorCode(error: unknown, fallback:OneVaultErrorCode="store_unknown"): OneVaultErrorCode {
  const code = error && typeof error === "object" && "code" in error ? (error as {code: unknown}).code : null;
  return typeof code === "string" && Object.hasOwn(errors,code) ? code as OneVaultErrorCode : fallback;
}
export interface OneVaultRequestFormProps {
  open: boolean; request: OneVaultRequest; recovery?:OneVaultRecoveryDescriptor|null; accountLabel: string;
  /** Changes for logout/account/org/host/authority changes, even when request props were cached. */
  currentBindingKey: string; sensitiveSurfaceReady: boolean; channel: OneVaultSecureChannel | null;
  onClose(reason: "cancelled" | "expired" | "background"): void;
  onStored(receipt: OneVaultReceipt): void;
  onRequestReplacement?(): void;
}
export function OneVaultRequestForm({open,request,recovery=null,accountLabel,currentBindingKey,sensitiveSurfaceReady,channel,onClose,onStored,onRequestReplacement}:OneVaultRequestFormProps) {
  const field=useRef<HTMLInputElement>(null);const epoch=useRef(0);const composing=useRef(false);const compositionEnded=useRef(0);
  const [filled,setFilled]=useState(false);const [trusted,setTrusted]=useState(false);const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<OneVaultErrorCode|null>(null);const [receipt,setReceipt]=useState<OneVaultReceipt|null>(null);
  const [pending,setPending]=useState<OneVaultEnvelope|null>(null);const [remaining,setRemaining]=useState(0);
  const binding=request.binding;const expiresAt=recovery?.expiresAt??request.expiresAt;const identity=JSON.stringify([currentBindingKey,request,recovery]);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  const clear=()=>{if(field.current)field.current.value="";setFilled(false);composing.current=false;};
  const close=(reason:"cancelled"|"expired"|"background")=>{++epoch.current;clear();setBusy(false);setTrusted(false);closeRef.current(reason);};
  useLayoutEffect(()=>{++epoch.current;clear();setBusy(false);setTrusted(false);setNotice(null);setReceipt(null);setPending(null);return()=>{++epoch.current;if(field.current)field.current.value="";};},[identity,open,sensitiveSurfaceReady]);
  useEffect(()=>{
    if(!open)return;const captured=epoch.current;
    const tick=()=>{setRemaining(Math.max(0,Math.ceil((expiresAt-Date.now())/1000)));if(Date.now()>=expiresAt)close("expired");};
    tick();const timer=window.setInterval(tick,1000);
    if(channel&&sensitiveSurfaceReady)void (recovery?channel.authenticateRecovery?.(request,recovery)??Promise.resolve(false):channel.authenticate(request)).then(ok=>{if(epoch.current===captured){setTrusted(ok);if(!ok)setNotice("secure_route_unavailable");}}).catch(error=>{if(epoch.current===captured)setNotice(errorCode(error,"secure_route_unavailable"));});
    const hidden=()=>{if(document.visibilityState==="hidden")close("background");};const pagehide=()=>close("background");window.addEventListener("pagehide",pagehide);document.addEventListener("visibilitychange",hidden);const blur=()=>close("background");window.addEventListener("blur",blur);
    return()=>{window.clearInterval(timer);window.removeEventListener("pagehide",pagehide);document.removeEventListener("visibilitychange",hidden);window.removeEventListener("blur",blur);};
  },[identity,open,channel,sensitiveSurfaceReady]);
  const metadataReady=!!accountLabel&&!!binding.principalId&&!!binding.sessionId&&!!binding.hostId&&!!binding.endpoint&&!!binding.provider&&!!binding.providerWorkspace&&!!binding.region&&!!binding.operations.length&&binding.storage==="os-vault"&&(binding.scope==="personal"?binding.organizationId===null:!!binding.organizationId);
  const valid=()=>open&&sensitiveSurfaceReady&&trusted&&metadataReady&&Date.now()<expiresAt;
  const applyReceipt=async(envelope:OneVaultEnvelope,result:OneVaultReceipt,captured:number,responseNonce:string|null=null)=>{
    const authenticated=await channel!.verifyReceipt(request,envelope,result,responseNonce);
    if(captured!==epoch.current||!valid())return;
    if(!Number.isSafeInteger(result.observedAt)||result.observedAt<Date.now()-120000||result.observedAt>Date.now()+30000||!authenticated||result.responseNonce!==responseNonce||result.requestId!==binding.requestId||result.requestRevision!==binding.requestRevision||result.hostId!==binding.hostId||result.operationId!==envelope.operationId||result.requestDigest!==envelope.requestDigest||result.generation!==binding.expectedGeneration+((result.state==="saved"||result.state==="deleted")?1:0)){setNotice("store_unknown");return;}
    setReceipt(result);
    if(result.state==="saved"||result.state==="deleted"){setPending(null);setNotice(null);if(result.state==="saved")onStored(result);}
    else setNotice(result.errorCode&&Object.hasOwn(errors,result.errorCode)?result.errorCode:result.state==="store_unknown"?"store_unknown":"store_failed");
  };
  const submit=async(action:"store"|"delete")=>{
    if(recovery||busy||pending||receipt?.state==="saved"||receipt?.state==="deleted"||!valid()||!channel)return;
    if(action==="store"&&!field.current?.value)return;
    const captured=epoch.current;let raw=action==="store"?field.current!.value:null;clear();setBusy(true);setNotice(null);
    try{const envelope=await channel.seal(request,crypto.randomUUID(),action,raw);raw=null;if(captured!==epoch.current||!valid())return;setPending(envelope);const result=await channel.submit(binding.requestId,envelope);await applyReceipt(envelope,result,captured);}
    catch(error){if(captured===epoch.current)setNotice(errorCode(error));}
    finally{raw=null;if(captured===epoch.current)setBusy(false);}
  };
  const reconcile=async()=>{if(busy||!channel||!valid()||(!pending&&!recovery))return;const captured=epoch.current;setBusy(true);try{
    if(recovery){if(!channel.statusQueryRecovery||!channel.verifyRecoveryReceipt)throw {code:"secure_route_unavailable"};const query=await channel.statusQueryRecovery(request,recovery);if(captured!==epoch.current||!valid())return;const result=await channel.reconcile(binding.requestId,query);const authenticated=await channel.verifyRecoveryReceipt(request,recovery,result,query);if(captured!==epoch.current||!valid())return;if(!authenticated)throw {code:"store_unknown"};setReceipt(result);setNotice(result.state==="saved"||result.state==="deleted"?null:result.errorCode&&Object.hasOwn(errors,result.errorCode)?result.errorCode:"store_unknown");if(result.state==="saved")onStored(result);
    }else{const envelope=pending!;const query=await channel.statusQuery(request,envelope);if(captured!==epoch.current||!valid())return;await applyReceipt(envelope,await channel.reconcile(binding.requestId,query),captured,query.nonce);}
  }catch(error){if(captured===epoch.current)setNotice(errorCode(error));}finally{if(captured===epoch.current)setBusy(false);}};
  const guardedKey=(event:KeyboardEvent<HTMLDivElement>)=>{
    const native=event.nativeEvent;const guarded=event.defaultPrevented||native.isComposing||native.keyCode===229||composing.current||Date.now()-compositionEnded.current<180;
    if(event.key==="Escape"){event.stopPropagation();if(!guarded){event.preventDefault();close("cancelled");}}
    // Secret submission requires an explicit button. Enter cannot reach the chat composer.
    if(event.key==="Enter"){event.stopPropagation();if(!guarded)event.preventDefault();}
  };
  const settled=receipt?.state==="saved"||receipt?.state==="deleted";
  return <OneBottomSheet open={open} onClose={()=>close("cancelled")} closeLabel="닫기" title="연결 키 저장" size="compact" closeOnEscape={false} dataAttributes={{"data-sensitive-surface":"vault","data-diagnostics":"disabled"}}>
    <div className={styles.root} onKeyDown={guardedKey} data-testid="one-vault-request-form">
      <dl className={styles.metadata}><dt>계정</dt><dd>{accountLabel} · {binding.principalId}</dd><dt>범위</dt><dd>{binding.scope==="personal"?"개인":`조직 · ${binding.organizationId}`}</dd><dt>Desktop</dt><dd>{binding.hostId}</dd><dt>제공자</dt><dd>{binding.provider}</dd><dt>워크스페이스</dt><dd>{binding.providerWorkspace}</dd><dt>지역·주소</dt><dd>{binding.region} · {binding.endpoint}</dd><dt>저장 위치</dt><dd>이 Desktop의 OS Vault · {binding.storage}</dd><dt>필요 권한</dt><dd><ul className={styles.permissions}>{binding.operations.map(value=><li key={value}>{value}</li>)}</ul></dd><dt>비용</dt><dd>{binding.cost?`${binding.cost.currency} ${binding.cost.maxMinor} 최소 화폐 단위 한도 · 부담 ${binding.payerId}`:"저장 요청에 유료 실행 승인이 없습니다."}</dd></dl>
      {recovery?<p className={styles.notice} data-testid="one-vault-recovery-mode">복구 모드 · 원래 작업 {recovery.operationId}의 결과만 확인합니다. 키 입력·저장·삭제를 다시 실행하지 않습니다.</p>:null}
      <p className={styles.notice}>키 저장, 제공자 확인, 오디오 생성은 별도 단계입니다. 유료 확인·사용은 비용과 현재 권한을 확인한 별도 승인 뒤 실행합니다. {remaining}초 남음</p>
      {!sensitiveSurfaceReady||!trusted||!metadataReady?<p role="status" className={styles.notice}>계정·요청·Desktop 신뢰 및 민감 입력 보호를 확인한 뒤 입력할 수 있습니다.</p>:null}
      {!recovery?<label className={styles.field}>API 키<input ref={field} type="password" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} name="one-vault-secret" data-private="true" data-sensitive="true" data-testid="one-vault-secret" disabled={!valid()||busy||!!pending||!!settled} onChange={event=>setFilled(event.currentTarget.value.length>0)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;compositionEnded.current=Date.now();}}/><small>이 전용 입력에서 암호화합니다. 채팅·일반 질문에는 입력하지 마세요.</small></label>:null}
      <ul className={styles.states} aria-label="연결 단계"><li>저장: {receipt?.state==="saved"?"확인됨":receipt?.state==="deleted"?"로컬 삭제 확인됨":pending||recovery?"결과 확인 필요":"미확인"}</li><li>제공자 확인: 미검증</li><li>허용된 오디오 결과: 없음</li></ul>
      {notice?<p role="alert" className={`${styles.notice} ${styles.error}`}>{errors[notice]}</p>:null}
      <div className={styles.actions}><button type="button" onClick={()=>close("cancelled")}>취소·닫기</button>{!recovery?<button type="button" className={styles.primary} disabled={!valid()||busy||!filled||!!pending||!!settled} onClick={()=>void submit("store")}>{busy?"확인 중":"암호화하여 저장"}</button>:null}{pending||recovery?<button type="button" disabled={busy||!valid()} onClick={()=>void reconcile()}>같은 작업 상태 확인</button>:null}{!recovery&&binding.expectedGeneration>0&&!pending&&!settled?<button type="button" disabled={busy||!valid()} onClick={()=>void submit("delete")}>로컬 키 삭제</button>:null}{!recovery&&onRequestReplacement?<button type="button" disabled={busy||!!pending&&receipt?.state!=="failed"} onClick={()=>{clear();++epoch.current;setTrusted(false);onRequestReplacement();}}>새 교체 요청</button>:null}</div>
      <small>로컬 삭제는 제공자에서 키를 폐기하지 않습니다. 닫기는 로컬 입력을 지우며 이미 전달된 작업의 취소를 뜻하지 않습니다.</small>
    </div>
  </OneBottomSheet>;
}
