import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { isAppControlEvent } from '../app-control/ipc-registry';
import { registerOnePersonalIntegrationIpc } from './personal-integrations-glue';
import { currentOnePersonalIntegrationActor, currentOnePersonalIntegrationEpoch, assertOnePersonalIntegrationCurrentOwner, dispatchOnePersonalIntegrationNative } from './personal-integrations-runtime';
import { supervisorRuntimeMode, callOneSupervisorRuntime } from './supervisor-native-runtime';
import { personalDataError, personalDataHash } from './personal-data-store';

/** Origin is the actual current owner window/top frame; a copied renderer payload has no review authority. */
export function registerOnePersonalIntegrationMainIpc(input:{ipc:Pick<IpcMain,'handle'>;assertTrustedSender(event:IpcMainInvokeEvent):void;isOwnerWindow(window:BrowserWindow):boolean}):void{
  const assertSender=(event:IpcMainInvokeEvent)=>{input.assertTrustedSender(event);const window=BrowserWindow.fromWebContents(event.sender);
    if(!window||window.isDestroyed()||!input.isOwnerWindow(window)||event.senderFrame!==event.sender.mainFrame)throw personalDataError('personal_integration_owner_window_required');return window;};
  registerOnePersonalIntegrationIpc({ipc:input.ipc,assertTrustedSender:assertSender,isAppControlEvent,mode:supervisorRuntimeMode,
    local:{dispatch:dispatchOnePersonalIntegrationNative},invokeOwner:(method,value)=>callOneSupervisorRuntime('personal.command',{method,args:value===undefined?[]:[value]}),
    reviewContext:event=>{const window=assertSender(event),actor=currentOnePersonalIntegrationActor(),digest=personalDataHash(actor),frame=event.senderFrame,url=frame?.url,epoch=currentOnePersonalIntegrationEpoch();
      const assertCurrent=()=>{assertSender(event);assertOnePersonalIntegrationCurrentOwner();if(window.isDestroyed()||!window.isFocused()||event.senderFrame!==frame||frame?.url!==url||personalDataHash(currentOnePersonalIntegrationActor())!==digest||currentOnePersonalIntegrationEpoch()!==epoch)throw personalDataError('personal_integration_native_review_changed');};
      assertCurrent();return {window,actor,assertCurrent};},
    // An authenticated daemon GUI review bridge must supply an original challenge/current-grant proof.
    // No Main-local fallback or renderer-provided approval exists while daemon owns the single Supervisor.
  });
}
