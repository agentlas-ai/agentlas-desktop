import { assertPreparedHostQuestionContinuation, type PreparedHostQuestionContinuation } from "./host-question-continuation";
import type { InvocationService } from "./service";
import type { McpInvocationRequest } from "../../shared/types";
import { canonicalInvocationRequestJson, createInvocationAdmission, decideInvocationAdmission, type InvocationAdmissionIdentity } from "../store/invocation-admissions";
import { invocationProcessOwner, invocationRunOwners } from "../store/invocation-run-owners";
import { getDb } from "../store/db";
import { createFreshReservationFrontier } from "../runtime/fresh-reservation-frontier";

type Runtime = Pick<InvocationService, "start">;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Opt-in for a trusted in-process host. It reserves the same canonical input
 * as native ingress, then the original service atomically admits its durable
 * start. This is not a renderer operation or a new scheduled-root capability. */
export function withHostInvocationAdmission<T extends Runtime>(runtime: T, assertHostCurrent: () => void = () => {}): T {
  return new Proxy(runtime, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "start") return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      if (typeof value !== "function") fail("host_invocation_start_port_invalid");
      const start = value as Runtime["start"];
      return (...args: Parameters<InvocationService["start"]>): ReturnType<InvocationService["start"]> => {
        assertHostCurrent();
        // This adapter owns only a fresh direct start, never a serialized/native
        // admission, question continuation, scheduled root, or report capability.
        if (args.slice(3).some(argument => argument !== undefined)) fail("host_invocation_direct_start_required");
        const request = structuredClone(args[0]) as McpInvocationRequest;
        if (!request.runId) fail("host_invocation_run_id_required");
        // Report turns require their original queued-report capability; that
        // service prelude can refuse before its ordinary start boundary exists.
        if (request.oneTeamReportTurn === true) fail("host_invocation_report_capability_required");
        return startWithHostAdmission(target,start,request,args[1],args[2],assertHostCurrent);

      };
    },
  });
}

function startWithHostAdmission(target: Runtime, start: Runtime["start"], request: McpInvocationRequest,
  workspaceBinding: Parameters<InvocationService["start"]>[1], executionContext: Parameters<InvocationService["start"]>[2],
  assertHostCurrent: () => void, questionContinuation?: {sourceMessageId:string;requestHash:string}, beforeSourceStart?:()=>void): ReturnType<InvocationService["start"]> {
        const owner = invocationProcessOwner();
        const admission: InvocationAdmissionIdentity = Object.freeze({ runId: request.runId!, chatId: request.chatId,
          canonicalRequestJson: canonicalInvocationRequestJson(request), ownerProcessEpoch: owner.ownerId });
        const freeze = (input: unknown): void => { if (input && typeof input === "object") { for (const item of Object.values(input)) freeze(item); Object.freeze(input); } };
        freeze(request);
        const reserved = createInvocationAdmission(admission);
        if (reserved.kind !== "created") fail(`host_invocation_admission_${reserved.kind === "conflict" ? reserved.reason : reserved.admission.status}`);
        const frontier = createFreshReservationFrontier({
          tryReject: () => getDb().transaction(() => {
            if (invocationRunOwners.getOwnerByRunId(admission.runId)) return false;
            return decideInvocationAdmission({ ...admission, decision: "rejected", reasonCode: "host_local_setup_refused",
              noStartProof: { kind: "owner-start-boundary-not-crossed", verifiedOwnerProcessEpoch: admission.ownerProcessEpoch } }).kind === "rejected";
          }).immediate(),
          schedule: (retry, delayMs) => { setTimeout(retry, delayMs).unref(); },
          onFailure: () => console.warn("[invocation] exact unstarted host reservation cleanup pending", { runId: admission.runId }),
        });
        try {
          assertHostCurrent();
          const current = invocationProcessOwner();
          if (current.ownerId !== owner.ownerId || current.ownerKind !== owner.ownerKind) fail("host_invocation_owner_changed");
          // Keep opaque workspace and execution-context capabilities by identity.
          // The original start() owns rejection/settlement after this frontier.
          beforeSourceStart?.();
          return frontier.enterSource(() => Reflect.apply(start, target, [request, workspaceBinding, executionContext, questionContinuation, undefined, undefined, admission]));
        } catch (error) { frontier.closeBeforeSource(); throw error; }
}

/** Only an exact host-minted object can add Question custody to this internal start. */
export function startPreparedHostQuestionInvocation(runtime: Runtime, token: PreparedHostQuestionContinuation,
  expected: {chatId:string;sourceMessageId:string;requestHash:string}): ReturnType<InvocationService["start"]> {
  const start = runtime.start;
  if(typeof start !== "function") fail("host_invocation_start_port_invalid");
  const data = assertPreparedHostQuestionContinuation(token,expected);
  const request = structuredClone(data.request);
  return startWithHostAdmission(runtime,start,request,data.workspaceBinding,data.executionContext,
    () => { assertPreparedHostQuestionContinuation(token,expected); },
    {sourceMessageId:expected.sourceMessageId,requestHash:expected.requestHash},
    () => { assertPreparedHostQuestionContinuation(token,expected); data.beforeSourceStart(); });
}
