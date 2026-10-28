import { createHash, randomUUID } from "node:crypto";
import {
  assertMainWorkRecoveryContext, registerMainWorkRecoveryRelayPort,
  type MainWorkActionRef, type MainWorkFinish, type MainWorkPortAdmission, type MainWorkRecoveryContext,
  type MainWorkRecoveryPort, type MainWorkReference, type MainWorkResult, type MainWorkUnknownEnd,
} from "../invocation/main-work-recovery";
import type { RemoteWorkRecoveryCall } from "./remote-contract";

/*
 * The Work journal (invocation/main-work-recovery.ts) has one writer: Main's MainWorkRecoveryContext. A managed local model
 * (agentlas-local) runs its tool loop in the daemon, which cannot receive that object (it is a class instance bound to Main's run;
 * a JSON copy was refused local_model_remote_value_invalid before anything was sent, so every Work-room turn on the local model
 * failed). The daemon's loop gets a relay port instead: each journal call travels on the run page and Main's own context answers it,
 * so admission, refusal of an identical repeat, the closed effect-free read list and the cause recorded when a call ends without its
 * answer are the ones Ollama, LM Studio and MLX get in Main.
 *
 * Main keeps every admission it handed out (by handle) and every action it admitted live. When the run ends in Main by any path
 * (completed, failed, aborted, the daemon lost), an admitted action whose dispatch end never arrived is closed with that cause
 * (closeOpen), so no action stays `started`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINISH: ReadonlySet<string> = new Set(["returned", "not_sent", "unconfirmed", "timeout", "aborted", "transport",
  "response_unreadable", "dispatch_ended", "process_lost"]);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = (code: string): never => { throw new Error(code); };

export const workRelayDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function reference(value: unknown): MainWorkReference | undefined {
  if (value === null || value === undefined) return undefined;
  if (!plain(value) || Object.entries(value).some(([key, item]) => key === "regenerate_read" ? item !== true
    : !["action_id", "step_id"].includes(key) || typeof item !== "string")) fail("main_work_reference_invalid");
  return value as MainWorkReference;
}
function actionRef(value: unknown): MainWorkActionRef {
  if (!plain(value) || typeof value.actionId !== "string" || !value.actionId || typeof value.stepId !== "string" || !value.stepId)
    fail("main_work_relay_reply_invalid");
  return { actionId: (value as { actionId: string }).actionId, stepId: (value as { stepId: string }).stepId };
}
function result(value: unknown): MainWorkResult {
  if (!plain(value) || typeof value.content !== "string" || typeof value.isError !== "boolean"
    || (value.artifactPaths !== undefined && (!Array.isArray(value.artifactPaths) || value.artifactPaths.some((item) => typeof item !== "string")))
    || (value.rawMcpResult !== undefined && !plain(value.rawMcpResult))) fail("main_work_relay_result_invalid");
  return value as unknown as MainWorkResult;
}

/**
 * Daemon side. `call` sends one journal call over the run page and resolves with Main's answer, or rejects with Main's error message
 * (main_work_* codes the loop reads exactly as it reads them from Main's context). Minted only by the daemon's run.start.
 */
export function createMainWorkRecoveryRelayPort(call: (input: RemoteWorkRecoveryCall) => Promise<unknown>): MainWorkRecoveryPort {
  // A unit is an opaque token naming Main's admission; the loop hands it back to finish/release unchanged.
  const units = new WeakMap<object, string>();
  const handleOf = (admission: { unit: unknown }): string => {
    const handle = admission.unit && typeof admission.unit === "object" ? units.get(admission.unit) : undefined;
    return handle ?? fail("main_work_relay_handle_unknown");
  };
  const text = (value: unknown): string => typeof value === "string" ? value : fail("main_work_relay_reply_invalid");
  const port: MainWorkRecoveryPort = {
    async admit(input) {
      const value = await call({ op: "admit", reference: input.reference ?? null, methodId: input.methodId,
        arguments: input.arguments, observational: input.observational, live: input.live === true });
      if (!plain(value)) return fail("main_work_relay_reply_invalid");
      const action = actionRef(value.action);
      if (value.kind === "reused") return { reused: result(value.reused), action } satisfies MainWorkPortAdmission;
      if (value.kind !== "unit" || typeof value.handle !== "string" || !UUID.test(value.handle)) return fail("main_work_relay_reply_invalid");
      const unit = Object.freeze({});
      units.set(unit, value.handle);
      return { unit, action } satisfies MainWorkPortAdmission;
    },
    async finish(admission, outcome, end: MainWorkFinish = "returned") {
      // The journal stores the JSON text of the result (MainWorkRecoveryContext.finish); the same text crosses here.
      const stored = JSON.parse(JSON.stringify({ content: outcome.content, isError: outcome.isError, visionMessage: outcome.visionMessage,
        ...(outcome.artifactPaths ? { artifactPaths: outcome.artifactPaths } : {}),
        ...(outcome.rawMcpResult ? { rawMcpResult: outcome.rawMcpResult } : {}) })) as MainWorkResult;
      await call({ op: "finish", handle: handleOf(admission), result: stored, outcome: end });
    },
    async release(admission) { await call({ op: "release", handle: handleOf(admission) }); },
    async endDispatch(actionId, effectStarted) {
      // Never throws (as Main's): when this answer cannot reach Main, Main closes the action itself when the run ends.
      try { await call({ op: "endDispatch", actionId, effectStarted }); } catch { /* closeOpen */ }
    },
    async packet(options) { return text(await call({ op: "packet", always: options?.always === true })); },
    async refusalPacket(stepId) { return text(await call({ op: "refusalPacket", stepId: stepId ?? null })); },
    async unknownOutcomePacket(actionIds) { return text(await call({ op: "unknownOutcomePacket", actionIds: [...actionIds] })); },
  };
  registerMainWorkRecoveryRelayPort(port);
  return port;
}

export interface MainWorkRecoveryRelayHost {
  /** The answer text for one request, computed once per request id (a page listing it again gets the same answer, never a second admit). */
  answer(requestId: string, callText: string, op: string): string;
  /** The daemon refused the answer (its request had already ended): an admission it carried never reached the loop. */
  undelivered(requestId: string): void;
  /** Every admitted action whose dispatch end never arrived is closed with `cause`. Never throws. */
  closeOpen(cause: MainWorkUnknownEnd): void;
}

/** Main side: answers the daemon's journal calls with Main's own context, the journal's only writer. */
export function createMainWorkRecoveryRelayHost(context: MainWorkRecoveryContext): MainWorkRecoveryRelayHost {
  assertMainWorkRecoveryContext(context);
  const admissions = new Map<string, Extract<ReturnType<MainWorkRecoveryContext["admit"]>, { unit: unknown }>>();
  const live = new Map<string, { ended: boolean }>();
  const answers = new Map<string, { text: string; admittedHandle?: string; actionId?: string }>();
  function execute(raw: unknown, op: string): { value: unknown; admittedHandle?: string; actionId?: string } {
    // The page names the op (a drain answers dispatch ends only); the call itself must be that op.
    if (!plain(raw) || typeof raw.op !== "string" || raw.op !== op) return fail("main_work_relay_call_invalid");
    const call = raw as RemoteWorkRecoveryCall;
    switch (call.op) {
      case "admit": {
        if (typeof call.methodId !== "string" || !call.methodId || call.methodId.length > 512 || !plain(call.arguments)
          || typeof call.observational !== "boolean" || typeof call.live !== "boolean") fail("main_work_relay_call_invalid");
        const admitted = context.admit({ reference: reference(call.reference), methodId: call.methodId, arguments: call.arguments,
          observational: call.observational, live: call.live });
        const action = { actionId: admitted.action.actionId, stepId: admitted.action.stepId };
        if ("reused" in admitted) return { value: { kind: "reused", reused: admitted.reused, action } };
        const handle = randomUUID();
        admissions.set(handle, admitted);
        if (call.live) live.set(action.actionId, { ended: false });
        return { value: { kind: "unit", handle, action }, admittedHandle: handle, actionId: action.actionId };
      }
      case "finish": case "release": {
        const admitted = admissions.get(typeof call.handle === "string" ? call.handle : "") ?? fail("main_work_relay_handle_unknown");
        admissions.delete(call.handle);
        if (call.op === "release") context.release(admitted);
        else {
          if (typeof call.outcome !== "string" || !FINISH.has(call.outcome)) fail("main_work_relay_call_invalid");
          context.finish(admitted, result(call.result), call.outcome);
        }
        return { value: null };
      }
      case "endDispatch": {
        const entry = typeof call.actionId === "string" ? live.get(call.actionId) : undefined;
        // Only an action this relay admitted live, once: the daemon cannot close another run's call.
        if (entry && !entry.ended && typeof call.effectStarted === "boolean") {
          entry.ended = true;
          context.endDispatch(call.actionId, call.effectStarted);
        }
        return { value: null };
      }
      case "packet": return { value: context.packet({ always: call.always === true }) };
      case "refusalPacket":
        return { value: context.refusalPacket(typeof call.stepId === "string" ? call.stepId : undefined) };
      case "unknownOutcomePacket":
        if (!Array.isArray(call.actionIds) || call.actionIds.length > 64 || call.actionIds.some((id) => typeof id !== "string"))
          fail("main_work_relay_call_invalid");
        return { value: context.unknownOutcomePacket(call.actionIds) };
      default: return fail("main_work_relay_call_invalid");
    }
  }
  return {
    answer(requestId, callText, op) {
      const known = answers.get(requestId);
      if (known) return known.text;
      let reply: { ok: true; value: unknown } | { ok: false; message: string };
      let admittedHandle: string | undefined, actionId: string | undefined;
      try {
        const done = execute(JSON.parse(callText), op);
        admittedHandle = done.admittedHandle; actionId = done.actionId;
        reply = { ok: true, value: done.value ?? null };
      } catch (error) {
        reply = { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
      }
      const text = JSON.stringify(reply);
      answers.set(requestId, { text, admittedHandle, actionId });
      // Only recent ids can be listed again (a page read before the answer arrived).
      if (answers.size > 64) answers.delete(answers.keys().next().value!);
      return text;
    },
    undelivered(requestId) {
      const known = answers.get(requestId);
      if (!known?.admittedHandle || !known.actionId) return;
      admissions.delete(known.admittedHandle);
      const entry = live.get(known.actionId);
      if (!entry || entry.ended) return;
      entry.ended = true;
      // The loop never received the admission, so it never dispatched the call: no effect (cancelled, main_tool_request_not_sent).
      try { context.endDispatch(known.actionId, false); } catch { /* endDispatch never throws */ }
    },
    closeOpen(cause) {
      for (const [actionId, entry] of live) {
        if (entry.ended) continue;
        entry.ended = true;
        try { context.endDispatch(actionId, true, cause); } catch { /* endDispatch never throws */ }
      }
      admissions.clear();
    },
  };
}
