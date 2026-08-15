import { tStatus } from "./status-i18n";
import { STOPPED_BY_USER } from "./invocation-lifecycle";

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
  /*
   * ★"사용자가 멈췄다"는 표식은 사람 문장으로 바꿔서 내보낸다.
   *
   * 중지 요청은 사유를 표식(STOPPED_BY_USER)으로 싣는다 — 기계가 분기할 수 있어야
   * 하기 때문이다. 그 표식이 그대로 화면에 가면 그것대로 읽을 수 없는 문장이 되므로,
   * 사람에게 나가는 마지막 자리인 여기서 로케일 문구로 바꾼다. 표식을 안 쓰면 DOM 이
   * 넣는 기본 사유("This operation was aborted")가 대신 흘러가 실패처럼 보인다.
   */
  if (reason instanceof Error && reason.message === STOPPED_BY_USER) {
    return new Error(tStatus(req.locale as never, "aborted"));
  }
  if (reason instanceof Error && reason.message.trim()) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  return new Error(tStatus(req.locale as never, "aborted"));
}
