import { AsyncLocalStorage } from "node:async_hooks";
import { tryRecordRunEvent } from "../store/run-events";

// judgment-exempt: 이 목록은 "이 도구가 바깥을 바꿨나"를 판정하지 않는다. claude-code가
// 선언한 내장 도구 이름의 **재고 목록**이며, 그 런타임이 어떤 내장 도구를 허용받았는지
// 영수증에 그대로 적기 위한 것이다(emit 은 runtimeKind: "claude-code" 로 고정).
// 다른 런타임의 읽기 도구 이름이 빠져도 이 영수증의 뜻은 달라지지 않는다.
const BUILTINS = ["Read", "Glob", "Grep", "ToolSearch", "WebSearch", "WebFetch", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell"] as const;
type Scope = { runId: string; chatId: string; nodeId: string; callRef: string; agentId: string | null };
type State = { scope: Scope; requested: boolean; observed: boolean };
const context = new AsyncLocalStorage<State>();
function emit(state: State, payload: Record<string, unknown>): void {
  tryRecordRunEvent({ ...state.scope, kind: "runtime_capability_receipt", payload: {
    schemaVersion: 1, runtimeKind: "claude-code", callRef: state.scope.callRef, ...payload,
  } });
}
export async function withRuntimeCapabilityReceipt<T>(scope: Scope, call: () => Promise<T>): Promise<T> {
  const state: State = { scope, requested: false, observed: false };
  return context.run(state, async () => {
    try { return await call(); }
    finally { if (state.requested && !state.observed) emit(state, { phase: "provider-init", status: "unknown", reason: "init-not-observed" }); }
  });
}
export function recordClaudeCapabilityRequest(input: {
  permission?: "read" | "write" | "full"; browserOnly: boolean; untrustedNoTools: boolean; allowedBuiltins: readonly string[];
}): void {
  const state = context.getStore();
  if (!state) return;
  state.requested = true;
  emit(state, { phase: "host-request", permission: input.permission ?? null, browserOnly: input.browserOnly,
    untrustedNoTools: input.untrustedNoTools, allowedBuiltins: BUILTINS.filter((name) => input.allowedBuiltins.includes(name)) });
}
export function projectClaudeBuiltinInventory(tools: unknown): Record<string, boolean> | null {
  if (!Array.isArray(tools) || !tools.every((item) => typeof item === "string")) return null;
  return Object.fromEntries(BUILTINS.map((name) => [name, tools.includes(name)]));
}
export function recordClaudeCapabilityInit(tools: unknown): void {
  const state = context.getStore();
  if (!state) return;
  state.observed = true;
  const advertisedBuiltins = projectClaudeBuiltinInventory(tools);
  emit(state, { phase: "provider-init", status: advertisedBuiltins ? "observed" : "unknown",
    ...(advertisedBuiltins ? { advertisedBuiltins } : { reason: "init-tools-missing-or-invalid" }) });
}
