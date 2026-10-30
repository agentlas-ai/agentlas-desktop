// A model change is never refused for the app's own reasons (a Goal that moved on, a model list that went stale, a quick second
// choice): Main takes it at the Goal's next safe episode or as the chat's next-message pin. What can still be refused is a
// cause outside the app, and then the person is told that plainly, in one sentence that names the runtime and what to do:
// the runtime is signed out, not installed, its credential store cannot be read, or its own authoritative model list says
// the model is not installed. Every other failure is retried or settles to the saved choice without a notice.
import type { RuntimeSelection } from "../../shared/types";

const KIND_LABEL: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity", kimi: "Kimi Code", grok: "Grok",
  cursor: "Cursor Agent", byok: "API", ollama: "Ollama", lmstudio: "LM Studio", mlx: "MLX",
  "agentlas-local": "Agentlas Local", acp: "ACP", agentlas: "Agentlas",
};

function runtimeName(selection: Pick<RuntimeSelection, "kind" | "label">): string {
  return selection.kind === "acp" && selection.label?.trim() ? selection.label.trim() : KIND_LABEL[selection.kind] ?? selection.kind;
}

/** Codes Main raises for a cause outside the app (runtime-handoff.ts goalRuntimeSelectionError). */
export const EXTERNAL_RUNTIME_REFUSAL_CODES = [
  "goal_runtime_sign_in_required",
  "goal_runtime_selection_unavailable",
  "goal_runtime_credential_unavailable",
  "goal_runtime_model_unverified",
] as const;

/** The sentence for a refusal that is not the app's doing, or null when the failure is not one (retry or settle silently). */
export function goalRuntimeRefusalNotice(
  code: string | undefined,
  selection: Pick<RuntimeSelection, "kind" | "label" | "model">,
  locale: "ko" | "en",
): string | null {
  const name = runtimeName(selection);
  const kept = locale === "ko" ? " 작성한 글과 첨부는 보관됩니다." : " Your text and attachments are kept.";
  switch (code) {
    case "goal_runtime_sign_in_required":
      return (locale === "ko" ? `${name}: 로그인이 필요합니다. 로그인한 뒤 모델을 다시 선택해 주세요.` : `${name} needs sign-in. Sign in, then choose the model again.`) + kept;
    case "goal_runtime_selection_unavailable":
      return (locale === "ko" ? `${name}: 이 컴퓨터에서 실행할 수 없습니다. 설치와 연결을 확인한 뒤 다시 선택해 주세요.` : `${name} cannot run on this computer. Check that it is installed and connected, then choose again.`) + kept;
    case "goal_runtime_credential_unavailable":
      return (locale === "ko" ? `${name}: 저장된 인증 정보를 읽지 못했습니다. 키체인 접근을 허용한 뒤 다시 선택해 주세요.` : `${name}'s saved credentials could not be read. Allow keychain access, then choose again.`) + kept;
    case "goal_runtime_model_unverified": {
      const model = selection.model?.trim();
      return (locale === "ko"
        ? `${name}에 ${model ? `${model} 모델이` : "선택한 모델이"} 설치되어 있지 않습니다. 설치하거나 다른 모델을 선택해 주세요.`
        : `${model ? `${model} is` : "The selected model is"} not installed in ${name}. Install it or choose another model.`) + kept;
    }
    default:
      return null;
  }
}

/** Main answers a Goal-aware choice with a receipt whose state says what happened: "pending"/"claimed" = queued for the
 * Goal's next safe episode, "applied" = no Goal needed it (it ended, or never was), the choice is the chat's pin. */
export function goalReceiptIsQueued(receipt: { state: "pending" | "claimed" | "applied" } | null | undefined): boolean {
  return receipt?.state === "pending" || receipt?.state === "claimed";
}

/** Chat/IPC codes of an overtaken or vanished request: the saved selection is the answer; nothing is said. */
export function isOvertakenSelectionCode(code: string | undefined): boolean {
  return code === "chat_runtime_selection_superseded" || code === "chat_runtime_selection_chat_missing";
}
