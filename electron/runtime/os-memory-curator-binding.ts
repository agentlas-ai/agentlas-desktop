import { createHash } from "node:crypto";
import { preparedMcpBindings, type PreparedMcpBinding } from "../mcp-tools/prepared-transport";
import { captureTrustedMemoryOwnerBinding } from "../memory/trusted-owner-binding";
import { currentRemoteCurationRuntime } from "./remote-curation-binding";
import { createOsCuratorGateway, OsCuratorGatewayError, type OsCuratorGateway } from "./os-memory-curator-gateway";

export type NativeOsCuratorRun = Readonly<{ readonly nativeOsCuratorRun: unique symbol }>;
type Run = { runId: string; model: string; current(): boolean; signal?: AbortSignal };
const runs = new WeakMap<object, Run>();
/** Native caller only. This opaque value is never serialized/delegated as authority. */
export function captureNativeOsCuratorRun(input: Run): NativeOsCuratorRun | undefined {
  if (!input.runId || !input.model || input.signal?.aborted || !input.current()) return undefined;
  const capability = Object.freeze({}) as NativeOsCuratorRun;
  runs.set(capability, { ...input }); return capability;
}
function fail(code: string): never { throw new OsCuratorGatewayError(code); }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** One canonical OS stdio row. Lookup is lazy because the actual runner binds its prepared config at dispatch. */
export async function prepareOsMemoryCuratorBridge(runCapability: NativeOsCuratorRun | undefined,
  preparation: { configPath: string; configKey: string; serverId: string },
): Promise<OsCuratorGateway | null> {
  const run = runCapability && runs.get(runCapability);
  if (!run || !run.current() || run.signal?.aborted) return null;
  let owner: ReturnType<typeof captureTrustedMemoryOwnerBinding>;
  try { owner = captureTrustedMemoryOwnerBinding(); } catch { return null; }
  const lifetime = new AbortController(); let closed = false, originalBinding: PreparedMcpBinding | undefined;
  const stop = () => lifetime.abort(new Error("os_curator_native_run_ended"));
  run.signal?.addEventListener("abort", stop, { once: true }); owner.signal.addEventListener("abort", stop, { once: true });
  const seen = new Set<string>();
  const cleanup = () => { if (closed) return; closed = true; stop(); owner.release();
    run.signal?.removeEventListener("abort", stop); owner.signal.removeEventListener("abort", stop); };
  try {
    const gateway = await createOsCuratorGateway({ model: run.model, signal: lifetime.signal,
      capture(_system, user) {
        if (closed || !run.current() || run.signal?.aborted) fail("os_curator_native_run_ended"); owner.assertCurrent();
        const rows = preparedMcpBindings(preparation.configPath).filter(binding => binding.configKey === preparation.configKey && binding.server.id === preparation.serverId);
        if (rows.length !== 1 || originalBinding && originalBinding !== rows[0]) fail("os_curator_preparation_changed");
        const binding = originalBinding ??= rows[0], runtime = currentRemoteCurationRuntime(binding);
        if (!runtime?.available || runtime.selection.model !== run.model || !runtime.current()
          || runtime.foregroundSignal.aborted) fail("os_curator_selected_runtime_unavailable");
        // Native owner pins the entire exact OS child. Known local packets carry an additional source-custody check.
        let packet: Record<string, unknown> | null = null;
        try { packet = object(JSON.parse(user)); } catch { fail("os_curator_packet_invalid"); }
        if (!packet) fail("os_curator_packet_invalid");
        if (packet.schema_version === "agentlas.memory-curation-input.v1") {
          const source = object(packet.data);
          if (!source || source.owner_namespace !== owner.ownerNamespace || source.intake_epoch !== owner.revocationEpoch) fail("os_curator_packet_owner_changed");
        }
        if (packet.schema_version === "agentlas.memory-curation-input.v1") {
          const key = createHash("sha256").update(user).digest("hex");
          // Preparation-local exact snapshot replay tombstones, not a quota on fresh jobs.
          // Retain oldest attempts (including unknown outcomes) for this native run; never evict to re-bill them.
          // Generic remote inputs have no job identity here: their authenticated Python job/lease remains authoritative.
          if (seen.has(key)) fail("os_curator_attempt_pending"); seen.add(key);
        }
        let released = false;
        const assertCurrent = () => {
          if (released || closed || lifetime.signal.aborted || !run.current() || run.signal?.aborted) fail("os_curator_native_run_ended");
          owner.assertCurrent();
          if (!preparedMcpBindings(preparation.configPath).includes(binding)
            || currentRemoteCurationRuntime(binding) !== runtime || !runtime.current() || runtime.foregroundSignal.aborted) fail("os_curator_selected_runtime_changed");
        };
        return { signals: [runtime.foregroundSignal, owner.signal], assertCurrent,
          async generate(input, signal) { assertCurrent(); const answer = await runtime.generate(input, signal); assertCurrent(); return answer; },
          release() { released = true; } };
      },
    });
    return { config: gateway.config, close() { cleanup(); gateway.close(); } };
  } catch { cleanup(); return null; }
}
