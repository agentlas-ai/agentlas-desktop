import type {HistoryWorkOwner} from './history-work-owner';
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { isAppControlEvent } from '../app-control/ipc-registry';
import { registerOnePersonalIntegrationIpc } from './personal-integrations-glue';
import { currentOnePersonalIntegrationActor, currentOnePersonalIntegrationEpoch, assertOnePersonalIntegrationCurrentOwner, dispatchOnePersonalIntegrationNative } from './personal-integrations-runtime';
import { supervisorRuntimeMode, callOneSupervisorRuntime } from './supervisor-native-runtime';
import { personalDataError, personalDataHash } from './personal-data-store';
import type { GmailPersonalSourceOwner } from './gmail-personal-source-owner';

/** Origin is the actual current owner window/top frame; a copied renderer payload has no review authority. */
export function registerOnePersonalIntegrationMainIpc(input:{ipc:Pick<IpcMain,'handle'>;assertTrustedSender(event:IpcMainInvokeEvent):void;isOwnerWindow(window:BrowserWindow):boolean;gmailSourceOwner?:GmailPersonalSourceOwner;historyWorkOwner?:HistoryWorkOwner;lifetime?:{ready():boolean;currentEpoch():number}}):void{
  const assertSender=(event:IpcMainInvokeEvent)=>{input.assertTrustedSender(event);const window=BrowserWindow.fromWebContents(event.sender);
    if(!window||window.isDestroyed()||!input.isOwnerWindow(window)||event.senderFrame!==event.sender.mainFrame)throw personalDataError('personal_integration_owner_window_required');return window;};
  const reviewContext=(event:IpcMainInvokeEvent)=>{const window=assertSender(event),actor=currentOnePersonalIntegrationActor(),digest=personalDataHash(actor),frame=event.senderFrame,url=frame?.url,epoch=currentOnePersonalIntegrationEpoch(),hostEpoch=input.lifetime?.currentEpoch();
    const assertCurrent=()=>{assertSender(event);assertOnePersonalIntegrationCurrentOwner();if(window.isDestroyed()||!window.isFocused()||event.senderFrame!==frame||frame?.url!==url||personalDataHash(currentOnePersonalIntegrationActor())!==digest||currentOnePersonalIntegrationEpoch()!==epoch||input.lifetime&&(input.lifetime.ready()!==true||input.lifetime.currentEpoch()!==hostEpoch))throw personalDataError('personal_integration_native_review_changed');};
    assertCurrent();return {window,actor,assertCurrent};};
  registerOnePersonalIntegrationIpc({ipc:input.ipc,assertTrustedSender:assertSender,isAppControlEvent,mode:supervisorRuntimeMode,
    local:{dispatch:dispatchOnePersonalIntegrationNative},invokeOwner:(method,value)=>callOneSupervisorRuntime('personal.command',{method,args:value===undefined?[]:[value]}),
    reviewContext,
    // An authenticated daemon GUI review bridge must supply an original challenge/current-grant proof.
    // No Main-local fallback or renderer-provided approval exists while daemon owns the single Supervisor.
  });
  // Settings are a Main-local, focused native source review, separate from daemon commands and OAuth.
  const sourceOwner=input.gmailSourceOwner;
  const sourceMethods={gmailSourceSettings:'settings',gmailConfigureSource:'configure',gmailTestSource:'test',gmailRevokeSource:'revoke'} as const;
  for(const [method,action] of Object.entries(sourceMethods)){
    const original=sourceOwner?.[action];
    input.ipc.handle(`onePersonalData:${method}`,async(event,value,...extras)=>{
      assertSender(event);
      if(isAppControlEvent(event)||extras.length)throw personalDataError('personal_integration_dedicated_port_required');
      const mode=supervisorRuntimeMode();
      if(mode==='handoff')throw personalDataError('personal_integration_owner_handoff_pending');
      if(mode!=='local')throw personalDataError('personal_integration_native_review_bridge_required');
      if(!sourceOwner||!original||sourceOwner[action]!==original||!input.lifetime||input.lifetime.ready()!==true)throw personalDataError('gmail_personal_source_owner_unavailable');
      try{
        const context=reviewContext(event);context.assertCurrent();
        const result=await (original as (...args:any[])=>unknown).call(sourceOwner,value,...(action==='settings'?[]:[context]));
        context.assertCurrent();
        if(sourceOwner[action]!==original||supervisorRuntimeMode()!=='local')throw personalDataError('personal_integration_native_review_changed');
        return result;
      }catch(error){const code=(error as {code?:unknown})?.code;throw personalDataError(typeof code==='string'&&/^(?:personal_integration|gmail_personal)_[a-z_]{1,80}$/.test(code)?code:'personal_integration_unavailable');}
    });
  }
  const work=input.historyWorkOwner;
  const workMethods={historyWorkStatus:'status',historyWorkRegister:'register',historyWorkOracle:'configureOracle',historyWorkStartApply:'startApply',historyWorkReceipt:'status',historyWorkRevoke:'revoke'} as const;
  for(const [method,action] of Object.entries(workMethods)){
    const original=work?.[action];input.ipc.handle(`onePersonalData:${method}`,async(event,value,...extras)=>{
      assertSender(event);if(isAppControlEvent(event)||extras.length||!work||!original||work[action]!==original)throw personalDataError('history_work_dedicated_port_required');
      if(action==='revoke')return work.revoke(value);
      if(supervisorRuntimeMode()!=='local'||!input.lifetime?.ready())throw personalDataError('personal_integration_native_review_bridge_required');
      const context=reviewContext(event);const result=await(original as (...args:any[])=>unknown).call(work,value,context);context.assertCurrent();
      if(work[action]!==original||supervisorRuntimeMode()!=='local')throw personalDataError('history_work_owner_changed');return result;
    });
  }

}
