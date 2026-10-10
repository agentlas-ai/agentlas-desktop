import { copyObservedRunnerEvidence } from '../runtime/observed-runner';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { HistoryNativeRunToken, createHistoryNativeExecution } from './history-native-execution-glue';
import { personalDataError, personalDataHash } from './personal-data-store';

export interface HistoryRuntimeToolInput {
  kind:'mcp'|'builtin';serverId:string|null;catalogId:string|null;toolName:string;args:unknown;schemaDigest:string|null;
}
/** Main-only callbacks; never a model/renderer request, provider payload, environment or delegated JSON field. */
type HistoryProducerPorts=Parameters<Parameters<Execution['withProducer']>[2]>[0];
export interface HistoryRuntimeFence {
  readonly schema:'agentlas.history-runtime-fence.v1';
  assertCurrent():void;
  assertRuntimeCoverage(runtimeKind:string):void;
  assertMcpMethod(method:string):void;
  assertTool(input:HistoryRuntimeToolInput):void;
  withMcpToolCall<T>(input:HistoryRuntimeToolInput,execute:()=>Promise<T>):Promise<T>;
  withProducerCall<T>(kind:'skill'|'toolchain'|'agent',execute:(ports:HistoryProducerPorts)=>Promise<T>):Promise<T>;
  withProviderCall<T>(execute:()=>Promise<T>):Promise<T>;
}
type Execution=ReturnType<typeof createHistoryNativeExecution>;
export interface HistoryRuntimeFencePorts {
  /** Existing native owner binds only after actual invocation_run_owners claim. */
  bindRun(input:{runId:string;chatId:string}):Promise<HistoryNativeRunToken|null>;
  execution():Execution|null;
  /** Exact native registry/asset canonical name. Null is unknown and denies.
   * Resource resolution remains execution.resolveToolResources, never caller args alone. */
  canonicalToolReference(input:Readonly<HistoryRuntimeToolInput>):string|null;
}
interface Scope {runId:string;chatId:string;token:HistoryNativeRunToken;execution:Execution;fence:HistoryRuntimeFence}
const toolScopes=new AsyncLocalStorage<{scope:Scope;input:HistoryRuntimeToolInput}>();
const scopes=new AsyncLocalStorage<Scope>(),seals=new WeakMap<object,Scope>();
function fail(code:string):never{throw personalDataError(code);}
const metadataMethods=new Set(['initialize','notifications/initialized','ping','tools/list','notifications/cancelled','notifications/tools/list_changed']);
/** No queues, reservations, tool approvals, new runtimes or serialized scope receipts. */
export function createHistoryRuntimeFences(ports:HistoryRuntimeFencePorts){
  const preserveEvidence=(error:unknown,check:()=>void)=>{try{check();}catch(denial){if(error!==null&&(typeof error==='object'||typeof error==='function')&&denial!==null&&(typeof denial==='object'||typeof denial==='function'))copyObservedRunnerEvidence(error,denial);throw denial;}};
  const assertScope=(scope:Scope)=>{if(ports.execution()!==scope.execution)fail('history_native_runtime_scope_changed');scope.execution.assertToken(scope.token);};
  const assertFence=(fence:HistoryRuntimeFence):Scope=>{const scope=seals.get(fence);if(!scope)fail('history_native_runtime_capability_required');assertScope(scope);return scope;};
  const tool=(scope:Scope,input:HistoryRuntimeToolInput)=>{
    assertScope(scope);if(!input||!['mcp','builtin'].includes(input.kind)||typeof input.toolName!=='string'||!input.toolName)fail('history_native_tool_input_invalid');
    const ref=ports.canonicalToolReference(Object.freeze(structuredClone(input)));if(!ref)fail('history_native_tool_reference_required');
    const request={kind:input.kind,serverId:input.serverId,catalogId:input.catalogId,toolName:input.toolName,args:structuredClone(input.args),schemaDigest:input.schemaDigest};
    scope.execution.assertTool(scope.token,{toolRef:ref,request});return {toolRef:ref,request};
  };
  const capture=async(input:{runId:string;chatId:string}):Promise<HistoryRuntimeFence|null>=>{
    const current=scopes.getStore();if(current&&(current.runId!==input.runId||current.chatId!==input.chatId))fail('history_native_runtime_scope_changed');
    const token=await ports.bindRun(input);if(!token){if(current)fail('history_native_runtime_scope_changed');return null;}
    const execution=ports.execution();if(!execution)fail('history_native_execution_adapter_required');execution.assertToken(token);
    if(current){assertScope(current);if(current.token!==token||current.execution!==execution)fail('history_native_runtime_scope_changed');return current.fence;}
    let scope:Scope;const fence:HistoryRuntimeFence=Object.freeze({schema:'agentlas.history-runtime-fence.v1' as const,
      assertCurrent:()=>assertScope(scope),assertRuntimeCoverage(runtimeKind:string){assertScope(scope);if(!['byok','ollama','lmstudio','mlx','agentlas'].includes(runtimeKind))fail('history_native_runtime_per_call_fence_unavailable');},assertMcpMethod(method:string){assertScope(scope);if(method!=='tools/call'&&!metadataMethods.has(method))fail('history_native_mcp_method_outside_envelope');},
      assertTool:(input:HistoryRuntimeToolInput)=>{tool(scope,input);},
      withMcpToolCall:async<T>(input:HistoryRuntimeToolInput,execute:()=>Promise<T>):Promise<T>=>{
        assertScope(scope);const digest=personalDataHash(input),bound=tool(scope,input);
        return scopes.run(scope,()=>toolScopes.run({scope,input},async()=>{let failure:unknown;try{return await execution.withTool(token,bound,execute);}catch(error){failure=error;throw error;}finally{preserveEvidence(failure,()=>{if(personalDataHash(input)!==digest)fail('history_native_tool_request_changed');tool(scope,input);});}}));
      },
      withProducerCall:async<T>(kind:'skill'|'toolchain'|'agent',execute:(ports:HistoryProducerPorts)=>Promise<T>):Promise<T>=>{assertScope(scope);const call=toolScopes.getStore();if(!call||call.scope!==scope)fail('history_native_original_tool_scope_required');const digest=personalDataHash(call.input),bound=tool(scope,call.input);let failure:unknown;try{return await execution.withProducer<T>(token,{...bound,kind},execute);}catch(error){failure=error;throw error;}finally{preserveEvidence(failure,()=>{if(personalDataHash(call.input)!==digest)fail('history_native_tool_request_changed');tool(scope,call.input);});}},
      withProviderCall:async<T>(execute:()=>Promise<T>):Promise<T>=>{
        assertScope(scope);return scopes.run(scope,async()=>{let failure:unknown;try{return await execution.withProvider(token,execute);}catch(error){failure=error;throw error;}finally{preserveEvidence(failure,()=>assertScope(scope));}});
      },
    });scope={...input,token,execution,fence};seals.set(fence,scope);return fence;
  };
  const withInvocation=async<T>(input:{runId:string;chatId:string},execute:(fence:HistoryRuntimeFence|null)=>Promise<T>):Promise<T>=>{
    const fence=await capture(input);if(!fence)return execute(null);const scope=assertFence(fence);
    return scopes.run(scope,async()=>{let failure:unknown;try{return await execute(fence);}catch(error){failure=error;throw error;}finally{preserveEvidence(failure,()=>assertScope(scope));}});
  };
  const current=():HistoryRuntimeFence|null=>{const scope=scopes.getStore();if(!scope)return null;assertScope(scope);return scope.fence;};
  const withCurrentTool=async<T>(input:HistoryRuntimeToolInput,execute:()=>Promise<T>):Promise<T>=>{const fence=current();return fence?fence.withMcpToolCall(input,execute):execute();};
  const withCurrentProvider=async<T>(execute:()=>Promise<T>):Promise<T>=>{const fence=current();return fence?fence.withProviderCall(execute):execute();};
  return {capture,withInvocation,current,assertFence,withCurrentTool,withCurrentProvider};
}

/** Composition with actual current native owner runtime; constructor performs no profile/source/provider read. */
export async function createDefaultHistoryRuntimeFences(canonicalToolReference:HistoryRuntimeFencePorts['canonicalToolReference']){
  const runtime=await import('./personal-integrations-runtime');
  return createHistoryRuntimeFences({bindRun:runtime.bindOneHistoryNativeRun,execution:runtime.currentOneHistoryExecution,canonicalToolReference});
}

/** Deep actual clients/loops use the original ALS scope; ordinary callers keep existing behavior. */
export function currentHistoryRuntimeFence():HistoryRuntimeFence|null{const scope=scopes.getStore();if(!scope)return null;if(seals.get(scope.fence)!==scope)fail('history_native_runtime_capability_required');scope.fence.assertCurrent();return scope.fence;}
export function assertHistoryRuntimeFence(fence:HistoryRuntimeFence):void{if(!seals.has(fence))fail('history_native_runtime_capability_required');fence.assertCurrent();}
export async function withCurrentHistoryTool<T>(input:HistoryRuntimeToolInput,execute:()=>Promise<T>):Promise<T>{const fence=currentHistoryRuntimeFence();return fence?fence.withMcpToolCall(input,execute):execute();}
export async function withCurrentHistoryProvider<T>(execute:()=>Promise<T>):Promise<T>{const fence=currentHistoryRuntimeFence();return fence?fence.withProviderCall(execute):execute();}

/** Delegated/env config retains no native callback object or schema marker. */
export function serializableHistoryGate<T extends {historyRuntimeFence?:HistoryRuntimeFence}>(gate:T):Omit<T,'historyRuntimeFence'>{const {historyRuntimeFence:_scope,...plain}=gate;return plain;}

/** Actual native builder callbacks retain the original opaque tool scope. Ordinary callers use their existing producer; unknown/JSON child scopes cannot enter. */
export async function withCurrentHistoryProducer<T>(kind:'skill'|'toolchain'|'agent',execute:(ports:HistoryProducerPorts)=>Promise<T>,ordinary:()=>Promise<T>):Promise<T>{const fence=currentHistoryRuntimeFence();return fence?fence.withProducerCall(kind,execute):ordinary();}
