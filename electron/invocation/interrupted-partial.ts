/**
 * 중단된 스트림 본문에 붙는 표식 — 순수 함수(게이트가 직접 호출한다).
 *
 * ★중단된 스트림은 중단됐다고 적힌 채로 남아야 한다.
 *
 * 취소·실패로 끝난 실행의 스트리밍 본문은 보존한다(그 자체가 사용자가 이미 본 작업이다).
 * 그런데 표식 없이 저장하면 마지막 문단이 곧 최종 답으로 읽힌다 — 실측(2026-08-15):
 * agy 실행이 `runner-failed / This operation was aborted`(hasFinalText=false)로 끝났는데
 * 그 부분 스트림이 그대로 저장돼 "100세트 전 과정 완료" 보고로 읽혔고, 사용자가
 * "다 된 거냐"고 되물었다. 원장은 실패라고 적고 있는데 대화창만 성공처럼 보였다.
 *
 * U+FFFD는 별도 사실이다 — agy의 text_delta는 UTF-8 바이트 경계에서 찢겨 양쪽 조각이
 * 대체 문자가 된다(원본 바이트 소실이라 접합 쪽 복원 불가). 정상 종료 경로는 최종
 * result.response를 정본으로 써서 이를 피하지만, 중단 경로에는 그 정본이 없다.
 * 고칠 수 없다면 최소한 깨졌다고 말한다(실측: 저장된 두 답변에 각각 102·135자).
 */
export function markInterruptedPartial(text: string, locale: string): string {
  const corrupted = text.includes("�");
  const banner = locale === "ko"
    ? [
      "> ⚠️ **중단된 답변입니다 — 완료된 결과가 아닙니다.**",
      "> 아래는 실행이 끝나기 전까지 스트리밍된 부분 내용이며, 검증되지 않았습니다.",
      ...(corrupted ? ["> 전송 중 일부 글자가 깨졌습니다(`�`)."] : []),
    ]
    : [
      "> ⚠️ **Interrupted answer — this is not a completed result.**",
      "> Below is the partial text streamed before the run ended. It was not finished or verified.",
      ...(corrupted ? ["> Some characters were corrupted in transit (`�`)."] : []),
    ];
  return `${banner.join("\n")}\n\n${text}`;
}
