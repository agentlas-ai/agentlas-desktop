import { randomUUID } from "node:crypto";
import type { InvocationCurrentTurnSteerRequest, McpInvocationRequest } from "../../shared/types";
import type { configuredNativeGuiControls } from "./native-gui-controls";

type Controls = NonNullable<ReturnType<typeof configuredNativeGuiControls>>;
/** Returned when the chat's active run is not a daemon-owned run this process holds no capture for. The caller then
 * takes the unchanged capture / local path. */
export const NOT_DAEMON_OWNED = Symbol("not-daemon-owned");
type Routed<T> = T | typeof NOT_DAEMON_OWNED;

/**
 * Single execution host, stage 1. steer / current-turn / attach / receipt for an ACTIVE run are routed by the durable
 * `invocationRunOwners` row (ownerKind "daemon", state "active", owner = the attached daemon boot), not by whether this
 * process holds a capture. The owner-text security design is untouched: every text still goes through
 * controls.ownerText* with the exact {chatId, runId, inputDigest} binding, which the daemon re-checks against its own
 * source (`native-invocation-runtime.ts` capture()/supervisor.runBinding). A run this GUI started itself
 * (`isCaptured`) is never routed here, so GUI-started runs behave exactly as before.
 */
export function createDurableOwnerTextRoutes(deps: { controls(): Controls | undefined; isCaptured(runId: string): boolean }) {
  const opts = (extra: { expectedRunId?: string; intentId?: string } = {}) => ({ ...extra, isCaptured: deps.isCaptured });
  const receiptOf = (r: { chatId: string; intentId: string; runId: string; promptHash: string; messageId: string; sourceStatus: string; code?: string }) =>
    ({ chatId: r.chatId, intentId: r.intentId, runId: r.runId, promptHash: r.promptHash, messageId: r.messageId, status: r.sourceStatus, ...(r.code ? { code: r.code } : {}) });
  return Object.freeze({
    async currentTurn(event: object, chatId: string): Promise<Routed<{ runId: string } | null>> {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, chatId, opts());
      return c && binding ? c.durableCurrentTurn(event, binding) as Promise<{ runId: string } | null> : NOT_DAEMON_OWNED;
    },
    async steerCurrentTurn(event: object, input: InvocationCurrentTurnSteerRequest) {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, input.chatId, opts({ expectedRunId: input.expectedRunId }));
      if (!c || !binding) return NOT_DAEMON_OWNED;
      if (binding.runId !== input.expectedRunId) throw new Error("invocation_steer_stale_run");
      return receiptOf(await c.ownerText(event, binding, input.intentId, input.text, "current"));
    },
    async currentTurnSteerReceipt(event: object, input: { chatId: string; intentId: string }) {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, input.chatId, opts({ intentId: input.intentId }));
      if (!c || !binding) return NOT_DAEMON_OWNED;
      const r = await c.ownerTextReceipt(event, binding, input.intentId);
      return r ? receiptOf(r) : null;
    },
    async steer(event: object, request: McpInvocationRequest, intentId?: string) {
      const c = deps.controls(); const binding = c && await c.durableDaemonTextBindingForRequest(event, request, opts());
      if (!c || !binding) return NOT_DAEMON_OWNED;
      const kind = request.steeringMode === "interrupt" ? "interrupt" : "queue";
      return (await c.ownerText(event, binding, intentId ?? randomUUID(), request.userPrompt, kind)).result;
    },
    async steerReceipt(event: object, input: { chatId: string; intentId: string }) {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, input.chatId, opts({ intentId: input.intentId }));
      if (!c || !binding) return NOT_DAEMON_OWNED;
      return (await c.ownerTextReceipt(event, binding, input.intentId))?.result ?? null;
    },
    async unsteer(event: object, req: { chatId: string; position: number; text: string }) {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, req.chatId, opts());
      return c && binding ? c.ownerTextUnsteer(event, binding, req.position, req.text) : NOT_DAEMON_OWNED;
    },
    async attach(event: object, chatId: string, includeEvents: boolean) {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, chatId, opts());
      return c && binding ? c.ownerTextAttach(event, binding, includeEvents) : NOT_DAEMON_OWNED;
    },
    async steeringRecovery(event: object, chatId: string) {
      const c = deps.controls(); const binding = c?.durableDaemonTextBinding(event, chatId, opts());
      return c && binding ? c.ownerTextRecovery(event, binding) : NOT_DAEMON_OWNED;
    },
    async receipt(event: object, runId: string) {
      const c = deps.controls(); if (!c) return NOT_DAEMON_OWNED;
      const routed = await c.durableReceipt(event, runId, deps.isCaptured);
      return routed.routed ? routed.value : NOT_DAEMON_OWNED;
    },
  });
}
