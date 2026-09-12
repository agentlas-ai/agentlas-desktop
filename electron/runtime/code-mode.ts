import { randomUUID } from "node:crypto";
import type { RunnerEvents } from "./runner";
import type { LocalToolApprovalContext, MainToolDispatchCall, MainToolDispatchResult, OpenAiToolDef, ResolvedTool } from "./local-tool-loop";

export const CODE_MODE_TOOL = "agentlas_code";
const states = new WeakMap<Map<string, ResolvedTool>, {calls: number}>();
const MAX_NESTED_CALLS = 200;
const MAX_PARALLEL_CALLS = 8;
export function installMainCodeMode(tools: OpenAiToolDef[], byName: Map<string, ResolvedTool>, enabled: boolean): OpenAiToolDef[] {
  if (!enabled || byName.size === 0 || tools.some(tool => tool.function.name === CODE_MODE_TOOL)) return tools;
  states.set(byName, {calls: 0});
  return [...tools, {type: "function", function: {name: CODE_MODE_TOOL,
    description: "Run bounded JavaScript to compose independent approved tools in one request. Use await tools.call(name, arguments), tools.list(options), tools.prepare(exactName), tools.callPrepared(token, arguments). Promise.all is supported. Return a compact JSON value. Every nested call keeps normal approval. No Node, imports or direct network. store(key,value)/load(key) last only inside this evaluation; no state survives another call or restart.",
    parameters: {type: "object", properties: {code: {type: "string"}, timeoutMs: {type: "integer", minimum: 10, maximum: 30000}}, required: ["code"], additionalProperties: false}}}];
}
type Dispatch = (byName: Map<string, ResolvedTool>, call: MainToolDispatchCall, events: RunnerEvents, approval: LocalToolApprovalContext) => Promise<MainToolDispatchResult>;
const bootstrap = `
const memory = new Map();
const store = (key, value) => { memory.set(String(key), value); };
const load = key => memory.get(String(key));
const tools = Object.freeze({
  call: (name, args = {}) => agentlas.invoke("main", "tool", {name, args}),
  list: (args = {}) => agentlas.invoke("main", "tool", {name:"agentlas_tools_list", args}),
  prepare: name => agentlas.invoke("main", "tool", {name:"agentlas_tools_prepare", args:{name}}),
  callPrepared: (token, args = {}) => agentlas.invoke("main", "tool", {name:"agentlas_tools_call", args:{token, arguments:args}})
});
`;

/** One evaluation owns one VM and abort scope. No VM handle or memory is a
 * durable checkpoint. Nested IDs identify actual Main operations, never fake
 * provider call IDs; providerCallId remains null inside the canonical dispatcher. */
export async function runMainCodeMode(byName: Map<string, ResolvedTool>, input: string, events: RunnerEvents,
  approval: LocalToolApprovalContext, dispatch: Dispatch): Promise<MainToolDispatchResult> {
  const state = states.get(byName);
  if (!state) throw new Error("code_mode_not_admitted");
  const args: unknown = JSON.parse(input);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("code_mode_arguments_invalid");
  const data = args as Record<string, unknown>;
  if (typeof data.code !== "string" || Object.keys(data).some(key => !["code", "timeoutMs"].includes(key))) throw new Error("code_mode_arguments_invalid");
  const timeoutMs = data.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 10 || (timeoutMs as number) > 30000) throw new Error("code_mode_timeout_invalid");
  approval.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(approval.signal?.reason);
  approval.signal?.addEventListener("abort", abort, {once: true});
  const pending = new Set<Promise<unknown>>();
  const waiters: Array<() => void> = [];
  let active = 0, peakConcurrency = 0, operationCount = 0, failed = 0;
  const acquire = async () => { if (active >= MAX_PARALLEL_CALLS) await new Promise<void>(resolve => waiters.push(resolve)); else active++; };
  const release = () => { const next = waiters.shift(); if (next) next(); else active--; };
  let engine: import("../computer-use/unified/quickjs-engine").QuickJsEngine | null = null;
  let value: unknown = null, failure: string | null = null;
  try {
    const { QuickJsEngine } = await import("../computer-use/unified/quickjs-engine");
    engine = await QuickJsEngine.create({invoke: (target, method, rawArgs, signal) => {
      const operation = (async () => {
        controller.signal.throwIfAborted(); signal.throwIfAborted();
        if (target !== "main" || method !== "tool" || !rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw new Error("code_mode_target_invalid");
        const callArgs = rawArgs as {name?: unknown; args?: unknown};
        if (typeof callArgs.name !== "string" || callArgs.name === CODE_MODE_TOOL || !callArgs.args || typeof callArgs.args !== "object" || Array.isArray(callArgs.args)) throw new Error("code_mode_nested_call_invalid");
        if (++state.calls > MAX_NESTED_CALLS) throw new Error("code_mode_call_budget_exhausted");
        operationCount++;
        const operationId = `host-code:${randomUUID()}`;
        const encoded = JSON.stringify(callArgs.args);
        events.onTool?.(callArgs.name, encoded, undefined, operationId);
        const operationEvents: RunnerEvents = {...events, onTool: (name, args, result, _providerId, ...rest) => events.onTool?.(name, args, result, operationId, ...rest)};
        await acquire();
        let resultObserved = false;
        try {
          controller.signal.throwIfAborted(); signal.throwIfAborted();
          peakConcurrency = Math.max(peakConcurrency, active);
          const outcome = await dispatch(byName, {providerCallId: null, toolName: callArgs.name, arguments: encoded}, operationEvents, {...approval, signal: controller.signal});
          resultObserved = true;
          if (outcome.isError) throw new Error(outcome.content);
          // Tool output remains data. JSON results (including prepared tokens)
          // can be composed directly; ordinary text remains an ordinary string.
          try { return JSON.parse(outcome.content) as unknown; } catch { return outcome.content; }
        } catch (error) {
          if (!resultObserved) events.onTool?.(callArgs.name, encoded, error instanceof Error ? error.message : String(error), operationId, true);
          throw error;
        } finally { release(); }
      })();
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => { failed++; pending.delete(operation); });
      return operation;
    }});
    value = await engine.evaluate(`${bootstrap}\n${data.code}`, {timeoutMs: timeoutMs as number, signal: controller.signal});
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    controller.abort();
    engine?.dispose();
    approval.signal?.removeEventListener("abort", abort);
    // Guest completion never implies a detached host effect settled. Give
    // cooperative dispatch cleanup a short bound, then report uncertainty.
    if (pending.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
      if (timer) clearTimeout(timer);
    }
  }
  const result = {schemaVersion: "agentlas.code-mode-result.v1", value, error: failure,
    operations: {observed: operationCount, failed, pending: pending.size, peakConcurrency},
    memory: {scope: "evaluation", durable: false, restartState: "unknown"}};
  const content = JSON.stringify(result);
  if (content.length > 18000) return {content: "Error: code_mode_result_too_large; return a smaller summary.", isError: true, visionMessage: null};
  return {content, isError: failure !== null || failed > 0 || pending.size > 0, visionMessage: null};
}
