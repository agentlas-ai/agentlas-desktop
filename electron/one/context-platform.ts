import { BrowserWindow, desktopCapturer, nativeImage, powerMonitor, screen, shell, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OneContextReadiness, OneContextScope } from "../../shared/one-context";
import { invokeNativeInputDriver, nativeInputDriverAvailable } from "../computer-use/native-driver";
import { OneContextError, OneContextService, configureOneContextService, type ContextTarget } from "./context-service";
import { OneOsResourceLeaseBroker, configureOneOsLeaseBroker, type OneOsActionTarget, type OneOsExecutionBinding } from "./context-lease";

type WindowMetadata = { appName: string; windowId: number; pid: number; processStartMs: number; name: string; bundleIdentifier: string; active: boolean; bounds: { x: number; y: number; width: number; height: number } };
let session: OneContextReadiness["session"] = "awake";
let initialized = false;
export function oneContextReadiness(): OneContextReadiness {
  let screenPermission: OneContextReadiness["screenPermission"] = "unknown", accessibility: OneContextReadiness["accessibility"] = "unknown";
  let currentSession = session, humanBusy = true;
  try { const state = powerMonitor.getSystemIdleState(1); if (state === "locked") currentSession = "locked"; else if (state === "unknown") currentSession = "unknown";
    // Conservative safe point: idle time includes synthesized input too. Never add
    // an AI-input grace interval that would hide simultaneous human activity.
    humanBusy = powerMonitor.getSystemIdleTime() < 2;
  } catch { currentSession = "unknown"; }
  if (process.platform === "darwin") {
    try { screenPermission = systemPreferences.getMediaAccessStatus("screen"); } catch {}
    try { accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied"; } catch {}
  }
  const driverAvailable = nativeInputDriverAvailable();
  return { available: currentSession === "awake" && screenPermission === "granted", platform: process.platform, screenPermission, accessibility,
    session: currentSession, driverAvailable, humanBusy, observedAt: new Date().toISOString(),
    ...(currentSession !== "awake" ? { reasonCode: `one-context-${currentSession}` } : screenPermission !== "granted" ? { reasonCode: "one-context-screen-permission-unavailable" } : {}) };
}
export async function openOneContextPermissions(value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "kind")) throw new OneContextError("one-context-invalid-input");
  const kind = (value as {kind: unknown}).kind;
  if (kind !== "screen" && kind !== "accessibility") throw new OneContextError("one-context-invalid-permission");
  if (process.platform === "darwin") await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === "screen" ? "ScreenCapture" : "Accessibility"}`);
  else if (process.platform === "win32" && kind === "screen") await shell.openExternal("ms-settings:privacy-graphicscaptureprogrammatic");
  else throw new OneContextError("one-context-settings-unavailable");
}
async function nativeWindows(): Promise<WindowMetadata[]> {
  if (!nativeInputDriverAvailable()) return [];
  const result = await invokeNativeInputDriver({ action: "listCaptureTargets" });
  if (!result.ok || !Array.isArray(result.targets)) throw new OneContextError("one-context-target-metadata-unavailable");
  return result.targets.filter((row): row is WindowMetadata => !!row && typeof row === "object" && Number.isSafeInteger(row.windowId) && Number.isSafeInteger(row.pid)
    && Number.isFinite(row.processStartMs) && typeof row.name === "string" && row.bounds && [row.bounds.x,row.bounds.y,row.bounds.width,row.bounds.height].every(Number.isFinite));
}
function fingerprint(value: unknown): string { return JSON.stringify(value); }
function ownedWindows(): ContextTarget[] {
  return BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && !window.webContents.isDestroyed() && window.isVisible()).map(window => ({
    kind: "window", sourceId: `electron:${window.id}:${window.webContents.id}`, label: window.getTitle() || "Agentlas", owned: true,
    fingerprint: fingerprint([window.id,window.webContents.id,window.webContents.getURL()]), pid: process.pid, bounds: window.getBounds(),
    captureAvailable: true, interactionAvailable: false,
  }));
}
export async function oneContextTargets(kind: "window" | "display"): Promise<ContextTarget[]> {
  const ready = oneContextReadiness();
  if (kind === "window") {
    const own = ownedWindows(); const rows = await nativeWindows();
    return [...own,...rows.filter(row => row.pid !== process.pid).map((row): ContextTarget => ({ kind: "window", sourceId: `window:${row.windowId}:0`, label: row.name,
      pid: row.pid, processStartMs: row.processStartMs, bounds: row.bounds, fingerprint: fingerprint([row.windowId,row.pid,row.processStartMs,row.bounds]),
      captureAvailable: ready.screenPermission === "granted", interactionAvailable: ready.driverAvailable && ready.accessibility === "granted" }))];
  }
  // Zero-size thumbnails request source identifiers only, never screen pixels.
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: {width:0,height:0}, fetchWindowIcons: false });
  const displays = screen.getAllDisplays();
  return sources.flatMap(source => { const display = displays.find(item => String(item.id) === source.display_id); return display ? [{kind:"display" as const,sourceId:source.id,label:source.name,bounds:display.bounds,
    fingerprint:fingerprint([source.id,source.display_id,display.bounds,display.scaleFactor]),captureAvailable:ready.screenPermission === "granted",interactionAvailable:false}] : []; });
}
export async function oneContextTargetCurrent(target: ContextTarget): Promise<boolean> {
  return (await oneContextTargets(target.kind)).some(current => current.sourceId === target.sourceId && current.fingerprint === target.fingerprint);
}
async function captureExact(target: ContextTarget, signal: AbortSignal): Promise<{ dataUrl:string; capturedAt:string }> {
  if (signal.aborted) throw new OneContextError("one-context-revoked");
  if (target.owned) {
    const match = /^electron:(\d+):(\d+)$/.exec(target.sourceId), window = match ? BrowserWindow.fromId(Number(match[1])) : null;
    if (!window || window.webContents.id !== Number(match![2])) throw new OneContextError("one-context-target-stale");
    const pixels = await window.webContents.capturePage();
    if (signal.aborted) throw new OneContextError("one-context-revoked");
    return {dataUrl:pixels.toDataURL(),capturedAt:new Date().toISOString()};
  }
  if (process.platform !== "darwin") throw new OneContextError("one-context-platform-unavailable");
  const args = ["-x","-t","png"];
  if (target.kind === "window") { const match = /^window:(\d+):0$/.exec(target.sourceId); if (!match) throw new OneContextError("one-context-target-invalid"); args.push(`-l${match[1]}`); }
  else { const all = await oneContextTargets("display"), index = all.findIndex(row => row.sourceId === target.sourceId && row.fingerprint === target.fingerprint); if(index<0)throw new OneContextError("one-context-target-stale"); args.push(`-D${index+1}`); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"agentlas-one-context-")), file = path.join(dir,"capture.png");
  try {
    await new Promise<void>((resolve,reject) => execFile("/usr/sbin/screencapture",[...args,file],{signal,timeout:5000,windowsHide:true},error => error ? reject(new OneContextError(signal.aborted?"one-context-revoked":"one-context-capture-failed")):resolve()));
    if(signal.aborted)throw new OneContextError("one-context-revoked");
    const bytes = await fs.readFile(file); if(bytes.length>5_900_000)throw new OneContextError("one-context-capture-too-large");
    return {dataUrl:`data:image/png;base64,${bytes.toString("base64")}`,capturedAt:new Date().toISOString()};
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
function pointInside(bounds: NonNullable<ContextTarget["bounds"]>, point:{x:number;y:number}): boolean {
  return point.x>=bounds.x && point.y>=bounds.y && point.x<bounds.x+bounds.width && point.y<bounds.y+bounds.height;
}
/** Configure before IPC admission. Source/task checks are provided by the canonical local store. */
export function initializeOneContext(input:{activeOneId():string;assertTask(scope:OneContextScope):void}): void {
  if(initialized)return; initialized=true;
  let service: OneContextService;
  const validate = async(binding:Readonly<OneOsExecutionBinding>,action:OneOsActionTarget) => {
    if(binding.oneId!==input.activeOneId())throw new OneContextError("one-context-identity-changed"); input.assertTask(binding);
    const rows=await nativeWindows();
    let target=rows.find(row=>action.appTarget===`pid:${row.pid}` || action.appTarget===row.bundleIdentifier || action.appTarget===row.appName);
    if(!target)throw new OneContextError("one-os-target-unavailable");
    // The default cannot activate another foreground app. The owner can bring
    // the requested app forward; this safe point then admits its explicit task.
    if(action.resolvedPid!==undefined && (target.pid!==action.resolvedPid || target.processStartMs!==action.resolvedProcessStartMs))throw new OneContextError("one-os-target-identity-changed");
    action.resolvedPid=target.pid;action.resolvedProcessStartMs=target.processStartMs;
    if(!target.active && !action.allowFocus && !binding.contextGrantId)throw new OneContextError("one-os-target-not-foreground");
    if(binding.contextGrantId){
      const authority=service.authorize({...binding,grantId:binding.contextGrantId},"interact"); authority.assertCurrent();
      if(action.sourceId && action.sourceId!==authority.target.sourceId)throw new OneContextError("one-os-source-outside-grant");action.sourceId=authority.target.sourceId;
      if(!await oneContextTargetCurrent(authority.target))throw new OneContextError("one-context-target-stale");
      const exact=rows.find(row=>authority.target.sourceId===`window:${row.windowId}:0` && row.pid===target!.pid && row.processStartMs===target!.processStartMs);
      if(!exact)throw new OneContextError("one-os-target-outside-grant");
      if(!action.allowFocus && (!exact.active || rows.find(row=>row.pid===exact.pid)?.windowId!==exact.windowId))throw new OneContextError("one-os-window-not-foreground");
      target=exact;
      if(authority.target.pid!==target.pid || authority.target.processStartMs!==target.processStartMs)throw new OneContextError("one-os-target-outside-grant");
      if(authority.target.bounds && ((action.points??[]).some(point=>!pointInside(authority.target.bounds!,point))
        || action.elementFrame && (!pointInside(authority.target.bounds,action.elementFrame) || !pointInside(authority.target.bounds,{x:action.elementFrame.x+action.elementFrame.width-1,y:action.elementFrame.y+action.elementFrame.height-1}))))throw new OneContextError("one-os-point-outside-grant");
    }
    if(action.resolvedWindowId!==undefined && action.resolvedWindowId!==target.windowId)throw new OneContextError("one-os-window-changed");
    action.resolvedWindowId=target.windowId;
  };
  const broker=new OneOsResourceLeaseBroker({resourceLockPath:path.join(os.tmpdir(),`agentlas-os-input-${process.getuid?.()??"owner"}`,"resource.lock"),readiness:oneContextReadiness,validateTarget:validate,validateObservation:async(binding,observation)=>{
    if(binding.oneId!==input.activeOneId())throw new OneContextError("one-context-identity-changed");input.assertTask(binding);
    if(binding.contextGrantId){const authority=service.authorize({...binding,grantId:binding.contextGrantId});authority.assertCurrent();
      if(!await oneContextTargetCurrent(authority.target))throw new OneContextError("one-context-target-stale");
      if(observation.sourceId && observation.sourceId!==authority.target.sourceId)throw new OneContextError("one-os-observation-outside-grant");
      // Generic AX observation spans every application window. Keep selected
      // window scope closed until the native observer supports an exact window.
      if(observation.appTarget)throw new OneContextError("one-os-window-observation-unavailable");}
  }}); configureOneOsLeaseBroker(broker);
  service=new OneContextService({...input,readiness:oneContextReadiness,targets:oneContextTargets,current:oneContextTargetCurrent,capture:captureExact,
    leaseState:()=>broker.snapshot(),revokeLease:(grant,reason)=>broker.revokeGrant(grant,reason)});configureOneContextService(service);
  const block=(state:OneContextReadiness["session"])=>{session=state;service.blockSession(`one-context-${state}`);broker.suspend(`one-context-${state}`);};
  powerMonitor.on("lock-screen",()=>block("locked"));powerMonitor.on("suspend",()=>block("sleeping"));
  powerMonitor.on("unlock-screen",()=>{session="awake";});powerMonitor.on("resume",()=>{session="awake";});
}

export async function captureOneContextExecution(binding:Readonly<OneOsExecutionBinding>):Promise<import("../../shared/types").ComputerUsePreview> {
  if(!binding.contextGrantId)throw new OneContextError("one-context-grant-unavailable");
  const {oneContextService}=await import("./context-service");const service=oneContextService();
  const authority=service.authorize({...binding,grantId:binding.contextGrantId});
  const snapshot=await service.capture({oneId:binding.oneId,taskId:binding.taskId,grantId:binding.contextGrantId});authority.assertCurrent();
  const latest=snapshot.latest;if(!latest)throw new OneContextError("one-context-capture-unavailable");
  const size=nativeImage.createFromDataURL(latest.dataUrl).getSize(),target=authority.target,ready=snapshot.readiness;
  return {platform:process.platform,captureMode:target.kind==="display"?"screen":"window",screenPermission:ready.screenPermission,accessibility:ready.accessibility==="granted",
    observationAvailable:true,interactionAvailable:target.interactionAvailable,interactionDriver:ready.driverAvailable?"agentlas-native":"agentlas-native-required",
    sources:[{id:target.sourceId,kind:target.kind==="display"?"screen":"window",name:target.label,displayId:null,width:size.width,height:size.height,bounds:target.bounds??null,scaleFactor:null}],
    selectedSourceId:target.sourceId,selectionRequired:false,dataUrl:latest.dataUrl,capturedAt:latest.capturedAt,error:null};
}
