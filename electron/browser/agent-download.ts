import { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { nativeBrowserTaskOwner, nativeBrowserGuest, nativeBrowserGuestDocument, nativeBrowserGuestIdentity,
  listWorkBrowserTabs, sanitizeWorkLiveUrl } from "../work-live-view";
import { onHostShutdown } from "../host-lifecycle";
import { ensureBrowserDownloadRegistry, registerAgentDownloadTicket, type AgentDownloadIdentity, type AgentDownloadResult } from "./download-registry";

function sourceGuest(chatId: string) {
  const owner = nativeBrowserTaskOwner(chatId);
  if (!owner) return null;
  const tabs = listWorkBrowserTabs(owner.ownerId,chatId);
  const tab = tabs.find(tab => tab.visible) ?? (tabs.length === 1 ? tabs[0] : null);
  if (!tab) return null;
  const contents = nativeBrowserGuest(owner.ownerId,chatId,tab.viewId);
  const document = nativeBrowserGuestDocument(owner.ownerId,chatId,tab.viewId);
  return contents && document ? {owner,contents,document,viewId:tab.viewId} : null;
}

export function canUseAgentBrowserDownload(chatId: string): boolean { return sourceGuest(chatId) !== null; }

/** A dedicated, never-attached guest provides actual request causality. User
 * input and scripts in the visible page cannot trigger this guest's download. */
export async function downloadInTaskBrowser(input: {url:string;identity:AgentDownloadIdentity;signal:AbortSignal;current:()=>boolean}): Promise<AgentDownloadResult> {
  const url = sanitizeWorkLiveUrl(input.url), source = sourceGuest(input.identity.chatId);
  if (!url || url.toString() !== input.url || !source || input.signal.aborted || !input.current()) throw new Error("browser_download_scope_unavailable");
  ensureBrowserDownloadRegistry(nativeBrowserGuestIdentity);
  const view = new WebContentsView({webPreferences:{session:source.contents.session,nodeIntegration:false,contextIsolation:true,sandbox:true}});
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({action:"deny"}));
  const current = () => {
    const owner = nativeBrowserTaskOwner(input.identity.chatId);
    const document = nativeBrowserGuestDocument(source.owner.ownerId,input.identity.chatId,source.viewId);
    return !input.signal.aborted && input.current() && owner?.window === source.owner.window
      && owner.ownerId === source.owner.ownerId && !source.contents.isDestroyed()
      && document?.webContentsId === source.document.webContentsId && document.navigationEpoch === source.document.navigationEpoch;
  };
  return new Promise<AgentDownloadResult>((resolve,reject) => {
    let settled = false;
    let unregister: (()=>void) | undefined, shutdown: (()=>void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
    const finish = (result:AgentDownloadResult|null, reason="browser_download_incomplete") => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearInterval(poll);
      input.signal.removeEventListener("abort",abort);
      source.owner.window.removeListener("closed",abort);
      shutdown?.();
      try { unregister?.(); } catch { /* Cleanup is unconditional even if history persistence failed. */ }
      try { if (!contents.isDestroyed()) contents.close(); } catch { /* Already destroyed. */ }
      if (result) resolve(result); else reject(new Error(reason));
    };
    const abort = () => finish(null,"browser_download_cancelled");
    try {
      unregister = registerAgentDownloadTicket(contents.id,{
        owner:{ownerId:source.owner.ownerId,taskScopeId:input.identity.chatId,viewId:`download_guest_${randomUUID().replace(/-/g,"")}`},
        identity:input.identity,url:input.url,current,
        acceptUrls: urls => urls.length > 0 && urls.every(value => sanitizeWorkLiveUrl(value) !== null),
        finish:(result,reason)=>finish(result && current() ? result : null,reason),
      });
      input.signal.addEventListener("abort",abort,{once:true});
      source.owner.window.once("closed",abort);
      shutdown=onHostShutdown(abort);
      timer=setTimeout(()=>finish(null,"browser_download_timeout"),60_000);
      poll=setInterval(()=>{if(!current())finish(null,"browser_download_scope_changed");},50);
      if (!current()) return finish(null,"browser_download_scope_changed");
      contents.downloadURL(input.url);
    } catch { finish(null,"browser_download_dispatch_failed"); }
  });
}
