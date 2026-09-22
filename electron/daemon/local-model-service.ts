import path from "node:path";
import { LocalModelHubManager, type LocalModelHubManagerOptions } from "../local-model-hub/manager";
import type { LocalModelHubControlPort, LocalModelHubRuntimePort } from "../local-model-hub/ports";
import type { Runner } from "../runtime/runner";

export interface DaemonLocalModelStatus {
  schema: "agentlas.local-model-service-status.v1";
  ownerEpoch: string;
  state: "idle" | "starting" | "ready" | "closing" | "closed" | "failed";
  errorCode: string | null;
  pendingOperations: number;
  settled: boolean;
}

export interface DaemonLocalModelService {
  start(): Promise<DaemonLocalModelStatus>;
  status(): DaemonLocalModelStatus;
  control: LocalModelHubControlPort;
  runtime: LocalModelHubRuntimePort;
  close(): Promise<void>;
}

function machineCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(code) ? code : "local_model_service_operation_failed";
}

function serviceError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** One service owns the real manager, native engine, credentials and runner.
 * Only the daemon lifecycle may close it. Merely constructing this service
 * does not open a hub, reconcile old processes, or download any model. */
export function createDaemonLocalModelService(options: {
  rootPath: string;
  ownerEpoch: string;
  assertOwner(): void;
  windowsRuntimeDir?: string;
  onResidentChanged?(): void;
  shutdownTimeoutMs?: number;
}): DaemonLocalModelService {
  if (!path.isAbsolute(options.rootPath) || path.resolve(options.rootPath) === path.parse(options.rootPath).root) {
    throw serviceError("local_model_service_root_invalid");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(options.ownerEpoch)) throw serviceError("local_model_service_owner_epoch_invalid");
  const timeoutMs = options.shutdownTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw serviceError("local_model_service_timeout_invalid");
  let state: DaemonLocalModelStatus["state"] = "idle";
  let errorCode: string | null = null;
  let manager: LocalModelHubManager | null = null;
  let startPromise: Promise<DaemonLocalModelStatus> | null = null;
  let closePromise: Promise<void> | null = null;
  let runnerPromise: Promise<Runner> | null = null;
  const pending = new Set<Promise<unknown>>();
  const stop = new AbortController();
  const status = (): DaemonLocalModelStatus => ({
    schema: "agentlas.local-model-service-status.v1", ownerEpoch: options.ownerEpoch,
    state, errorCode, pendingOperations: pending.size,
    settled: (state === "idle" || state === "ready" || state === "closed") && pending.size === 0,
  });
  const assertAdmission = () => {
    if (stop.signal.aborted || state === "failed") throw serviceError("local_model_service_admission_closed");
    options.assertOwner();
  };
  const signal = (parent?: AbortSignal): AbortSignal => parent ? AbortSignal.any([stop.signal, parent]) : stop.signal;

  function start(): Promise<DaemonLocalModelStatus> {
    try { assertAdmission(); }
    catch (error) { return Promise.reject(error); }
    if (state === "ready") return manager!.assertOwnership().then(() => status());
    if (startPromise) return startPromise;
    state = "starting";
    // Assign before awaiting any filesystem operation: initialize() itself is
    // not a single-flight API and racing it can mistake its own lease for foreign.
    manager ??= new LocalModelHubManager(options.rootPath, {
      windowsRuntimeDir: options.windowsRuntimeDir,
      onResidentChanged: () => { try { options.onResidentChanged?.(); } catch { /* observation only */ } },
    } satisfies LocalModelHubManagerOptions);
    startPromise = (async () => {
      await manager!.initialize();
      assertAdmission();
      await manager!.assertOwnership();
      assertAdmission();
      state = "ready";
      return status();
    })().catch(error => {
      errorCode = machineCode(error);
      if (!stop.signal.aborted) state = "failed";
      throw error;
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  function execute<T>(operation: (owner: LocalModelHubManager) => Promise<T>, terminal = false): Promise<T> {
    if (terminal && stop.signal.aborted) {
      // close() already aborts inference and unloads the engine. Do not restart
      // a service just because a late GUI cancellation arrived.
      return Promise.resolve().then(() => closePromise).then(() => undefined as T);
    }
    const result = (async () => {
      await start();
      assertAdmission();
      await manager!.assertOwnership();
      assertAdmission();
      return await operation(manager!);
    })();
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  }

  const control: LocalModelHubControlPort = {
    snapshot: () => execute(owner => owner.snapshot()),
    searchModels: input => execute(owner => owner.searchModels(input)),
    inspectRepository: input => execute(owner => owner.inspectRepository(input)),
    addModel: input => execute(owner => owner.addModel(input)),
    downloadEngine: (id, parent) => execute(owner => owner.downloadEngine(id, signal(parent))),
    downloadModel: (id, parent) => execute(owner => owner.downloadModel(id, signal(parent))),
    importModel: (id, file, parent) => execute(owner => owner.importModel(id, file, signal(parent))),
    installEngine: (id, parent) => execute(owner => owner.installEngine(id, signal(parent))),
    installDownloadedModel: (id, parent) => execute(owner => owner.installDownloadedModel(id, signal(parent))),
    loadModel: (id, context, parent) => execute(owner => owner.loadModel(id, context, signal(parent))),
    unload: (epoch, input) => execute(owner => owner.unload(epoch, input), true),
    testCapabilities: (id, selection, parent) => execute(owner => owner.testCapabilities(id, selection, signal(parent))),
  };
  const runtime: LocalModelHubRuntimePort = {
    snapshot: control.snapshot,
    run: (request, events) => execute(async owner => {
      signal(request.signal).throwIfAborted();
      runnerPromise ??= import("../local-model-hub/runner").then(module => module.createManagedLocalModelRunner(owner));
      const runner = await runnerPromise;
      assertAdmission();
      return runner({ ...request, signal: signal(request.signal) }, events);
    }),
  };

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    state = "closing";
    stop.abort(serviceError("local_model_service_shutdown"));
    const startup = startPromise;
    const drain = (async () => {
      // Never release a lease while an in-flight initialize can still create it.
      await startup?.catch(() => {});
      // Stop the engine to unblock inference, but retain the manager lease
      // until downloads/installers and receipt writes have actually settled.
      await manager?.unload(undefined, { cancelActiveRuns: true });
      await Promise.allSettled([...pending]);
      await manager?.shutdown();
    })();
    closePromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([drain, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(serviceError("local_model_service_shutdown_unsettled")), timeoutMs);
        })]);
        state = "closed";
      } catch (error) {
        errorCode = machineCode(error);
        state = "failed";
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    })();
    return closePromise;
  }
  return { start, status, control, runtime, close };
}
