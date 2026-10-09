import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { oneSupervisorEndpoint } from "./supervisor-native-runtime";

export function registerOneSupervisorIpc(input:{ipc:Pick<IpcMain,"handle">;assertTrustedSender:(event:IpcMainInvokeEvent)=>void}):void {
  for (const [method,action] of Object.entries({
    snapshot:()=>oneSupervisorEndpoint().snapshot(),
    send:(value:any)=>oneSupervisorEndpoint().send(value),
    startWork:(value:any)=>oneSupervisorEndpoint().startWork(value),
    startScience:(value:any)=>oneSupervisorEndpoint().startScience(value),
    control:(value:any)=>oneSupervisorEndpoint().control(value),
    stopReply:(value:any)=>oneSupervisorEndpoint().stopReply(value),
    appearance:(value:any)=>oneSupervisorEndpoint().appearance(value),
    journal:(value:any)=>oneSupervisorEndpoint().journal(value),
    receipt:(value:any)=>oneSupervisorEndpoint().receipt(value),
    stopTask:(value:any)=>oneSupervisorEndpoint().stopTask(value),
    checkin:(value:any)=>oneSupervisorEndpoint().checkin(value),
    budgets:(value:any)=>oneSupervisorEndpoint().budgets(value),
    budgetConfigure:(value:any)=>oneSupervisorEndpoint().budgetConfigure(value),
  })) input.ipc.handle(`oneSupervisor:${method}`,(event,value)=>{input.assertTrustedSender(event);return action(value);});
}
