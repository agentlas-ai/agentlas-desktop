import { tStatus } from "./status-i18n";

/**
 * 왜 멈췄는지를 **끊은 쪽이 실은 말**로 전한다.
 *
 * `AbortController.abort(reason)` 은 이유를 실어 보낼 수 있고, 우리 코드에서 실제로
 * 끊는 주체는 여럿이다 — 사람이 누른 [중지], 워치독, 시간 초과, 체크포인트 저장 실패.
 * 여기서 이유를 읽지 않고 기본 문구로 덮으면, 워치독이 죽인 실행도 화면에는
 * "사용자가 중지했습니다"로 남는다. 그러면 사용자는 자기가 누른 줄 알고 원인을
 * 찾지 않는다(자동화 정직성 계약, `test-automation-honesty-contract`).
 *
 * 기본 문구는 원인을 단정하지 않는 "실행이 중지되었습니다"다 — 이유를 모르면
 * 모르는 대로 말한다.
 *
 * ★한 벌만 둔다. 예전에는 이 함수가 네 러너 파일에 글자까지 똑같이 복사돼 있었고,
 *   다섯 번째(공용 로컬 루프)를 만들 때 규칙을 잊어 게이트에 걸렸다.
 */
export function abortReasonError(req: { signal?: AbortSignal; locale?: unknown }): Error {
  const reason = req.signal?.reason;
  if (reason instanceof Error && reason.message.trim()) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  return new Error(tStatus(req.locale as never, "aborted"));
}
