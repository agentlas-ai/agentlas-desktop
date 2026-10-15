// Host-owned content-free runtime diagnostic values. No provider payload is retained.
export interface NativeProtocolCounters { lines:number; parsed:number; invalidJson:number; invalidShape:number; unmatchedResponses:number; notifications:number; requests:number; handlerErrors:number; }
export type NativeStderrHint = "empty"|"configuration"|"argument"|"authentication"|"permission"|"unclassified";
export interface NativeTransportSnapshot { connectionLifetime:true; transportEndReason:"stdout-end"|"child-error"|"child-close"|null; childCloseObserved:boolean; exitCode:number|null; signal:string|null; spawnErrorCode:string|null; stderrBytesObserved:number; stderrPrefixBytes:number; stderrPrefixSha256:string; stderrPrefixLimitBytes:65536; stderrHint?:NativeStderrHint; }
export interface NativeFailureEvidence { category:"rpc-error"|"rpc-timeout"|"transport-ended"|"child-process-error"|"unknown"; rpcCode:number|null; timeoutMs:number|null; requestMethod:"initialize"|"turn/start"|"thread/start"|"thread/resume"|null; }
export interface NativeRuntimeDiagnostic { schemaVersion:"agentlas.native-runtime-diagnostic.v1"; runtime:"codex"; driver:"app-server"|"exec"; phase:"initialize-failed"|"turn-start-failed"|"transport-ended"|"child-closed"|"process-error"|"process-closed"|"turn-terminal"; diagnosticAttemptId:string; runtimeAttemptId:string|null; sequence:number; transport:NativeTransportSnapshot|null; protocol:NativeProtocolCounters|null; protocolScope:"connection-delta"|"attempt"|null; terminal:{accepted:boolean;threadMismatch:number;turnMismatch:number;earlyOverflow:number}; failure:NativeFailureEvidence|null; observedAt:string; }

import { createHash } from "node:crypto";
import { types } from "node:util";

const PREFIX_LIMIT = 65536 as const;
const counterKeys = ["lines", "parsed", "invalidJson", "invalidShape", "unmatchedResponses", "notifications", "requests", "handlerErrors"] as const;
const errno = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "ENOTDIR", "ETXTBSY", "EIO", "EBADF", "ENOSYS"]);
const signals = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGSYS"]);
const methods = new Set(["initialize", "turn/start", "thread/start", "thread/resume"]);
const phases = new Set(["initialize-failed", "turn-start-failed", "transport-ended", "child-closed", "process-error", "process-closed", "turn-terminal"]);
const stderrHints = new Set<NativeStderrHint>(["empty", "configuration", "argument", "authentication", "permission", "unclassified"]);
const uuid = (v:unknown):v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const count = (v:unknown):v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const machineInteger = (v:unknown):v is number => typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
function plain(value:unknown, keys:readonly string[]):value is Record<string,unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own=Reflect.ownKeys(value);
  return own.length === keys.length && own.every(k => typeof k === "string" && keys.includes(k) && Object.getOwnPropertyDescriptor(value,k)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value,k)!);
}
export function nativeRequestMethod(value:unknown):NativeFailureEvidence["requestMethod"] { return typeof value === "string" && methods.has(value) ? value as NativeFailureEvidence["requestMethod"] : null; }
export function nativeSpawnErrorCode(value:unknown):string|null { return typeof value === "string" && errno.has(value) ? value : null; }
export function nativeProcessErrorCode(error:unknown):string|null {
  try {
    if(!error || typeof error!=="object" || types.isProxy(error))return null;
    const code=Object.getOwnPropertyDescriptor(error,"code");
    return code && "value" in code ? nativeSpawnErrorCode(code.value) : null;
  }catch{return null;}
}
export class NativeProtocolDiagnostics {
  private counts:NativeProtocolCounters = {lines:0,parsed:0,invalidJson:0,invalidShape:0,unmatchedResponses:0,notifications:0,requests:0,handlerErrors:0};
  increment(key:keyof NativeProtocolCounters):void { if(counterKeys.includes(key)) this.counts[key]=Math.min(Number.MAX_SAFE_INTEGER,this.counts[key]+1); }
  snapshot():NativeProtocolCounters { return Object.freeze({...this.counts}); }
}
/** A fixed hint from an untrusted error line, never a proven failure cause.
 * Provider text can match these patterns. Hints grant no control authority;
 * terminal/effect acceptance still uses protocol and physical process receipts.
 */
function stderrHint(prefix:Buffer, bytesObserved:number):NativeStderrHint {
  if(bytesObserved===0)return "empty";
  const lines=prefix.toString("utf8").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  // Official CLI startup emits these headers directly, including a multiline
  // config.toml diagnostic. The fixed header is advisory; its body stays private.
  const directConfig=/^\s*Error loading (?:config\.toml|configuration):/i;
  const error=lines.find(line=>/^\s*error:\s*\S/i.test(line)||directConfig.test(line));
  if(!error)return "unclassified";
  if(directConfig.test(error))return "configuration";
  const message=error.replace(/^\s*error:\s*/i, "");
  if(/^(?:error (?:loading|parsing) config(?:uration)?|(?:failed|unable) to (?:load|read|parse) (?:the )?config(?:uration)?|(?:invalid|malformed) config(?:uration)?|config(?:uration)? (?:error|parse error))\b/i.test(message))return "configuration";
  if(/^(?:unexpected argument|unrecognized (?:option|argument)|unknown (?:option|argument)|(?:invalid|unsupported) (?:value|argument|option))\b/i.test(message))return "argument";
  if(/^(?:not logged in|(?:authentication|authorization) (?:required|failed)|(?:missing|invalid) (?:api key|access token)|please (?:run |use )?(?:\/login|codex login))\b/i.test(message))return "authentication";
  if(/^(?:permission denied|operation not permitted|access denied)\b/i.test(message))return "permission";
  return "unclassified";
}
export class NativeTransportDiagnostics {
  private prefix=Buffer.alloc(0);
  private bytes=0;
  private reason:NativeTransportSnapshot["transportEndReason"]=null;
  private closeObserved=false;
  private code:number|null=null;
  private signal:string|null=null;
  private errorCode:string|null=null;
  addStderr(bytes:Buffer):void {
    if(!Buffer.isBuffer(bytes))return;
    this.bytes=Math.min(Number.MAX_SAFE_INTEGER,this.bytes+bytes.byteLength);
    const remaining=PREFIX_LIMIT-this.prefix.byteLength;
    if(remaining>0)this.prefix=Buffer.concat([this.prefix,bytes.subarray(0,remaining)]);
  }
  transportEnded(reason:NonNullable<NativeTransportSnapshot["transportEndReason"]>):void { if(!this.reason && ["stdout-end","child-error","child-close"].includes(reason))this.reason=reason; }
  childClosed(code:unknown,signal:unknown):void {
    if(this.closeObserved)return;
    this.closeObserved=true;this.code=machineInteger(code)?code:null;this.signal=typeof signal==="string"&&signals.has(signal)?signal:null;
    if(this.code!==null&&this.signal!==null){this.code=null;this.signal=null;}
    this.transportEnded("child-close");
  }
  childError(machineCode:unknown):void { this.errorCode=nativeSpawnErrorCode(machineCode);this.transportEnded("child-error"); }
  snapshot():NativeTransportSnapshot { return Object.freeze({connectionLifetime:true,transportEndReason:this.reason,childCloseObserved:this.closeObserved,exitCode:this.code,signal:this.signal,spawnErrorCode:this.errorCode,stderrBytesObserved:this.bytes,stderrPrefixBytes:this.prefix.byteLength,stderrPrefixSha256:createHash("sha256").update(this.prefix).digest("hex"),stderrPrefixLimitBytes:PREFIX_LIMIT,stderrHint:stderrHint(this.prefix,this.bytes)}); }
}
function transportValid(v:unknown):v is NativeTransportSnapshot {
  const keys=["connectionLifetime","transportEndReason","childCloseObserved","exitCode","signal","spawnErrorCode","stderrBytesObserved","stderrPrefixBytes","stderrPrefixSha256","stderrPrefixLimitBytes"];
  // Existing v1 receipts have no hint. An added field must be a fixed enum,
  // not a raw message, path, config value or caller-defined category.
  if(!plain(v,keys)&&!plain(v,[...keys,"stderrHint"]))return false;
  return v.connectionLifetime===true && (v.transportEndReason===null || typeof v.transportEndReason==="string"&&["stdout-end","child-error","child-close"].includes(v.transportEndReason)) && typeof v.childCloseObserved==="boolean"
    && (v.exitCode===null || machineInteger(v.exitCode)) && (v.signal===null || typeof v.signal==="string"&&signals.has(v.signal)) && !(v.exitCode!==null&&v.signal!==null)
    && (v.childCloseObserved || v.exitCode===null&&v.signal===null) && (v.spawnErrorCode===null || nativeSpawnErrorCode(v.spawnErrorCode)!==null)
    && count(v.stderrBytesObserved) && count(v.stderrPrefixBytes) && v.stderrPrefixBytes<=PREFIX_LIMIT && v.stderrPrefixBytes<=v.stderrBytesObserved && v.stderrPrefixLimitBytes===PREFIX_LIMIT
    && typeof v.stderrPrefixSha256==="string" && /^[a-f0-9]{64}$/.test(v.stderrPrefixSha256)
    && (!Object.hasOwn(v,"stderrHint") || typeof v.stderrHint==="string"&&stderrHints.has(v.stderrHint as NativeStderrHint)&&(v.stderrHint==="empty")===(v.stderrBytesObserved===0));
}
function protocolValid(v:unknown):v is NativeProtocolCounters { return plain(v,counterKeys)&&counterKeys.every(k=>count(v[k])); }
function failureValid(v:unknown):v is NativeFailureEvidence {
  if(!plain(v,["category","rpcCode","timeoutMs","requestMethod"]))return false;
  return typeof v.category==="string"&&["rpc-error","rpc-timeout","transport-ended","child-process-error","unknown"].includes(v.category)
    && (v.rpcCode===null || machineInteger(v.rpcCode)) && (v.timeoutMs===null || count(v.timeoutMs)&&v.timeoutMs>0&&v.timeoutMs<=86400000)
    && (v.requestMethod===null || nativeRequestMethod(v.requestMethod)!==null)
    && (v.category==="rpc-error" || v.rpcCode===null) && (v.category==="rpc-timeout" || v.timeoutMs===null);
}
const inputKeys=["driver","phase","diagnosticAttemptId","runtimeAttemptId","sequence","transport","protocol","protocolScope","terminal","failure"];
const branded=new WeakSet<object>();
function validFields(v:Record<string,unknown>):boolean {
  return (v.driver==="app-server"||v.driver==="exec")&&typeof v.phase==="string"&&phases.has(v.phase)&&uuid(v.diagnosticAttemptId)&&(v.runtimeAttemptId===null||uuid(v.runtimeAttemptId))
    && count(v.sequence)&&v.sequence>=1&&v.sequence<=32&&(v.transport===null||transportValid(v.transport))&&(v.protocol===null||protocolValid(v.protocol))
    && (v.protocolScope===null||v.protocolScope==="connection-delta"||v.protocolScope==="attempt") && (v.protocol===null)===(v.protocolScope===null)
    && plain(v.terminal,["accepted","threadMismatch","turnMismatch","earlyOverflow"])&&typeof v.terminal.accepted==="boolean"&&count(v.terminal.threadMismatch)&&count(v.terminal.turnMismatch)&&count(v.terminal.earlyOverflow)
    && (v.failure===null||failureValid(v.failure));
}
export function createNativeRuntimeDiagnostic(input:Omit<NativeRuntimeDiagnostic,"schemaVersion"|"runtime"|"observedAt">):NativeRuntimeDiagnostic|null {
  try{
    if(!plain(input,inputKeys)||!validFields(input))return null;
    const result:NativeRuntimeDiagnostic={...input,schemaVersion:"agentlas.native-runtime-diagnostic.v1",runtime:"codex",observedAt:new Date().toISOString(),transport:input.transport===null?null:Object.freeze({...input.transport}),protocol:input.protocol===null?null:Object.freeze({...input.protocol}),terminal:Object.freeze({...input.terminal}),failure:input.failure===null?null:Object.freeze({...input.failure})};
    Object.freeze(result);branded.add(result);return result;
  }catch{return null;}
}
export function validatedHostNativeRuntimeDiagnostic(value:unknown):value is NativeRuntimeDiagnostic {
  try{return !!value&&typeof value==="object"&&branded.has(value)&&plain(value,[...inputKeys,"schemaVersion","runtime","observedAt"])&&validFields(value)&&value.schemaVersion==="agentlas.native-runtime-diagnostic.v1"&&value.runtime==="codex"&&typeof value.observedAt==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt);}catch{return false;}
}
