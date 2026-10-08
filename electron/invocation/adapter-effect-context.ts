import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationEvent } from "../../shared/types";
import type { RunnerEvents } from "../runtime/runner";
import { captureScienceToolCorrelation, type ScienceToolCorrelation } from "./science-failure-settlement";
import { captureScienceNativeFailureObservation, type ScienceNativeFailureObservation } from "./science-native-failure";
import { MAIN_TOOL_PREDISPATCH_PROTOCOL, bindMainHostControlEvent, mainHostControlForEvent, type MainHostControlObservation } from "./effect-metadata";

export interface AdapterEffectReport {
  schemaVersion: "agentlas.adapter-effect-coverage.v1";
  protocol: string;
  complete: boolean;
  terminal: string | null;
  operationIds: string[];
  frameKinds: string[];
  reasons: string[];
  /** Failed operations with Main-attested definite settlement (e.g. rejected before dispatch). */
  settledFailureIds?: string[];
  /** Native/host transport has acknowledged its terminal and drained its operations. */
  quiesced?: boolean;
  effectClass?: "remote-control-write";
  requestDigest?: string;
  responseDigest?: string;
}
export interface AdapterEffectAdmission {
  scopeId: string; adapterKind: string; chatId: string | null; agentId: string | null;
  rootBound: boolean;
  /** Main-owned dispatch role, not a claim of isolation or effect settlement. */
  purpose?: "preparation";
  /** Main-issued child dispatch, anchored to the invocation or another admitted scope. */
  parentScopeId?: string;
  dispatchId?: string;
}
interface Scope {
  runId: string; chatId: string; rootAgentId: string | null;
  source?: string;
  nativeScienceTool?: (binding: ScienceToolCorrelation) => void;
  nativeScienceFailure?: (observation: ScienceNativeFailureObservation) => void;
  purpose?: "preparation";
  begin: (admission: AdapterEffectAdmission) => void;
  finish: (scopeId: string, report: AdapterEffectReport) => void;
  hostControl?: (observation: MainHostControlObservation) => void;
  recordingFailed?: () => void;
  childDispatchId?: string;
  parentEffectScopeId?: string;
  activeEffectScopeId?: string;
  /** Main's synchronous tool-start callback; never serialized or provider-authored. */
  durableToolStart?: { active: boolean };
}
const context = new AsyncLocalStorage<Scope>();

/** The existing start event must be stored before Main leaves for this tool.
 * The token closes when the synchronous callback returns, including rejection;
 * detached async work cannot borrow this execution-before-record boundary. */
export function withDurableMainToolStart<T>(action: () => T): T {
  const scope = context.getStore();
  if (!scope) return action();
  const token = { active: true };
  try { return context.run({ ...scope, durableToolStart: token }, action); }
  finally { token.active = false; }
}
export function mainToolStartRequiresDurability(): boolean {
  return context.getStore()?.durableToolStart?.active === true;
}

/** Capture at dispatch; resident callbacks must not borrow another ALS turn.
 * Nested/preparation/non-Science adapters cannot supply root correlation. */
export function bindScienceNativeToolObserver(input: { chatId?: string; agentId?: string }, qualify: (id: string) => string = id => id): (item: unknown) => void {
  const scope = context.getStore();
  if (!scope || scope.source !== "science" || scope.purpose === "preparation" || scope.childDispatchId !== undefined || !scope.rootAgentId
    || input.chatId !== scope.chatId || input.agentId !== scope.rootAgentId) return () => {};
  return item => {
    const binding = captureScienceToolCorrelation(scope.runId, scope.chatId, item);
    if (binding) scope.nativeScienceTool?.({ ...binding, providerToolId: qualify(binding.providerToolId) });
  };
}

/** Bind once in Main's dispatch scope, before any provider/UI truncation. */
export function bindScienceNativeFailureObserver(input: { chatId?: string; agentId?: string }, qualify: (id: string) => string = id => id):
  (item: unknown, completionKind: ScienceNativeFailureObservation["completionKind"]) => void {
  const scope = context.getStore();
  if (!scope || scope.source !== "science" || scope.purpose === "preparation" || scope.childDispatchId !== undefined || !scope.rootAgentId
    || input.chatId !== scope.chatId || input.agentId !== scope.rootAgentId) return () => {};
  return (item, completionKind) => {
    const observation = captureScienceNativeFailureObservation(scope.runId, scope.chatId, item, completionKind);
    if (observation) scope.nativeScienceFailure?.({ ...observation, binding: { ...observation.binding, providerToolId: qualify(observation.binding.providerToolId) } });
  };
}

/** Only Main enters this scope. Providers cannot select a run or borrow another run's receipt. */
export function withAdapterEffectContext<T>(scope: Scope, action: () => T): T { return context.run(scope, action); }

/** Add a Main observer without replacing the enclosing ledger or its identity. */
export function withAdapterEffectObserver<T>(
  fallback: Pick<Scope, "runId" | "chatId" | "rootAgentId" | "source">,
  observer: Pick<Scope, "begin" | "finish" | "recordingFailed">,
  action: () => T,
): T {
  const parent = context.getStore();
  return context.run({ ...(parent ?? fallback),
    begin: admission => { try { observer.begin(admission); } finally { parent?.begin(admission); } },
    finish: (scopeId, report) => { try { observer.finish(scopeId, report); } finally { parent?.finish(scopeId, report); } },
    recordingFailed: () => { try { observer.recordingFailed?.(); } finally { parent?.recordingFailed?.(); } },
  }, action);
}

/** Only Main dispatch integration may grant a child access to this invocation's ledger. */
export function withAdapterEffectChildDispatch<T>(dispatchId: string, action: () => T): T {
  const scope = context.getStore();
  if (scope?.childDispatchId && !scope.activeEffectScopeId) throw new Error("adapter_effect_child_parent_unadmitted");
  return scope ? context.run({ ...scope, childDispatchId: dispatchId, parentEffectScopeId: scope.activeEffectScopeId ?? `${scope.runId}:root` }, action) : action();
}

type MainHostControlProjection = NonNullable<McpInvocationEvent["tool"]> & Pick<McpInvocationEvent, "agentId" | "runtimeAgentId" | "nodeId" | "role" | "phase" | "tier"> & { id: string; result: string };

/** Registration and consumption share a private Host sink; provider callbacks never receive it. */
export function createMainHostControlSink(sink: (event: McpInvocationEvent) => void): {
  audit: (kind: MainHostControlObservation["controlKind"], projection: MainHostControlProjection, record: () => { id: string; kind: string; payload: Record<string, unknown> }) => void;
  sink: (event: McpInvocationEvent) => void;
} {
  const scope = context.getStore();
  const pending = new Map<string, MainHostControlObservation>();
  const projectionDigest = (tool: NonNullable<McpInvocationEvent["tool"]>, actor: Pick<McpInvocationEvent, "agentId" | "runtimeAgentId" | "nodeId" | "role" | "phase" | "tier">): string =>
    createHash("sha256").update(JSON.stringify([tool.name ?? null, tool.id ?? null, tool.args ?? null, tool.result ?? null, tool.isError ?? null, tool.origin ?? null,
      actor.agentId ?? null, actor.runtimeAgentId ?? null, actor.nodeId ?? null, actor.role ?? null, actor.phase ?? null, actor.tier ?? null])).digest("hex");
  return {
    audit: (controlKind, projection, record) => {
      let audit: { id: string; kind: string; payload: Record<string, unknown> };
      try { audit = record(); } catch (error) { scope?.recordingFailed?.(); throw error; }
      if (!scope?.hostControl) return;
      if (pending.size >= 512) { scope.recordingFailed?.(); return; }
      const { runtimeEvidence: _evidence, ...auditPayload } = audit.payload;
      const auditPayloadSha256 = createHash("sha256").update(JSON.stringify(auditPayload)).digest("hex");
      const projectionSha256 = projectionDigest(projection, projection);
      pending.set(projectionSha256, { controlId: `${scope.runId}:control:${audit.id}`, auditEventId: audit.id, auditKind: audit.kind, controlKind, projectionSha256, auditPayloadSha256 });
    },
    sink: event => {
      const digest = event.tool && projectionDigest(event.tool, event);
      const observation = digest && pending.get(digest);
      if (observation && event.kind === "tool-use") {
        pending.delete(digest!);
        scope!.hostControl!(observation);
        bindMainHostControlEvent(event, observation);
      }
      sink(event);
    },
  };
}

/** Private Main dispatcher bridge: only starts emitted by this host callback can
 * bind the following concrete transport call. A missing call leaves an open scope. */
export function createMainHostOperationBridge(sink: (event: McpInvocationEvent) => void, adapterKind: string, chatId: string, agentId: string) {
  type Start = { name: string; ledger: ReturnType<typeof createAdapterEffectLedger>; entered: boolean; envelope: McpInvocationEvent;
    transport?: { requestDigest: string; responseDigest: string; isError: boolean }; ambiguous?: boolean; closed?: boolean };
  const starts = new Map<string, Start>();
  const scope = context.getStore();
  const hostSink = (event: McpInvocationEvent): void => {
    if (mainHostControlForEvent(event)) { sink(event); return; }
    const tool = event.kind === "tool-use" ? event.tool : undefined;
    if (!tool?.id) { sink(event); return; }
    const previous = starts.get(tool.id);
    if (tool.result !== undefined) {
      if (!previous || previous.name !== tool.name || previous.closed) { sink(event); return; }
      previous.envelope = event;
      const isError = tool.isError === true || previous.transport?.isError === true;
      previous.ledger.events.onTool?.(tool.name, tool.args, tool.result, tool.id, previous.transport ? isError : undefined);
      previous.closed = true;
      starts.delete(tool.id);
      previous.ledger.complete(previous.transport ? "host_transport_result" : "host_transport_unconfirmed",
        Boolean(previous.transport) && !previous.ambiguous && event.done === true,
        "remote-control-write", previous.transport ? { requestDigest: previous.transport.requestDigest, responseDigest: previous.transport.responseDigest } : undefined);
      return;
    }
    if (starts.size >= 4096) { scope?.recordingFailed?.(); sink(event); return; }
    if (previous) { previous.ledger.uncertain("host-operation-identity-reused"); sink(event); return; }
    let start: Start;
    const ledger = withAdapterEffectChildDispatch(tool.id, () => createAdapterEffectLedger({ adapterKind, chatId, agentId }, {
      onStatus: () => {}, onPartial: () => {},
      onTool: (name, args, result, id, isError) => sink({ ...start.envelope, tool: { ...start.envelope.tool!, name, args, result, id, isError } }),
    }));
    start = { name: tool.name, ledger, entered: false, envelope: event };
    starts.set(tool.id, start);
    ledger.events.onTool?.(tool.name, tool.args, undefined, tool.id, false);
  };
  return { sink: hostSink, call: async <T>(name: string, args: unknown, invoke: () => Promise<T>): Promise<T> => {
    const matches = [...starts].filter(([, start]) => !start.entered && start.name === name);
    if (matches.length !== 1) { scope?.recordingFailed?.(); for (const [, start] of matches) start.ledger.uncertain("host-operation-binding-ambiguous"); return invoke(); }
    const [, start] = matches[0]; start.entered = true;
    const requestDigest = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    return start.ledger.withScope(async () => {
      try {
        const result = await invoke();
        const responseDigest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
        const typedResult = result && typeof result === "object" ? result as { isError?: unknown; is_error?: unknown } : null;
        start.transport = { requestDigest, responseDigest, isError: typedResult?.isError === true || typedResult?.is_error === true };
        return result;
      } catch (error) { start.ambiguous = true; start.ledger.uncertain("host-transport-unconfirmed"); throw error; }
    });
  } };
}

/** Preserve the parent's ledger callbacks and run identity. Preparation still
 * needs its real adapter report; this neither detaches nor settles any effects. */
export function withAdapterEffectPreparation<T>(action: () => T): T {
  const scope = context.getStore();
  return scope ? context.run({ ...scope, purpose: "preparation" }, action) : action();
}

/** Call immediately before an actual adapter dispatch, never on adapter selection. */
export function beginAdapterEffectRun(input: { adapterKind: string; chatId?: string; agentId?: string }): { scopeId: string; qualified: boolean; withScope: <T>(action: () => T) => T; complete: (report: AdapterEffectReport) => void } | null {
  const scope = context.getStore();
  if (!scope) return null;
  const scopeId = `${scope.runId}:${randomUUID()}`;
  const preparation = scope.purpose === "preparation";
  const child = !preparation && scope.childDispatchId !== undefined;
  scope.begin({ scopeId, adapterKind: input.adapterKind, chatId: preparation || child ? scope.chatId : input.chatId ?? null, agentId: input.agentId ?? null,
    rootBound: !preparation && !child && input.chatId === scope.chatId && scope.rootAgentId !== null && input.agentId === scope.rootAgentId,
    ...(preparation ? { purpose: "preparation" as const } : {}),
    ...(child ? { parentScopeId: scope.parentEffectScopeId, dispatchId: scope.childDispatchId } : {}) });
  let finished = false;
  return { scopeId, qualified: child, withScope: action => context.run({ ...scope, activeEffectScopeId: scopeId }, action),
    complete: report => { if (finished) return; finished = true; scope.finish(scopeId, report); } };
}

/** Closed native protocol facts, independent of the displayed agent/tool names. */
export function createAdapterEffectLedger(input: { adapterKind: string; chatId?: string; agentId?: string }, events: RunnerEvents) {
  const run = beginAdapterEffectRun(input);
  const operations = new Map<string, { started: boolean; completed: boolean; outcome: "pending" | "succeeded" | "failed" | "unknown" }>();
  const reasons = new Set<string>(), frames = new Set<string>();
  const expectedOperations = new Set<string>();
  // Root provider identities remain unchanged for Science/file/cancellation consumers.
  const qualify = (id: string): string => run?.qualified ? `${run.scopeId}:tool:${createHash("sha256").update(id).digest("hex")}` : id;
  const wrapped: RunnerEvents = { ...events, onTool: (name, args, result, id, isError, artifacts, image, origin) => {
    if (!id) reasons.add("native-operation-identity-missing");
    else if (operations.size >= 4096 && !operations.has(id)) reasons.add("native-operation-overflow");
    else {
      const previous = operations.get(id);
      const completed = result !== undefined || artifacts !== undefined || image !== undefined;
      if (previous?.completed && !completed) reasons.add("native-operation-identity-reused");
      operations.set(id, { started: previous?.started === true || !completed, completed: previous?.completed === true || completed,
        outcome: previous?.completed && (previous.outcome === "failed" || previous.outcome === "unknown") ? previous.outcome
          : !completed ? previous?.outcome ?? "pending" : isError === false ? "succeeded" : isError === true ? "failed" : "unknown" });
    }
    events.onTool?.(name, args, result, id ? qualify(id) : id, isError, artifacts, image, origin);
  } };
  return { scopeId: run?.scopeId, qualify, events: wrapped, withScope: <T>(action: () => T): T => run ? run.withScope(action) : action(),
    operationStarted: (id: string): boolean => operations.get(id)?.started === true,
    frame: (kind: string, covered: boolean, operationId?: string) => {
      if (frames.size >= 128) reasons.add("native-frame-overflow");
      else if (/^[a-zA-Z0-9._/-]{1,128}$/.test(kind)) frames.add(kind); else reasons.add("native-frame-identity-invalid");
      if (!covered) reasons.add("native-frame-uncovered");
      if (expectedOperations.size >= 4096) reasons.add("native-operation-overflow");
      else if (operationId) expectedOperations.add(operationId);
    },
    uncertain: (reason: string) => reasons.add(reason),
    complete: (terminal: string, quiesced: boolean, effectClass?: AdapterEffectReport["effectClass"], evidence?: { requestDigest: string; responseDigest: string }) => {
      for (const id of expectedOperations) if (!operations.has(id)) reasons.add("native-frame-operation-unaccounted");
      for (const operation of operations.values()) if (!operation.started || !operation.completed || operation.outcome !== "succeeded") reasons.add("native-operation-unsettled");
      if (!quiesced) reasons.add("native-terminal-unconfirmed");
      run?.complete({ schemaVersion: "agentlas.adapter-effect-coverage.v1", protocol: "main-scoped-adapter.v1", complete: reasons.size === 0,
        terminal, operationIds: [...operations.keys()].map(qualify), frameKinds: [...frames], reasons: [...reasons], quiesced,
        ...(effectClass ? { effectClass } : {}), ...(evidence ?? {}) });
    },
  };
}

/** Call only where Main knows the requested tool implementation was never entered.
 * Admission/completion witnesses reuse the exact adapter ledger contract. */
export function attestMainToolPreDispatchRejection(input: { adapterKind: string; chatId?: string; agentId?: string; toolId?: string }): void {
  const scope = context.getStore();
  if (!scope || scope.purpose === "preparation" || scope.childDispatchId !== undefined || !scope.rootAgentId || input.chatId !== scope.chatId
    || input.agentId !== scope.rootAgentId || !input.toolId) return;
  const run = beginAdapterEffectRun(input);
  run?.complete({ schemaVersion: "agentlas.adapter-effect-coverage.v1", protocol: MAIN_TOOL_PREDISPATCH_PROTOCOL,
    complete: true, terminal: "pre_dispatch_rejected", operationIds: [input.toolId],
    settledFailureIds: [input.toolId], frameKinds: ["main_dispatch_rejected"], reasons: [] });
}
