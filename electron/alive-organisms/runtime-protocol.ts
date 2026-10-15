/**
 * Owner edits for the Alive domain travel to whichever process holds it (NH21). The window process forwards them to the
 * background service over the authenticated native channel (native.attach, this version); the service answers with the
 * same AliveState its own host returns. No dependencies: both sides import the constants.
 */
export const ALIVE_RUNTIME_PROTOCOL = "agentlas.alive-runtime.v1";
export const ALIVE_RUNTIME_OPS = ["getState", "setEnabled", "setTokenLimit", "resumeUncertainWake"] as const;
export type AliveRuntimeOp = typeof ALIVE_RUNTIME_OPS[number];
/** Below the reverse path's own deadlines; a plan-access refresh that hangs is reported, not left to hold the channel. */
export const ALIVE_RUNTIME_BUDGET_MS = 7_000;

/** ownerIntentId is host-issued metadata, never an app/tool input. Optional for older Main clients;
 * a new daemon records their intent at its authenticated ingress. A newer Main never retries an enable without it.
 */
export interface AliveRuntimeRequest {
  version: typeof ALIVE_RUNTIME_PROTOCOL;
  op: AliveRuntimeOp;
  input: Record<string, unknown>;
  ownerIntentId?: string;
}
