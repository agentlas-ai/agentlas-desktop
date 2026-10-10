import type {BrowserWindow,IpcMainInvokeEvent,Session} from 'electron';
// Electron is loaded on use: the background service (ELECTRON_RUN_AS_NODE) reaches this module through
// invocation and MCP code and has no 'electron' module, so a top-level import crashed it on every start (1.2.84).
const electron=():typeof import('electron')=>require('electron') as typeof import('electron');
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {OneVaultError,type OneVaultEnvelope,type OneVaultStatusQuery} from '../../shared/one-vault';
import {OneVaultService,type OneVaultSurface} from './one-vault-service';
export const ONE_VAULT_WINDOW_CHANNELS=Object.freeze({bootstrap:'oneVault:bootstrap',registerSender:'oneVault:registerSender',submit:'oneVault:submit',reconcile:'oneVault:reconcile',cancel:'oneVault:cancel',changed:'oneVault:changed'});
export interface OneVaultWindowPorts {
 service:OneVaultService;
 /** Existing compiled preload path; parent adds a minimal --one-vault-window early branch. */
 preloadPath:string;
 /** Trusted Main configuration only. Production agentlas://app; development loopback only. */
 rendererBaseUrl:string;
 /** Existing scheme handler must be registered on the isolated in-memory session. */
 prepareSession(session:Session):void|Promise<void>;
 acquireSensitiveSurface(webContentsId:number,requestId:string):()=>void;
 onClosed?():void;
}
interface Held {window:BrowserWindow;surface:OneVaultSurface;requestId:string|null;url:string;release:()=>void;confirming:boolean;loaded:boolean;closing:boolean}
/** Single dedicated native surface; no exported generic renderer registration or secret-valued IPC. */
export class OneVaultWindowManager {
 private held:Held|null=null;private opening=false;private registered=false;
 constructor(private readonly p:OneVaultWindowPorts){}
 private exactUrl(raw:string,expected:string):boolean{try{const url=new URL(raw);return !url.username&&!url.password&&url.href===expected;}catch{return false;}}
 private sender(event:IpcMainInvokeEvent,requireFocused=false):Held {
  const h=this.held;
  if(!h||h.closing||h.window.isDestroyed()||event.sender!==h.window.webContents||event.senderFrame!==event.sender.mainFrame||!event.senderFrame||!this.exactUrl(event.senderFrame.url,h.url)||!this.exactUrl(event.sender.getURL(),h.url)||!h.surface.ready()||(requireFocused&&!h.window.isFocused()))throw new OneVaultError('secure_route_unavailable');return h;
 }
 isDedicatedWebContents(id:number):boolean{return !!this.held&&!this.held.window.isDestroyed()&&this.held.window.webContents.id===id;}
 private close(h:Held,reason:'cancelled'|'expired'|'background'):void {
  if(h.closing)return;h.closing=true;
  // Hide before releasing capture barrier: no observable frame can retain input.
  if(!h.window.isDestroyed())h.window.hide();
  this.p.service.cancel(h.surface,h.requestId,reason);
  h.release();if(!h.window.isDestroyed())h.window.destroy();
  if(this.held===h)this.held=null;this.p.onClosed?.();
 }
 private safe<T>(run:()=>Promise<T>|T):Promise<T>{return Promise.resolve().then(run).catch(error=>{throw new OneVaultError(error instanceof OneVaultError?error.code:'secure_route_unavailable');});}
 registerIpc():void {
  if(this.registered)return;this.registered=true;
  electron().ipcMain.handle(ONE_VAULT_WINDOW_CHANNELS.bootstrap,event=>this.safe(()=>this.p.service.bootstrap(this.sender(event).surface)));
  electron().ipcMain.handle(ONE_VAULT_WINDOW_CHANNELS.registerSender,(event,input)=>this.safe(()=>this.p.service.registerSender(this.sender(event,true).surface,input)));
  electron().ipcMain.handle(ONE_VAULT_WINDOW_CHANNELS.submit,(event,requestId:unknown,envelope:OneVaultEnvelope)=>this.safe(()=>{const h=this.sender(event,true);if(typeof requestId!=='string'||requestId!==h.requestId)throw new OneVaultError('not_found');return this.p.service.submit(h.surface,requestId,envelope);}));
  electron().ipcMain.handle(ONE_VAULT_WINDOW_CHANNELS.reconcile,(event,requestId:unknown,query:OneVaultStatusQuery)=>this.safe(()=>{const h=this.sender(event);if(typeof requestId!=='string'||requestId!==h.requestId)throw new OneVaultError('not_found');return this.p.service.reconcile(h.surface,requestId,query);}));
  electron().ipcMain.handle(ONE_VAULT_WINDOW_CHANNELS.cancel,(event,requestId:unknown,reason:unknown)=>this.safe(()=>{
   // Origin still required; close never depends on current auth/provider or request admission.
   const h=this.held;if(!h||event.sender!==h.window.webContents||event.senderFrame!==event.sender.mainFrame)return;
   if(requestId!==null&&requestId!==h.requestId)throw new OneVaultError('not_found');
   this.close(h,reason==='expired'?'expired':reason==='background'?'background':'cancelled');
  }));
 }
 /** Main-native owner action only; do not register a generic IPC taking commandId. */
 async open(commandId:string,options:{reconcileOnly?:boolean}={}):Promise<void>{
  if(this.opening||this.held)throw new OneVaultError('request_consumed');this.opening=true;let held:Held|null=null;let allocated:BrowserWindow|null=null;
  try{
   if(!path.isAbsolute(this.p.preloadPath))throw new OneVaultError('secure_route_unavailable');
   const base=new URL(this.p.rendererBaseUrl);
   if(!(base.protocol==='agentlas:'&&base.host==='app')&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw new OneVaultError('secure_route_unavailable');
   const url=new URL('/one-vault',base).href,ses=electron().session.fromPartition(`one-vault:${randomUUID()}`,{cache:false});
   await this.p.prepareSession(ses);
   ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
   ses.on('will-download',(event,item)=>{event.preventDefault();item.cancel();});
   ses.webRequest.onBeforeRequest((details,callback)=>{
    try{
     const resource=new URL(details.url),entry=new URL(url);
     const sameOrigin=entry.protocol===resource.protocol&&entry.host===resource.host;
     const staticAsset=resource.pathname.startsWith('/_next/static/')||resource.pathname.startsWith('/fonts/');
     callback({cancel:!(sameOrigin&&(resource.href===url||staticAsset))});
    }catch{callback({cancel:true});}
   });
   const win=new (electron().BrowserWindow)({width:540,height:780,minWidth:420,minHeight:600,title:'Agentlas — 연결 키 입력',show:false,autoHideMenuBar:true,webPreferences:{preload:this.p.preloadPath,additionalArguments:['--one-vault-window'],session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false,spellcheck:false,webviewTag:false}});
   allocated=win;win.setContentProtection(true);win.setMenu(null);
   const surfaceId=randomUUID();let released=false;const releaseNative=this.p.acquireSensitiveSurface(win.webContents.id,options.reconcileOnly?this.p.service.recoveryRequestId(commandId):surfaceId);
   const release=()=>{if(!released){released=true;releaseNative();}};
   const surface:OneVaultSurface={id:surfaceId,ready:()=>!released&&!win.isDestroyed()&&(!held?.loaded||this.exactUrl(win.webContents.getURL(),url)),close:()=>{if(held&&!held.closing)this.close(held,'cancelled');},changed:()=>{if(!win.isDestroyed())win.webContents.send(ONE_VAULT_WINDOW_CHANNELS.changed);},confirmSender:async (request,statusOnly)=>{
    if(!held||!win.isFocused()||released)throw new OneVaultError('authority_denied');held.confirming=true;
    try{
     const b=request.binding;
     const confirmation=await electron().dialog.showMessageBox(win,{type:'question',title:'연결 키 입력 승인',message:statusOnly?'이전 저장 작업의 상태 확인을 새 전용 창에 허용하시겠습니까?':'이 전용 창에서 연결 키 입력을 허용하시겠습니까?',detail:`${b.provider} · ${b.providerWorkspace} · ${b.region}\n저장 위치: 이 Desktop의 OS Vault\n범위: ${b.scope}\n요청: ${b.requestId}`,buttons:['허용','취소'],defaultId:1,cancelId:1,noLink:true});
     return confirmation.response===0&&!released&&!win.isDestroyed();
    }finally{if(held)held.confirming=false;}
   }};
   held={window:win,surface,requestId:null,url,release,confirming:false,loaded:false,closing:false};this.held=held;
   const h=held;
   win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   win.webContents.on('will-navigate',event=>{event.preventDefault();this.close(h,'background');});
   win.webContents.on('will-redirect',event=>{event.preventDefault();this.close(h,'background');});
   win.webContents.on('will-attach-webview',event=>event.preventDefault());
   win.webContents.on('context-menu',event=>event.preventDefault());
   win.webContents.on('before-input-event',(event,input)=>{/* Renderer owns Escape including IME/keyCode229/post-composition guards. */if((input.control||input.meta)&&['c','x','p','s','r'].includes(input.key.toLowerCase()))event.preventDefault();});
   win.webContents.on('render-process-gone',()=>this.close(h,'background'));
   win.on('blur',()=>{if(!h.confirming)this.close(h,'background');});
   win.on('hide',()=>{if(!h.closing)this.close(h,'background');});
   win.on('closed',()=>{release();this.p.service.cancel(surface,h.requestId,'cancelled');if(this.held===h)this.held=null;});
   const bootstrap=await this.p.service.open(commandId,surface,options);h.requestId=bootstrap.request?.binding.requestId??null;
   if(!h.requestId)throw new OneVaultError('secure_route_unavailable');
   await win.loadURL(url);h.loaded=true;
   if(!this.exactUrl(win.webContents.getURL(),url))throw new OneVaultError('secure_route_unavailable');
   win.show();win.focus();
  }catch(error){if(held)this.close(held,'cancelled');else if(allocated&&!allocated.isDestroyed())allocated.destroy();throw new OneVaultError(error instanceof OneVaultError?error.code:'secure_route_unavailable');}
  finally{this.opening=false;}
 }
 shutdown():void{if(this.held)this.close(this.held,'cancelled');}
}
