import type { RuntimeStatus } from "../../shared/types";
import type { Runner } from "../runtime/runner";
import { LocalModelHubManager } from "./manager";
import { createManagedLocalModelRunner } from "./runner";
import type { LocalModelHubRuntimePort } from "./ports";

let configured: { manager: LocalModelHubManager | null; runtime: LocalModelHubRuntimePort } | null = null;

/** A GUI facade can route both detection and invocation to the same daemon.
 * Configuring a facade never creates a second manager or owns engine shutdown. */
export function configureLocalModelRuntime(runtime: LocalModelHubRuntimePort): void {
  if (configured && configured.runtime !== runtime) throw new Error("local_model_hub_already_configured");
  configured ??= { manager: null, runtime };
}

/** Main configures one manager; detect, IPC and selection consume that identity. */
export function configureLocalModelHubManager(manager: LocalModelHubManager): void {
  if (configured && configured.manager !== manager) throw new Error("local_model_hub_already_configured");
  configured ??= { manager, runtime: { snapshot: () => manager.snapshot(), run: createManagedLocalModelRunner(manager) } };
}

export function requireLocalModelHubManager(): LocalModelHubManager {
  if (!configured) throw new Error("local_model_hub_not_configured");
  if (!configured.manager) throw new Error("local_model_hub_local_owner_not_configured");
  return configured.manager;
}

export async function probeManagedLocalRuntime(): Promise<RuntimeStatus | null> {
  if (!configured) return null;
  try {
    const snapshot = await configured.runtime.snapshot();
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
  try { return await configured.runtime.run(request, events); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.message : null;
    if (typeof code === "string" && (code.startsWith("local_model_remote_mcp_admission_")
      || code.startsWith("mcp_prepared_"))) return { text: "", failure: {
      kind: "refused", runtime: "agentlas-local", source: "marker",
      providerCode: "local_model_remote_mcp_admission_refused",
      message: request.locale === "ko" ? "선택한 로컬 모델의 도구 권한을 준비하지 못했습니다. 같은 로컬 연결을 유지합니다."
        : "The selected local model's tool admission could not be prepared. The local binding is unchanged.",
    } };
    throw error;
  }
};
