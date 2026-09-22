import { createHash } from "node:crypto";
import type { DaemonLocalModelService } from "./local-model-service";
import type { RunnerEvents, RunnerResult } from "../runtime/runner";
import { assertLocalModelWireValue, localModelRemoteError, remoteLocalModelRequest,
  type LocalModelControlCommand, type LocalModelControlPage, type LocalModelRpcCommand,
  type LocalModelRpcReply, type RemoteLocalModelRunEvent, type RemoteLocalModelRunPage } from "../local-model-hub/remote-contract";

type State = LocalModelControlPage["state"];
type Entry = {
  clientId: string; id: string; material: string; controller: AbortController;
  state: State; result: unknown; errorCode: string | null; errorMessage: string | null;
  waiters: Set<() => void>; bytes: number;
};
type Run = Entry & { events: Array<{ sequence: number; event: RemoteLocalModelRunEvent; bytes: number }>;
  sequence: number; truncated: number; acknowledged: number; eventBytes: number };
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw localModelRemoteError("local_model_remote_id_invalid");
  return value;
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw localModelRemoteError("local_model_remote_cursor_invalid");
  return Number(value);
}
function diagnostic(error: unknown): { code: string; message: string } {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return { code: typeof code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(code) ? code : "local_model_remote_operation_failed",
    message: error instanceof Error ? error.message.slice(0, 2_000) : "Local model operation failed" };
}

/** Execution belongs to the service, never to a socket/GUI lifetime. Long-poll
 * observation has bounded replay and cannot create/restart a run. The outer
 * daemon must validate serviceIdentity + bootId before dispatching any command. */
export function createDaemonLocalModelRpc(options: {
  service: DaemonLocalModelService; ownerEpoch: string; assertOwner(): void;
}): { dispatch(command: LocalModelRpcCommand): Promise<LocalModelRpcReply>; closeAdmission(): void; close(): Promise<void> } {
  const controls = new Map<string, Entry>();
  const runs = new Map<string, Run>();
  const detached = new Set<string>();
  const cancelled = new Set<string>();
  const pending = new Set<Promise<void>>();
  let admission = true;
  const key = (clientId: string, itemId: string) => `${clientId}:${itemId}`;
  const wake = (entry: Entry) => { for (const fn of [...entry.waiters]) fn(); };
  const material = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
  function assertAdmission(clientId: string) {
    if (!admission || detached.has(clientId)) throw localModelRemoteError("local_model_remote_admission_closed");
    options.assertOwner();
  }
  function makeRoom(map: Map<string, Entry>, activeLimit: number) {
    if ([...map.values()].filter(row => row.state === "running").length >= activeLimit) throw localModelRemoteError("local_model_remote_capacity_exceeded");
    let retained = [...map.values()].reduce((sum, row) => sum + row.bytes, 0);
    for (const [itemKey, row] of map) {
      if (map.size < 32 && retained < 8 * 1024 * 1024) break;
      if (row.state !== "running" && row.waiters.size === 0) { map.delete(itemKey); retained -= row.bytes; }
    }
    if (map.size >= 32) throw localModelRemoteError("local_model_remote_capacity_exceeded");
  }
  function entry(clientId: string, itemId: string, digest: string): Entry {
    return { clientId, id: itemId, material: digest, controller: new AbortController(), state: "running",
      result: null, errorCode: null, errorMessage: null, waiters: new Set(), bytes: 0 };
  }
  function launch(row: Entry, operation: () => Promise<unknown>): void {
    const task = Promise.resolve().then(() => {
      row.controller.signal.throwIfAborted();
      return operation();
    }).then(result => {
      assertLocalModelWireValue(result);
      const encoded = JSON.stringify(result ?? null);
      row.bytes = Buffer.byteLength(encoded);
      if (row.bytes > MAX_RESULT_BYTES) throw localModelRemoteError("local_model_remote_result_too_large");
      row.result = result ?? null;
      row.state = "completed";
    }).catch(error => {
      const info = diagnostic(error);
      row.state = row.controller.signal.aborted ? "cancelled" : "failed";
      row.errorCode = info.code; row.errorMessage = info.message; row.bytes = 0;
    }).finally(() => { pending.delete(task); wake(row); });
    pending.add(task);
  }
  function wait(row: Entry, waitMs: number, ready: () => boolean): Promise<void> {
    if (ready() || waitMs === 0) return Promise.resolve();
    if (row.waiters.size >= 8) return Promise.reject(localModelRemoteError("local_model_remote_viewer_capacity_exceeded"));
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); row.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, waitMs);
      row.waiters.add(finish);
      if (ready()) finish();
    });
  }
  function get<T extends Entry>(map: Map<string, T>, clientId: string, itemId: unknown): T {
    const row = map.get(key(clientId, id(itemId)));
    if (!row) throw localModelRemoteError("local_model_remote_receipt_unavailable");
    return row;
  }
  function cancel(map: Map<string, Entry>, clientId: string, itemId: unknown, kind: "run" | "control") {
    const itemKey = key(clientId, id(itemId));
    const row = map.get(itemKey);
    if (!row) {
      // The cancellation socket can arrive before the start socket. Keep a
      // bounded fence; never turn a pre-dispatch cancellation into late work.
      if (cancelled.size >= 1_024 && !cancelled.has(`${kind}:${itemKey}`)) throw localModelRemoteError("local_model_remote_cancel_capacity_exceeded");
      cancelled.add(`${kind}:${itemKey}`);
      return { requested: true };
    }
    if (row.state === "running") row.controller.abort(localModelRemoteError("local_model_remote_cancelled"));
    return { requested: row.state === "running" || row.state === "cancelled" };
  }
  const controlPage = (row: Entry): LocalModelControlPage => ({
    schema: "agentlas.local-model-control-page.v1", ownerEpoch: options.ownerEpoch, operationId: row.id,
    state: row.state, result: row.result, errorCode: row.errorCode, errorMessage: row.errorMessage,
  });
  function runPage(row: Run, after = 0, limit = 128): RemoteLocalModelRunPage {
    if (after > row.sequence) throw localModelRemoteError("local_model_remote_cursor_invalid");
    let bytes = 0;
    const selected: RemoteLocalModelRunPage["events"] = [];
    for (const event of row.events) {
      if (event.sequence <= after) continue;
      if (selected.length >= limit || (selected.length > 0 && bytes + event.bytes > 256 * 1024)) break;
      selected.push({ sequence: event.sequence, event: event.event }); bytes += event.bytes;
    }
    return { schema: "agentlas.local-model-run-page.v1", ownerEpoch: options.ownerEpoch, runId: row.id,
      state: row.state, events: selected, nextSequence: selected.at(-1)?.sequence ?? after,
      truncatedBeforeSequence: Math.max(row.truncated, row.acknowledged),
      result: row.result as RunnerResult | null, errorCode: row.errorCode, errorMessage: row.errorMessage };
  }
  function emit(row: Run, event: RemoteLocalModelRunEvent): void {
    if (row.state !== "running") return;
    const sequence = ++row.sequence;
    let bytes: number;
    try { assertLocalModelWireValue(event); bytes = Buffer.byteLength(JSON.stringify(event)); }
    catch { bytes = MAX_EVENT_BYTES + 1; }
    if (bytes > MAX_EVENT_BYTES) {
      row.events = []; row.eventBytes = 0; row.truncated = sequence;
    } else {
      row.events.push({ sequence, event, bytes }); row.eventBytes += bytes;
      while (row.events.length > 2_048 || row.eventBytes > MAX_EVENT_BYTES) {
        const removed = row.events.shift()!; row.eventBytes -= removed.bytes; row.truncated = removed.sequence;
      }
    }
    wake(row);
  }
  function executeControl(command: LocalModelControlCommand, signal: AbortSignal): Promise<unknown> {
    const c = options.service.control;
    // Explicit method switch: no access to manager.shutdown, endpoint, bearer
    // headers, executeWithReceipt callbacks or arbitrary private methods.
    switch (command.method) {
      case "snapshot": return c.snapshot();
      case "searchModels": return c.searchModels(command.args[0]);
      case "inspectRepository": return c.inspectRepository(command.args[0]);
      case "addModel": return c.addModel(command.args[0]);
      case "downloadEngine": return c.downloadEngine(command.args[0], signal);
      case "downloadModel": return c.downloadModel(command.args[0], signal);
      case "importModel": return c.importModel(command.args[0], command.args[1], signal);
      case "installEngine": return c.installEngine(command.args[0], signal);
      case "installDownloadedModel": return c.installDownloadedModel(command.args[0], signal);
      case "loadModel": return c.loadModel(command.args[0], command.args[1], signal);
      case "unload": return c.unload(command.args[0], command.args[1]);
      case "testCapabilities": return c.testCapabilities(command.args[0], command.args[1], signal);
      default: throw localModelRemoteError("local_model_remote_method_unknown");
    }
  }
  async function dispatch(command: LocalModelRpcCommand): Promise<LocalModelRpcReply> {
    try {
      options.assertOwner();
      assertLocalModelWireValue(command);
      const clientId = id(command.clientId);
      let value: unknown;
      switch (command.op) {
        case "client.detach": {
          if (detached.size >= 256 && !detached.has(clientId)) throw localModelRemoteError("local_model_remote_client_capacity_exceeded");
          detached.add(clientId);
          for (const row of controls.values()) if (row.clientId === clientId && row.state === "running") row.controller.abort(localModelRemoteError("local_model_remote_client_detached"));
          value = { detached: true }; break;
        }
        case "control.cancel": value = cancel(controls, clientId, command.operationId, "control"); break;
        case "run.cancel": value = cancel(runs, clientId, command.runId, "run"); break;
        case "control.start": {
          const itemKey = key(clientId, id(command.operationId));
          if (!command.command || !Array.isArray(command.command.args)) throw localModelRemoteError("local_model_remote_command_invalid");
          const digest = material(command.command);
          let row = controls.get(itemKey);
          if (row) {
            if (row.material !== digest) throw localModelRemoteError("local_model_remote_id_conflict");
          } else {
            assertAdmission(clientId); makeRoom(controls, 16);
            row = entry(clientId, command.operationId, digest); controls.set(itemKey, row);
            if (cancelled.has(`control:${itemKey}`)) row.controller.abort(localModelRemoteError("local_model_remote_cancelled"));
            const current = row;
            launch(row, () => executeControl(command.command, current.controller.signal));
          }
          value = controlPage(row); break;
        }
        case "control.read": {
          const row = get(controls, clientId, command.operationId);
          await wait(row, integer(command.waitMs, 0, 25_000), () => row.state !== "running");
          value = controlPage(row); break;
        }
        case "run.start": {
          const itemKey = key(clientId, id(command.runId));
          if (!command.request || Object.prototype.hasOwnProperty.call(command.request, "signal")) throw localModelRemoteError("local_model_remote_request_invalid");
          const request = remoteLocalModelRequest(command.request);
          const digest = material(request);
          let row = runs.get(itemKey);
          if (row) {
            if (row.material !== digest) throw localModelRemoteError("local_model_remote_id_conflict");
          } else {
            assertAdmission(clientId); makeRoom(runs, 8);
            row = { ...entry(clientId, command.runId, digest), events: [], sequence: 0, truncated: 0, acknowledged: 0, eventBytes: 0 };
            runs.set(itemKey, row);
            if (cancelled.has(`run:${itemKey}`)) row.controller.abort(localModelRemoteError("local_model_remote_cancelled"));
            const current = row;
            const events: RunnerEvents = {
              onPartial: (...args) => emit(current, { kind: "onPartial", args }),
              onStatus: (...args) => emit(current, { kind: "onStatus", args }),
              onTool: (...args) => emit(current, { kind: "onTool", args }),
              onUsage: (...args) => emit(current, { kind: "onUsage", args }),
              onThinking: (...args) => emit(current, { kind: "onThinking", args }),
              onNotice: (...args) => emit(current, { kind: "onNotice", args }),
            };
            launch(row, () => options.service.runtime.run({ ...request, signal: current.controller.signal }, events));
          }
          value = runPage(row); break;
        }
        case "run.read": {
          const row = get(runs, clientId, command.runId);
          const after = integer(command.afterSequence, 0, Number.MAX_SAFE_INTEGER);
          const limit = integer(command.limit, 128, 256);
          if (!limit || after > row.sequence) throw localModelRemoteError("local_model_remote_cursor_invalid");
          await wait(row, integer(command.waitMs, 0, 25_000), () => row.state !== "running" || row.sequence > after);
          value = runPage(row, after, limit); break;
        }
        case "run.ack": {
          const row = get(runs, clientId, command.runId);
          const through = integer(command.throughSequence, 0, Number.MAX_SAFE_INTEGER);
          if (through > row.sequence) throw localModelRemoteError("local_model_remote_cursor_invalid");
          row.acknowledged = Math.max(row.acknowledged, through);
          while (row.events.length && row.events[0].sequence <= through) row.eventBytes -= row.events.shift()!.bytes;
          value = { acknowledged: through }; break;
        }
        default: throw localModelRemoteError("local_model_remote_command_unknown");
      }
      options.assertOwner();
      return { ok: true, value };
    } catch (error) { return { ok: false, error: diagnostic(error) }; }
  }
  return { dispatch, closeAdmission: () => { admission = false; }, close: async () => {
    admission = false;
    for (const row of [...controls.values(), ...runs.values()]) if (row.state === "running") row.controller.abort(localModelRemoteError("local_model_remote_service_stopping"));
    // The daemon lifecycle also closes service (and its owned engine). This
    // observer adapter must not release the manager lease itself.
    await Promise.allSettled([...pending]);
  } };
}
