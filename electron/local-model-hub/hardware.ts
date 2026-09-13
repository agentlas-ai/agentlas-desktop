import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import type {
  LocalEngineDevice,
  LocalHardwareProfile,
  LocalModelFitAssessment,
  LocalModelPackageIdentity,
} from "../../shared/local-model-hub";
import { LOCAL_MODEL_HUB_SCHEMA_VERSION } from "../../shared/local-model-hub";

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

let darwinAvailable: { at: number; bytes: number } | null = null;

/**
 * macOS: `os.freemem()` counts only truly free pages. On a 48 GB Mac it read
 * 2.0 GiB while 13.9 GiB were reclaimable (inactive + speculative + purgeable,
 * vm_stat 2026-09-13), so a 0.6 B model was rated "not recommended". Activity
 * Monitor's "available" is the reclaimable figure; use it, cached for 2 s.
 */
async function observeAvailableMemory(): Promise<number> {
  if (process.platform !== "darwin") return freemem();
  if (darwinAvailable && Date.now() - darwinAvailable.at < 2_000) return darwinAvailable.bytes;
  const bytes = await new Promise<number>((resolveBytes) => {
    execFile("/usr/bin/vm_stat", [], { timeout: 1_500, maxBuffer: 65_536 }, (error, stdout) => {
      if (error) return resolveBytes(freemem());
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
      const pages = (label: string) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(stdout)?.[1] ?? NaN);
      const reclaimable = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
      resolveBytes(Number.isFinite(pageSize) && Number.isFinite(reclaimable) && pageSize > 0 ? Math.min(totalmem(), reclaimable * pageSize) : freemem());
    });
  });
  darwinAvailable = { at: Date.now(), bytes };
  return bytes;
}

/**
 * `engineDevices` is what the installed llama-server listed with `--list-devices`.
 * Without it, only Apple Silicon can be called accelerated (Metal is always
 * present there). Windows and Intel Macs stay "not-observed" until the engine
 * itself has listed a GPU — a CPU-only guess must never turn into "recommended".
 */
export async function observeLocalHardware(storagePath: string, engineDevices: LocalEngineDevice[] = []): Promise<LocalHardwareProfile> {
  const cpuList = cpus();
  let diskAvailableBytes: number | null = null;
  try {
    const disk = await statfs(storagePath);
    diskAvailableBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch {
    // The caller may be evaluating before its storage directory exists.
  }
  const platform = process.platform;
  const arch = process.arch;
  const appleSilicon = platform === "darwin" && arch === "arm64";
  const observedAt = new Date().toISOString();
  const totalMemoryBytes = totalmem();
  const availableMemoryBytes = await observeAvailableMemory();
  const gpu = engineDevices.find((device) => device.gpu) ?? null;
  const accelerator = gpu ? gpu.accelerator : appleSilicon ? "metal" : "unknown";
  const acceleratorEvidence = gpu ? "engine-observed" : appleSilicon ? "host-observed" : "not-observed";
  return {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    profileId: `hardware:${digest([platform, arch, cpuList[0]?.model ?? "unknown", totalMemoryBytes])}`,
    observedAt,
    platform,
    arch,
    cpuModel: cpuList[0]?.model ?? "unknown",
    logicalCpuCount: cpuList.length,
    totalMemoryBytes,
    availableMemoryBytes,
    memoryKind: appleSilicon ? "unified" : "system",
    accelerator,
    acceleratorEvidence,
    vramBytes: gpu?.memoryBytes ?? (appleSilicon ? totalMemoryBytes : null),
    diskAvailableBytes,
    engineDevices: engineDevices.map((device) => ({ ...device })),
  };
}

/**
 * This is deliberately an estimate. A verified classification can only be
 * minted after this exact model is loaded and exercised on this device.
 */
export function estimateLocalModelFit(
  hardware: LocalHardwareProfile,
  model: LocalModelPackageIdentity,
  contextTokens = 8_192,
): LocalModelFitAssessment {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 512 || contextTokens > 131_072) {
    throw new TypeError("invalid_local_model_context_tokens");
  }
  const runtimeReserve = Math.max(1_073_741_824, Math.ceil(hardware.totalMemoryBytes * 0.15));
  const kvAndScratch = Math.max(536_870_912, contextTokens * 131_072);
  const requiredBytes = model.byteLength + runtimeReserve + kvAndScratch;
  const memoryAvailable = hardware.availableMemoryBytes;
  const diskAvailable = hardware.diskAvailableBytes;
  const reasonCodes: string[] = ["fit_is_estimated"];
  let fit: LocalModelFitAssessment["class"];
  if (diskAvailable !== null && diskAvailable < model.byteLength * 1.1) {
    fit = "unsupported";
    reasonCodes.push("insufficient_disk");
  } else if (memoryAvailable < requiredBytes * 0.75) {
    fit = "not_recommended";
    reasonCodes.push("insufficient_available_memory");
  } else if (memoryAvailable < requiredBytes) {
    fit = "may_be_slow";
    reasonCodes.push("memory_pressure_likely");
  } else if (hardware.acceleratorEvidence !== "not-observed" && hardware.accelerator !== "unknown" && hardware.accelerator !== "cpu") {
    // A GPU backend the host or the engine itself observed (Metal on Apple Silicon,
    // or any device the installed engine listed). Discrete GPUs also need the model
    // to fit their own memory, not only system RAM.
    const vramShort = hardware.memoryKind !== "unified" && hardware.vramBytes !== null && hardware.vramBytes < model.byteLength + kvAndScratch;
    fit = vramShort ? "may_be_slow" : "recommended";
    reasonCodes.push(`${hardware.accelerator}_observed`);
    if (vramShort) reasonCodes.push("gpu_memory_smaller_than_model");
  } else {
    fit = "runnable";
    reasonCodes.push("accelerator_not_verified");
  }
  return {
    schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
    assessmentId: `fit:${digest([hardware.profileId, model.packageId, contextTokens, fit])}`,
    hardwareProfileId: hardware.profileId,
    modelPackageId: model.packageId,
    class: fit,
    evidence: "estimated",
    requiredBytes,
    availableBytes: memoryAvailable,
    reasonCodes,
  };
}
