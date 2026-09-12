"use client";
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ChatInput } from './ChatInput';
import { ipc, ipcEvents } from '@/lib/ipc';
import { navigate } from '@/lib/navigation';
import { useT } from '@/lib/i18n';
import { isUserFacingProjectPoolMember } from '@/lib/project-agent-roster';
import { pendingWorkStart, persistWorkStart, workStartBridge } from '@/lib/work-start-intent';
import type { InstalledAgent, Project, RuntimeSelection, RuntimeStatus } from '@/lib/types';
import menus from './PanelPopover.module.css';
import styles from './WorkWorkspaceEntry.module.css';

type SendOptions=Parameters<ComponentProps<typeof ChatInput>['onSend']>[1];
export function WorkWorkspaceEntry(){
  const {locale}=useT(),ko=locale==='ko';
  const [projects,setProjects]=useState<Project[]>([]),[agents,setAgents]=useState<InstalledAgent[]>([]),[projectId,setProjectId]=useState<string|null>(null);
  const [runtimeLoaded,setRuntimeLoaded]=useState(false);
  const [runtime,setRuntime]=useState<RuntimeStatus|null>(null),[selection,setSelection]=useState<RuntimeSelection|undefined>(),[models,setModels]=useState<NonNullable<ComponentProps<typeof ChatInput>['modelOptions']>>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[prefill,setPrefill]=useState<string|null>(null),[menu,setMenu]=useState(false);
  const selectionRef=useRef(selection);selectionRef.current=selection;
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),generation=useRef(0),submitting=useRef(false);
  const project=projects.find(p=>p.id===projectId),members=(project?.agentPool??[]).filter(m=>isUserFacingProjectPoolMember(m,agents));
  useEffect(()=>{
    let disposed=false;
    const refresh=()=>{const request=++generation.current;const api=ipc();if(!api){setError(ko?'앱 연결을 확인한 뒤 다시 시도해 주세요.':'The app bridge is unavailable.');return;}
      void Promise.all([api.projects.list(),api.team.list(),api.runtime.detect()]).then(([p,a,r])=>{if(disposed||request!==generation.current)return;setProjects(p);setAgents(a);setRuntimeLoaded(true);const pin=selectionRef.current;setRuntime((pin?r.find(item=>item.kind===pin.kind&&item.backend===pin.backend&&item.source===pin.source):r.find(item=>item.active))??null);}).catch(()=>{if(!disposed)setError(ko?'프로젝트와 모델 상태를 읽지 못했습니다.':'Project and model status could not be read.');});};
    refresh();const off=ipcEvents()?.onStoreChanged?.(event=>{if(['project','runtime','agent'].includes(event.entity))refresh();});
    const pending=pendingWorkStart();if(pending){setPrefill(pending.prompt);setProjectId(pending.projectId??null);setSelection(pending.runtimeSelection);}
    return()=>{disposed=true;off?.();};
  },[ko]);
  useEffect(()=>{if(!runtime)return;let disposed=false;void ipc()?.runtime.listModels({kind:runtime.kind,backend:runtime.backend,availableModels:runtime.availableModels}).then(result=>{if(!disposed)setModels(result);}).catch(()=>{if(!disposed)setModels([]);});return()=>{disposed=true;};},[runtime?.kind,runtime?.backend,runtime?.source]);
  useEffect(()=>{if(!menu)return;const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setMenu(false);};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenu(false);trigger.current?.focus();}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key);};},[menu]);
  const exactSelection=selection??(runtime?{kind:runtime.kind,backend:runtime.backend,source:runtime.source,model:runtime.model??undefined,effort:runtime.effort??undefined,longContext:runtime.longContextEnabled}:undefined);
  const selectedRuntime=runtime?{...runtime,model:exactSelection?.model??runtime.model,effort:exactSelection?.effort??runtime.effort}:null;
  async function start(text:string,options?:SendOptions){
    if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try{const bridge=workStartBridge();if(!bridge)throw new Error(ko?'작업 시작 연결을 사용할 수 없습니다.':'Work start is unavailable.');
      if(!exactSelection)throw new Error(ko?'사용할 모델을 연결해 주세요. 입력은 보존됩니다.':'Connect a model to start. Your request is preserved.');
      const intent=persistWorkStart({prompt:text,...(projectId?{projectId}:{}),runtimeSelection:exactSelection,options});const result=await bridge.create(intent);
      if(result.intentId!==intent.intentId||result.prompt!==text)throw new Error('work_start_receipt_mismatch');
      window.dispatchEvent(new Event('agentlas:projects-changed'));navigate(`/workspace/task?id=${encodeURIComponent(result.chatId)}&workStart=${encodeURIComponent(result.intentId)}`);
    }catch(cause){setPrefill(text);setError(ko?'작업을 시작하지 못했습니다. 입력은 보존했습니다. 모델과 프로젝트 연결을 확인한 뒤 다시 보내 주세요.':'Work could not start. Your input is preserved. Check the model and project connection, then send again.');}finally{submitting.current=false;setBusy(false);}
  }
  return <section className={styles.entry} data-work-entry>
    <header className={`${styles.header} titlebar-drag`}>
      <div className={`${styles.projectMenu} titlebar-nodrag`} ref={root}>
        <button ref={trigger} type="button" className={styles.projectTrigger} aria-expanded={menu} aria-haspopup="menu" onClick={()=>setMenu(v=>!v)}><span aria-hidden>▱</span><span>{project?.name??(ko?'새 작업':'New work')}</span><span aria-hidden>⌄</span></button>
        {menu&&<div role="menu" aria-label={ko?'프로젝트와 에이전트':'Projects and agents'} className={`${menus.panelPopover} ${styles.menu}`}>
          <button role="menuitem" className={menus.panelMenuRow} onClick={()=>{setProjectId(null);setMenu(false);trigger.current?.focus();}}>{ko?'새 프로젝트에서 시작':'Start a new project'}<span aria-hidden>＋</span></button>
          <div className={menus.panelMenuSeparator}/>
          <div className={styles.projectList}>{projects.map(item=><button role="menuitemradio" aria-checked={item.id===projectId} key={item.id} className={menus.panelMenuRow} onClick={()=>{setProjectId(item.id);setMenu(false);trigger.current?.focus();}}><span className={styles.ellipsis}>{item.name}</span><span>{item.id===projectId?'✓':''}</span></button>)}</div>
          {project&&<><div className={menus.panelMenuSeparator}/><span className={menus.panelMenuLabel}>{ko?'프로젝트 에이전트':'Project agents'}</span>{members.map(member=><span key={`${member.source}:${member.targetId}`} className={menus.panelMenuRow}>{member.nameSnapshot}</span>)}<button role="menuitem" className={menus.panelMenuRow} onClick={()=>navigate(`/project/detail?id=${encodeURIComponent(project.id)}`)}>{ko?'에이전트와 프로젝트 설정':'Agents and project settings'}<span aria-hidden>↗</span></button></>}
          <div className={menus.panelMenuSeparator}/><button role="menuitem" className={menus.panelMenuRow} onClick={()=>navigate('/project/new')}>{ko?'폴더·저장소 연결':'Connect folder or repository'}<span aria-hidden>↗</span></button>
        </div>}
      </div>
      <span className={styles.brand}>Agentlas Work</span>
    </header>
    <main className={styles.conversation}><div className={styles.welcome}><h1>{ko?'어떤 일을 시작할까요?':'What would you like to work on?'}</h1><p>{ko?'원하는 결과를 적으면 프로젝트와 대화가 함께 준비됩니다.':'Describe the result. Your project and conversation will be prepared together.'}</p></div></main>
    <div className={styles.composer}>
      <ChatInput onSend={(text,options)=>{void start(text,options);}} busy={busy} runtime={selectedRuntime} modelOptions={models} onSelectModel={model=>{if(exactSelection)setSelection({...exactSelection,model});}} onSelectEffort={effort=>{if(exactSelection)setSelection({...exactSelection,effort});}} activeChatId="work-entry-draft" prefillText={prefill} activeProjectId={projectId} projectOrchestration placeholder={ko?'원하는 결과를 설명하세요':'Describe the result you want'}/>
      {error&&<p className={styles.notice} role="alert">{error}</p>}
      {!runtime&&!error&&<p className={styles.notice}>{runtimeLoaded?(ko?'연결된 모델을 선택해 주세요. 입력은 보존됩니다.':'Choose a connected model. Your request is preserved.'):(ko?'모델 연결을 확인하고 있습니다. 먼저 요청을 적어 두세요.':'Checking your model connection. You can write your request now.')} <button onClick={()=>navigate('/settings')}>{ko?'모델 설정':'Model settings'}</button></p>}
    </div>
  </section>;
}
