import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerRequest } from "./runner";
import { withoutMcpTransportEnv } from "./runner";
import { runObservedRunnerAs } from "./observed-runner";
import { inspectJudgmentCapability } from "../system-agents/judgment-capability";
import { getCredentialStateRevision, getEnvConfigurationRevision } from "../secrets/vault";
import { preparedMcpBindings, type PreparedMcpBinding } from "../mcp-tools/prepared-transport";

/** Created during common runtime module initialization, outside an invocation.
 * Detached memory work must not inherit its parent's history/effect grants. */
const background = new AsyncResource("agentlas-remote-memory-background");
const scopes = new AsyncLocalStorage<RemoteCurationRuntime>();
const bound = new WeakMap<PreparedMcpBinding, RemoteCurationRuntime>();
const foreground = new WeakSet<RemoteCurationRuntime>();
const ambiguous = new WeakSet<PreparedMcpBinding>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pin = (req: RunnerRequest) => [req.model ?? null, req.effort ?? null, req.longContext ?? false,
  req.runtimeSource ?? null, req.env ?? null];

export interface RemoteCurationRuntime {
  readonly selection: Readonly<RuntimeSelection>;
  readonly available: boolean;
  /** Separate foreground lifetime; the remote consumer retains its existing90second window. */
  readonly foregroundSignal: AbortSignal;
  current(): boolean;
  generate(input: { system: string; input: string; maxOutputTokens: number }, signal: AbortSignal): Promise<{ model: string; output: string }>;
}

/** Common selection owns this wrapper; packets, nonces and requestedRuntime
 * cannot create it. The observed request supplies model/effort/source pins. */
export function withRemoteCurationRuntime(runner: Runner, active: RuntimeStatus, configurationCurrent: () => boolean): Runner {
  return async (req, events) => {
    if (req.untrustedNoTools || req.judgmentOnly) return runner(req, events);
    const selection: RuntimeSelection = Object.freeze({ kind: active.kind, backend: active.backend,
      source: req.runtimeSource ?? active.source, ...(active.acpAgentId ? { acpAgentId: active.acpAgentId } : {}),
      ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), longContext: req.longContext === true });
    const credentialRevision = getCredentialStateRevision(), envRevision = getEnvConfigurationRevision(), requestDigest = digest(pin(req));
    const source = { runtimeSource: selection.source, model: req.model, effort: req.effort,
      longContext: req.longContext, env: withoutMcpTransportEnv({ ...(req.env ?? process.env) }), locale: req.locale };
    let endedAt: number | null = null;
    const foregroundLifetime = new AbortController();
    const capability: RemoteCurationRuntime = Object.freeze({ selection, foregroundSignal: foregroundLifetime.signal,
      available: inspectJudgmentCapability(selection).status === "verified",
      current: () => !req.signal?.aborted && (endedAt === null || Date.now() - endedAt < 90_000) && configurationCurrent()
        && credentialRevision === getCredentialStateRevision() && envRevision === getEnvConfigurationRevision() && requestDigest === digest(pin(req)),
      async generate(input: { system: string; input: string; maxOutputTokens: number }, signal: AbortSignal) {
        if (!capability.available || !capability.current()) throw new Error("remote_memory_runtime_unavailable");
        let toolObserved = false;
        const result = await runObservedRunnerAs("curator", "remote-memory", runner, {
          ...source, systemPrompt: input.system, userPrompt: input.input, history: [],
          backendLabel: "Automatic memory curation", maxOutputTokens: input.maxOutputTokens,
          permission: "read", untrustedNoTools: true, judgmentOnly: true, singleUse: true, surfaceGate: "exclude", runPriority: "background", signal,
        }, { onPartial: () => {}, onStatus: () => {}, onTool: () => { toolObserved = true; } }, selection.kind);
        signal.throwIfAborted();
        const model = result.observedModel || selection.model;
        if (!capability.current() || toolObserved || result.failure || !model || !result.text
          || Buffer.byteLength(result.text, "utf8") > 48_000) throw new Error("remote_memory_model_result_unavailable");
        return { model, output: result.text };
      },
    });
    foreground.add(capability);
    if (req.mcpConfigPath) try {
      for (const binding of preparedMcpBindings(req.mcpConfigPath)) {
        const previous = bound.get(binding);
        // One sealed config concurrently borrowed by two different invocations
        // cannot identify a CLI proxy's current brain. Deny that shared binding.
        if (previous && foreground.has(previous)) ambiguous.add(binding);
        bound.set(binding, capability);
      }
    } catch { /* An absent native preparation cannot grant a proxy callback a runtime. */ }
    try { return await scopes.run(capability, () => runner(req, events)); }
    finally { endedAt = Date.now(); foreground.delete(capability); foregroundLifetime.abort(new Error("remote_memory_foreground_ended")); }
  };
}

/** An opaque prepared proxy carries the same actual host invocation even when
 * its IPC callback cannot inherit ALS. Never look up a mutable global model. */
export function currentRemoteCurationRuntime(binding: PreparedMcpBinding): RemoteCurationRuntime | null {
  const runtime = bound.get(binding);
  // ALS alone cannot associate an arbitrary installed server with a native run.
  const observed = scopes.getStore();
  return !ambiguous.has(binding) && runtime && (!observed || observed === runtime) && runtime.current() ? runtime : null;
}

/** Queue in the module's independent async resource, not the tool's execution grant. */
export function scheduleRemoteCuration(action: () => Promise<void>): void {
  background.runInAsyncScope(() => { setImmediate(() => { void action().catch(() => {}); }); });
}
