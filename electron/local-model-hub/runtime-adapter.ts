import type { RuntimeStatus } from "../../shared/types";
import type { Runner } from "../runtime/runner";
import { LocalModelHubManager } from "./manager";
import { createManagedLocalModelRunner } from "./runner";

let configured: { manager: LocalModelHubManager; runner: Runner } | null = null;

/** Main configures one manager; detect, IPC and selection consume that identity. */
export function configureLocalModelHubManager(manager: LocalModelHubManager): void {
  if (configured && configured.manager !== manager) throw new Error("local_model_hub_already_configured");
  configured = { manager, runner: createManagedLocalModelRunner(manager) };
}

export function requireLocalModelHubManager(): LocalModelHubManager {
  if (!configured) throw new Error("local_model_hub_not_configured");
  return configured.manager;
}

export async function probeManagedLocalRuntime(): Promise<RuntimeStatus | null> {
  if (!configured) return null;
  try {
    const snapshot = await configured.manager.snapshot();
    const resident = snapshot.resident;
    if (!resident) return null;
    const installation = snapshot.modelInstallations.find((item) => item.installationId === resident.installationId);
    if (!installation) return null;
    return {
      kind: "agentlas-local",
      backend: "agentlas-local",
      source: `agentlas-local:${resident.enginePackageId}:${resident.installationId}`,
      version: resident.enginePackageId,
      active: false,
      label: "Agentlas Local · On-device",
      model: installation.fileName,
      availableModels: [installation.fileName],
      allocationModels: [installation.fileName],
      allocationModelProfiles: {
        [installation.fileName]: {
          contextWindow: resident.contextTokens,
          // 비전 프로젝터가 붙어 로드된 모델은 이미지 입력을 받는다 — 대시보드 멀티모달 자리에 앉을 수 있다.
          capabilities: installation.projectorFileName ? ["multimodal"] : [],
          supportsTools: snapshot.capabilityReceipts.some((receipt) =>
            receipt.installationId === installation.installationId && receipt.toolUse === "verified"),
          supportsMultimodal: Boolean(installation.projectorFileName),
        },
      },
      effort: null,
      efforts: [],
    };
  } catch {
    // Detection is a best-effort inventory. A broken local manager must not
    // reject the shared probe batch and hide healthy CLI connections. The
    // Local Models screen reports its own snapshot/install failures.
    return null;
  }
}

export const runManagedLocalModel: Runner = async (request, events) => {
  if (!configured) throw new Error("local_model_hub_not_configured");
  return await configured.runner(request, events);
};
