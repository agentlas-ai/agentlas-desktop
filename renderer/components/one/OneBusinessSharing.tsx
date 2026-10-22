"use client";
import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ipc} from '@/lib/ipc';
import {failureCode} from '@/lib/invocation-failure';
import type {BusinessNativeSharingAPI} from '@shared/business/native-sharing-api';
import {BusinessEmployeeAgentTransfer} from '../../business/BusinessEmployeeAgentTransfer';
import {OsButton,OsCard,OsChoiceGroup,OsCount,OsDangerZone,OsEmpty,OsField,OsInput,OsNotice,OsRoot,OsTextarea,OsTracker,osStyles as os} from '../../business/org-share-kit';
import type {OsStepState,OsTone} from '../../business/org-share-kit';
import {IconCopy,IconFileText,IconRefresh} from '../Icon';
type Msg={scope:'connect'|'share'|'receipt'|'stop';tone:OsTone;text:string};
type Outcome=[OsTone,string]|null;
type Track={received:boolean;publication:'published'|'awaiting-enrollment'|'unknown'|null};
/** Opening settings is inert. Native review rechecks the original focused owner;
 * this view supplies selectors/text, never an approval boolean or source proof.
 * 화면 구성: ① 기기 연결 ② 완료 작업 공유 ③ 회사 에이전트 전달 + 공유 중지. 결과는 누른 카드 안에 톤으로 보인다. */
export function OneBusinessSharing({locale}:{locale:string}){
 const ko=locale==='ko',t=(kr:string,en:string)=>ko?kr:en, [challenge,setChallenge]=useState(''),[request,setRequest]=useState(''),[work,setWork]=useState<readonly {commandId:string;taskId:string;runId:string;title:string|null}[]>([]),[command,setCommand]=useState(''),[summary,setSummary]=useState(''),[acceptance,setAcceptance]=useState(''),[pendingApproval,setPendingApproval]=useState(''),[busy,setBusy]=useState(false),[running,setRunning]=useState<Msg['scope']|null>(null),[msg,setMsg]=useState<Msg|null>(null),[canContinue,setCanContinue]=useState(false),[canRecover,setCanRecover]=useState(false),[canCopy,setCanCopy]=useState(false),[link,setLink]=useState<'idle'|'ok'|'pending'>('idle'),[searched,setSearched]=useState(false),[track,setTrack]=useState<Track|null>(null);
 const operation=useRef(0),activeRun=useRef(0);
 useEffect(()=>()=>{operation.current++},[]);
 const invalidateSelection=()=>{operation.current++;setCanCopy(false)};
 const registrationSelector=(result:Awaited<ReturnType<BusinessNativeSharingAPI['receipt']>>)=>{
  if(result.state!=='custody-confirmed')return null;
  const selector=result.registrationSelector;
  return selector&&Object.keys(selector).length===2&&typeof selector.packetId==='string'&&typeof selector.packetRevision==='string'&&[selector.packetId,selector.packetRevision].every(value=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))?{packetId:selector.packetId,packetRevision:selector.packetRevision}:null;
 };
 async function run(scope:Msg['scope'],action:()=>Promise<Outcome>){invalidateSelection();const revision=operation.current,runId=++activeRun.current;setBusy(true);setRunning(scope);try{const outcome=await action();if(revision===operation.current)setMsg(outcome?{scope,tone:outcome[0],text:outcome[1]}:null)}catch(error){if(revision===operation.current){const code=failureCode(error);setMsg({scope,tone:'danger',text:code==='business_native_report_generation_retirement_required'?t('이전 조직 연결이 종료되었습니다. 계정에 다시 로그인한 뒤 연결 정보를 새로 확인해 주세요.','The previous organization connection has ended. Sign in to your account again, then retrieve fresh connection details.'):code==='business_native_connection_already_active'?t('이미 조직에 연결되어 있습니다. 현재 연결을 사용해 주세요.','This device is already connected to an organization. Use the current connection.'):code==='business_native_connection_approval_in_progress'?t('다른 연결 승인을 확인 중입니다. 완료된 뒤 다시 확인해 주세요.','Another connection approval is being checked. Wait for it to finish, then check again.'):t('현재 연결이나 원본 승인을 확인하지 못했습니다. 내용을 다시 검토해 주세요.','The current connection or original approval could not be verified. Review the request again.')})}}finally{if(runId===activeRun.current){setBusy(false);setRunning(null)}}}
 const api=()=>{const current=ipc()?.businessNative;if(!current)throw Error('unavailable');return current};
 const note=(scope:Msg['scope'])=>msg?.scope===scope?msg:null;
 const published=track?.publication==='published';
 const shareHint=!request.trim()?t('조직에서 받은 보고 요청을 붙여 넣으세요.','Paste the report request from your organization.'):!command?t('공유할 완료 작업을 선택하세요.','Select the completed work to share.'):!summary.trim()?t('공유할 요약을 입력하세요.','Enter the summary to share.'):t('공유 전에 승인 창에서 요약을 한 번 더 확인합니다.','You review the summary again in the approval window before it is shared.');
 const trackSteps:{label:string;state:OsStepState}[]=[
  {label:t('공유 승인','Approved'),state:'done'},
  {label:t('조직 수신','Received'),state:track?.received?'done':'current'},
  {label:t('직원 등록','Enrolled'),state:!track?.received?'todo':track.publication==='published'?'done':track.publication==='awaiting-enrollment'?'current':'todo'},
  {label:t('보고 발행','Published'),state:track?.publication==='published'?'done':track?.publication==='unknown'?'current':'todo'},
 ];
 const notice=(m:Msg|null,action?:ReactNode)=>m&&<OsNotice tone={m.tone} action={action}>{m.text}</OsNotice>;
 return <OsRoot>
  <OsCard step={1} busy={running==='connect'} done={link==='ok'} tone={link==='ok'?'ok':link==='pending'?'warn':'idle'} status={link==='ok'?t('연결됨','Connected'):link==='pending'?t('확인 필요','Needs check'):t('연결 전','Not connected')} title={t('이 기기를 조직에 연결','Connect this device to your organization')} description={t('조직에서 발급한 연결 요청을 이 기기에서 검토합니다.','Review your organization’s connection request on this device.')}>
   <div className={os.line}><p className={`${os.lineCopy} ${os.hint}`}>{t('조직의 연결 요청 화면에 이 기기 정보를 붙여 넣으세요.','Paste this device’s details into your organization’s connection request.')}</p>
    <OsButton variant="secondary" icon={<IconCopy size={16} />} disabled={busy} onClick={()=>void run('connect',async()=>{const identity=await api().identity();await navigator.clipboard.writeText(JSON.stringify(identity));return ['ok',t('연결 정보를 복사했습니다. 조직의 연결 요청 화면에 붙여 넣으세요.','Connection details copied. Paste them into your organization’s connection request.')]})}>{t('연결 정보 복사','Copy connection details')}</OsButton></div>
   <OsField label={t('조직 연결 요청 코드','Organization connection code')} hint={t('연결 요청 화면에 나온 코드를 입력한 뒤 내용을 검토하세요.','Enter the code shown in the connection request, then review it.')} action={<OsButton variant="primary" disabled={busy||!challenge.trim()} onClick={()=>void run('connect',async()=>{const result=await api().approveAssociation({challengeId:challenge.trim()});if(result.state==='unknown'){setPendingApproval(result.approvalReceiptId);setLink('pending');return ['warn',t('응답을 받지 못했습니다. 다시 승인하지 말고 ‘기존 승인 확인’으로 처리됐는지 확인하세요.','The response was lost. Do not approve again; use “Check existing approval” to see whether it went through.')]}setPendingApproval('');setLink('ok');return ['ok',t('조직 연결을 승인했습니다. 공유할 작업은 별도로 선택하세요.','Organization connection approved. Select the work to share separately.')]})}>{t('연결 내용 검토','Review connection')}</OsButton>}>
    <OsInput value={challenge} maxLength={256} onChange={e=>{invalidateSelection();setChallenge(e.target.value)}} />
   </OsField>
   {pendingApproval?<OsNotice tone="warn" action={<OsButton variant="primary" disabled={busy} onClick={()=>void run('connect',async()=>{await api().reconcileAssociation({approvalReceiptId:pendingApproval});setPendingApproval('');setLink('ok');return ['ok',t('기존 조직 연결 승인을 확인했습니다.','The original organization approval is confirmed.')]})}>{t('기존 승인 확인','Check original approval')}</OsButton>}>{note('connect')?.text??t('응답을 받지 못했습니다. 다시 승인하지 말고 ‘기존 승인 확인’으로 처리됐는지 확인하세요.','The response was lost. Do not approve again; use “Check existing approval” to see whether it went through.')}</OsNotice>:notice(note('connect'))}
  </OsCard>

  <OsCard step={2} busy={running==='share'||running==='receipt'} done={published} tone={published?'ok':acceptance?'info':'idle'} status={published?t('발행됨','Published'):track?.received?t('조직 수신','Received'):acceptance?t('공유함','Shared'):t('공유 전','Not shared')} title={t('완료한 작업 공유','Share completed work')} description={t('완료한 작업의 요약을 조직과 공유합니다. 공유할 때마다 요약을 승인 창에서 다시 확인합니다.','Share a summary of completed work with your organization. Each summary is reviewed again in the approval window.')}>
   <OsField label={t('조직 보고 요청','Organization report request')} hint={t('조직 관리자 화면에서 복사한 보고 요청을 붙여 넣으세요.','Paste the report request copied from your organization’s admin screen.')}>
    <OsTextarea mono rows={2} value={request} maxLength={4096} onChange={e=>{invalidateSelection();setRequest(e.target.value)}} placeholder={t('조직에서 복사한 보고 요청','Paste the report request from your organization')} />
   </OsField>
   <div className={os.group}>
    <div className={os.groupHead}><span className={os.groupTitle}>{t('공유할 완료 작업','Completed work to share')}{work.length>0&&<OsCount>{work.length}</OsCount>}</span>
     <OsButton variant="secondary" icon={<IconRefresh size={16} />} disabled={busy} onClick={()=>void run('share',async()=>{const items=await api().completedWork();setWork(items);setCommand('');setSearched(true);return items.length>0?['ok',t(`확인된 완료 작업 ${items.length}개 중 하나를 선택하세요.`,`Choose from ${items.length} verified completed tasks.`)]:['warn',t('확인된 완료 작업이 없습니다. 작업을 끝낸 뒤 다시 확인해 주세요.','No verified completed work yet. Finish a task, then check again.')]})}>{t('완료 작업 확인','Find completed work')}</OsButton></div>
    {work.length>0?<OsChoiceGroup label={t('작업 선택','Select work')} value={command} disabled={busy} onChange={value=>{invalidateSelection();setCommand(value)}} items={work.map(item=>({value:item.commandId,title:item.title??item.taskId,meta:`${t('실행','Run')} ${item.runId}`}))} />
     :searched?<OsEmpty icon={<IconFileText size={20} />} title={t('완료한 작업이 없습니다','No completed work')} body={t('이 기기에서 작업을 끝낸 뒤 ‘완료 작업 확인’을 다시 눌러 주세요.','Finish a task on this device, then press “Find completed work” again.')} />
     :<p className={os.hint}>{t('‘완료 작업 확인’을 누르면 이 기기에서 끝난 작업을 불러옵니다.','Press “Find completed work” to load tasks finished on this device.')}</p>}
   </div>
   <OsField label={t('공유할 작업 요약','Work summary to share')} hint={`${summary.length}/600`}>
    <OsTextarea value={summary} maxLength={600} rows={3} onChange={e=>{invalidateSelection();setSummary(e.target.value)}} />
   </OsField>
   <div className={os.footRow}><p className={os.hint}>{shareHint}</p>
    <OsButton variant={acceptance?'secondary':'primary'} disabled={busy||!request.trim()||!command||!summary.trim()} onClick={()=>void run('share',async()=>{const selector=JSON.parse(request) as {agentResourceId:string;sourceResourceId:string;expectedRevision:number|null};const result=await api().shareCompletedResult({commandId:command,agentResourceId:selector.agentResourceId,sourceResourceId:selector.sourceResourceId,expectedRevision:selector.expectedRevision,summary});setAcceptance(result.acceptanceId);setTrack(null);setCanContinue(false);setCanRecover(false);return ['ok',t('공유를 승인했습니다. 조직이 받았는지 아래 ‘수신 확인’으로 확인하세요.','Sharing approved. Use “Check receipt” below to see whether your organization received it.')]})}>{t('요약 검토 후 공유','Review and share summary')}</OsButton></div>
   {notice(note('share'))}
   {acceptance&&<div className={os.inset}>
    <div className={os.insetHead}><strong className={os.insetTitle}>{t('공유 기록','Sharing record')}</strong>
     <OsButton variant="primary" icon={<IconRefresh size={16} />} disabled={busy} onClick={()=>void run('receipt',async()=>{const revision=operation.current;const result=await api().receipt({acceptanceId:acceptance});if(revision!==operation.current)return null;setCanCopy(!!registrationSelector(result));setCanContinue(result.state==='custody-confirmed'&&result.publication==='awaiting-enrollment');setCanRecover(result.state==='custody-confirmed'&&result.publication==='unknown');setTrack({received:result.state==='custody-confirmed',publication:result.state==='custody-confirmed'?result.publication:null});return result.state==='custody-confirmed'?(result.publication==='published'?['ok',t('조직 보고 발행과 현재 조회 권한을 확인했습니다.','Report publication and current read access are confirmed.')]:result.publication==='awaiting-enrollment'?['warn',t('조직이 자료를 수신했습니다. 직원 에이전트 등록을 기다리고 있습니다.','Your organization received the source. Employee agent enrollment is required.')]:['warn',t('자료 수신은 확인했습니다. 보고 발행은 아직 확인하지 못했습니다.','Source receipt is confirmed. Report publication is not yet confirmed.')]):['warn',t('조직의 수신을 아직 확인하지 못했습니다. 중복 전송하지 않습니다.','Organization receipt is not yet confirmed. The submission will not be sent again.')]})}>{t('수신 확인','Check receipt')}</OsButton></div>
    <OsTracker ko={ko} steps={trackSteps} />
    {canCopy&&<div className={os.line}><p className={`${os.lineCopy} ${os.hint}`}>{t('등록 검토용 선택자입니다. 복사는 승인이 아닙니다.','Selection for registration review. Copying does not approve it.')}</p>
     <OsButton variant="secondary" icon={<IconCopy size={16} />} disabled={busy} onClick={()=>void run('receipt',async()=>{const revision=operation.current;const result=await api().receipt({acceptanceId:acceptance});if(revision!==operation.current)return null;const selector=registrationSelector(result);if(!selector)return ['warn',t('등록 선택자를 확인하지 못했습니다. ‘수신 확인’을 다시 눌러 주세요.','The registration selection is unavailable. Press “Check receipt” again.')];await navigator.clipboard.writeText(JSON.stringify(selector));return ['ok',t('등록 선택자를 복사했습니다. 조직 관리자의 범위 승인 화면에 붙여 넣으세요. 승인은 별도로 진행됩니다.','Registration selection copied. Paste it into your organization manager’s scope approval panel. Approval is a separate step.')]})}>{t('현재 등록 선택자 복사','Copy current registration selection')}</OsButton></div>}
    {(canContinue||canRecover)&&<div className={os.line}><p className={`${os.lineCopy} ${os.hint}`}>{canRecover?t('발행 결과가 불확실합니다. 현재 소유자와 원래 기록을 검토한 뒤 명시적으로 복구하세요.','Publication is uncertain. Review the current owner and original record before explicitly recovering.'):t('직원 등록을 마친 뒤 원래 요약을 검토하세요.','After employee enrollment, review the original summary.')}</p>
     <OsButton variant="secondary" disabled={busy} onClick={()=>void run('receipt',async()=>{setCanContinue(false);setCanRecover(false);const result=await api().continuePublication({acceptanceId:acceptance});setCanContinue(result.publication==='awaiting-enrollment');setTrack(previous=>previous?{...previous,publication:result.publication}:previous);return result.publication==='published'?['ok',t('원래 요약의 조직 보고 발행을 확인했습니다.','Publication of the original summary is confirmed.')]:result.publication==='awaiting-enrollment'?['warn',t('직원 등록이 아직 필요합니다. 발행은 실행되지 않았습니다.','Employee enrollment is still required. Publication was not executed.')]:['warn',t('발행됐는지 확인하지 못했습니다. 다시 발행하지 말고 ‘수신 확인’으로 상태를 확인하세요.','Publication could not be confirmed. Do not publish again; use “Check receipt” to see its status.')]})}>{canRecover?t('원래 발행 복구 검토','Review original publication recovery'):t('원래 요약 검토 후 발행 계속','Review original summary and continue publication')}</OsButton></div>}
    {notice(note('receipt'))}
   </div>}
  </OsCard>

  <BusinessEmployeeAgentTransfer locale={locale} step={3} />

  <OsDangerZone ko={ko} title={t('조직 공유 중지','Stop organization sharing')} description={t('이 기기의 조직 공유 연결을 철회합니다.','Revoke this device’s organization sharing connection.')} actionLabel={t('조직 공유 중지','Stop sharing')} confirmTitle={t('조직 공유를 중지할까요?','Stop organization sharing?')} consequence={t('철회하면 이 기기는 작업 요약을 더 공유할 수 없습니다. 다시 공유하려면 조직에서 새 연결 요청을 받아 승인해야 합니다.','Once revoked, this device can no longer share work summaries. To share again, approve a new connection request from your organization.')} confirmLabel={t('공유 중지','Stop sharing')} onConfirm={()=>void run('stop',async()=>{setCanContinue(false);setCanRecover(false);const result=await api().revoke();setLink('idle');return result.state==='revoked'?['ok',t('이 기기의 조직 공유 연결을 철회했습니다.','Organization sharing from this device was revoked.')]:['warn',t('로컬 공유를 중지했습니다. 조직 확인은 대기 중입니다.','Local sharing has stopped; organization confirmation is pending.')]})} />
  {notice(note('stop'))}
 </OsRoot>;
}
