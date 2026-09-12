import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  LocalEngineInstallationReceipt,
  LocalModelCapabilityReceipt,
  LocalModelPackageIdentity,
  LocalModelFitAssessment,
  LocalModelHubSnapshot,
  LocalModelInstallationReceipt,
  LocalModelLoadReceipt,
  LocalModelRunReceipt,
  LocalPackageDownloadReceipt,
  LocalPackageProgress,
} from "../../shared/local-model-hub";
import { assertLocalModelPackageIdentity, LOCAL_MODEL_HUB_SCHEMA_VERSION } from "../../shared/local-model-hub";
import {
  compatibleEnginePackage,
  localEngineCatalog,
  localEnginePackage,
  localModelCatalog,
} from "./catalog";
import { LocalPackageDownloadManager, sha256File } from "./download-manager";
import { HuggingFaceModelIndex } from "./huggingface";
import { LocalEngineInstaller } from "./engine-installer";
import { observeLocalProcessIdentity, matchesLocalProcessIdentity, terminateMatchedLocalProcess } from "./platform";
import { estimateLocalModelFit, observeLocalHardware } from "./hardware";

interface PersistedHubState {
  schemaVersion: 1;
  registeredModels?: LocalModelPackageIdentity[];
  downloadReceipts: LocalPackageDownloadReceipt[];
  engineInstallations: LocalEngineInstallationReceipt[];
  modelInstallations: LocalModelInstallationReceipt[];
  loadReceipts: LocalModelLoadReceipt[];
  capabilityReceipts: LocalModelCapabilityReceipt[];
  runReceipts: LocalModelRunReceipt[];
}

interface OwnerLease {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  createdAt: string;
}

interface ProcessLease {
  schemaVersion: 1;
  processEpoch: string;
  pid: number;
  executablePath: string;
  executableSha256: string;
  modelPath: string;
  modelSha256: string;
  port: number;
  createdAt: string;
  processCreatedAt?: string | null;
}

export interface LocalModelHubManagerOptions {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  engineInstaller?: LocalEngineInstaller;
  healthTimeoutMs?: number;
}

export interface LocalCapabilityTestSelection {
  strictJson?: boolean;
  toolUse?: boolean;
  cancellation?: boolean;
}

function emptyState(): PersistedHubState {
  return {
    schemaVersion: 1,
    downloadReceipts: [],
    engineInstallations: [],
    modelInstallations: [],
    loadReceipts: [],
    capabilityReceipts: [],
    runReceipts: [],
  };
}

function bounded<T>(items: T[], limit = 200): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function validState(value: unknown): value is PersistedHubState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PersistedHubState>;
  return state.schemaVersion === 1
    && Array.isArray(state.downloadReceipts)
    && Array.isArray(state.engineInstallations)
    && Array.isArray(state.modelInstallations)
    && Array.isArray(state.loadReceipts)
    && Array.isArray(state.capabilityReceipts)
    && Array.isArray(state.runReceipts);
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function aborted(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}


export async function probeLocalEngineHealth(endpoint: string, authToken: string, remainingMs: number, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve,reject) => {
    abort = () => { controller.abort(); reject(new DOMException("Aborted","AbortError")); };
    signal?.addEventListener("abort",abort,{once:true});
    timer = setTimeout(() => { controller.abort(); reject(new Error("engine_health_timeout")); },Math.max(1,remainingMs));
  });
  try {
    return await Promise.race([boundary, fetchImpl(`${endpoint}/health`, { signal: controller.signal, headers: { authorization: `Bearer ${authToken}` } }).then(response => response.ok).catch(() => false)]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort",abort); }
}

export class LocalModelHubManager {
  private readonly packageRoot: string;
  private readonly engineRoot: string;
  private readonly statePath: string;
  private readonly ownerLeasePath: string;
  private readonly processLeasePath: string;
  private readonly instanceId = randomUUID();
  private readonly modelIndex: HuggingFaceModelIndex;
  private readonly downloader: LocalPackageDownloadManager;
  private readonly installer: LocalEngineInstaller;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly healthTimeoutMs: number;
  private readonly progress = new Map<string, LocalPackageProgress>();
  private state: PersistedHubState = emptyState();
  private initialized = false;
  private unavailableReason: string | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private residentProcess: ChildProcess | null = null;
  private residentReceipt: LocalModelLoadReceipt | null = null;
  private residentAuthToken: string | null = null;
  private lifecycleChain: Promise<void> = Promise.resolve();
  private loadGeneration = 0;
  private readonly activeInference = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(readonly rootPath: string, options: LocalModelHubManagerOptions = {}) {
    this.packageRoot = join(rootPath, "packages");
    this.engineRoot = join(rootPath, "engines");
    this.statePath = join(rootPath, "state.json");
    this.ownerLeasePath = join(rootPath, "owner-lease.json");
    this.processLeasePath = join(rootPath, "process-lease.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.modelIndex = new HuggingFaceModelIndex(join(rootPath, "hf-cache"), this.fetchImpl);
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 60_000;
    this.downloader = new LocalPackageDownloadManager(this.packageRoot);
    this.installer = options.engineInstaller ?? new LocalEngineInstaller(this.engineRoot);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
      await this.claimOwnerLease();
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : "local_model_hub_initialization_failed";
      this.initialized = true;
      return;
    }
    try {
      const raw = await readFile(this.statePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        this.unavailableReason = "local_model_hub_state_invalid_json";
        this.initialized = true;
        return;
      }
      if (!validState(parsed)) {
        this.unavailableReason = "local_model_hub_state_invalid_schema";
        this.initialized = true;
        return;
      }
      try {
        if (parsed.registeredModels !== undefined && (!Array.isArray(parsed.registeredModels) || parsed.registeredModels.length > 1000)) throw new Error();
        for (const identity of parsed.registeredModels ?? []) assertLocalModelPackageIdentity(identity);
      } catch { this.unavailableReason = "local_model_registry_invalid"; this.initialized = true; return; }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unavailableReason = "local_model_hub_state_unreadable";
        this.initialized = true;
        return;
      }
      this.state = emptyState();
    }
    try {
      await this.reconcileStaleProcessLease();
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : "local_model_process_recovery_failed";
    }
    this.initialized = true;
  }

  private async claimOwnerLease(): Promise<void> {
    const lease: OwnerLease = {
      schemaVersion: 1,
      instanceId: this.instanceId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.ownerLeasePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let current: OwnerLease | null = null;
        try { current = JSON.parse(await readFile(this.ownerLeasePath, "utf8")) as OwnerLease; } catch { /* stale */ }
        if (current && Number.isSafeInteger(current.pid) && current.pid > 0 && processAlive(current.pid)) {
          throw new Error("local_model_hub_owned_by_other_process");
        }
        const stale = `${this.ownerLeasePath}.stale-${randomUUID()}`;
        await rename(this.ownerLeasePath, stale).catch(() => undefined);
        await rm(stale, { force: true }).catch(() => undefined);
      }
    }
    throw new Error("local_model_hub_owner_lease_failed");
  }

  private async reconcileStaleProcessLease(): Promise<void> {
    let lease: ProcessLease | null = null;
    try { lease = JSON.parse(await readFile(this.processLeasePath, "utf8")) as ProcessLease; } catch { return; }
    if (!lease || lease.schemaVersion !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1) {
      throw new Error("local_model_process_lease_invalid");
    }
    if (!processAlive(lease.pid)) {
      await rm(this.processLeasePath, { force: true });
      return;
    }
    const engineBoundary = `${resolve(this.engineRoot)}${sep}`;
    const modelBoundary = `${resolve(this.packageRoot)}${sep}`;
    if (!resolve(lease.executablePath).startsWith(engineBoundary) || !resolve(lease.modelPath).startsWith(modelBoundary)) {
      throw new Error("local_model_process_lease_path_rejected");
    }
    if (
      await sha256File(lease.executablePath).catch(() => null) !== lease.executableSha256
      || await sha256File(lease.modelPath).catch(() => null) !== lease.modelSha256
    ) throw new Error("local_model_process_lease_hash_mismatch");
    const identity = await observeLocalProcessIdentity(lease.pid);
    if (!identity || !matchesLocalProcessIdentity(identity, lease)) {
      throw new Error("local_model_process_lease_command_mismatch");
    }
    await terminateMatchedLocalProcess(lease);
    await rm(this.processLeasePath, { force: true });
  }

  private async save(): Promise<void> {
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      const temporary = `${this.statePath}.tmp-${randomUUID()}`;
      await writeFile(temporary, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    await this.saveChain;
  }

  private async ready(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async readyForMutation(): Promise<void> {
    await this.ready();
    if (this.unavailableReason) throw new Error(this.unavailableReason);
  }

  private modelCatalog(): LocalModelPackageIdentity[] {
    return [...localModelCatalog(), ...(this.state.registeredModels ?? [])].map(value => ({ ...value }));
  }

  private modelPackage(id: string): LocalModelPackageIdentity | undefined {
    return this.modelCatalog().find(value => value.packageId === id);
  }

  searchModels(input: { query: string; cursor?: string; refresh?: boolean }) { return this.modelIndex.searchModels(input); }
  inspectRepository(input: { repository: string; refresh?: boolean }) { return this.modelIndex.inspectRepository(input); }

  async addModel(input: { repository: string; revision: string; fileName: string }): Promise<LocalModelPackageIdentity> {
    await this.readyForMutation();
    const identity = await this.modelIndex.resolveModel(input);
    return this.enqueueLifecycle(async () => {
      if (this.shutdownPromise) throw new Error("local_model_hub_admission_closed");
      if (this.unavailableReason) throw new Error(this.unavailableReason);
      const existing = this.modelCatalog().find(value => value.repository === identity.repository && value.revision === identity.revision && value.fileName === identity.fileName);
      if (existing) {
        if (existing.sha256 !== identity.sha256 || existing.byteLength !== identity.byteLength) throw new Error("local_model_identity_conflict");
        return existing;
      }
      if ((this.state.registeredModels?.length ?? 0) >= 1000) throw new Error("local_model_registry_capacity_exceeded");
      this.state.registeredModels = [...(this.state.registeredModels ?? []), identity];
      try { await this.save(); } catch (error) { this.unavailableReason = "local_model_registry_write_failed"; throw error; }
      return { ...identity };
    });
  }

  async snapshot(): Promise<LocalModelHubSnapshot> {
    await this.ready();
    const hardware = await observeLocalHardware(this.rootPath);
    const models = this.modelCatalog();
    const fitAssessments = models.map((model) => {
      const fit = estimateLocalModelFit(hardware, model);
      const loaded = this.state.loadReceipts.some(receipt => receipt.state === "resident" && this.state.modelInstallations.some(installation => installation.installationId === receipt.installationId && installation.modelPackageId === model.packageId));
      return this.state.registeredModels?.some(registered => registered.packageId === model.packageId) && !loaded
        ? { ...fit, class: "unknown" as const, reasonCodes: [...fit.reasonCodes, "hf_engine_compatibility_unverified"] }
        : fit;
    });
    const compatible = compatibleEnginePackage();
    return {
      schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      hardware,
      engineCatalog: localEngineCatalog(),
      modelCatalog: models,
      engineProgress: [...this.progress.values()].filter((item) => item.packageId.startsWith("llama.cpp:")),
      modelProgress: [...this.progress.values()].filter((item) => !item.packageId.startsWith("llama.cpp:")),
      downloadReceipts: [...this.state.downloadReceipts],
      engineInstallations: [...this.state.engineInstallations],
      modelInstallations: [...this.state.modelInstallations],
      fitAssessments,
      loadReceipts: [...this.state.loadReceipts],
      capabilityReceipts: [...this.state.capabilityReceipts],
      runReceipts: [...this.state.runReceipts],
      resident: this.residentProcess && this.residentReceipt?.state === "resident" ? { ...this.residentReceipt } : null,
      unavailableReason: this.unavailableReason ?? compatible.reasonCode,
    };
  }

  async downloadEngine(packageId: string, signal?: AbortSignal): Promise<LocalPackageDownloadReceipt> {
    await this.readyForMutation();
    const identity = localEnginePackage(packageId);
    if (!identity) throw new Error("unknown_engine_package");
    if (identity.platform !== process.platform || identity.arch !== process.arch) {
      throw new Error("engine_package_host_mismatch");
    }
    const result = await this.downloader.download(identity, "engine", {
      signal,
      fetchImpl: this.fetchImpl,
      onProgress: (progress) => this.progress.set(packageId, progress),
    });
    this.state.downloadReceipts = bounded([...this.state.downloadReceipts, result.receipt]);
    await this.save();
    return result.receipt;
  }

  async downloadModel(packageId: string, signal?: AbortSignal): Promise<LocalPackageDownloadReceipt> {
    await this.readyForMutation();
    const identity = this.modelPackage(packageId);
    if (!identity) throw new Error("unknown_model_package");
    if (identity.gated) throw new Error("gated_model_download_unsupported");
    const result = await this.downloader.download(identity, "model", {
      signal,
      fetchImpl: this.fetchImpl,
      onProgress: (progress) => this.progress.set(packageId, progress),
    });
    this.state.downloadReceipts = bounded([...this.state.downloadReceipts, result.receipt]);
    await this.save();
    return result.receipt;
  }

  async importModel(
    packageId: string,
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<LocalModelInstallationReceipt> {
    await this.readyForMutation();
    const identity = this.modelPackage(packageId);
    if (!identity) throw new Error("unknown_model_package");
    const result = await this.downloader.importVerified(selectedPath, identity, "model", signal);
    this.state.downloadReceipts = bounded([...this.state.downloadReceipts, result.receipt]);
    if (!result.verifiedPath) {
      await this.save();
      throw new Error(result.receipt.reasonCode ?? "model_import_failed");
    }
    return await this.recordModelInstallation(identity.packageId, "user-import");
  }

  async installEngine(packageId: string, signal?: AbortSignal): Promise<LocalEngineInstallationReceipt> {
    await this.readyForMutation();
    const identity = localEnginePackage(packageId);
    if (!identity) throw new Error("unknown_engine_package");
    const archive = this.downloader.verifiedPath(identity);
    const receipt = await this.installer.install(identity, archive, signal);
    signal?.throwIfAborted();
    this.state.engineInstallations = bounded([
      ...this.state.engineInstallations.filter((item) => item.enginePackageId !== packageId),
      receipt,
    ]);
    await this.save();
    return receipt;
  }

  async installDownloadedModel(packageId: string, signal?: AbortSignal): Promise<LocalModelInstallationReceipt> {
    await this.readyForMutation();
    signal?.throwIfAborted();
    return await this.recordModelInstallation(packageId, "download", signal);
  }

  private async recordModelInstallation(
    packageId: string,
    source: LocalModelInstallationReceipt["source"],
    signal?: AbortSignal,
  ): Promise<LocalModelInstallationReceipt> {
    const identity = this.modelPackage(packageId);
    if (!identity) throw new Error("unknown_model_package");
    const modelPath = this.downloader.verifiedPath(identity);
    const file = await stat(modelPath).catch(() => null);
    if (!file?.isFile() || file.size !== identity.byteLength) throw new Error("verified_model_missing");
    if (await sha256File(modelPath) !== identity.sha256) throw new Error("verified_model_sha256_mismatch");
    // Stop may arrive during the file hash. Refuse the installation before its durable commit.
    signal?.throwIfAborted();
    const compatible = compatibleEnginePackage();
    const engineInstalled = compatible.item
      ? this.state.engineInstallations.find((item) => item.enginePackageId === compatible.item!.packageId)
      : null;
    const receipt: LocalModelInstallationReceipt = {
      schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
      installationId: randomUUID(),
      modelPackageId: identity.packageId,
      repository: identity.repository,
      revision: identity.revision,
      fileName: identity.fileName,
      fileSha256: identity.sha256,
      quantization: identity.quantization,
      enginePackageId: engineInstalled?.enginePackageId ?? null,
      installedAt: new Date().toISOString(),
      source,
    };
    this.state.modelInstallations = bounded([
      ...this.state.modelInstallations.filter((item) => item.modelPackageId !== packageId),
      receipt,
    ]);
    await this.save();
    return receipt;
  }

  async loadModel(
    installationId: string,
    contextTokens = 8_192,
    signal?: AbortSignal,
  ): Promise<LocalModelLoadReceipt> {
    const generation = ++this.loadGeneration;
    return await this.enqueueLifecycle(() => this.loadModelExclusive(installationId, contextTokens, generation, signal));
  }

  private async enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.then(operation, operation);
    this.lifecycleChain = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async loadModelExclusive(
    installationId: string,
    contextTokens: number,
    generation: number,
    signal?: AbortSignal,
  ): Promise<LocalModelLoadReceipt> {
    await this.readyForMutation();
    if (!Number.isSafeInteger(contextTokens) || contextTokens < 512 || contextTokens > 131_072) {
      throw new Error("invalid_local_model_context_tokens");
    }
    const installation = this.state.modelInstallations.find((item) => item.installationId === installationId);
    if (!installation) throw new Error("model_installation_not_found");
    const model = this.modelPackage(installation.modelPackageId);
    if (!model || installation.fileSha256 !== model.sha256) throw new Error("model_installation_identity_mismatch");
    const compatible = compatibleEnginePackage();
    if (!compatible.item) throw new Error(compatible.reasonCode ?? "engine_package_unavailable");
    const engineReceipt = this.state.engineInstallations.find((item) => item.enginePackageId === compatible.item!.packageId);
    if (!engineReceipt) throw new Error("engine_not_installed");
    const executable = this.installer.executablePath(compatible.item, engineReceipt);
    const modelPath = this.downloader.verifiedPath(model);
    await this.installer.verifyRuntimeFiles(compatible.item, engineReceipt);
    if (await sha256File(modelPath) !== model.sha256) throw new Error("model_file_sha256_mismatch");

    if (this.activeInference.size > 0) throw new Error("local_model_runs_active");
    await this.terminateResidentProcess();
    const startedAt = new Date().toISOString();
    const processEpoch = randomUUID();
    const port = await freeLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const authToken = randomBytes(32).toString("base64url");
    const receiptBase = {
      schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
      receiptId: randomUUID(),
      processEpoch,
      installationId,
      enginePackageId: compatible.item.packageId,
      engineExecutableSha256: engineReceipt.executableSha256,
      endpoint,
      contextTokens,
      startedAt,
    } as const;
    let reasonCode: string | null = null;
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (generation !== this.loadGeneration) throw new Error("model_load_obsolete");
      const child = this.spawnImpl(executable, [
        "--model", modelPath,
        "--host", "127.0.0.1",
        "--port", String(port),
        "--ctx-size", String(contextTokens),
        "--parallel", "1",
        "--jinja",
        "--no-webui",
        "--api-key", authToken,
      ], { stdio: "ignore", windowsHide: true, cwd: dirname(executable), env: { ...process.env, GGML_BACKEND_PATH: undefined } });
      const exitPromise = new Promise<never>((_resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, exitSignal) => reject(new Error(`engine_exited_${code ?? exitSignal ?? "unknown"}`)));
      });
      void exitPromise.catch(() => {});
      this.residentProcess = child;
      this.residentAuthToken = authToken;
      if (!child.pid) throw new Error("engine_process_pid_missing");
      const processIdentity = process.platform === "win32" ? await observeLocalProcessIdentity(child.pid) : null;
      if (process.platform === "win32" && (!processIdentity || !matchesLocalProcessIdentity(processIdentity, {
        pid: child.pid, executablePath: executable, modelPath, processCreatedAt: processIdentity.createdAt,
      }))) throw new Error("local_model_process_identity_unavailable");
      const processLease: ProcessLease = {
        schemaVersion: 1,
        processEpoch,
        pid: child.pid,
        processCreatedAt: processIdentity?.createdAt ?? null,
        executablePath: executable,
        executableSha256: engineReceipt.executableSha256,
        modelPath,
        modelSha256: model.sha256,
        port,
        createdAt: new Date().toISOString(),
      };
      await writeFile(this.processLeasePath, `${JSON.stringify(processLease)}\n`, { encoding: "utf8", mode: 0o600 });
      const deadline = Date.now() + this.healthTimeoutMs;
      for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (generation !== this.loadGeneration) throw new Error("model_load_obsolete");
        const healthy = await Promise.race([
          probeLocalEngineHealth(endpoint, authToken, deadline - Date.now(), this.fetchImpl, signal),
          exitPromise,
        ]);
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("engine_health_timeout");
        if (healthy) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
      if (generation !== this.loadGeneration) throw new Error("model_load_obsolete");
      const receipt: LocalModelLoadReceipt = {
        ...receiptBase,
        state: "resident",
        finishedAt: new Date().toISOString(),
        reasonCode: null,
      };
      this.residentReceipt = receipt;
      child.once("exit", (code, exitSignal) => {
        if (this.residentProcess === child && this.residentReceipt?.processEpoch === receipt.processEpoch) {
          this.residentProcess = null;
          this.residentReceipt = null;
          this.residentAuthToken = null;
          // Keep the successful load observation, and append the exact process's
          // later failure. Intentional unload clears ownership before killing it.
          this.state.loadReceipts = bounded([...this.state.loadReceipts, {
            ...receipt,
            receiptId: randomUUID(),
            state: "failed",
            finishedAt: new Date().toISOString(),
            reasonCode: `engine_exited_${code ?? exitSignal ?? "unknown"}`,
          }]);
          void this.save().catch(() => {
            this.unavailableReason = "local_model_crash_receipt_write_failed";
          });
          void this.removeProcessLease(receipt.processEpoch);
        }
      });
      this.state.loadReceipts = bounded([...this.state.loadReceipts, receipt]);
      await this.save();
      return receipt;
    } catch (error) {
      reasonCode = aborted(error, signal) ? "model_load_cancelled" : (error instanceof Error ? error.message : "model_load_failed");
      await this.terminateResidentProcess();
      const receipt: LocalModelLoadReceipt = {
        ...receiptBase,
        state: aborted(error, signal) ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        reasonCode,
      };
      this.state.loadReceipts = bounded([...this.state.loadReceipts, receipt]);
      await this.save();
      return receipt;
    }
  }

  endpoint(): string {
    if (!this.residentProcess || this.residentReceipt?.state !== "resident") {
      throw new Error("local_model_not_resident");
    }
    return this.residentReceipt.endpoint;
  }

  authorizationHeaders(): Record<string, string> {
    if (!this.residentProcess || !this.residentAuthToken || this.residentReceipt?.state !== "resident") {
      throw new Error("local_model_not_resident");
    }
    return { authorization: `Bearer ${this.residentAuthToken}` };
  }

  residentInstallation(): LocalModelInstallationReceipt {
    const receipt = this.residentReceipt;
    if (!this.residentProcess || receipt?.state !== "resident") throw new Error("local_model_not_resident");
    const installation = this.state.modelInstallations.find((item) => item.installationId === receipt.installationId);
    if (!installation) throw new Error("resident_model_installation_missing");
    return installation;
  }

  async unload(expectedProcessEpoch?: string, options: { cancelActiveRuns?: boolean } = {}): Promise<void> {
    this.loadGeneration += 1;
    await this.enqueueLifecycle(async () => {
      if (expectedProcessEpoch && this.residentReceipt?.processEpoch !== expectedProcessEpoch) {
        throw new Error("stale_local_model_process_epoch");
      }
      if (this.activeInference.size > 0) {
        if (!options.cancelActiveRuns) throw new Error("local_model_runs_active");
        await this.cancelActiveRuns();
      }
      await this.terminateResidentProcess();
    });
  }

  async cancelActiveRuns(): Promise<number> {
    const active = [...this.activeInference.values()];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.done));
    return active.length;
  }

  private async terminateResidentProcess(): Promise<void> {
    const child = this.residentProcess;
    const processEpoch = this.residentReceipt?.processEpoch ?? null;
    this.residentProcess = null;
    this.residentReceipt = null;
    this.residentAuthToken = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      await this.removeProcessLease(processEpoch, child.pid);
      return;
    }
    try { await new Promise<void>((resolveDone, reject) => {
      let forced: ReturnType<typeof setTimeout> | undefined;
      const done = () => { clearTimeout(timer); if (forced) clearTimeout(forced); resolveDone(); };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Exit still needs observation. */ }
        forced = setTimeout(() => {
          child.removeListener("exit", done);
          if (child.exitCode !== null || child.signalCode !== null) resolveDone();
          else reject(new Error("local_model_process_shutdown_unconfirmed"));
        }, 2000);
      }, 5000);
      child.once("exit", done);
      try { child.kill("SIGTERM"); } catch { /* Keep waiting for the terminal receipt. */ }
    }); } catch (error) {
      // Keep a retryable handle and its durable lease, while leaving it unavailable
      // for inference. A timeout is not evidence that the process exited.
      if (!this.residentProcess) this.residentProcess = child;
      throw error;
    }
    await this.removeProcessLease(processEpoch, child.pid);
  }

  private async removeProcessLease(expectedEpoch: string | null, expectedPid?: number): Promise<void> {
    try {
      const lease = JSON.parse(await readFile(this.processLeasePath, "utf8")) as ProcessLease;
      if (expectedEpoch && lease.processEpoch !== expectedEpoch) return;
      if (expectedPid !== undefined && lease.pid !== expectedPid) return;
      await rm(this.processLeasePath, { force: true });
    } catch {
      // Already absent.
    }
  }

  async executeWithReceipt<T>(
    requestMaterial: unknown,
    signal: AbortSignal | undefined,
    executor: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.readyForMutation();
    const resident = this.residentReceipt;
    if (!resident || !this.residentProcess) throw new Error("local_model_not_resident");
    const queuedAt = new Date().toISOString();
    const startedAt = new Date().toISOString();
    const active = this.beginActiveInference(signal);
    let state: LocalModelRunReceipt["state"] = "completed";
    let reasonCode: string | null = null;
    let result: T;
    try {
      result = await executor(active.signal);
      return result;
    } catch (error) {
      state = aborted(error, active.signal) ? "cancelled" : "failed";
      reasonCode = aborted(error, active.signal) ? "run_cancelled" : (error instanceof Error ? error.message : "run_failed");
      throw error;
    } finally {
      const receipt: LocalModelRunReceipt = {
        schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
        receiptId: randomUUID(),
        processEpoch: resident.processEpoch,
        installationId: resident.installationId,
        requestSha256: requestDigest(requestMaterial),
        state,
        queuedAt,
        startedAt,
        finishedAt: new Date().toISOString(),
        promptTokens: null,
        completionTokens: null,
        reasonCode,
      };
      this.state.runReceipts = bounded([...this.state.runReceipts, receipt]);
      try {
        await this.save();
      } finally {
        active.finish();
      }
    }
  }

  private beginActiveInference(parentSignal?: AbortSignal): { signal: AbortSignal; finish: () => void } {
    const activeId = randomUUID();
    const controller = new AbortController();
    let finishDone!: () => void;
    const done = new Promise<void>((resolveDone) => { finishDone = resolveDone; });
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    this.activeInference.set(activeId, { controller, done });
    let finished = false;
    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        parentSignal?.removeEventListener("abort", abortFromParent);
        this.activeInference.delete(activeId);
        finishDone();
      },
    };
  }

  async testCapabilities(
    installationId: string,
    selection: LocalCapabilityTestSelection,
    signal?: AbortSignal,
  ): Promise<LocalModelCapabilityReceipt> {
    const active = this.beginActiveInference(signal);
    try {
      return await this.testCapabilitiesActive(installationId, selection, active.signal);
    } finally {
      active.finish();
    }
  }

  private async testCapabilitiesActive(
    installationId: string,
    selection: LocalCapabilityTestSelection,
    signal: AbortSignal,
  ): Promise<LocalModelCapabilityReceipt> {
    await this.readyForMutation();
    const resident = this.residentReceipt;
    if (!resident || !this.residentProcess || resident.installationId !== installationId) {
      throw new Error("capability_test_model_not_resident");
    }
    const installation = this.residentInstallation();
    const model = this.modelPackage(installation.modelPackageId);
    if (!model) throw new Error("model_package_not_found");
    const hardware = await observeLocalHardware(this.rootPath);
    const reasonCodes: string[] = [];
    let strictJson: LocalModelCapabilityReceipt["strictJson"] = "not_tested";
    let toolUse: LocalModelCapabilityReceipt["toolUse"] = "not_tested";
    let cancellation: LocalModelCapabilityReceipt["cancellation"] = "not_tested";

    const complete = async (body: Record<string, unknown>, requestSignal: AbortSignal | undefined = signal) => {
      const response = await this.fetchImpl(`${resident.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authorizationHeaders() },
        body: JSON.stringify({
          model: model.fileName,
          stream: false,
          max_tokens: 128,
          chat_template_kwargs: { enable_thinking: false },
          ...body,
        }),
        signal: requestSignal,
      });
      if (!response.ok) throw new Error(`capability_http_${response.status}`);
      return await response.json() as {
        choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>;
      };
    };

    if (selection.strictJson) {
      try {
        const response = await complete({
          messages: [{ role: "user", content: "Return an object whose ok field is true." }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "receipt_probe",
              strict: true,
              schema: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false },
            },
          },
        });
        const parsed = JSON.parse(response.choices?.[0]?.message?.content ?? "null") as { ok?: unknown } | null;
        strictJson = parsed?.ok === true ? "verified" : "failed";
      } catch {
        strictJson = "failed";
      }
      if (strictJson === "failed") reasonCodes.push("strict_json_probe_failed");
    }
    if (selection.toolUse) {
      try {
        const response = await complete({
          messages: [{ role: "user", content: "Call receipt_ping exactly once with value ok." }],
          tools: [{ type: "function", function: { name: "receipt_ping", description: "Capability probe", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }],
          tool_choice: { type: "function", function: { name: "receipt_ping" } },
        });
        const calls = response.choices?.[0]?.message?.tool_calls;
        toolUse = Array.isArray(calls) && calls.length > 0 ? "verified" : "failed";
      } catch {
        toolUse = "failed";
      }
      if (toolUse === "failed") reasonCodes.push("tool_use_probe_failed");
    }
    if (selection.cancellation) {
      const controller = new AbortController();
      const abortFromOperation = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abortFromOperation, { once: true });
      const timer = setTimeout(() => controller.abort(), 25);
      try {
        await complete({
          messages: [{ role: "user", content: "Write a long numbered list with detailed explanations." }],
          max_tokens: 2_048,
        }, controller.signal);
        cancellation = "failed";
      } catch (error) {
        cancellation = aborted(error, controller.signal) ? "verified" : "failed";
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abortFromOperation);
      }
      if (cancellation === "failed") reasonCodes.push("cancellation_probe_failed");
    }
    if (!selection.strictJson) reasonCodes.push("strict_json_not_tested");
    if (!selection.toolUse) reasonCodes.push("tool_use_not_tested");
    if (!selection.cancellation) reasonCodes.push("cancellation_not_tested");
    reasonCodes.push("image_input_not_tested");
    const receipt: LocalModelCapabilityReceipt = {
      schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
      receiptId: randomUUID(),
      installationId,
      enginePackageId: resident.enginePackageId,
      hardwareProfileId: hardware.profileId,
      testedAt: new Date().toISOString(),
      contextTokens: resident.contextTokens,
      toolUse,
      strictJson,
      imageInput: "not_tested",
      cancellation,
      reasonCodes,
    };
    this.state.capabilityReceipts = bounded([...this.state.capabilityReceipts, receipt]);
    await this.save();
    return receipt;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    this.shutdownPromise = (async () => {
      await this.unload(undefined, { cancelActiveRuns: true });
      await this.saveChain;
      try {
        const lease = JSON.parse(await readFile(this.ownerLeasePath, "utf8")) as OwnerLease;
        if (lease.instanceId === this.instanceId) await rm(this.ownerLeasePath, { force: true });
      } catch {
        // Already absent or replaced by another owner.
      }
    })();
    return await this.shutdownPromise;
  }
}
