/**
 * 역할 풀 저장이 거절됐을 때 **사람이 읽고 풀 수 있는 문장**으로 옮긴다.
 *
 * ★왜 이 파일이 따로 있나 (실측 2026-09-08).
 *   RuntimeControl 의 쓰기 경로 세 곳이 전부 `catch { setMessage(""); }` 였다. 저장이
 *   거절되면 문구가 지워졌고, 그래서 "아무 일도 안 일어난 화면"과 "거절당한 화면"이
 *   픽셀 단위로 같았다. QA 가 오케스트레이터 행의 × 를 다섯 번 누르고도 이유를 못 봤다.
 *
 *   판단을 컴포넌트 안에 두면 게이트가 그것을 **부를 수 없고** 소스 문자열만 맞춰보게
 *   된다. 그 검사는 이 계열의 회귀를 원리적으로 못 잡는다. 그래서 순수 함수로 꺼냈다.
 *
 * 규칙: 모르는 오류는 지어내지 않는다 — 원문을 붙여서라도 보여준다. 삼키는 것이 최악이다.
 */

import { failureMessage } from "@/lib/invocation-failure";

export function describeRoleWriteFailure(error: unknown, ko: boolean): string {
  /*
   * ★IPC 포장까지 벗겨야 한다 (게이트가 잡았다, 2026-09-08).
   *   여기서는 `Error: ` 접두사만 벗기고 있었는데, IPC 를 건너온 오류는
   *   `Error invoking remote method 'runtime:setRoleMembers': Error: ...` 로 온다.
   *   그러면 사용자에게 **remote method 이름**이 그대로 보인다.
   *   벗기는 규칙은 한 곳(invocation-failure)에만 둔다 — 두 벌이면 갈라진다.
   */
  const text = failureMessage(error);

  if (/pool cannot be empty/i.test(text)) {
    return ko
      ? "오케스트레이터 후보는 최소 하나가 있어야 합니다. 다른 후보를 먼저 추가한 뒤 이 행을 지우세요."
      : "At least one orchestrator candidate must remain. Add another candidate first, then remove this row.";
  }

  if (/CHECK constraint failed/i.test(text) && /role/i.test(text)) {
    // 옛 저장소는 역할 어휘가 두 개뿐(orchestrator·worker)이라 멀티모달 행을 못 받는다.
    // 앱을 다시 켜면 저장소 업그레이드(db.ts v106)가 열을 넓힌다. 그래도 같은 오류면
    // 업그레이드 자체가 실패한 상태다 — 그때는 재시도가 아니라 다른 조치가 필요하다.
    return ko
      ? "이 컴퓨터의 저장소가 아직 이 역할을 모릅니다. 앱을 완전히 종료했다 다시 켜면 저장소를 올립니다. 다시 켜도 같은 오류가 나오면 저장소 업그레이드가 실패한 상태입니다."
      : "This machine's store does not know this role yet. Quit and reopen the app to finish the store upgrade. If the same error returns after a restart, the store upgrade itself failed.";
  }

  if (/Unknown stored runtime kind/i.test(text)) {
    return ko
      ? "저장된 런타임 중 이 앱 판이 모르는 것이 있습니다. 앱을 최신으로 올리거나, 그 행을 지우고 다시 고르세요."
      : "A stored runtime is unknown to this build. Update the app, or remove that row and pick again.";
  }

  if (/inherit/i.test(text) && /worker/i.test(text)) {
    return ko
      ? "'상속'은 작업자 역할에서만 켤 수 있습니다. 이 역할에는 런타임을 직접 고르세요."
      : "Inheritance is only available for the worker role. Pick a runtime directly for this role.";
  }

  if (!text) {
    // 이유가 안 온 것도 사실이다. "성공"으로도 "조용함"으로도 넘기지 않는다.
    return ko
      ? "저장하지 못했습니다. 이유가 오지 않았습니다 — 앱을 다시 켠 뒤 다시 시도하세요."
      : "The change was not saved and no reason came back. Reopen the app and try again.";
  }

  return ko ? `저장하지 못했습니다: ${text}` : `The change was not saved: ${text}`;
}
