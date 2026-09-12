import { createHash } from "node:crypto";
import type { Runner } from "../runtime/runner";
import { makeLocalOpenAiRunner } from "../runtime/local-openai";
import { LocalModelHubManager } from "./manager";

/**
 * The runtime selector remains the single authority. It may select this runner
 * only after detect exposes the resident receipt as an available runtime.
 */
export function createManagedLocalModelRunner(manager: LocalModelHubManager): Runner {
  const runner = makeLocalOpenAiRunner(() => manager.endpoint(), "agentlas-local", {
    chatTemplateKwargs: { enable_thinking: false },
    headersFn: () => manager.authorizationHeaders(),
  });
  return async (request, events) => {
    const installation = manager.residentInstallation();
    if (request.model !== installation.fileName) {
      throw new Error("resident_model_selection_mismatch");
    }
    return await manager.executeWithReceipt(
      {
        installationId: installation.installationId,
        model: request.model,
        userPrompt: request.userPrompt,
        outputSchema: request.outputSchema ?? null,
        imageDigests: request.images?.map((image) => ({
          mediaType: image.mediaType,
          sha256: createHash("sha256").update(image.data).digest("hex"),
        })) ?? [],
      },
      request.signal,
      (signal) => runner({ ...request, signal }, events),
    );
  };
}
