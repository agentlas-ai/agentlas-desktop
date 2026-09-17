/**
 * 실행 시작 실패를 화면이 알아보는 방법.
 *
 * ★왜 문자열로 보는가 (2026-09-08).
 *   엔진은 이 실패에 `error.code = "chat_invocation_active"` 를 붙인다. 그런데 그 값은
 *   **렌더러까지 오지 못한다** — Electron 의 ipcRenderer.invoke 거절은 원본 Error 의
 *   message 만 실어 오고 커스텀 속성은 사라진다. 실제로 이 저장소의 렌더러 어디에도
 *   `error.code` 로 판정하는 자리가 **한 곳도 없다**(선례 0건). 코드로 판정하는 코드를
 *   쓰면 컴파일도 되고 타입도 맞지만 **한 번도 참이 되지 않는다.**
 *
 *   Main therefore includes a stable machine marker in the IPC message.
 *   Classify that marker, never localized prose, when custom fields are lost.
 *
 *   메시지는 IPC 를 건너며 "Error invoking remote method '...': Error: <원문>" 으로
 *   감싸이므로 반드시 **부분 일치**로 본다.
 */

/** Stable marker emitted by electron/runtime/run-id.ts. */
export const CHAT_BUSY_CODE = "chat_invocation_active";

export function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error ?? "");
  return raw
    // IPC 포장을 벗긴다 — 사용자에게 remote method 이름을 보여 줄 이유가 없다.
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(Error:\s*)+/, "")
    .trim();
}

export function isChatBusyFailure(error: unknown): boolean {
  if ((error as { code?: string } | null)?.code === CHAT_BUSY_CODE) return true;
  const message = failureMessage(error);
  return message.startsWith(`${CHAT_BUSY_CODE}:`);
}

/**
 * 엔진 문구가 **사람 문장인지** 본다.
 *
 * ★왜 (실측 2026-09-08): 엔진의 실패 문구 상당수가 문장이 아니라 식별자다 —
 *   `untrusted-site-publish-ipc-sender`, `goal_contract_not_created`,
 *   `native-publish-approval-contract-invalid`. 설정의 모바일 연결 패널이 그것을
 *   **그대로** 화면에 그리고 있었다(단추 7개에서 재현). 사용자는 그걸 읽고
 *   무엇을 해야 할지 알 수 없다.
 */
export function looksLikeMachineText(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  // 공백 없는 kebab/snake 식별자
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(value)) return true;
  // 한 낱말짜리 영문 토큰
  if (!/\s/.test(value) && /^[A-Za-z0-9_.:-]+$/.test(value)) return true;
  return false;
}

/**
 * 사람 문장 + (사람이 읽을 만한 경우에만) 엔진이 말한 이유.
 * 기계 식별자는 화면에 올리지 않는다 — 대신 준비된 문장만 보여 준다.
 */
export function humanFailure(error: unknown, human: string): string {
  const detail = failureMessage(error);
  if (!detail || looksLikeMachineText(detail)) return human;
  return `${human}\n\n${detail}`;
}

/**
 * 사람 문장 뒤에 **덧붙여도 되는** 상세 문구만 돌려준다.
 *
 * ★`${String(err)}` 로 붙이던 자리가 화면에 그대로 식별자를 그렸다
 *   (실측 2026-09-08: 에이전트 가져오기 실패 뒤에 `Error: machine-token...`).
 *   String(err) 는 "Error: " 접두사까지 그대로 남긴다.
 *   기계 문자열이면 빈 문자열을 준다 — 붙일 것이 없다는 뜻이다.
 */
export function detailForUser(error: unknown): string {
  const detail = failureMessage(error);
  return !detail || looksLikeMachineText(detail) ? "" : detail;
}

/** Admission/control refusals need a new user decision, not a recovery model
 * turn. Match only exact machine codes after Electron's transport wrapping. */
export function goalAdmissionControlFailure(error: unknown, ko: boolean): { code: string; message: string } | null {
  const code = failureMessage(error);
  let message: string;
  switch (code) {
    case "goal_stop_in_progress":
      message = ko ? "목표를 멈추는 중이라 아직 새 요청을 시작할 수 없습니다. 입력은 보존되어 있습니다. 멈춤이 끝난 뒤 보내 주세요."
        : "The goal is still stopping, so a new request cannot start yet. Your input is preserved; send it after stopping finishes.";
      break;
    case "goal_explicit_resume_required":
      message = ko ? "목표가 멈춰 있어 이번 요청을 시작하지 못했습니다. 목표와 입력은 보존되어 있습니다."
        : "The goal is stopped, so this request did not start. Your goal and input are preserved.";
      break;
    case "auto_goal_resume_attempt_unsettled":
    case "goal_verification_pending":
      message = ko ? "이전 실행의 결과가 아직 확인되지 않아 시작하지 않았습니다. 목표와 입력은 보존되어 있습니다."
        : "The previous attempt's outcome is still unresolved, so this request did not start. Your goal and input are preserved.";
      break;
    case "auto_goal_resume_chat_busy":
      message = ko ? "이 목표의 이전 실행이 아직 진행 중입니다. 입력은 보존되어 있습니다."
        : "An earlier run of this goal is still active. Your input is preserved.";
      break;
    case "auto_goal_resume_not_ready":
    case "auto_goal_resume_contract_not_blocked":
    case "auto_goal_resume_version_required":
    case "long_run_resume_version_conflict":
    case "goal_control_binding_changed":
    case "goal_control_scope_mismatch":
    case "auto_goal_control_not_allowed":
      message = ko ? "목표 상태가 달라졌거나 아직 이어갈 수 없어 시작하지 않았습니다. 현재 목표 상태를 확인해 주세요. 입력은 보존되어 있습니다."
        : "The goal state changed or is not ready to continue, so this request did not start. Check its current state; your input is preserved.";
      break;
    case "auto_goal_budget_exhausted":
      message = ko ? "목표의 실행 한도에 도달해 시작하지 않았습니다. 목표 한도를 확인해 주세요. 입력은 보존되어 있습니다."
        : "The goal's execution budget is exhausted, so this request did not start. Check its budget; your input is preserved.";
      break;
    default:
      return null;
  }
  return { code, message };
}

/** Shared customer wording; a new user turn may resume a paused goal in Main.
 * Do not require a separate Resume button or turn a refusal into a retry. */
export function knownStartFailureHuman(error: unknown, ko: boolean): string | null {
  return goalAdmissionControlFailure(error, ko)?.message ?? null;
}
