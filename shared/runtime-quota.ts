/**
 * 사용량 한도로 모델을 건너뛰는 단 하나의 기준.
 *
 * 기준이 두 벌로 갈라져 있었다: 역할 풀 선택은 `detect.ts` 에서 90%, 실제 실행 선택은
 * `selection.ts` 에서 100% 였다. 그래서 주간 사용량 90% 인 Codex 가 화면에는
 * "Quota exceeded · skipped" 로 뜨는데 실행 판정은 멀쩡히 통과하는 상태가 됐다
 * (오너 신고 2026-09-14: "10% 남았는데 왜"). 화면과 동작이 갈린 것이고, 남은 10% 는
 * 매주 그대로 버려졌다.
 *
 * `detect.ts` 의 그 상수 바로 위 주석이 이미 이렇게 적고 있었다 — *"detect 본체와 UI
 * 조회가 같은 규칙을 쓰게 한 곳에 둔다. 두 벌로 두면 한쪽만 고쳐져 '설정 화면과 실제
 * 실행이 다른 모델'이 된다."* 그 경고가 맞았는데, 정작 두 번째 벌이 다른 파일에 있었다.
 *
 * 오너 결정 2026-09-14: **100 으로 통일한다.** 한도가 실제로 소진됐을 때만 건너뛴다.
 * 90% 에서 미리 손을 떼면 쓸 수 있는 몫을 버리는 것이고, "규제는 적게, 자율은 많이,
 * 막을 것은 자원 폭주뿐" 이라는 같은 날 결정과도 어긋난다. 한도가 진짜로 소진되면
 * 실행 실패 경로가 따로 받아 낸다.
 */
export const QUOTA_EXHAUSTED_PERCENT = 100;

/** 이 사용률이면 자동 선택에서 건너뛴다. 사용률을 모르면(null) 건너뛰지 않는다. */
export function quotaExhausted(usedPercent: number | null | undefined): boolean {
  return typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= QUOTA_EXHAUSTED_PERCENT;
}
