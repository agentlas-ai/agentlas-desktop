import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { validLocalPackageId } from "../shared/local-model-hub";
import type { LocalModelHubManager } from "./local-model-hub/manager";

type Operation = {
  ownerId: number;
  material: string;
  controller: AbortController;
  pending: boolean;
  promise: Promise<unknown>;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("local_model_payload_required");
  return value as Record<string, unknown>;
}

function identifier(value: unknown, kind: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new TypeError(`invalid_local_model_${kind}`);
  }
  return value;
}

function packageId(value: unknown): string {
  if (!validLocalPackageId(value)) throw new TypeError("invalid_local_model_package_id");
  return value;
}

/** The app window owns requests; the shared manager owns all package and process state. */
export function registerLocalModelHubIpc(deps: {
  ipc: Pick<IpcMain, "handle">;
  manager: LocalModelHubManager;
  assertTrustedSender: (event: IpcMainInvokeEvent) => BrowserWindow;
  selectModelFile: (window: BrowserWindow) => Promise<string | null>;
}): { closeAdmission: () => void; shutdown: () => Promise<void>; isSettled: () => boolean } {
  const operations = new Map<string, Operation>();
  const mutations = new Set<Promise<unknown>>();
  let admissionOpen = true;
  let shutdownPromise: Promise<void> | null = null;
  let settled = false;

  function track<T>(promise: Promise<T>): Promise<T> {
    mutations.add(promise);
    void promise.finally(() => mutations.delete(promise)).catch(() => {});
    return promise;
  }

  function handle(name: string, run: (event: IpcMainInvokeEvent, payload: Record<string, unknown>) => unknown,
    options: { terminal?: boolean; read?: boolean } = {}): void {
    deps.ipc.handle(`localModelHub:${name}`, (event, input: unknown) => {
      deps.assertTrustedSender(event);
      if (!admissionOpen && !options.terminal && !options.read) throw new Error("local_model_hub_admission_closed");
      const promise = Promise.resolve().then(() => run(event, input === undefined ? {} : object(input)));
      return options.read ? promise : track(promise);
    });
  }

  function operate<T>(event: IpcMainInvokeEvent, input: Record<string, unknown>, material: unknown,
    run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = identifier(input.operationId, "operation_id");
    const encoded = JSON.stringify(material);
    const existing = operations.get(id);
    if (existing) {
      if (existing.ownerId !== event.sender.id || existing.material !== encoded) {
        throw new Error("local_model_operation_id_conflict");
      }
      return existing.promise as Promise<T>;
    }
    // Retain completed requests for retry reconciliation within this app session.
    for (const [key, operation] of operations) {
      if (operations.size < 256) break;
      if (!operation.pending) operations.delete(key);
    }
    if (operations.size >= 256) throw new Error("local_model_operation_capacity_exceeded");
    const controller = new AbortController();
    const ownerDestroyed = () => controller.abort(new Error("local_model_request_owner_closed"));
    event.sender.once("destroyed", ownerDestroyed);
    const entry: Operation = { ownerId: event.sender.id, material: encoded, controller, pending: true, promise: Promise.resolve() };
    operations.set(id, entry);
    entry.promise = Promise.resolve().then(() => run(controller.signal)).finally(() => {
      entry.pending = false;
      event.sender.removeListener("destroyed", ownerDestroyed);
    });
    return entry.promise as Promise<T>;
  }

  handle("snapshot", () => deps.manager.snapshot(), { read: true });
  handle("downloadEngine", (event, input) => {
    const id = packageId(input.packageId);
    return operate(event, input, ["downloadEngine", id], (signal) => deps.manager.downloadEngine(id, signal));
  });
  handle("downloadModel", (event, input) => {
    const id = packageId(input.packageId);
    return operate(event, input, ["downloadModel", id], (signal) => deps.manager.downloadModel(id, signal));
  });
  handle("cancelOperation", (event, input) => {
    const id = identifier(input.operationId, "operation_id");
    const operation = operations.get(id);
    if (operation && operation.ownerId !== event.sender.id) throw new Error("local_model_operation_owner_mismatch");
    if (!operation?.pending) return { cancelled: false };
    operation.controller.abort(new Error("local_model_user_cancelled"));
    return { cancelled: true };
  }, { terminal: true });
  handle("importModel", async (event, input) => {
    const id = packageId(input.packageId);
    const selected = await deps.selectModelFile(deps.assertTrustedSender(event));
    if (!selected) return null;
    deps.assertTrustedSender(event);
    if (!admissionOpen) throw new Error("local_model_hub_admission_closed");
    return deps.manager.importModel(id, selected);
  });
  handle("installEngine", (_event, input) => deps.manager.installEngine(packageId(input.packageId)));
  handle("installDownloadedModel", (_event, input) => deps.manager.installDownloadedModel(packageId(input.packageId)));
  handle("loadModel", (event, input) => {
    const id = identifier(input.installationId, "installation_id");
    const context = input.contextTokens;
    if (typeof context !== "number" || !Number.isSafeInteger(context) || context < 512 || context > 131072) {
      throw new TypeError("invalid_local_model_context_tokens");
    }
    return operate(event, input, ["loadModel", id, context], (signal) => deps.manager.loadModel(id, context, signal));
  });
  handle("unload", (_event, input) => {
    if (typeof input.cancelActiveRuns !== "boolean") throw new TypeError("invalid_local_model_cancel_active_runs");
    return deps.manager.unload(identifier(input.processEpoch, "process_epoch"), { cancelActiveRuns: input.cancelActiveRuns });
  }, { terminal: true });
  handle("testCapabilities", (event, input) => {
    const id = identifier(input.installationId, "installation_id");
    for (const field of ["strictJson", "toolUse", "cancellation"] as const) {
      if (typeof input[field] !== "boolean") throw new TypeError(`invalid_local_model_${field}`);
    }
    const selection = {
      strictJson: input.strictJson as boolean,
      toolUse: input.toolUse as boolean,
      cancellation: input.cancellation as boolean,
    };
    return operate(event, input, ["testCapabilities", id, selection], (signal) => deps.manager.testCapabilities(id, selection, signal));
  });

  return {
    closeAdmission: () => { admissionOpen = false; },
    isSettled: () => settled,
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      admissionOpen = false;
      for (const operation of operations.values()) if (operation.pending) operation.controller.abort(new Error("local_model_app_shutdown"));
      shutdownPromise = (async () => {
        // Stop the native server first so outstanding inference calls can settle.
        await deps.manager.shutdown();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...mutations]),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("local_model_shutdown_operations_unsettled")), 10_000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        await deps.manager.shutdown();
        settled = true;
      })();
      return shutdownPromise;
    },
  };
}
