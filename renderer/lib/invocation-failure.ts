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

/**
 * 시작 실패 코드 → 사람 문장. 실측(페르소나 루프 라운드 1, 2026-09-13): 멈춘 목표 대화에 "이어서"를 치면
 * goal_explicit_resume_required 가 그대로 떨어져 "이유가 오지 않았습니다"만 4번 반복됐다. 다음 행동을 말해 준다.
 */
export function knownStartFailureHuman(error: unknown, ko: boolean): string | null {
  const code = failureMessage(error).split(/[\s:]/, 1)[0] ?? "";
  switch (code) {
    case "goal_explicit_resume_required":
      return ko ? "이 작업은 멈춰 있어요. 위 목표 칩의 '재개'를 누르면 여기서부터 이어집니다." : "This task is paused. Press 'Resume' on the goal chip above to continue from here.";
    case "auto_goal_resume_attempt_unsettled":
      return ko ? "이전 실행이 아직 정리되지 않았어요. 잠시 뒤 다시 시도해 주세요." : "The previous run is still settling. Try again in a moment.";
    case "auto_goal_resume_chat_busy":
      return ko ? "이 대화가 아직 앞 요청을 돌리는 중이에요." : "This chat is still running an earlier request.";
    default:
      return null;
  }
}
