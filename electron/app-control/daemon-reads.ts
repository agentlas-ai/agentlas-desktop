import { appControlHandlerRegistered, recordAppControlDomainHandler } from "./ipc-registry";

/*
 * App operations the background service answers itself, without the window process.
 *
 * One/Hope turns run in the daemon while the app is closed, restarting or updating. Every app operation used to be asked of Main over
 * the device bridge, so while Main was away even a plain read of the database (the team's resolved org, an automation, a chat's latest
 * receipt) was refused as app-window-unavailable (production 35 refusals in two chats).
 *
 * This list is closed and exact, and every entry is the very call Main's handler makes (ipc.ts registerAppControlDomainIpc, same channel,
 * same store function): operations that only read the owner's database. They go through appControlCallLocal like any call, so the
 * catalog policy, the argument decoder, the read-permission rule, the receipt and the result clipping are Main's own code, not a copy.
 * Anything that needs a window, a dialog, the owner's interaction or a screen stays Main's (the device bridge) and is never listed here.
 */
export const DAEMON_APP_CONTROL_READ_CHANNELS: ReadonlyMap<string, (...args: any[]) => unknown> = new Map<string, (...args: any[]) => unknown>([
  ["firms:getResolvedOrg", (id: string) => {
    const firm = (require("../store/firms") as typeof import("../store/firms")).getFirm(id);
    return firm ? (require("../store/org-spec") as typeof import("../store/org-spec")).getResolvedOrg(firm) : null;
  }],
  ["automations:list", () => {
    const { automationWorkspaceView } = require("../automation-workspace") as typeof import("../automation-workspace");
    return (require("../store/automations") as typeof import("../store/automations")).listAutomations().map(automationWorkspaceView);
  }],
  ["automations:get", (id: string) => {
    const a = (require("../store/automations") as typeof import("../store/automations")).getAutomation(id);
    return a ? (require("../automation-workspace") as typeof import("../automation-workspace")).automationWorkspaceView(a) : null;
  }],
  ["automations:listRuns", (id: string, limit?: number) =>
    (require("../store/automations") as typeof import("../store/automations")).listRunHistory(id, limit ?? 50)],
  ["automations:runCounts", (id: string, since?: string | null, until?: string | null) =>
    (require("../store/automations") as typeof import("../store/automations")).countRunHistory(id, since, until)],
  ["invoke:latestReceipt", (chatId: string) =>
    (require("../invocation/service") as typeof import("../invocation/service")).invocationService.latestReceipt(chatId)],
]);

let registered = false;

/** True when the background service can answer this catalog channel itself (registering the read handlers on first use). */
export function daemonServesAppControlChannel(channel: string): boolean {
  if (!DAEMON_APP_CONTROL_READ_CHANNELS.has(channel)) return false;
  if (!registered) {
    registered = true;
    for (const [name, handler] of DAEMON_APP_CONTROL_READ_CHANNELS) {
      // A handler Main registered in this process is never replaced.
      if (!appControlHandlerRegistered(name)) recordAppControlDomainHandler(name, handler);
    }
  }
  return appControlHandlerRegistered(channel);
}
