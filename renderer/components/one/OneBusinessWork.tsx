"use client";
import {useEffect,useRef,useState} from 'react';
import {ipc} from '@/lib/ipc';
import {failureCode} from '@/lib/invocation-failure';
import type {WorkChoice,WorkUiStatus} from '@shared/business/employee-agent-work-api';
import {OsButton,OsCard,OsCheck,OsChecks,OsCount,OsDangerZone,OsField,OsNotice,OsInput,OsRoot,OsSelect,osStyles as os} from '../../business/org-share-kit';
import type {OsTone} from '../../business/org-share-kit';
import {IconCopy,IconRefresh} from '../Icon';
/** Opening this sheet performs no read, connection or work. Every operation is
 * an explicit employee action; native review supplies the approval authority.
 * 화면: 맨 위에 지금 상태(14가지)와 다음에 할 일 · ① 연결 ② 업무 등록 ③ 등록한 업무 변경 ④ 처리 상태·중지. */
export function OneBusinessWork({locale}:{locale:string}){
 const ko=locale==='ko',t=(kr:string,en:string)=>ko?kr:en,[code,setCode]=useState(''),[sources,setSources]=useState<WorkChoice[]>([]),[source,setSource]=useState(''),[files,setFiles]=useState<string[]>([]),[paths,setPaths]=useState<string[]>([]),[works,setWorks]=useState<WorkChoice[]>([]),[work,setWork]=useState(''),[path,setPath]=useState(''),[pendingConnection,setPendingConnection]=useState(''),[status,setStatus]=useState<WorkUiStatus>({state:'disconnected'}),[busy,setBusy]=useState(false),[card,setCard]=useState(0),[error,setError]=useState<string|null>(null),[copied,setCopied]=useState(false);
 const generation=useRef(0),pending=useRef(0);useEffect(()=>()=>{generation.current++},[]);
 const api=()=>{const value=ipc()?.businessWork;if(!value)throw Error('unavailable');return value};
 const clearSelector=()=>{setCopied(false);setStatus(previous=>{const{registrationId,...rest}=previous;return rest})};
 const edit=()=>{generation.current++;setError(null);clearSelector()};
 async function run(action:()=>Promise<void>){const g=++generation.current,id=++pending.current;setBusy(true);setError(null);clearSelector();try{await action()}catch(error){if(generation.current===g){clearSelector();const code=failureCode(error);setError(code==='employee_agent_work_connection_already_active'?t('이미 조직에 연결되어 있습니다. 현재 연결을 사용해 주세요.','This device is already connected to an organization. Use the current connection.'):code==='employee_agent_work_connection_approval_in_progress'?t('다른 연결 승인을 확인 중입니다. 완료된 뒤 다시 확인해 주세요.','Another connection approval is being checked. Wait for it to finish, then check again.'):t('연결이나 원본 파일을 확인하지 못했습니다. 적용됐는지 모르겠다면 다시 적용하지 말고 처리 상태를 확인해 주세요.','The connection or original file could not be verified. If you are not sure it was applied, do not apply again; check its status.'))}}finally{if(pending.current===id)setBusy(false)}}
 async function result(action:()=>Promise<WorkUiStatus>){const g=generation.current,r=await action();if(g===generation.current)setStatus(r)}
 const act=(n:number,call:()=>Promise<void>)=>()=>{setCard(n);void run(call)};
 const notices:Record<WorkUiStatus['state'],[string,string]>={
 disconnected:['조직의 업무 변경 연결을 준비하세요.','Prepare a WORK change connection with your organization.'],associated:['연결을 확인했습니다. 등록할 업무 파일을 선택하세요.','Connection confirmed. Select WORK files to register.'],
 'approval-required':['조직 관리자가 업무 범위를 승인해야 합니다. 등록 코드를 복사해 관리자에게 전달하고, 승인된 뒤 ‘처리 상태 확인’을 눌러 주세요.','Your organization admin must approve this WORK scope. Copy the registration code for the admin, then press “Check status” once it is approved.'],
    'native-registered':['선택한 파일을 별도 업무 공간에 기록했습니다. 평가 기준은 별도로 검토해야 합니다.','Selected files are recorded in a separate workspace. Review evaluation criteria separately.'],registered:['조직 등록을 확인했습니다. 변경할 파일을 선택하세요.','Organization registration confirmed. Select a file to change.'],
 preparing:['원래 작업 실행을 요청했습니다. 실행 중에 변경과 평가 결과를 검토하세요. 작업이 먼저 끝나면 새 승인은 불가능합니다.','Original work was requested. Review the change and evaluation while it is running. Approval is unavailable once the run ends.'],
 'review-required':['변경 내용과 평가 결과를 승인 창에서 검토하세요.','Review the change and evaluation in the native approval dialog.'],
 'native-applied':['이 기기의 파일은 바뀌었지만, 조직에 기록됐는지는 아직 확인하지 못했습니다. 다시 적용하지 말고 ‘처리 상태 확인’을 눌러 주세요.','Files on this device changed, but the organization record is not confirmed yet. Do not apply again; press “Check status”.'],
 finalized:['기기 변경과 조직의 최종 기록을 확인했습니다.','The device change and organization finalization are confirmed.'],rejected:['기기의 변경은 유지되지만 조직이 최종 기록을 거절했습니다. 자동 복원하지 않습니다.','The device change remains, but the organization rejected finalization. It will not be restored automatically.'],
 unknown:['결과를 확인하지 못했습니다. 같은 변경을 다시 하지 말고 처리 상태를 먼저 확인해 주세요.','The outcome is unknown. Do not repeat the change; check its status first.'],expired:['연결 또는 요청이 만료되었습니다. 새 승인이 필요합니다.','The connection or request expired. New approval is required.'],revoked:['이 기기의 업무 변경 연결이 중지되었습니다.','WORK changes from this device have stopped.'],
 'original-execution-unavailable':['원래 실행을 확인하지 못해 변경할 수 없습니다.','The original execution is unavailable; the change cannot proceed.']};
 const labels:Record<WorkUiStatus['state'],[string,string,OsTone]>={
 disconnected:['연결 전','Not connected','idle'],associated:['연결됨','Connected','ok'],'approval-required':['관리자 승인 대기','Waiting for admin approval','warn'],'native-registered':['기기에 기록됨','Recorded on device','info'],registered:['조직 등록 확인','Registered','ok'],
 preparing:['변경 검토 준비됨','Review ready','info'],'review-required':['검토 필요','Review needed','warn'],'native-applied':['조직 기록 확인 필요','Organization record unconfirmed','warn'],finalized:['완료','Done','ok'],rejected:['조직이 거절','Rejected by organization','danger'],
 unknown:['결과 확인 필요','Outcome unconfirmed','warn'],expired:['만료됨','Expired','danger'],revoked:['중지됨','Stopped','idle'],'original-execution-unavailable':['변경할 수 없음','Cannot proceed','danger']};
 const [label,labelEn,tone]=labels[status.state]??labels.unknown,stateText=notices[status.state]?.[ko?0:1];
 const connection:[OsTone,string]=status.state==='disconnected'?['idle',t('연결 전','Not connected')]:status.state==='revoked'?['idle',t('중지됨','Stopped')]:status.state==='expired'?['danger',t('만료됨','Expired')]:status.state==='unknown'?['warn',t('확인 필요','Needs check')]:['ok',t('연결됨','Connected')];
 const registerable=paths.length>0&&status.state!=='approval-required',canRegisterState=['approval-required','registered','finalized'].includes(status.state);
 const canNewReview=!!work&&status.state!=='approval-required',canPrepare=!!path&&status.state!=='approval-required',canReview=status.state==='preparing'&&!!status.selection;
 return <OsRoot>
  <OsNotice tone={tone==='idle'?'info':tone}><strong className={os.noticeTitle}>{ko?label:labelEn}</strong>{stateText}</OsNotice>

  <OsCard step={1} busy={busy&&card===1} done={connection[0]==='ok'} tone={connection[0]} status={connection[1]} title={t('이 기기를 조직에 연결','Connect this device to your organization')} description={t('조직에서 받은 연결 코드로 이 기기를 업무 변경 대상으로 연결합니다.','Connect this device for WORK changes with the code from your organization.')}>
   <div className={os.line}><p className={`${os.lineCopy} ${os.hint}`}>{t('조직의 연결 요청 화면에 이 기기 정보를 붙여 넣으세요.','Paste this device’s details into your organization’s connection request.')}</p>
    <OsButton variant="secondary" icon={<IconCopy size={16} />} disabled={busy} onClick={act(1,async()=>{const g=generation.current,n=await api().identity();if(g===generation.current)await navigator.clipboard.writeText(JSON.stringify(n))})}>{t('연결 정보 복사','Copy connection details')}</OsButton></div>
   <OsField label={t('조직 연결 코드','Organization connection code')} action={<OsButton variant="primary" disabled={busy||!code.trim()} onClick={act(1,async()=>{const g=generation.current,r=await api().approveAssociation({challengeId:code.trim()});if(g===generation.current){setStatus(r);setPendingConnection(r.state==='unknown'?r.selection??'':'')}})}>{t('연결 검토','Review connection')}</OsButton>}>
    <OsInput value={code} maxLength={256} onChange={e=>{edit();setCode(e.target.value)}} />
   </OsField>
   {pendingConnection&&<OsNotice tone="warn" action={<OsButton variant="primary" disabled={busy} onClick={act(1,async()=>{const g=generation.current,r=await api().reconcile({selection:pendingConnection});if(g===generation.current){setStatus(r);setPendingConnection('')}})}>{t('원래 연결 승인 확인','Check original connection approval')}</OsButton>}>{t('응답을 받지 못했습니다. 다시 승인하지 말고 원래 승인이 처리됐는지 확인하세요.','The response was lost. Do not approve again; check whether the original approval went through.')}</OsNotice>}
  </OsCard>

  <OsCard step={2} busy={busy&&card===2} done={['native-registered','registered','finalized'].includes(status.state)} title={t('업무 등록','Register WORK')} description={t('선택한 업무 파일만 별도 업무 공간에 등록합니다. 평가 기준과 각 변경은 직접 검토하며, 개인 메모리와 보고 공유는 포함하지 않습니다.','Register only selected WORK files in a separate workspace. You review evaluation criteria and each change yourself; personal memory and report sharing are excluded.')}>
   <div className={os.groupHead}><span className={os.groupTitle}>{t('등록할 업무','WORK to register')}{sources.length>0&&<OsCount>{sources.length}</OsCount>}</span>
    <OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy} onClick={act(2,async()=>{const g=generation.current,v=await api().sources();if(g===generation.current){setSources(v);setSource('');setFiles([]);setPaths([])}})}>{t('등록할 업무 찾기','Find WORK to register')}</OsButton></div>
   {sources.length>0&&<OsField label={t('원본 업무','Original WORK')} action={source?<OsButton variant="secondary" disabled={busy} onClick={act(2,async()=>{const g=generation.current,v=await api().files({sourceId:source});if(g===generation.current)setFiles(v)})}>{t('선택 가능한 파일 확인','Find selectable files')}</OsButton>:undefined}>
    <OsSelect value={source} disabled={busy} onChange={e=>{edit();setSource(e.target.value);setFiles([]);setPaths([])}}><option value="">{t('업무 선택','Choose WORK')}</option>{sources.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</OsSelect>
   </OsField>}
   {files.length>0&&<div className={os.group}><div className={os.groupHead}><span className={os.groupTitle}>{t('등록할 파일','Files to register')}<OsCount>{`${paths.length}/${files.length}`}</OsCount></span></div>
    <OsChecks>{files.map(file=><OsCheck key={file} checked={paths.includes(file)} disabled={busy} onChange={checked=>{edit();setPaths(checked?[...paths,file]:paths.filter(p=>p!==file))}}>{file}</OsCheck>)}</OsChecks></div>}
   {(registerable||(status.state==='native-registered'&&status.selection))&&<div className={os.actions}>
    {registerable&&<OsButton variant={status.state==='native-registered'?'secondary':'primary'} disabled={busy} onClick={act(2,()=>result(()=>api().register({sourceId:source,paths})))}>{t('선택 파일 검토 후 등록','Review and register selected files')}</OsButton>}
    {status.state==='native-registered'&&status.selection&&<OsButton variant="primary" disabled={busy} onClick={act(2,()=>result(()=>api().oracle({selection:status.selection!})))}>{t('평가 기준 파일 선택 및 검토','Choose and review evaluation criteria')}</OsButton>}
   </div>}
  </OsCard>

  <OsCard step={3} busy={busy&&card===3} done={status.state==='finalized'} title={t('등록한 업무 변경','Change registered WORK')} description={t('등록한 업무의 파일을 고치고, 변경과 평가 결과를 검토한 뒤 조직에 기록합니다.','Edit a registered WORK file, review the change and evaluation, then record it with your organization.')}>
   <div className={os.groupHead}><span className={os.groupTitle}>{t('등록한 업무','Registered WORK')}{works.length>0&&<OsCount>{works.length}</OsCount>}</span>
    <OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy} onClick={act(3,async()=>{const g=generation.current,v=await api().workspaces();if(g===generation.current){setWorks(v);setWork('');setPath('')}})}>{t('등록한 업무 확인','Find registered WORK')}</OsButton></div>
   {works.length>0&&<OsField label={t('변경할 업무','WORK to change')}>
    <OsSelect value={work} disabled={busy} onChange={e=>{edit();setWork(e.target.value);setPath('')}}><option value="">{t('업무 선택','Choose WORK')}</option>{works.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</OsSelect>
   </OsField>}
   {work&&<OsField label={t('업무 파일','WORK file')}>
    <OsSelect value={path} disabled={busy} onChange={e=>{edit();setPath(e.target.value)}}><option value="">{t('파일 선택','Choose a file')}</option>{works.find(v=>v.id===work)?.paths?.map(p=><option key={p} value={p}>{p}</option>)}</OsSelect>
   </OsField>}
   {(canNewReview||canPrepare||canReview)&&<div className={os.actions}>
    {canNewReview&&<OsButton variant="secondary" disabled={busy} onClick={act(3,()=>result(()=>api().oracle({selection:work})))}>{t('평가 기준 파일 선택 및 새 검토','Choose evaluation criteria for a new review')}</OsButton>}
    {canPrepare&&<><OsButton variant="secondary" disabled={busy} onClick={act(3,()=>result(()=>api().prepare({selection:work,path,action:'restore'})))}>{t('처음 승인한 버전으로 복원 검토','Review restoration to the first approved version')}</OsButton>
     <OsButton variant="primary" disabled={busy} onClick={act(3,()=>result(()=>api().prepare({selection:work,path,action:'edit'})))}>{t('변경 파일 선택 후 검토 준비','Choose revised file and prepare review')}</OsButton></>}
    {canReview&&<OsButton variant="primary" disabled={busy} onClick={act(3,()=>result(()=>api().review({selection:status.selection!})))}>{t('변경과 평가 결과 검토','Review change and evaluation')}</OsButton>}
   </div>}
  </OsCard>

  <OsCard step={4} busy={busy&&card===4} done={status.state==='finalized'} tone={tone} status={ko?label:labelEn} title={t('처리 상태','Status')} description={t('조직의 처리 결과를 확인합니다. 결과가 불확실하면 같은 변경을 다시 하지 말고 여기서 확인하세요.','Check how your organization processed it. If the outcome is uncertain, check here instead of repeating the change.')}>
   {(status.selection||copied)&&<div className={os.actions} data-align="start">
    {status.selection&&<OsButton variant="primary" icon={<IconRefresh size={16} />} disabled={busy} onClick={act(4,()=>result(()=>api().receipt({selection:status.selection!})))}>{t('처리 상태 확인','Check status')}</OsButton>}
    {status.selection&&canRegisterState&&<OsButton variant="secondary" icon={<IconCopy size={16} />} disabled={busy} onClick={act(4,async()=>{const g=generation.current,selection=status.selection!,r=await api().receipt({selection});if(g!==generation.current)return;if(r.selection!==selection||!['approval-required','registered','finalized'].includes(r.state)||typeof r.registrationId!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(r.registrationId)){setStatus({...r,selection,registrationId:undefined});throw Error('registration_selector_unavailable')}setStatus(r);await navigator.clipboard.writeText(r.registrationId);if(g===generation.current)setCopied(true)})}>{t('조직 등록 코드 복사','Copy organization registration code')}</OsButton>}
   </div>}
   {copied&&<OsNotice tone="ok">{t('조직 등록 코드를 복사했습니다. 조직의 승인 화면에 전달하세요. 이 코드는 승인이 아닙니다.','Registration code copied. Use it in your organization’s approval screen. The code is not an approval.')}</OsNotice>}
   {!status.selection&&!copied&&<p className={os.hint}>{t('업무를 등록하거나 변경 검토를 준비하면 여기서 처리 상태를 확인할 수 있습니다.','Once you register WORK or prepare a review, you can check its status here.')}</p>}
   {error&&<OsNotice tone="danger">{error}</OsNotice>}
  </OsCard>

  {status.selection&&<OsDangerZone ko={ko} title={t('변경 요청 취소','Cancel change request')} description={t('진행 중인 변경 요청을 취소합니다.','Cancel the change request in progress.')} actionLabel={t('변경 요청 취소','Cancel request')} confirmTitle={t('변경 요청을 취소할까요?','Cancel this change request?')} consequence={t('취소하면 이 요청은 더 진행되지 않습니다. 필요하면 새 변경 검토를 다시 준비해야 합니다.','The request will not proceed. Prepare a new review if you still need the change.')} confirmLabel={t('요청 취소','Cancel request')} onConfirm={act(4,()=>result(()=>api().cancel({selection:status.selection!})))} />}
  <OsDangerZone ko={ko} title={t('업무 변경 연결 중지','Stop WORK change connection')} description={t('이 기기의 업무 변경 연결을 중지합니다.','Stop WORK changes from this device.')} actionLabel={t('연결 중지','Stop connection')} confirmTitle={t('업무 변경 연결을 중지할까요?','Stop the WORK change connection?')} consequence={t('중지하면 이 기기에서 업무 파일을 더 등록하거나 변경할 수 없습니다. 다시 하려면 새 연결 코드를 승인해야 합니다.','This device can no longer register or change WORK files. Approve a new connection code to resume.')} confirmLabel={t('연결 중지','Stop connection')} onConfirm={act(4,()=>result(()=>api().revoke()))} />
 </OsRoot>;
}
