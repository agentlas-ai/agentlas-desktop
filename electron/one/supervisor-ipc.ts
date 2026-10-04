import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { oneSupervisor } from "./supervisor";

export function registerOneSupervisorIpc(input:{ipc:Pick<IpcMain,"handle">;assertTrustedSender:(event:IpcMainInvokeEvent)=>void}):void {
  for (const [method,action] of Object.entries({
    snapshot:()=>oneSupervisor().snapshot(),
    send:(value:any)=>oneSupervisor().send(value),
    startWork:(value:any)=>oneSupervisor().startWork(value),
    startScience:(value:any)=>oneSupervisor().startScience(value),
    control:(value:any)=>oneSupervisor().control(value),
    stopReply:(value:any)=>oneSupervisor().stopReply(value),
    appearance:(value:any)=>oneSupervisor().appearance(value),
  })) input.ipc.handle(`oneSupervisor:${method}`,(event,value)=>{input.assertTrustedSender(event);return action(value);});
}
