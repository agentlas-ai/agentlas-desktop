




import { invocationBreaker, invocationBreakerKey } from "./invocation-breaker";
import { withModelCallLedger, withModelCallScope, type ModelCallRole } from "./model-call-ledger";
import type { Runner, RunnerResult } from "./runner";

export interface DirectCliRuntime {
  kind: string;
  backend: string;
  source: string;
  label: string;
}

/** The runtime identity each direct route reports (the same breaker key as that runtime's turns). */
export const DIRECT_CLI_RUNTIMES = {
  codex: { kind: "codex", backend: "openai", source: "codex", label: "Codex" },
  antigravity: { kind: "antigravity", backend: "google", source: "agy", label: "Antigravity" },
  grok: { kind: "grok", backend: "xai", source: "grok", label: "Grok" },
} as const satisfies Record<string, DirectCliRuntime>;

/**
 * Runs `produce` (the CLI spawn) as one ledger-recorded, breaker-guarded call. `produce` returns the call's product, or
 * null/undefined when the CLI produced nothing (a failed row with `failureCode`). A tripped breaker refuses without
 * calling `produce`. Never throws: an error is a failed call that returns null.
 */
export async function runLedgeredCliCall<T>(input: {
  runtime: DirectCliRuntime;
  phase: string;
  role?: ModelCallRole;
  /** What the CLI was asked; the ledger records its size estimate and digest-free length only. */
  request: string;
  permission?: "read" | "write" | "full";
  failureCode?: string;
  produce: () => Promise<T | null | undefined>;
}): Promise<T | null> {
  const { runtime } = input;
  let product: T | null = null;
  const adapter: Runner = async (): Promise<RunnerResult> => {
    const produced = await input.produce();
    if (produced === null || produced === undefined) {
      return { text: "", ownerControlTerminal: "completed", failure: { kind: "exit", runtime: runtime.kind, source: "marker",
        providerCode: input.failureCode ?? "direct_cli_no_output", message: `${runtime.label} produced nothing.` } };
    }
    product = produced;
    return { text: "", ownerControlTerminal: "completed" };
  };
  const runner = invocationBreaker.wrap(withModelCallLedger(adapter, { kind: runtime.kind, backend: runtime.backend, model: null, effort: null }),
    invocationBreakerKey(runtime), runtime.label);
  try {
    const result = await withModelCallScope({ role: input.role ?? "worker", phase: input.phase }, () => runner({ systemPrompt: "",
      history: [], userPrompt: input.request, backendLabel: runtime.label, locale: "en", singleUse: true,
      ...(input.permission ? { permission: input.permission } : {}) }, { onPartial: () => {}, onStatus: () => {} }));
    return result.failure ? null : product;
  } catch {
    return null;
  }
}
