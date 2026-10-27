import { preDispatchRefusal, type RunnerEvents, type RunnerRequest } from "./runner";
import { agentContextSessionKey } from "./agent-context";
import { createTurnLine, type TurnLineDb } from "./agent-context-turn-line";
import { releaseDeadSessionTurn } from "./agent-context-dead-holder";
import { currentNativeExecution } from "./native-execution-context";
export { withNativeExecution as withNativeWriterExecution } from "./native-execution-context";
export type { NativeExecutionSource as NativeWriterExecution } from "./native-execution-context";
import { nativeWriterKey, withNativeWriterKeys } from "./native-writer-admission";
import { getDb } from "../store/db";
import { assertInvocationRunOwner, invocationProcessOwner, invocationRunOwners } from "../store/invocation-run-owners";

let line: ReturnType<typeof createTurnLine> | undefined;
function writerLine(): ReturnType<typeof createTurnLine> {
  return line ??= createTurnLine({
    db: () => getDb() as unknown as TurnLineDb,
    who: () => ({ ...invocationProcessOwner(), pid: process.pid }),
    requireProcessOrRunEnd: true,
    requireProcessExit: true,
    runEnded: turn => {
      const owner = invocationRunOwners.getRunOwner(turn.chatId, turn.runId);
      return !!owner && (owner.state === "released" || (!!turn.leaseId && owner.leaseId !== turn.leaseId));
    },
    recoverDeadRun: holder => { releaseDeadSessionTurn(holder, {
      current: () => ({ ...invocationProcessOwner(), pid: process.pid }),
      getOwner: (chatId, runId) => invocationRunOwners.getRunOwner(chatId, runId),
      release: expected => invocationRunOwners.release(expected),
    }); },
  });
}

/** Common CLI boundary. Neither the model nor a project ID can choose a native writer partition. */
export async function withHostNativeWriter<T>(runtimeKind: string, request: RunnerRequest, events: RunnerEvents,
  action: () => Promise<T>): Promise<T> {
  let entered = false;
  try {
    const key = nativeWriterKey({ runtimeKind,
      contextKey: request.agentContext && !request.minimalObservation && !request.untrustedNoTools
        ? agentContextSessionKey(request.agentContext) : null,
      nativeSessionId: request.runtimeSessionId,
      chatId: request.chatId,
      sessionOwnerId: request.runtimeSessionOwnerId ?? request.agentId,
      isolatedOwner: request.runtimeSessionOwnerId != null,
    });
    const native = currentNativeExecution();
    const owner = native && invocationRunOwners.getRunOwner(native.chatId, native.runId);
    const handleKey = request.runtimeSessionId ? nativeWriterKey({ runtimeKind, nativeSessionId: request.runtimeSessionId }) : null;
    return await withNativeWriterKeys([key, handleKey].filter((value): value is string => value !== null), writerKey => ({
      signal: request.signal,
      ...(native ? {
        requireDurableLine: true,
        line: () => {
          // Recheck the genuine execution after all earlier asynchronous preparation and before taking a place.
          currentNativeExecution();
          if (!owner || owner.state !== "active" || owner.ownerId !== native.ownerId || owner.leaseId !== native.leaseId)
            throw Object.assign(new Error("native_writer_owner_unavailable"), { code: "native_writer_owner_unavailable" });
          return writerLine().enqueue(writerKey, { chatId: native.chatId, runId: native.runId, leaseId: native.leaseId });
        },
      } : {}),
      onWait: () => events.onStatus(request.locale === "ko"
        ? "같은 세션의 실행이 끝나기를 기다리는 중..." : "Waiting for the current turn of this session..."),
    }), async () => {
      currentNativeExecution();
      if (native) {
        if (!owner) throw Object.assign(new Error("native_writer_owner_unavailable"), { code: "native_writer_owner_unavailable" });
        assertInvocationRunOwner(owner);
      }
      if (request.agentContext && !request.minimalObservation && !request.untrustedNoTools) agentContextSessionKey(request.agentContext);
      entered = true;
      return action();
    });
  } catch (error) {
    if (request.signal?.aborted && !entered) throw request.signal.reason ?? error;
    // Waiting/currentness/store failures preceded every provider dispatch. A failure from the admitted action keeps
    // its original accepted/effect facts, including unsettled native turns; it is never relabelled for replay.
    throw entered ? error : preDispatchRefusal(error, "native-writer-admission", "native_writer_admission_failed");
  }
}
