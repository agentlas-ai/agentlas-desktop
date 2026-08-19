// 런타임이 "이 실행은 나로선 못 한다"고 거절할 때 쓰는 **표식**.
//
// ★사유는 문장이 아니라 표식이어야 한다. 판정(judgeChecklist)이 후보 런타임을 차례로
//   돌다 전부 거절당하면, 지금까지는 마지막 에러 문장 하나만 남고 다음 행동은
//   "잠시 뒤 다시 실행해 주세요" 로 고정돼 있었다. 그런데 거절은 시간이 지나도
//   해결되지 않는다 — codex 만 설치한 사용자는 그 안내를 따라 영원히 다시 눌러도
//   같은 자리에 선다(실측 2026-08-19: 설치된 5종 중 codex 만 판정을 거절했고,
//   codex 단독 사용자는 검증이 있는 자동화를 하나도 끝낼 수 없다).
//
//   "한도 소진"·"로그인 필요"는 기다리거나 손을 쓰면 풀리고, "이 런타임은 판정을
//   수행할 수 없다"는 다른 런타임을 하나 연결해야 풀린다. 두 사유의 다음 행동이
//   다르므로, 코드가 둘을 구분할 수 있어야 한다.
export class RuntimeJudgmentRefusal extends Error {
  readonly code = "runtime_cannot_judge" as const;
  readonly runtimeKind: string;

  constructor(runtimeKind: string, message: string) {
    super(message);
    this.name = "RuntimeJudgmentRefusal";
    this.runtimeKind = runtimeKind;
  }
}

/** 이 실패가 "이 런타임은 판정을 못 한다"인가. 문장을 읽지 않고 표식으로 답한다. */
export function isJudgmentRefusal(error: unknown): error is RuntimeJudgmentRefusal {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { code?: unknown }).code === "runtime_cannot_judge",
  );
}
