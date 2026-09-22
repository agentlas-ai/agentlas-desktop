import { createHash } from "node:crypto";
import type { Runner } from "../runtime/runner";
import { makeLocalOpenAiRunner } from "../runtime/local-openai";
import type { LocalModelHubOwnerPort } from "./ports";

/**
 * The runtime selector remains the single authority. It may select this runner
 * only after detect exposes the resident receipt as an available runtime.
 */
export function createManagedLocalModelRunner(manager: LocalModelHubOwnerPort): Runner {
  const makeRunner = (acceptsImageResults: boolean) => makeLocalOpenAiRunner(() => manager.endpoint(), "agentlas-local", {
    chatTemplateKwargs: { enable_thinking: false },
    headersFn: () => manager.authorizationHeaders(),
    // 비전 프로젝터(mmproj)가 붙어 로드된 모델만 도구 스크린샷을 본다. 텍스트 GGUF 는 텍스트 전용.
    acceptsImageResults,
    // Tool agents need determinism more than variety; llama-server's default 0.8 made the same task
    // succeed or fail run to run (isolated app measurement 2026-09-13).
    temperature: 0.2,
    contextWindowFn: async () => {
      const receipt = (await manager.snapshot()).resident;
      if (!receipt || receipt.state !== "resident") throw new Error("local_model_not_resident");
      return receipt.contextTokens;
    },
  });
  const textRunner = makeRunner(false);
  const visionRunner = makeRunner(true);
  return async (request, events) => {
    const installation = manager.residentInstallation();
    if (request.model !== installation.fileName) {
      throw new Error("resident_model_selection_mismatch");
    }
    const vision = Boolean(installation.projectorFileName);
    const runner = vision ? visionRunner : textRunner;
    // A text GGUF loaded without a vision projector cannot process images. An
    // OpenAI-compatible image envelope does not add that support. Refuse before
    // inference/receipts; never discard attachments or pretend the selected
    // model processed them.
    if (request.images?.length && !vision) {
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
