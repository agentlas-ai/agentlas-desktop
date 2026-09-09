import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

export type QuickJsHostInvoke = (
  target: string,
  method: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

export interface QuickJsEngineOptions {
  invoke: QuickJsHostInvoke;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
}

export interface QuickJsEvaluateOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class QuickJsEngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "QuickJsEngineError";
  }
}

const DEFAULT_MEMORY_LIMIT = 32 * 1024 * 1024;
const DEFAULT_STACK_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const CPU_SLICE_MS = 1_000;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 256 * 1024;

function jsonRoundTrip(value: unknown, errorCode: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined is not JSON");
    if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) throw new Error("JSON exceeds 256 KiB");
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new QuickJsEngineError(errorCode, "Value is not JSON serializable.");
  }
}

/**
 * A persistent QuickJS context for the unified computer-use API.
 *
 * Evaluations are serialized. State intentionally persists only when assigned
 * to `globalThis`; each source string otherwise executes inside its own async
 * function scope. No Node globals or module loader are installed in the guest.
 */
export class QuickJsEngine {
  private disposed = false;
  private resourcesDisposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private activeAbort: AbortController | null = null;
  private activeWallDeadline = 0;
  private cpuDeadline = 0;
  private activeJobReject: ((error: QuickJsEngineError) => void) | null = null;
  private readonly pendingHostPromises = new Set<QuickJSDeferredPromise>();

  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext,
    private readonly invokeHost: QuickJsHostInvoke,
  ) {}

  static async create(options: QuickJsEngineOptions): Promise<QuickJsEngine> {
    if (typeof options?.invoke !== "function") {
      throw new QuickJsEngineError("invalid-options", "A host invoke callback is required.");
    }
    const memoryLimit = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT;
    const stackLimit = options.maxStackBytes ?? DEFAULT_STACK_LIMIT;
    if (!Number.isInteger(memoryLimit) || memoryLimit < 1024 * 1024 || memoryLimit > DEFAULT_MEMORY_LIMIT) {
      throw new QuickJsEngineError("invalid-options", "memoryLimitBytes must be between 1 MiB and 32 MiB.");
    }
    if (!Number.isInteger(stackLimit) || stackLimit < 64 * 1024 || stackLimit > DEFAULT_STACK_LIMIT) {
      throw new QuickJsEngineError("invalid-options", "maxStackBytes must be between 64 KiB and 1 MiB.");
    }

    const module = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(memoryLimit);
    runtime.setMaxStackSize(stackLimit);
    const context = runtime.newContext();
    const engine = new QuickJsEngine(runtime, context, options.invoke);
    engine.installHostBridge();
    return engine;
  }

  evaluate(code: string, options: QuickJsEvaluateOptions = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new QuickJsEngineError("engine-disposed", "QuickJS engine is disposed."));
    if (typeof code !== "string") return Promise.reject(new QuickJsEngineError("invalid-code", "code must be a string."));
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
      return Promise.reject(new QuickJsEngineError("code-too-large", "code must be at most 256 KiB."));
    }
    const run = () => this.evaluateNow(code, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeAbort?.abort();
    for (const deferred of this.pendingHostPromises) deferred.dispose();
    this.pendingHostPromises.clear();
    // An active evaluate owns QuickJS handles until its finally block. Dispose
    // the context only after the serialized queue releases those handles.
    void this.queue.finally(() => this.finishDispose());
  }

  private finishDispose(): void {
    if (this.resourcesDisposed) return;
    this.resourcesDisposed = true;
    this.context.dispose();
    this.runtime.dispose();
  }

  private installHostBridge(): void {
    const bridge = this.context.newFunction("__agentlasInvoke", (...handles: QuickJSHandle[]) => {
      if (this.disposed || !this.activeAbort) return this.context.newError("QuickJS engine is disposed.");
      const target = handles[0] ? this.context.getString(handles[0]) : "";
      const method = handles[1] ? this.context.getString(handles[1]) : "";
      const rawArgs = handles[2] ? this.context.getString(handles[2]) : "null";
      if (Buffer.byteLength(rawArgs, "utf8") > MAX_JSON_BYTES) return this.context.newError("agentlas.invoke args exceed 256 KiB.");
      let args: unknown;
      try {
        args = JSON.parse(rawArgs) as unknown;
      } catch {
        return this.context.newError("agentlas.invoke args must be JSON serializable.");
      }
      const signal = this.activeAbort.signal;
      const deferred = this.context.newPromise();
      this.pendingHostPromises.add(deferred);
      const rejectOnAbort = () => {
        if (!deferred.alive) return;
        // Evaluation cancellation wins on the host-side race. Do not resume
        // guest handlers after cancellation; a catch handler could itself loop.
        deferred.dispose();
        this.pendingHostPromises.delete(deferred);
      };
      signal.addEventListener("abort", rejectOnAbort, { once: true });
      void this.invokeHost(target, method, args, signal).then(
        (value) => {
          if (!deferred.alive || this.disposed || signal.aborted) return;
          try {
            const encoded = JSON.stringify(jsonRoundTrip(value, "host-result-not-json"));
            const handle = this.context.newString(encoded);
            deferred.resolve(handle);
            handle.dispose();
            this.runPendingJobs();
          } catch (error) {
            const handle = this.context.newError(error instanceof Error ? error.message : "Host invocation failed.");
            deferred.reject(handle);
            handle.dispose();
            this.runPendingJobs();
          } finally {
            signal.removeEventListener("abort", rejectOnAbort);
            this.pendingHostPromises.delete(deferred);
          }
        },
        (error) => {
          if (!deferred.alive || this.disposed || signal.aborted) return;
          const handle = this.context.newError(error instanceof Error ? error.message : "Host invocation failed.");
          deferred.reject(handle);
          handle.dispose();
          signal.removeEventListener("abort", rejectOnAbort);
          this.pendingHostPromises.delete(deferred);
          this.runPendingJobs();
        },
      );
      return deferred.handle;
    });
    this.context.setProp(this.context.global, "__agentlasInvoke", bridge);
    bridge.dispose();

    const installed = this.context.evalCode(`
      Object.defineProperty(globalThis, "agentlas", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: Object.freeze({
          invoke(target, method, args = null) {
            if (typeof target !== "string" || typeof method !== "string") {
              throw new TypeError("agentlas.invoke target and method must be strings");
            }
            return __agentlasInvoke(target, method, JSON.stringify(args)).then(JSON.parse);
          }
        })
      });
    `, "agentlas-bootstrap.js");
    if (installed.error) {
      const message = String(this.context.dump(installed.error));
      installed.error.dispose();
      throw new QuickJsEngineError("bootstrap-failed", message);
    }
    installed.value.dispose();
  }

  private runPendingJobs(): void {
    if (this.disposed) return;
    this.cpuDeadline = Math.min(this.activeWallDeadline, Date.now() + CPU_SLICE_MS);
    const jobs = this.runtime.executePendingJobs();
    if (jobs.error) {
      const detail = this.context.dump(jobs.error);
      jobs.error.dispose();
      const interrupted = detail === "interrupted" || detail?.message === "interrupted";
      this.activeJobReject?.(new QuickJsEngineError(
        interrupted ? "script-cpu-limit" : "script-error",
        interrupted ? "QuickJS execution exceeded its CPU slice." : String(detail?.message ?? detail),
      ));
    }
  }

  private async evaluateNow(code: string, options: QuickJsEvaluateOptions): Promise<unknown> {
    if (this.disposed) throw new QuickJsEngineError("engine-disposed", "QuickJS engine is disposed.");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) {
      throw new QuickJsEngineError("invalid-timeout", "timeoutMs must be between 10 and 120000.");
    }
    if (options.signal?.aborted) throw new QuickJsEngineError("script-aborted", "QuickJS evaluation was aborted.");

    const controller = new AbortController();
    this.activeAbort = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + timeoutMs;
    this.activeWallDeadline = deadline;
    this.cpuDeadline = Math.min(deadline, Date.now() + CPU_SLICE_MS);
    this.runtime.setInterruptHandler(() => controller.signal.aborted || Date.now() >= this.cpuDeadline);

    let promiseHandle: QuickJSHandle | null = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      const evaluated = this.context.evalCode(`(async () => {\n${code}\n})()`, "agentlas-eval.js");
      if (evaluated.error) {
        const detail = this.context.dump(evaluated.error);
        evaluated.error.dispose();
        if (controller.signal.aborted || detail === "interrupted" || detail?.message === "interrupted") {
          const code = options.signal?.aborted ? "script-aborted" : Date.now() >= deadline ? "script-timeout" : "script-cpu-limit";
          throw new QuickJsEngineError(code, "QuickJS evaluation was interrupted.");
        }
        throw new QuickJsEngineError("script-error", String(detail?.message ?? detail));
      }
      promiseHandle = evaluated.value;
      const resolved = this.context.resolvePromise(promiseHandle);
      const jobFailure = new Promise<never>((_, reject) => {
        this.activeJobReject = reject;
      });
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new QuickJsEngineError(this.disposed ? "engine-disposed" : options.signal?.aborted ? "script-aborted" : "script-timeout", "QuickJS evaluation was aborted."));
        }, { once: true });
      });
      this.cpuDeadline = Math.min(deadline, Date.now() + CPU_SLICE_MS);
      const initialJobs = this.runtime.executePendingJobs();
      if (initialJobs.error) {
        const detail = this.context.dump(initialJobs.error);
        initialJobs.error.dispose();
        if (detail === "interrupted" || detail?.message === "interrupted") {
          const code = options.signal?.aborted ? "script-aborted" : Date.now() >= deadline ? "script-timeout" : "script-cpu-limit";
          throw new QuickJsEngineError(code, "QuickJS evaluation was interrupted.");
        }
        throw new QuickJsEngineError("script-error", String(detail?.message ?? detail));
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new QuickJsEngineError(options.signal?.aborted ? "script-aborted" : "script-timeout", "QuickJS evaluation timed out."));
        }, Math.max(1, deadline - Date.now()));
      });
      const result = await Promise.race([resolved, timeout, aborted, jobFailure]);
      if (result.error) {
        const detail = this.context.dump(result.error);
        result.error.dispose();
        if (controller.signal.aborted) {
          throw new QuickJsEngineError(options.signal?.aborted ? "script-aborted" : "script-timeout", "QuickJS evaluation was interrupted.");
        }
        if (detail === "interrupted" || detail?.message === "interrupted") {
          const code = options.signal?.aborted ? "script-aborted" : Date.now() >= deadline ? "script-timeout" : "script-cpu-limit";
          throw new QuickJsEngineError(code, "QuickJS evaluation was interrupted.");
        }
        throw new QuickJsEngineError("script-error", String(detail?.message ?? detail));
      }
      const dumped = this.context.dump(result.value);
      result.value.dispose();
      return jsonRoundTrip(dumped, "result-not-json");
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      promiseHandle?.dispose();
      controller.abort();
      this.runtime.removeInterruptHandler();
      if (this.activeAbort === controller) this.activeAbort = null;
      this.activeJobReject = null;
      this.activeWallDeadline = 0;
      this.cpuDeadline = 0;
    }
  }
}
