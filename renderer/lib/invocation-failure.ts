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

/*
 * IPC 경계 코드 읽기. 형식의 정본은 shared/ipc-error-code.ts(Main 이 싣는 쪽)다.
 * 이 파일은 여러 게이트가 import 없이 단독 트랜스파일하므로 읽는 쪽 사본을 둔다 —
 * scripts/local/ipc-error-code-boundary-contract.cjs 가 두 정규식이 같은지 본다.
 */
const IPC_ERROR_CODE_PREFIX_RE = /\[agentlas:code=([A-Za-z][A-Za-z0-9_.:-]{0,95})\]\s?/;

/** 화면의 모든 기계 코드 판정은 이 함수 하나로 읽는다(own .code → IPC 접두어). */
export function ipcErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const own = (error as { code?: unknown }).code;
    if (typeof own === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(own)) return own;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : "";
  return IPC_ERROR_CODE_PREFIX_RE.exec(message)?.[1];
}

/** Stable marker emitted by electron/runtime/run-id.ts. */
export const CHAT_BUSY_CODE = "chat_invocation_active";

export function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error ?? "");
  return raw
    // IPC 포장을 벗긴다 — 사용자에게 remote method 이름을 보여 줄 이유가 없다.
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^([A-Za-z]*Error:\s*)+/, "")
    // Main IPC 경계가 싣는 기계 코드 접두어(shared/ipc-error-code)는 사람 문장이 아니다.
    .replace(IPC_ERROR_CODE_PREFIX_RE, "")
    .trim();
}

/**
 * 실패의 기계 코드. 순서: 오류 자신의 code(같은 프로세스) → IPC 경계 접두어
 * `[agentlas:code=…]` → 메시지 전체가 식별자 → 메시지 앞머리 `code: 설명`.
 * 사람 문장뿐이면 undefined.
 */
export function failureCode(error: unknown): string | undefined {
  const coded = ipcErrorCode(error);
  if (coded) return coded;
  const message = failureMessage(error);
  if (/^[a-z][a-z0-9_-]{1,95}$/.test(message)) return message;
  return /^([a-z][a-z0-9_]{2,95}):\s/.exec(message)?.[1];
}

export function isChatBusyFailure(error: unknown): boolean {
  if (ipcErrorCode(error) === CHAT_BUSY_CODE) return true;
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
  return goalAdmissionControlFailureForCode(failureCode(error), ko);
}

/**
 * Same wording keyed by a stored machine code (e.g. the admission ledger's
 * rejectionReasonCode, which Main now records as the real refusal code).
 */
export function goalAdmissionControlFailureForCode(code: string | null | undefined, ko: boolean): { code: string; message: string } | null {
  if (!code) return null;
  let message: string;
  if (code.startsWith("invocation_admission_") && code !== "invocation_admission_chat_pending") {
    message = ko
      ? `실행 접수 기록을 안전하게 남기지 못해 시작하지 않았습니다(사유 코드: ${code}). 아무것도 실행되지 않았고 입력은 보존되어 있습니다. 잠시 뒤 다시 보내도 중복 실행되지 않습니다.`
      : `The run could not be recorded safely, so it did not start (reason code: ${code}). Nothing ran and your input is preserved; sending again later cannot run it twice.`;
    return { code, message };
  }
  if (code.startsWith("work_attachment_goal_")) {
    message = ko
      ? "첨부를 준비하는 사이 목표가 바뀌어 시작하지 않았습니다. 목표의 현재 상태를 확인한 뒤 보내 주세요. 입력과 첨부는 보존되어 있습니다."
      : "The goal changed while the attachment was being prepared, so this did not start. Check the goal's current state, then send; your input and attachments are preserved.";
    return { code, message };
  }
  switch (code) {
    case "budget_cost_exhausted":
      message = ko ? "목표에 정한 비용 한도를 모두 써서 시작하지 않았습니다. 목표의 비용 한도를 늘리면 이어서 진행합니다. 입력은 보존되어 있습니다."
        : "The goal's cost budget is used up, so this did not start. Raise the goal's cost budget to continue; your input is preserved.";
      break;
    case "budget_cost_unavailable":
      message = ko ? "이전 실행의 비용을 확인할 수 없어, 비용 한도가 있는 목표를 이어가지 않았습니다. 목표의 비용 한도를 확인하거나 해제하면 이어집니다. 입력은 보존되어 있습니다."
        : "The previous run's cost could not be measured, so a cost-capped goal did not continue. Review or remove the goal's cost budget to continue; your input is preserved.";
      break;
    case "goal_wait_claimed_reconciliation_required":
      message = ko ? "목표가 기다리던 신호를 이미 받아 처리 중인지 확인하는 중이라 시작하지 않았습니다. 확인은 자동으로 이어지며, 끝나면 목표 상태에 표시됩니다. 입력은 보존되어 있습니다."
        : "The goal is confirming whether the signal it was waiting for is already being handled, so this did not start. The check continues automatically and the goal status will update; your input is preserved.";
      break;
    case "goal_resume_effect_boundary_uncertain":
      message = ko ? "이전 실행의 외부 결과가 확인되지 않아 목표를 이어가지 않았습니다. 목표의 재개에서 결과를 검토하면 이어집니다. 목표와 입력은 보존되어 있습니다."
        : "The previous run's external outcome is unconfirmed, so the goal did not continue. Review it from the goal's Resume to continue; your goal and input are preserved.";
      break;
    case "desktop_execution_admission_closed":
      message = ko ? "앱이 종료 또는 업데이트를 준비하는 중이라 새 실행을 받지 않았습니다. 앱이 다시 열리면 보내 주세요. 입력은 보존되어 있습니다."
        : "The app is shutting down or preparing an update, so it is not accepting new runs. Send once the app reopens; your input is preserved.";
      break;
    case "invocation_cleanup_pending":
    case "invocation_admission_chat_pending":
      message = ko ? "이 대화의 이전 실행을 마무리하는 중이라 시작하지 않았습니다. 보통 몇 초 안에 끝나며, 끝난 뒤 보내면 됩니다. 입력은 보존되어 있습니다."
        : "This chat is still finishing its previous run, so this did not start. It usually takes a few seconds; send once it finishes. Your input is preserved.";
      break;
    case "goal_control_not_started":
      message = ko ? "목표가 아직 실행을 시작하지 않아 일시정지할 것이 없습니다. 목표 상태는 그대로입니다."
        : "The goal has not started a run yet, so there is nothing to pause. The goal is unchanged.";
      break;
    case "goal_stop_in_progress":
      message = ko ? "목표를 멈추는 중이라 아직 새 요청을 시작할 수 없습니다. 입력은 보존되어 있습니다. 멈춤이 끝난 뒤 보내 주세요."
        : "The goal is still stopping, so a new request cannot start yet. Your input is preserved; send it after stopping finishes.";
      break;
    case "goal_explicit_resume_required":
      message = ko ? "목표가 멈춰 있어 이번 요청을 시작하지 못했습니다. 목표와 입력은 보존되어 있습니다."
        : "The goal is stopped, so this request did not start. Your goal and input are preserved.";
      break;
    case "auto_goal_resume_attempt_unsettled":
      message = ko ? "이전 실행의 외부 결과가 불확실해 새 요청을 시작하지 않았습니다. Activity와 실제 외부 결과를 확인한 뒤 목표의 재개 버튼에서 검토해 주세요. 목표와 입력은 보존되어 있습니다."
        : "The previous action's external outcome is uncertain, so this request did not start. Check Activity and the external result, then review it from the goal's Resume button. Your goal and input are preserved.";
      break;
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

