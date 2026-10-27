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
    // Read in this process from the shared store whichever host runs the personal agent (owner 2026-10-27).
    supervisedRooms:async(value:any)=>(await import("./supervised-approvals")).supervisedRoomsAmong(value),
    // "내가 직접 이어가기" (owner 2026-10-27): the owner takes a personal agent's room back. Renderer only; the model's
    // app.call to oneSupervisor.* is refused (app-control/policy.ts).
    releaseRoom:async(value:any)=>(await import("./personal-agent-rooms")).releasePersonalAgentRoom(value),
  })) input.ipc.handle(`oneSupervisor:${method}`,(event,value)=>{input.assertTrustedSender(event);return action(value);});
}
