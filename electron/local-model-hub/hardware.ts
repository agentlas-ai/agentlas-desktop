import { createHash } from "node:crypto";
import { cpus, freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import type {
  LocalHardwareProfile,
  LocalModelFitAssessment,
  LocalModelPackageIdentity,
} from "../../shared/local-model-hub";
import { LOCAL_MODEL_HUB_SCHEMA_VERSION } from "../../shared/local-model-hub";

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export async function observeLocalHardware(storagePath: string): Promise<LocalHardwareProfile> {
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
  const availableMemoryBytes = freemem();
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
    accelerator: appleSilicon ? "metal" : "unknown",
    acceleratorEvidence: appleSilicon ? "host-observed" : "not-observed",
    vramBytes: appleSilicon ? totalMemoryBytes : null,
    diskAvailableBytes,
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
  } else if (hardware.accelerator === "metal") {
    fit = "recommended";
    reasonCodes.push("metal_observed");
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
