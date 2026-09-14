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
import { assertLocalModelPackageIdentity, localModelProjectorIdentity, LOCAL_MODEL_HUB_SCHEMA_VERSION } from "../../shared/local-model-hub";
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
import { parseEngineLoadLog } from "./acceleration";

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
  /** Pinned CRT DLL directory for Windows app-local deployment (see engine-installer.ts). */
  windowsRuntimeDir?: string;
  /** Resident llama-server changed; callers invalidate runtime projections. */
  onResidentChanged?: () => void;
}

export interface LocalCapabilityTestSelection {
  strictJson?: boolean;
  toolUse?: boolean;
  cancellation?: boolean;
  /** 프로젝터가 붙은 모델에만 실제 이미지를 보내 본다. 없으면 not_tested. */
  imageInput?: boolean;
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

/** Realistic, unforced tool-selection probes. All must pass; a model that picks the wrong tool is not "verified". */
const TOOL_USE_PROBE_TOOLS = [
  { type: "function", function: { name: "browser_navigate", description: "Open a URL in the browser tab", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "write_file", description: "Write text to a file in the project folder", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_shell", description: "Run a shell command in the project folder", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "computer_screenshot", description: "Take a screenshot of the desktop", parameters: { type: "object", properties: {} } } },
] as const;
const TOOL_USE_PROBES: ReadonlyArray<{ user: string; expect: string; check: (args: unknown) => boolean }> = [
  { user: "Open https://example.com in the browser and tell me the page title.", expect: "browser_navigate", check: (args) => /^https?:\/\/example\.com\/?$/.test(String((args as { url?: unknown })?.url ?? "")) },
  { user: "Create a file named hello.txt in the project folder containing the text hi.", expect: "write_file", check: (args) => /hello\.txt$/.test(String((args as { path?: unknown })?.path ?? "")) && typeof (args as { content?: unknown })?.content === "string" },
  { user: "Count how many files are in the project folder.", expect: "run_shell", check: (args) => typeof (args as { command?: unknown })?.command === "string" && (args as { command: string }).command.length > 0 },
];

/** 32×32 단색 빨강 PNG — 이미지 입력 능력 검사용. 모델이 "red" 라고 답하면 프로젝터가 실제로 작동한 것이다. */
const RED_SQUARE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

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
  private readonly onResidentChanged: () => void;
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
  private deviceProbe: Promise<void> | null = null;
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
    this.onResidentChanged = options.onResidentChanged ?? (() => {});
    this.downloader = new LocalPackageDownloadManager(this.packageRoot);
    this.installer = options.engineInstaller ?? new LocalEngineInstaller(this.engineRoot, { windowsRuntimeDir: options.windowsRuntimeDir });
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

  /**
   * Engines installed before device probing existed carry no `devices`. Ask the
   * installed executable once per app session and persist the answer, so an
   * upgraded install shows the same GPU truth as a fresh one.
   */
  private async ensureEngineDevices(): Promise<void> {
    if (this.unavailableReason || this.shutdownPromise) return;
    const compatible = compatibleEnginePackage();
    const receipt = compatible.item ? this.state.engineInstallations.find((item) => item.enginePackageId === compatible.item!.packageId) : null;
    if (!compatible.item || !receipt || receipt.devices) return;
    if (!this.deviceProbe) {
      this.deviceProbe = (async () => {
        const executable = this.installer.executablePath(compatible.item!, receipt);
        await this.installer.verifyRuntimeFiles(compatible.item!, receipt);
        const devices = await this.installer.probeDevices(executable);
        if (!devices) return;
        this.state.engineInstallations = this.state.engineInstallations.map((item) => item.receiptId === receipt.receiptId ? { ...item, devices } : item);
        await this.save();
      })().catch(() => undefined);
    }
    await this.deviceProbe;
  }

  private installedEngineDevices() {
    const compatible = compatibleEnginePackage();
    const receipt = compatible.item ? this.state.engineInstallations.find((item) => item.enginePackageId === compatible.item!.packageId) : null;
    return receipt?.devices ?? [];
  }

  async snapshot(): Promise<LocalModelHubSnapshot> {
    await this.ready();
    await this.ensureEngineDevices();
    const hardware = await observeLocalHardware(this.rootPath, this.installedEngineDevices());
    const models = this.modelCatalog();
    const fitAssessments = models.map((model) => {
      const fit = estimateLocalModelFit(hardware, model);
      const loaded = this.state.loadReceipts.some(receipt => receipt.state === "resident" && this.state.modelInstallations.some(installation => installation.installationId === receipt.installationId && installation.modelPackageId === model.packageId));
      // A registered Hugging Face model that has not been loaded yet keeps its measured
      // memory fit; only the engine-compatibility caveat is added as a reason code.
      // Forcing class "unknown" here made every HF download show the amber icon, so
      // "원활" was unreachable before the first load (2026-09-13).
      return this.state.registeredModels?.some(registered => registered.packageId === model.packageId) && !loaded
        ? { ...fit, reasonCodes: [...fit.reasonCodes, "hf_engine_compatibility_unverified"] }
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
    // 비전 프로젝터 동반 파일은 본체 뒤에 같은 절차로 받는다. 실패하면 본체 영수증이 아니라 이 영수증이 실패로 남는다.
    const projector = localModelProjectorIdentity(identity);
    if (projector && result.receipt.state === "verified") {
      signal?.throwIfAborted();
      const projectorResult = await this.downloader.download(projector, "model", {
        signal,
        fetchImpl: this.fetchImpl,
        onProgress: (progress) => this.progress.set(packageId, { ...progress, packageId }),
      });
      this.state.downloadReceipts = bounded([...this.state.downloadReceipts, projectorResult.receipt]);
      await this.save();
      if (projectorResult.receipt.state !== "verified") return projectorResult.receipt;
    }
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
    const projector = localModelProjectorIdentity(identity);
    if (projector) {
      const projectorPath = this.downloader.verifiedPath(projector);
      const projectorFile = await stat(projectorPath).catch(() => null);
      if (!projectorFile?.isFile() || projectorFile.size !== projector.byteLength) throw new Error("verified_projector_missing");
      if (await sha256File(projectorPath) !== projector.sha256) throw new Error("verified_projector_sha256_mismatch");
    }
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
      projectorFileName: projector?.fileName ?? null,
      projectorSha256: projector?.sha256 ?? null,
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
    try {
      return await this.enqueueLifecycle(() => this.loadModelExclusive(installationId, contextTokens, generation, signal));
    } finally {
      this.notifyResidentChanged();
    }
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
    // 0 = 자동: 엔진이 모델의 학습 문맥(n_ctx_train)을 쓰되 장치 메모리에 맞춰 줄인다(--fit on 기본).
    // 8192 고정은 오케스트레이터 프롬프트+도구 스키마만으로 넘쳐 4B 모델이 파일 과제조차 못 시작했다(격리 앱 실측 2026-09-13).
    if (!Number.isSafeInteger(contextTokens) || (contextTokens !== 0 && (contextTokens < 512 || contextTokens > 131_072))) {
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
    // 비전 프로젝터: 설치 영수증과 패키지 정체성이 같은 파일을 가리켜야 --mmproj 로 붙인다.
    const projectorIdentity = localModelProjectorIdentity(model);
    let projectorPath: string | null = null;
    if (installation.projectorFileName) {
      if (!projectorIdentity || projectorIdentity.fileName !== installation.projectorFileName
        || projectorIdentity.sha256 !== installation.projectorSha256) throw new Error("projector_installation_identity_mismatch");
      projectorPath = this.downloader.verifiedPath(projectorIdentity);
      if (await sha256File(projectorPath) !== projectorIdentity.sha256) throw new Error("projector_file_sha256_mismatch");
    }

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
      // Machine-readable log at trace level: this is where llama.cpp prints which
      // device each layer landed on ("offloaded 29/29 layers to GPU"). Default
      // verbosity hides it, and prompts are not logged at this level (measured
      // 2026-09-13: ~24 KB per load, ~3 KB per request, no prompt text).
      const child = this.spawnImpl(executable, [
        "--model", modelPath,
        ...(projectorPath ? ["--mmproj", projectorPath] : []),
        "--host", "127.0.0.1",
        "--port", String(port),
        "--ctx-size", String(contextTokens),
        "--parallel", "1",
        "--jinja",
        "--no-webui",
        "--api-key", authToken,
        "--log-jsonl",
        "--verbosity", "4",
      ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, cwd: dirname(executable), env: { ...process.env, GGML_BACKEND_PATH: undefined } });
      let engineLog = "";
      // Always drain: a full pipe would block the server. Only the load window is kept.
      child.stdout?.on("data", (chunk: Buffer) => { if (engineLog.length < 262_144) engineLog += chunk.toString("utf8"); });
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
      // The load lines are written before the server listens; give the pipe a
      // moment to deliver them so the receipt does not miss its own evidence.
      for (let i = 0; i < 20 && !/model loaded|listening on/.test(engineLog); i += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      // The receipt carries the context the server actually allocated (auto mode asks the engine).
      const properties = await this.fetchImpl(`${endpoint}/props`, { headers: { authorization: `Bearer ${authToken}` }, signal }).then(response => response.ok ? response.json() : null).catch(() => null) as { default_generation_settings?: { n_ctx?: unknown } } | null;
      const actualContext = properties?.default_generation_settings?.n_ctx;
      if (!Number.isSafeInteger(actualContext) || (actualContext as number) < 512) throw new Error("engine_context_unreadable");
      const receipt: LocalModelLoadReceipt = {
        ...receiptBase,
        contextTokens: actualContext as number,
        state: "resident",
        finishedAt: new Date().toISOString(),
        reasonCode: null,
        acceleration: parseEngineLoadLog(engineLog),
      };
      this.residentReceipt = receipt;
      child.once("exit", (code, exitSignal) => {
        if (this.residentProcess === child && this.residentReceipt?.processEpoch === receipt.processEpoch) {
          this.residentProcess = null;
          this.residentReceipt = null;
          this.residentAuthToken = null;
          this.notifyResidentChanged();
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
    try {
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
    } finally {
      this.notifyResidentChanged();
    }
  }

  private notifyResidentChanged(): void {
    try { this.onResidentChanged(); } catch { /* Runtime projection listeners cannot own model lifecycle. */ }
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
      // 강제(tool_choice)로 한 도구를 부르게 하면 0.6B 도 "확인됨"이 된다 — 실측 2026-09-13 에서 그 모델은
      // 실제 과제 4개 중 2개에서 엉뚱한 도구를 골랐다(4B 는 4/4). 그래서 강제 없이 도구 여러 개를 주고
      // 과제에 맞는 도구를 올바른 인자로 고르는지 본다. 이것이 채팅에서 실제로 겪는 일이다.
      try {
        const passed = await Promise.all(TOOL_USE_PROBES.map(async (probe) => {
          const response = await complete({
            messages: [
              { role: "system", content: "You are a desktop agent. Use a tool when the task needs the browser, files or the shell." },
              { role: "user", content: probe.user },
            ],
            tools: TOOL_USE_PROBE_TOOLS,
          });
          const call = response.choices?.[0]?.message?.tool_calls?.[0] as { function?: { name?: string; arguments?: string } } | undefined;
          if (call?.function?.name !== probe.expect) return false;
          try { return probe.check(JSON.parse(call.function.arguments ?? "")); } catch { return false; }
        }));
        toolUse = passed.every(Boolean) ? "verified" : "failed";
        if (toolUse === "failed") reasonCodes.push(`tool_use_probe_failed:${passed.filter(Boolean).length}/${passed.length}`);
      } catch {
        toolUse = "failed";
        reasonCodes.push("tool_use_probe_failed");
      }
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
    // 이미지 입력: 프로젝터가 붙은 모델에만 실제로 그림을 보내 본다 — 단색 빨강 정사각형의 색을 묻는다.
    // 프로젝터가 없으면 not_tested 로 남긴다(텍스트 모델에 이미지를 보내는 것은 검사가 아니다).
    let imageInput: LocalModelCapabilityReceipt["imageInput"] = "not_tested";
    if (selection.imageInput && installation.projectorFileName) {
      try {
        const response = await complete({
          messages: [{ role: "user", content: [
            { type: "text", text: "What is the dominant color of this image? Answer with a single English color word." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${RED_SQUARE_PNG_BASE64}` } },
          ] }],
          max_tokens: 16,
        });
        const answer = String(response.choices?.[0]?.message?.content ?? "");
        imageInput = /red|crimson|scarlet|빨강|빨간|적색/i.test(answer) ? "verified" : "failed";
        if (imageInput === "failed") reasonCodes.push(`image_input_probe_answer:${answer.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 60)}`);
      } catch (error) {
        imageInput = "failed";
        reasonCodes.push(`image_input_probe_error:${String(error instanceof Error ? error.message : error).replace(/[^\p{L}\p{N} ._:-]/gu, "").slice(0, 80)}`);
      }
      if (imageInput === "failed") reasonCodes.push("image_input_probe_failed");
    }
    if (!selection.strictJson) reasonCodes.push("strict_json_not_tested");
    if (!selection.toolUse) reasonCodes.push("tool_use_not_tested");
    if (!selection.cancellation) reasonCodes.push("cancellation_not_tested");
    if (imageInput === "not_tested") reasonCodes.push(installation.projectorFileName ? "image_input_not_tested" : "image_input_no_projector");
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
      imageInput,
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
