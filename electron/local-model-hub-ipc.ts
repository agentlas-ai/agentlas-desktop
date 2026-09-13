import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { validLocalPackageId } from "../shared/local-model-hub";
import type { LocalModelOperationView } from "../shared/local-model-hub";
import type { LocalModelHubManager } from "./local-model-hub/manager";

type Operation = {
  ownerId: number;
  material: string;
  controller: AbortController;
  pending: boolean;
  promise: Promise<unknown>;
  view: LocalModelOperationView;
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

  function operate<T>(event: IpcMainInvokeEvent, input: Record<string, unknown>, material: readonly unknown[],
    run: (signal: AbortSignal, phase: (value: LocalModelOperationView["phase"]) => void) => Promise<T>): Promise<T> {
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
    const kind = material[0] as LocalModelOperationView["kind"];
    const packageOperation = kind === "downloadEngine" || kind === "downloadModel" || kind === "installModelPackage" || kind === "installEnginePackage";
    const entry: Operation = { ownerId: event.sender.id, material: encoded, controller, pending: true, promise: Promise.resolve(), view: {
      operationId: id, kind, packageId: packageOperation ? material[1] as string : null,
      installationId: packageOperation ? null : material[1] as string,
      state: "pending", phase: packageOperation ? "download" : kind === "loadModel" ? "load" : "check",
      startedAt: new Date().toISOString(), finishedAt: null, reasonCode: null,
    } };
    operations.set(id, entry);
    entry.promise = Promise.resolve().then(() => run(controller.signal, phase => { entry.view.phase = phase; })).then(result => {
      const outcome = result && typeof result === "object" ? result as Record<string, unknown> : {};
      if (typeof outcome.installationId === "string") entry.view.installationId = outcome.installationId;
      entry.view.state = controller.signal.aborted || outcome.state === "cancelled" ? "cancelled"
        : outcome.state === "failed" || outcome.state === "unsupported" ? "failed" : "completed";
      entry.view.reasonCode = entry.view.state === "cancelled" ? "local_model_operation_cancelled"
        : entry.view.state === "failed" ? "local_model_operation_failed" : null;
      // A late adapter result may describe an already committed installation, but must
      // never let a cancelled renderer request continue into selection or another step.
      controller.signal.throwIfAborted();
      return result;
    }, error => {
      entry.view.state = controller.signal.aborted ? "cancelled" : "failed";
      // 실패 사유를 지우지 않는다(프로덕션 1.2.0 실측 2026-09-13): 엔진 설치가
      // engine_attestation_managed_runtime_unavailable 로 던졌는데 화면은 "완료하지 못함"만 보여
      // 사용자는 버튼이 아무것도 안 한다고 느꼈다. 던진 쪽이 기계 코드를 쓰면 그대로 실어 보낸다.
      entry.view.reasonCode = controller.signal.aborted ? "local_model_operation_cancelled" : failureReasonCode(error);
      throw error;
    }).finally(() => {
      entry.pending = false;
      entry.view.finishedAt = new Date().toISOString();
      event.sender.removeListener("destroyed", ownerDestroyed);
    });
    return entry.promise as Promise<T>;
  }

  handle("searchModels", (_event, input) => deps.manager.searchModels(input as unknown as Parameters<LocalModelHubManager["searchModels"]>[0]), { read: true });
  handle("inspectRepository", (_event, input) => deps.manager.inspectRepository(input as unknown as Parameters<LocalModelHubManager["inspectRepository"]>[0]), { read: true });
  handle("addModel", (_event, input) => deps.manager.addModel(input as unknown as Parameters<LocalModelHubManager["addModel"]>[0]));
  handle("snapshot", () => deps.manager.snapshot(), { read: true });
  handle("operations", event => [...operations.values()].filter(operation => operation.ownerId === event.sender.id)
    .map(operation => ({ ...operation.view, ...(operation.pending && operation.controller.signal.aborted ? { state: "cancelling" as const } : {}) })), { read: true });
  handle("installEnginePackage", (event, input) => {
    const id = packageId(input.packageId);
    return operate(event, input, ["installEnginePackage", id], async (signal, phase) => {
      signal.throwIfAborted();
      const download = await deps.manager.downloadEngine(id, signal);
      signal.throwIfAborted();
      if (download.state !== "verified") throw new Error(download.reasonCode ?? "local_engine_download_unverified");
      phase("install");
      return await deps.manager.installEngine(id, signal);
    });
  });
  handle("installModelPackage", (event, input) => {
    const id = packageId(input.packageId);
    return operate(event, input, ["installModelPackage", id], async (signal, phase) => {
      signal.throwIfAborted();
      const download = await deps.manager.downloadModel(id, signal);
      signal.throwIfAborted();
      if (download.state !== "verified") throw new Error(download.reasonCode ?? "local_model_download_unverified");
      phase("install");
      return await deps.manager.installDownloadedModel(id, signal);
    });
  });
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
    if (typeof context !== "number" || !Number.isSafeInteger(context) || (context !== 0 && (context < 512 || context > 131072))) {
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

/** 던져진 오류의 메시지가 기계 코드 형태(snake_case)면 그것을, 아니면 일반 실패 코드를 돌려준다. */
function failureReasonCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = message.trim().split(/[\s:]/, 1)[0] ?? "";
  return /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : "local_model_operation_failed";
}
