import { shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { isAppControlEvent } from '../app-control/ipc-registry';
import { onePersonalDataEndpoint, dispatchOnePersonalDataNative, onePersonalDataFileToOpen, type resolveOnePersonalDataSpaceLink } from './personal-data-runtime';
import { openOneWindow } from '../one-window-manager';
import { callOneSupervisorRuntime, supervisorRuntimeMode } from './supervisor-native-runtime';
const METHODS = ['bootstrap','listTargets','createTarget','selectTarget','connectorCatalog','registerSource','snapshot','create','edit','collect','sourceControl','accept','cancelProposal','rebaseProposal','cancelInference','followUp'] as const;
export function registerOnePersonalDataIpc(input: { ipc: Pick<IpcMain,'handle'>; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  for (const method of METHODS) input.ipc.handle(`onePersonalData:${method}`, async (event, ...args) => {
    input.assertTrustedSender(event);
    if (isAppControlEvent(event)) throw new Error('personal_data_dedicated_port_required');
    if(args.length>1)throw new Error('personal_data_invalid_input');
    try { return await (onePersonalDataEndpoint()[method] as (...values: unknown[])=>unknown)(...args); }
    catch(error){const code=(error as {code?:unknown})?.code;throw new Error(typeof code==='string'&&/^personal_data_[a-z_]{1,80}$/.test(code)?code:'personal_data_unavailable');}
  });
  input.ipc.handle('onePersonalData:openSpaceLink',async(event,value,...extras)=>{
    input.assertTrustedSender(event);
    if(isAppControlEvent(event)||extras.length)throw new Error('personal_data_dedicated_port_required');
    if(supervisorRuntimeMode()==='handoff')throw new Error('personal_data_owner_handoff_pending');
    const resolution=(supervisorRuntimeMode()==='daemon'
      ?await callOneSupervisorRuntime('personal.command',{method:'resolveSpaceLink',args:[value]})
      :await dispatchOnePersonalDataNative('resolveSpaceLink',[value])) as ReturnType<typeof resolveOnePersonalDataSpaceLink>;
    if(resolution.kind==='conversation')await openOneWindow({taskId:resolution.taskId});
    else if(resolution.kind==='file'){
      // Re-read the exact native file and ACL after the owner response, before OS opening.
      const error=await shell.openPath(onePersonalDataFileToOpen(value.target,resolution.ref));
      if(error)throw new Error('personal_data_file_open_unconfirmed');
    }
  });
}
