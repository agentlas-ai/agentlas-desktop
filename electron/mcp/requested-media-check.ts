// Host check: an image or screen capture the owner asked for must exist before the answer stands as delivered.
//
// Sibling of requested-file-check.ts, for the two things a chat answer can promise that are checked by what the host holds
// rather than by a file name: an image the owner asked to have drawn (naturalLanguageRequiresImageGeneration) and a screenshot
// the owner asked to have taken (naturalLanguageRequiresScreenCapture). Both used to end a turn that had already answered as a
// failed run, with the answer thrown away ("screen_capture_unavailable" became `runner-failed`, observed in use):
// the model's missing capture is not an internal fault the owner can act on, and the answer it wrote is still the answer.
// The honest handling is the one a missing requested file already gets: keep the answer, save a factual correction with
// it (so neither the owner nor the next turn builds on an image that is not there), tell the owner with a warning notice, and
// let the turn complete without a completion claim.
//
// No electron import: Main and the daemon both finish runs.
import { registerDeclaredPromptModule } from "../runtime/prompt-order";

export type MissingRequestedMedia = "image" | "screen-capture";

export const REQUESTED_MEDIA_NOTICE_CODE: Record<MissingRequestedMedia, string> = {
  image: "requested-image-missing",
  "screen-capture": "requested-screen-capture-missing",
};

/** The correction saved with the answer (and read by later turns from the conversation history). */
export function requestedMediaCorrection(kind: MissingRequestedMedia, locale: "ko" | "en"): string {
  // Saved with the answer like requestedFileCorrection: a declared host module, not a model-written line.
  registerDeclaredPromptModule({ id: "one.answer.host.requested-media-check", revision: 1, stability: "turn-context", changeTriggers: ["model-output"], order: 0 });
  if (kind === "image") {
    return locale === "ko"
      ? "**호스트 확인:** 요청하신 이미지가 만들어져 첨부되지 않았습니다. 위 답에서 이미지를 만들었다고 했더라도 사실이 아닙니다. 다시 요청하시면 새로 시도합니다."
      : "**Host check:** the image you asked for was not produced or attached. If the answer above says it was, that is not so. Ask again and it will be tried again.";
  }
  return locale === "ko"
    ? "**호스트 확인:** 요청하신 화면 캡처가 만들어져 첨부되지 않았습니다. 위 답에서 캡처했다고 했더라도 사실이 아닙니다. 다시 요청하시면 새로 시도합니다."
    : "**Host check:** the screen capture you asked for was not produced or attached. If the answer above says it was taken, that is not so. Ask again and it will be tried again.";
}

/** The warning notice shown with the answer (additive code; clients that do not know it show its message). */
export function requestedMediaNotice(kind: MissingRequestedMedia): { code: string; i18n: { ko: string; en: string } } {
  return {
    code: REQUESTED_MEDIA_NOTICE_CODE[kind],
    i18n: kind === "image"
      ? { ko: "요청한 이미지가 만들어지지 않았습니다.", en: "The requested image was not produced." }
      : { ko: "요청한 화면 캡처가 만들어지지 않았습니다.", en: "The requested screen capture was not produced." },
  };
}
