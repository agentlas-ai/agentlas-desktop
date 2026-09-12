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
    // The managed loader currently starts a text GGUF without a vision
    // projector. An OpenAI-compatible image envelope does not add that support.
    // Refuse before inference/receipts; never discard attachments or pretend
    // the selected model processed them.
    if (request.images?.length) {
      return {
        text: "",
        failure: {
          kind: "unsupported",
          runtime: "agentlas-local",
          source: "marker",
          providerCode: "local_model_image_input_unsupported",
          message: request.locale === "ko"
            ? "현재 로컬 실행 환경에서는 이미지 입력을 처리할 수 없습니다."
            : "The current local runtime does not support image input.",
        },
      };
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
