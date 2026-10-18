'use client';
import {useEffect,useRef,useState} from 'react';
import type {OneVaultNativeAPI} from '@shared/one-vault';
import {OneBottomSheet} from '@/components/one/OneBottomSheet';
type RecoveryOperation=Awaited<ReturnType<OneVaultNativeAPI['recoverableOperations']>>[number];
/** This list is native-filtered for the current account and exact host. It never contains credential values. */
export function OneVaultRecoveryFeature({api,authorityEpoch=0}:{api:OneVaultNativeAPI|null;authorityEpoch?:number}){
 const [open,setOpen]=useState(false),[operations,setOperations]=useState<RecoveryOperation[]>([]),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[trustUnknown,setTrustUnknown]=useState(false),[notice,setNotice]=useState<string|null>(null);const epoch=useRef(0);
 const close=()=>{++epoch.current;setBusy(false);setOperations([]);setLoaded(false);setNotice(null);setOpen(false);};
 useEffect(()=>{close();return()=>{++epoch.current}},[api,authorityEpoch]);
 const read=async(captured:number)=>{if(!api)throw Error();const rows=await api.recoverableOperations();if(captured!==epoch.current)return;
 if(!Array.isArray(rows)||rows.some(row=>!row.operationId||!row.commandId||!['reserved','store_unknown'].includes(row.state)||!['personal','organization'].includes(row.scope)))throw Error();setOperations(rows);setLoaded(true);};
 const work=async(action:(captured:number)=>Promise<void>)=>{if(busy)return;const captured=epoch.current;setBusy(true);setNotice(null);try{await action(captured)}catch{if(captured===epoch.current){setLoaded(false);setNotice('이 계정과 이 컴퓨터의 복구 권한이나 작업 결과를 확인하지 못했습니다. ‘복구 목록 다시 조회’를 눌러 주세요.');}}finally{if(captured===epoch.current)setBusy(false)}};
 const show=()=>{++epoch.current;setOpen(true);setOperations([]);setLoaded(false);void work(read);};
 const reconcile=(operation:RecoveryOperation)=>void work(async captured=>{if(!api)throw Error();const current=await api.recoverableOperations();if(captured!==epoch.current)return;const exact=current.find(row=>row.operationId===operation.operationId&&row.commandId===operation.commandId&&row.provider===operation.provider&&row.scope===operation.scope);if(!exact)throw Error();const result=await api.openStoredOperation({operationId:operation.operationId});if(captured!==epoch.current)return;setNotice(result.state==='opened'?'작업 상태 확인 창을 열었습니다. 저장됐는지는 그 창에서 확인하세요.':'이 컴퓨터의 복구 권한을 확인하지 못해 창을 열지 않았습니다.');});
 const review=(mode:'initialize-or-rotate'|'reconcile'|'reauthorize')=>void work(async captured=>{if(!api)throw Error();const result=await api.reviewHostTrust({mode});if(captured!==epoch.current)return;setTrustUnknown(result.state==='unknown');setLoaded(false);setNotice(result.state==='active'?'이 컴퓨터의 신뢰 상태를 확인했습니다. 복구 목록을 다시 조회해 주세요.':'신뢰 설정이 바뀌었는지 아직 확인하지 못했습니다. ‘같은 신뢰 변경 상태 확인’을 눌러 확인해 주세요.');setOperations([]);});
 return <><button type="button" onClick={show}>Vault 복구·기기 신뢰</button><OneBottomSheet open={open} onClose={close} ariaLabel="Vault 복구·기기 신뢰" title="Vault 복구·기기 신뢰" closeLabel="닫기" size="compact"><div style={{display:'flex',flexDirection:'column',gap:16,overflowWrap:'anywhere'}}>
 <p>이 계정과 이 컴퓨터에서 권한이 확인된 작업 중 결과를 확인하지 못한 것을 찾습니다. 새 키를 입력하거나 저장을 다시 보내지 않습니다.</p>
 {!api&&<p role="status">지금은 Vault 복구 기능에 연결되지 않았습니다.</p>}{notice&&<p role="status">{notice}</p>}
 {operations.map(operation=><article key={operation.operationId}><p>{operation.provider} · {operation.scope==='personal'?'개인':'조직'} · {operation.state==='store_unknown'?'저장됐는지 확인 안 됨':'작업 결과 확인 안 됨'}</p><p>원래 요청: {operation.commandId}</p><p>작업: {operation.operationId}</p><button disabled={busy} onClick={()=>reconcile(operation)}>같은 작업의 상태 확인 창 열기</button></article>)}
 {!busy&&api&&loaded&&operations.length===0&&<p>현재 권한으로 조회된 복구 작업이 없습니다.</p>}
 <button disabled={busy||!api} onClick={()=>void work(read)}>복구 목록 다시 조회</button>
 <p>기기 신뢰 설정은 버튼을 누르면 열리는 본인 확인·승인 창에서 검토합니다.</p><div style={{display:'flex',flexWrap:'wrap',gap:8}}><button disabled={busy||!api||trustUnknown} onClick={()=>review('initialize-or-rotate')}>기기 신뢰 설정·교체 검토</button><button disabled={busy||!api} onClick={()=>review('reconcile')}>같은 신뢰 변경 상태 확인</button><button disabled={busy||!api||trustUnknown} onClick={()=>review('reauthorize')}>현재 권한으로 재승인 검토</button></div>
 <button onClick={close}>취소·닫기</button></div></OneBottomSheet></>;
}
