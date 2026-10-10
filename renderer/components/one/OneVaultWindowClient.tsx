"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { oneVaultCanonical, type OneVaultRequest, type OneVaultEnvelope, type OneVaultReceipt, type OneVaultStatusQuery, type OneVaultErrorCode, type OneVaultRecoveryDescriptor } from "@shared/one-vault";
import { createOneVaultSecureChannel, type OneVaultRendererTrust } from "@/lib/one-vault-crypto";
import { OneVaultRequestForm } from "./OneVaultRequestForm";
export interface OneVaultWindowBootstrap {
  state:"register-required"|"entry-ready"|"blocked";request:OneVaultRequest|null;recovery:OneVaultRecoveryDescriptor|null;
  pinnedHost:{hostId:string;hostKeyId:string;publicKey:string;trustGeneration:number}|null;
  sender:{senderId:string;keyId:string;challengeNonce:string;challengeExpiresAt:number;requestId:string;requestRevision:number}|null;
  accountLabel:string;bindingKey:string;sensitiveSurfaceReady:boolean;errorCode:OneVaultErrorCode|null;
}
export interface OneVaultWindowBridge {
  bootstrap():Promise<OneVaultWindowBootstrap>;
  registerSender(input:{publicKey:string;challengeNonce:string;proof:string}):Promise<OneVaultWindowBootstrap>;
  submit(requestId:string,envelope:OneVaultEnvelope):Promise<OneVaultReceipt>;
  reconcile(requestId:string,query:OneVaultStatusQuery):Promise<OneVaultReceipt>;
  cancel(requestId:string|null,reason:"cancelled"|"expired"|"background"):Promise<void>;
  onChanged?(listener:()=>void):()=>void;
}
function base64url(bytes:Uint8Array){let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function nativeBridge(){return (window as unknown as {oneVault?:OneVaultWindowBridge}).oneVault;}
export function OneVaultWindowClient(){
  const [snapshot,setSnapshot]=useState<OneVaultWindowBootstrap|null>(null);const [error,setError]=useState(false);const [closed,setClosed]=useState(false);const [saved,setSaved]=useState(false);
  const signer=useRef<{key:CryptoKey;senderKeyId:string}|null>(null);const epoch=useRef(0);const bridge=useRef<OneVaultWindowBridge|null>(null);
  const refresh=useCallback(async()=>{
    const captured=++epoch.current;setSnapshot(null);setError(false);setSaved(false);
    try{const api=nativeBridge();if(!api)throw new Error("secure_route_unavailable");bridge.current=api;let next=await api.bootstrap();if(captured!==epoch.current)return;
      if(next.state==="register-required"){
        const {sender,pinnedHost,request}=next;
        if(!sender||!pinnedHost||!request||!next.sensitiveSurfaceReady||sender.challengeExpiresAt<=Date.now()||sender.requestId!==request.binding.requestId||sender.requestRevision!==request.binding.requestRevision||sender.senderId!==request.binding.senderId||pinnedHost.hostId!==request.binding.hostId)throw new Error("secure_route_unavailable");
        const keys=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);const publicKey=base64url(new Uint8Array(await crypto.subtle.exportKey("raw",keys.publicKey)));
        const transcript=new TextEncoder().encode(oneVaultCanonical(["sender-register",{challengeNonce:sender.challengeNonce,publicKey,requestId:sender.requestId,requestRevision:sender.requestRevision,hostId:pinnedHost.hostId,senderId:sender.senderId}]));
        const proof=base64url(new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,transcript)));
        if(captured!==epoch.current)return;signer.current={key:keys.privateKey,senderKeyId:sender.keyId};next=await api.registerSender({publicKey,challengeNonce:sender.challengeNonce,proof});
      }
      if(captured!==epoch.current)return;setSnapshot(next);
      if(next.state==="entry-ready"&&(!signer.current||signer.current.senderKeyId!==next.sender?.keyId))setError(true);
    }catch{if(captured===epoch.current){signer.current=null;setError(true);}}
  },[]);
  useEffect(()=>{void refresh();const off=nativeBridge()?.onChanged?.(()=>void refresh());return()=>{++epoch.current;signer.current=null;off?.();};},[refresh]);
  const close=useCallback((reason:"cancelled"|"expired"|"background")=>{++epoch.current;setClosed(true);signer.current=null;void bridge.current?.cancel(snapshot?.request?.binding.requestId??null,reason).catch(()=>setError(true));},[snapshot]);
  const channel=useRef<ReturnType<typeof createOneVaultSecureChannel>|null>(null);
  if(!channel.current)channel.current=createOneVaultSecureChannel({
    trustedIdentity:async(requestId)=>{
      const api=bridge.current;const currentSigner=signer.current;if(!api||!currentSigner)throw {code:"sender_untrusted"};const current=await api.bootstrap();const request=current.request;const pinned=current.pinnedHost;const sender=current.sender;
      if(current.state!=="entry-ready"||!current.sensitiveSurfaceReady||!request||!pinned||!sender||request.binding.requestId!==requestId||sender.keyId!==currentSigner.senderKeyId)throw {code:"authority_unavailable"};
      const binding=request.binding;const trust:OneVaultRendererTrust={hostId:pinned.hostId,hostKeyId:pinned.hostKeyId,hostPublicKey:pinned.publicKey,trustGeneration:pinned.trustGeneration,currentAuthorityDigest:current.recovery?.currentAuthorityDigest,currentRecovery:current.recovery,senderId:sender.senderId,senderKeyId:sender.keyId,current:{requestId:binding.requestId,requestRevision:binding.requestRevision,principalId:binding.principalId,sessionId:binding.sessionId,scope:binding.scope,organizationId:binding.organizationId,authorityRevision:binding.authorityRevision,permissionRevision:binding.permissionRevision,expectedGeneration:binding.expectedGeneration},sign:async(data)=>{if(signer.current!==currentSigner)throw {code:"sender_untrusted"};return new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},currentSigner.key,Uint8Array.from(data).buffer));}};return trust;
    },submit:(id,envelope)=>{if(!bridge.current)throw {code:"secure_route_unavailable"};return bridge.current.submit(id,envelope);},reconcile:(id,query)=>{if(!bridge.current)throw {code:"secure_route_unavailable"};return bridge.current.reconcile(id,query);},
  });
  if(closed)return <main><p>입력이 닫혔습니다. 전달된 작업의 결과는 원래 요청에서 확인해 주세요.</p></main>;
  if(error||snapshot?.state==="blocked")return <main style={{padding:20,overflowWrap:"anywhere"}}><h1>연결 키 입력</h1><p>안전한 입력 경로 또는 현재 권한을 확인할 수 없습니다. {snapshot?.errorCode&&["secure_route_unavailable","authority_denied","authority_unavailable","host_mismatch","revision_changed","sender_untrusted","request_expired"].includes(snapshot.errorCode)?snapshot.errorCode:"secure_route_unavailable"}</p><button type="button" onClick={()=>close("cancelled")}>닫기</button></main>;
  if(!snapshot?.request||snapshot.state!=="entry-ready")return <main style={{padding:20}}><p role="status">Desktop 신뢰와 민감 입력 보호를 확인하고 있습니다.</p><button type="button" onClick={()=>close("cancelled")}>취소</button></main>;
  return <><OneVaultRequestForm open request={snapshot.request} recovery={snapshot.recovery} accountLabel={snapshot.accountLabel} currentBindingKey={snapshot.bindingKey} sensitiveSurfaceReady={snapshot.sensitiveSurfaceReady} channel={channel.current} onClose={close} onStored={()=>setSaved(true)}/>{saved?<span role="status" style={{position:"fixed",bottom:2,left:16}}>저장 확인됨 · 제공자 확인과 오디오 사용은 별도 단계입니다.</span>:null}</>;
}
